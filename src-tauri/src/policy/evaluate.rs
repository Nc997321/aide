//! Policy evaluation: per-scope winner selection, deny override, and the
//! explanation chain. Provider-agnostic — the only Claude-specific behavior
//! (canUseTool mapping, AskUserQuestion reshaping) lives in the agent sidecar.

use crate::settings::{PermissionEffect, SettingsScope, StoredPermissionRule};

use super::matchers::{matcher_matches, specificity};
use super::model::{
    ChainEntry, ChainStatus, PermissionMatcher, PermissionPolicySnapshot, PermissionRule,
    PermissionSource, PolicyDecision, PolicyDisposition, ToolInvocation,
};

/// Scope priority, highest first. Used both to pick the cross-scope winner and
/// to order per-scope evaluation. `Session` is in-memory only and never
/// persisted, but a snapshot may carry session rules.
const SCOPE_PRIORITY: [SettingsScope; 5] = [
    SettingsScope::Session,
    SettingsScope::Local,
    SettingsScope::Project,
    SettingsScope::User,
    SettingsScope::Managed,
];

/// Evaluate `invocation` against `snapshot`. The decision is `defer` when no
/// rule matches, leaving the caller to fall back to the provider's existing
/// permission mode. Filesystem access happens only for path-folder matchers
/// (symlink safety); Bash/field/tool matchers are pure.
pub fn evaluate(snapshot: &PermissionPolicySnapshot, invocation: &ToolInvocation) -> PolicyDecision {
    // Per scope: collect matched rules, pick the winner by
    // (specificity DESC, order ASC). Losers in the same scope are recorded for
    // the chain as `shadowed_by_specificity`.
    let mut scope_winners: Vec<&PermissionRule> = Vec::new();
    let mut same_scope_losers: Vec<&PermissionRule> = Vec::new();

    for &scope in &SCOPE_PRIORITY {
        let mut candidates: Vec<&PermissionRule> = snapshot
            .rules
            .iter()
            .filter(|r| r.scope == scope && r.tool == invocation.tool)
            .filter(|r| {
                matcher_matches(&r.matcher, &invocation.input, invocation.cwd.as_deref(), r.effect)
            })
            .collect();
        if candidates.is_empty() {
            continue;
        }
        candidates.sort_by(|a, b| {
            specificity(&b.matcher)
                .cmp(&specificity(&a.matcher))
                .then(a.order.cmp(&b.order))
        });
        scope_winners.push(candidates[0]);
        for loser in candidates.iter().skip(1) {
            same_scope_losers.push(loser);
        }
    }

    // Any deny among scope winners → final deny. The reported deny is the
    // highest-priority one (SCOPE_PRIORITY order, so the first deny found).
    let deny_winner = scope_winners
        .iter()
        .find(|r| r.effect == PermissionEffect::Deny)
        .copied();

    let (disposition, selected): (PolicyDisposition, Option<&PermissionRule>) = match deny_winner {
        Some(deny) => (PolicyDisposition::Deny, Some(deny)),
        None => match scope_winners.first().copied() {
            Some(winner) => {
                let disp = match winner.effect {
                    PermissionEffect::Allow => PolicyDisposition::Allow,
                    PermissionEffect::Ask => PolicyDisposition::Ask,
                    PermissionEffect::Deny => PolicyDisposition::Deny, // unreachable: no deny
                };
                (disp, Some(winner))
            }
            None => (PolicyDisposition::Defer, None),
        },
    };

    // Build the explanation chain. Same-scope losers first, then scope winners
    // so the selected rule and its overrides are visible.
    let mut chain: Vec<ChainEntry> = Vec::new();
    for loser in &same_scope_losers {
        chain.push(ChainEntry {
            rule_id: loser.id.clone(),
            scope: loser.scope,
            matched: true,
            specificity: specificity(&loser.matcher),
            status: ChainStatus::ShadowedBySpecificity,
        });
    }
    for winner in &scope_winners {
        let status = if Some(*winner) == selected {
            ChainStatus::Selected
        } else if deny_winner.is_some() {
            // A deny won. Non-deny winners were overridden by it; a deny winner
            // that wasn't selected was shadowed by a higher-priority deny.
            if winner.effect == PermissionEffect::Deny {
                ChainStatus::OverriddenByLowerScope
            } else {
                ChainStatus::OverriddenByDeny
            }
        } else {
            // No deny: a non-selected winner sits in a lower-priority scope than
            // the selected winner.
            ChainStatus::OverriddenByLowerScope
        };
        chain.push(ChainEntry {
            rule_id: winner.id.clone(),
            scope: winner.scope,
            matched: true,
            specificity: specificity(&winner.matcher),
            status,
        });
    }

    let reason = match selected {
        Some(rule) => summarize_rule(rule),
        None => "no matching permission rule; deferring to provider permission mode".to_string(),
    };

    PolicyDecision {
        disposition,
        winner: selected.cloned(),
        chain,
        reason,
    }
}

/// Validate a typed rule. `scope` and matcher `field` are typed enums so
/// "unknown scope/field" is rejected at deserialization time; this fn checks
/// the semantic constraints (empty id/tool, empty matcher values, and the
/// bash-contains-allow prohibition).
pub fn validate_rule(rule: &PermissionRule) -> Result<(), super::model::PolicyValidationError> {
    if rule.id.trim().is_empty() {
        return Err(super::model::PolicyValidationError::EmptyId);
    }
    if rule.tool.trim().is_empty() {
        return Err(super::model::PolicyValidationError::EmptyTool);
    }
    match &rule.matcher {
        PermissionMatcher::Tool => {}
        PermissionMatcher::Bash { mode, value } => {
            if matches!(mode, super::model::BashMode::Prefix | super::model::BashMode::Contains)
                && value.as_deref().map_or(true, |v| v.trim().is_empty())
            {
                return Err(match mode {
                    super::model::BashMode::Prefix => {
                        super::model::PolicyValidationError::EmptyPrefix
                    }
                    super::model::BashMode::Contains => {
                        super::model::PolicyValidationError::EmptyContains
                    }
                    super::model::BashMode::All => unreachable!(),
                });
            }
            if matches!(mode, super::model::BashMode::Contains)
                && rule.effect == PermissionEffect::Allow
            {
                return Err(super::model::PolicyValidationError::BashContainsAllow);
            }
        }
        PermissionMatcher::Path { folder, .. } => {
            if let Some(f) = folder {
                if f.trim().is_empty() {
                    return Err(super::model::PolicyValidationError::EmptyFolder);
                }
            }
        }
        PermissionMatcher::Field { equals, .. } => {
            if equals.is_empty() {
                return Err(super::model::PolicyValidationError::EmptyEquals);
            }
        }
    }
    Ok(())
}

/// Parse a stored rule (matcher kept as opaque JSON) into a typed rule. The
/// scope is supplied by the caller because `StoredPermissionRule` doesn't carry
/// it (scope comes from which document the rule lives in). A malformed matcher
/// yields `InvalidMatcher` so callers can reject the document rather than
/// silently dropping rules.
pub fn parse_stored_rule(
    stored: &StoredPermissionRule,
    scope: SettingsScope,
    source: super::model::PermissionSource,
) -> Result<PermissionRule, super::model::PolicyValidationError> {
    let matcher: PermissionMatcher = serde_json::from_value(stored.matcher.clone()).map_err(|e| {
        super::model::PolicyValidationError::InvalidMatcher(e.to_string())
    })?;
    Ok(PermissionRule {
        id: stored.id.clone(),
        scope,
        order: stored.order,
        effect: stored.effect,
        tool: stored.tool.clone(),
        matcher,
        source,
    })
}

fn summarize_rule(rule: &PermissionRule) -> String {
    let scope_word = scope_word(rule.scope);
    let action = match rule.effect {
        PermissionEffect::Allow => "Allowed",
        PermissionEffect::Deny => "Denied",
        PermissionEffect::Ask => "Confirmation required",
    };
    format!(
        "{action} by {scope_word} rule \u{2018}{}\u{2019} ({}: {})",
        rule.id,
        rule.tool,
        matcher_summary(&rule.matcher),
    )
}

fn scope_word(scope: SettingsScope) -> &'static str {
    match scope {
        SettingsScope::Managed => "managed",
        SettingsScope::User => "user",
        SettingsScope::Project => "project",
        SettingsScope::Local => "local",
        SettingsScope::Session => "session",
    }
}

fn matcher_summary(matcher: &PermissionMatcher) -> String {
    match matcher {
        PermissionMatcher::Tool => "any invocation".to_string(),
        PermissionMatcher::Bash { mode, value } => {
            let mode_word = match mode {
                super::model::BashMode::All => "all commands",
                super::model::BashMode::Prefix => "prefix",
                super::model::BashMode::Contains => "contains",
            };
            match value {
                Some(v) => format!("bash {mode_word} {v:?}"),
                None => format!("bash {mode_word}"),
            }
        }
        PermissionMatcher::Path { field, folder } => match folder {
            Some(f) => format!("path {:?} under {f:?}", field),
            None => format!("path {:?} (any)", field),
        },
        PermissionMatcher::Field { field, equals } => {
            format!("field {:?} equals {equals:?}", field)
        }
    }
}

impl crate::settings::SettingsService {
    /// Build a typed `PermissionPolicySnapshot` from the effective layered
    /// documents. Each layer's stored rules (matcher kept as opaque JSON) are
    /// parsed into typed `PermissionRule`s, tagged with the layer's scope and a
    /// `PermissionSource` describing the file the rule came from. Unparseable
    /// rules are skipped with a redacted warning rather than failing the whole
    /// snapshot — a single bad rule in one layer must not blank the policy.
    pub fn permission_snapshot_blocking(
        &self,
        project_root: Option<&std::path::Path>,
    ) -> Result<PermissionPolicySnapshot, crate::settings::SettingsError> {
        let effective = self.effective_document_blocking(project_root)?;
        let revision = self.current_revision()?;
        let mut rules = Vec::new();
        for layer in &effective.documents {
            let source = PermissionSource {
                label: scope_word(layer.scope).to_string(),
                path: layer
                    .path
                    .as_ref()
                    .map(|p| p.to_string_lossy().into_owned()),
                read_only: layer.scope == SettingsScope::Managed,
            };
            for stored in &layer.document.permissions.rules {
                match parse_stored_rule(stored, layer.scope, source.clone()) {
                    Ok(rule) => rules.push(rule),
                    Err(err) => {
                        tracing::warn!(
                            ?err,
                            rule_id = %stored.id,
                            "skipping unparseable permission rule when building snapshot"
                        );
                    }
                }
            }
        }
        Ok(PermissionPolicySnapshot { revision, rules })
    }
}