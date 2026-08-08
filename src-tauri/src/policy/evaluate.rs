//! Policy evaluation: per-scope winner selection, deny override, and the
//! explanation chain. Provider-agnostic — the only Claude-specific behavior
//! (canUseTool mapping, AskUserQuestion reshaping) lives in the agent sidecar.

use crate::settings::{PermissionEffect, SettingsScope, StoredPermissionRule};

use super::matchers::{has_unquoted_shell_control, matcher_matches, specificity, split_bash_segments};
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

/// Winner ordering shared by composite evaluation: highest-priority scope,
/// then specificity DESC, then order ASC. Must stay identical to the
/// TypeScript mirror in agent-sidecar/src/policy/evaluate.ts.
fn compare_by_priority(a: &PermissionRule, b: &PermissionRule) -> std::cmp::Ordering {
    scope_rank(a.scope)
        .cmp(&scope_rank(b.scope))
        .then(specificity(&b.matcher).cmp(&specificity(&a.matcher)))
        .then(a.order.cmp(&b.order))
}

fn scope_rank(scope: SettingsScope) -> usize {
    SCOPE_PRIORITY.iter().position(|&s| s == scope).unwrap_or(usize::MAX)
}

/// Evaluate `invocation` against `snapshot`. The decision is `defer` when no
/// rule matches, leaving the caller to fall back to the provider's existing
/// permission mode. Filesystem access happens only for path-folder matchers
/// (symlink safety); Bash/field/tool matchers are pure.
///
/// Chained Bash commands (`a | b`, `a && b`, …) take the composite path: the
/// command is split into verifiable segments (see `split_bash_segments`) and
/// every segment must independently match an allow rule — a prefix allow never
/// silently widens across a separator into an unvetted command. deny/ask rules
/// are checked against the raw command AND each segment, so a `deny rm -rf`
/// still fires on `echo hi | rm -rf /`. Commands the analyzer cannot verify
/// (file redirects, `$(…)`, backticks, unbalanced quotes) fall through to the
/// classic path where the allow shell-gate blocks them.
pub fn evaluate(snapshot: &PermissionPolicySnapshot, invocation: &ToolInvocation) -> PolicyDecision {
    if invocation.tool == "Bash" {
        if let Some(command) = invocation.input.get("command").and_then(|v| v.as_str()) {
            if !command.is_empty() && has_unquoted_shell_control(command) {
                if let Some(segments) = split_bash_segments(command) {
                    return evaluate_bash_composite(snapshot, invocation, &segments);
                }
            }
        }
    }

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

// ---------------------------------------------------------------------------
// Chained Bash command evaluation
// ---------------------------------------------------------------------------

/// Composite evaluation for a chained Bash command already split into
/// verifiable segments by `split_bash_segments`. Mirror of the TypeScript
/// `evaluateBashComposite` — decision semantics and winner ordering must stay
/// identical (locked by the shared JSON fixture).
fn evaluate_bash_composite(
    snapshot: &PermissionPolicySnapshot,
    invocation: &ToolInvocation,
    segments: &[String],
) -> PolicyDecision {
    let cwd = invocation.cwd.as_deref();
    let rules: Vec<&PermissionRule> = snapshot
        .rules
        .iter()
        .filter(|r| r.tool == "Bash")
        .collect();
    let segment_inputs: Vec<serde_json::Map<String, serde_json::Value>> = segments
        .iter()
        .map(|s| {
            let mut m = invocation.input.clone();
            m.insert("command".to_string(), serde_json::Value::String(s.clone()));
            m
        })
        .collect();

    // Highest-priority rule with `effect` matching ANY candidate input (raw
    // command first, then segments in order). deny/ask only.
    let best_match = |effect: PermissionEffect| -> Option<(&PermissionRule, usize)> {
        for &scope in &SCOPE_PRIORITY {
            // index 0 = raw invocation input; 1.. = segments
            for idx in 0..=segment_inputs.len() {
                let candidate: &serde_json::Map<String, serde_json::Value> = if idx == 0 {
                    &invocation.input
                } else {
                    &segment_inputs[idx - 1]
                };
                let mut matched: Vec<&PermissionRule> = rules
                    .iter()
                    .filter(|r| r.scope == scope && r.effect == effect)
                    .filter(|r| matcher_matches(&r.matcher, candidate, cwd, effect))
                    .copied()
                    .collect();
                if !matched.is_empty() {
                    matched.sort_by(|a, b| compare_by_priority(a, b));
                    return Some((matched[0], idx));
                }
            }
        }
        None
    };

    let segment_note = |idx: usize| -> String {
        if idx == 0 {
            String::new()
        } else {
            format!(
                " — matched segment {:?} of the chained command",
                segments[idx - 1]
            )
        }
    };

    if let Some((deny, idx)) = best_match(PermissionEffect::Deny) {
        return PolicyDecision {
            disposition: PolicyDisposition::Deny,
            winner: Some(deny.clone()),
            chain: vec![composite_chain_entry(deny, ChainStatus::Selected)],
            reason: format!("{}{}", summarize_rule(deny), segment_note(idx)),
        };
    }

    if let Some((ask, idx)) = best_match(PermissionEffect::Ask) {
        return PolicyDecision {
            disposition: PolicyDisposition::Ask,
            winner: Some(ask.clone()),
            chain: vec![composite_chain_entry(ask, ChainStatus::Selected)],
            reason: format!("{}{}", summarize_rule(ask), segment_note(idx)),
        };
    }

    // Allow: EVERY segment must match at least one allow rule. Per-segment
    // winners are all marked selected — each one vouches for its segment.
    let mut per_segment_winners: Vec<&PermissionRule> = Vec::new();
    for (idx, candidate) in segment_inputs.iter().enumerate() {
        let mut matched: Vec<&PermissionRule> = rules
            .iter()
            .filter(|r| r.effect == PermissionEffect::Allow)
            .filter(|r| matcher_matches(&r.matcher, candidate, cwd, PermissionEffect::Allow))
            .copied()
            .collect();
        if matched.is_empty() {
            return PolicyDecision {
                disposition: PolicyDisposition::Defer,
                winner: None,
                chain: Vec::new(),
                reason: format!(
                    "segment {}/{} {:?} of the chained command matched no allow rule; deferring to provider permission mode",
                    idx + 1,
                    segments.len(),
                    segments[idx]
                ),
            };
        }
        matched.sort_by(|a, b| compare_by_priority(a, b));
        per_segment_winners.push(matched[0]);
    }

    let mut sorted = per_segment_winners.clone();
    sorted.sort_by(|a, b| compare_by_priority(a, b));
    let winner = sorted[0];
    // Dedupe by rule id — one rule may vouch for several segments.
    let mut seen_ids = std::collections::HashSet::new();
    let chain: Vec<ChainEntry> = per_segment_winners
        .iter()
        .filter(|r| seen_ids.insert(r.id.clone()))
        .map(|r| composite_chain_entry(r, ChainStatus::Selected))
        .collect();
    let suffix = if segments.len() > 1 {
        format!(
            " — all {} segments of the chained command matched allow rules",
            segments.len()
        )
    } else {
        String::new()
    };
    PolicyDecision {
        disposition: PolicyDisposition::Allow,
        winner: Some(winner.clone()),
        chain,
        reason: format!("{}{}", summarize_rule(winner), suffix),
    }
}

fn composite_chain_entry(rule: &PermissionRule, status: ChainStatus) -> ChainEntry {
    ChainEntry {
        rule_id: rule.id.clone(),
        scope: rule.scope,
        matched: true,
        specificity: specificity(&rule.matcher),
        status,
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