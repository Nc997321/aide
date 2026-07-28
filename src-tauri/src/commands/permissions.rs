//! Provider-agnostic permission CRUD + decision-explanation Tauri commands.
//!
//! These are thin async boundaries: every disk/keychain/serialization action
//! runs under `spawn_blocking` against a cloned `Arc<SettingsService>`. No
//! `State` reference crosses a blocking closure. After a successful atomic
//! write the new snapshot is broadcast to affected live sessions via the
//! existing runtime stdin channel (`update_permission_policy`); a failed write
//! never broadcasts. No Claude/Anthropic permission-mode semantics live here —
//! only `allow | ask | deny`, tool name, and an explainable matcher.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::State;

use crate::commands::WorkspaceState;
use crate::policy::{
    self, ChainEntry, PermissionMatcher, PermissionRule, PermissionSource,
    ToolInvocation,
};
use crate::runtime::AgentRuntimeManager;
use crate::settings::{PermissionEffect, SettingsError, SettingsScope, SettingsService, StoredPermissionRule};

// ---- DTOs ----

/// New-rule payload from the UI. The backend assigns `id`, `order`, `scope`
/// (from the target document) and `source` (from the layer the rule lands in).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRuleDraft {
    pub effect: PermissionEffect,
    pub tool: String,
    pub matcher: PermissionMatcher,
}

/// One scope's availability for the permissions UI: whether it's editable, why
/// not, where it's stored, and a short human note.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScopeAvailability {
    pub scope: SettingsScope,
    pub editable: bool,
    /// Why the scope is not editable (empty when editable).
    pub reason: String,
    pub storage_path: Option<String>,
    /// Scope-specific note (e.g. local: "仅本机，不建议提交").
    pub description: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PermissionSettingsView {
    pub revision: u64,
    pub scopes: Vec<ScopeAvailability>,
    pub rules: Vec<PermissionRule>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PermissionExplanationRequest {
    pub tool: String,
    pub input: Map<String, Value>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PermissionExplanationView {
    pub final_decision: String,
    pub winner: Option<PermissionRule>,
    pub chain: Vec<ChainEntry>,
    pub reason: String,
}

// ---- helpers ----

/// Read the active project root from the workspace state. Returns None when no
/// workspace is open or the path no longer exists — project/local scopes are
/// then reported unavailable ("尚未打开项目").
fn current_project_root(workspace: &WorkspaceState) -> Option<PathBuf> {
    workspace
        .path
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().filter(|p| p.exists()).cloned())
}

/// Generate a UUID-v4-shaped id without pulling in a uuid dependency. Uniqueness
/// comes from wall-clock nanos XOR'd with pid and a per-process counter; the v4
/// version nibble is set so the result looks like a real UUID. `is_uuid` only
/// checks shape (36 chars, dashes, hex), which this always satisfies.
fn generate_rule_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u128)
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    let mix = nanos ^ (pid << 17) ^ (seq as u128).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let hi = (mix >> 64) as u64;
    let lo = mix as u64;
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (hi >> 32) as u32,
        (hi >> 16) as u16 & 0xFFFF,
        (hi & 0xFFF) as u16,
        (lo >> 48) as u16 & 0xFFFF,
        lo & 0xFFFF_FFFF_FFFF,
    )
}

/// Validate the draft's semantic constraints (empty tool, empty matcher values,
/// bash-contains-allow) before touching disk. Scope/field "unknown" cases are
/// rejected at deserialization time by the typed enums.
fn validate_draft(scope: SettingsScope, draft: &PermissionRuleDraft) -> Result<(), String> {
    let probe = PermissionRule {
        id: "probe".to_string(),
        scope,
        order: 0,
        effect: draft.effect,
        tool: draft.tool.clone(),
        matcher: draft.matcher.clone(),
        source: PermissionSource::default(),
    };
    policy::validate_rule(&probe).map_err(|e| e.to_string())
}

fn build_scope_availabilities(
    service: &SettingsService,
    project: Option<&Path>,
) -> Vec<ScopeAvailability> {
    let paths = service.paths();
    // Fixed tab order: 用户全局 / 项目共享 / 项目本地 / 受管策略.
    let user = ScopeAvailability {
        scope: SettingsScope::User,
        editable: true,
        reason: String::new(),
        storage_path: Some(paths.user().to_string_lossy().into_owned()),
        description: "对所有工作区生效".to_string(),
    };
    let (proj_editable, proj_reason, proj_path) = match project {
        None => (false, "尚未打开项目".to_string(), None),
        Some(root) => {
            let path = paths.project_shared(Some(root));
            (
                true,
                String::new(),
                path.map(|p| p.to_string_lossy().into_owned()),
            )
        }
    };
    let project_scope = ScopeAvailability {
        scope: SettingsScope::Project,
        editable: proj_editable,
        reason: proj_reason,
        storage_path: proj_path,
        description: "适合提交到 Git 与团队共享".to_string(),
    };
    let (local_editable, local_reason, local_path) = match project {
        None => (false, "尚未打开项目".to_string(), None),
        Some(root) => {
            let path = paths.project_local(Some(root));
            (
                true,
                String::new(),
                path.map(|p| p.to_string_lossy().into_owned()),
            )
        }
    };
    let local = ScopeAvailability {
        scope: SettingsScope::Local,
        editable: local_editable,
        reason: local_reason,
        storage_path: local_path,
        description: "仅本机生效，不建议提交".to_string(),
    };
    let managed = ScopeAvailability {
        scope: SettingsScope::Managed,
        editable: false,
        reason: "受管策略只读".to_string(),
        storage_path: Some(paths.managed().to_string_lossy().into_owned()),
        description: "由管理员配置，拒绝规则始终优先".to_string(),
    };
    vec![user, project_scope, local, managed]
}

fn build_permission_settings_view(
    service: &SettingsService,
    project: Option<&Path>,
) -> Result<PermissionSettingsView, String> {
    let snapshot = service.permission_snapshot_blocking(project).map_err(|e| e.to_string())?;
    let scopes = build_scope_availabilities(service, project);
    Ok(PermissionSettingsView {
        revision: snapshot.revision,
        scopes,
        rules: snapshot.rules,
    })
}

// ---- impl functions (testable; called by the Tauri command wrappers) ----

pub async fn create_permission_rule_impl(
    service: Arc<SettingsService>,
    runtime: &AgentRuntimeManager,
    scope: SettingsScope,
    draft: PermissionRuleDraft,
    project: Option<PathBuf>,
) -> Result<PermissionSettingsView, String> {
    validate_draft(scope, &draft)?;

    let svc = service.clone();
    let project_for_write = project.clone();
    let write_scope = scope;
    let write_result = tokio::task::spawn_blocking(move || {
        svc.mutate_scope_blocking(write_scope, project_for_write.as_deref(), |doc| {
            let next_order = doc
                .permissions
                .rules
                .iter()
                .map(|r| r.order)
                .max()
                .unwrap_or(-1)
                .saturating_add(1);
            let stored = StoredPermissionRule {
                id: generate_rule_id(),
                effect: draft.effect,
                tool: draft.tool,
                matcher: serde_json::to_value(&draft.matcher)
                    .map_err(|e| SettingsError::Storage(e.to_string()))?,
                order: next_order,
            };
            doc.permissions.rules.push(stored);
            Ok(())
        })
    })
    .await
    .map_err(|e| e.to_string())?;
    write_result.map_err(|e| e.to_string())?;

    // Broadcast only after a successful atomic store.
    runtime
        .broadcast_policy_change(scope, project.as_deref(), service.as_ref())
        .await;

    let svc = service.clone();
    let p = project.clone();
    tokio::task::spawn_blocking(move || build_permission_settings_view(&svc, p.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

pub async fn update_permission_rule_impl(
    service: Arc<SettingsService>,
    runtime: &AgentRuntimeManager,
    scope: SettingsScope,
    id: String,
    draft: PermissionRuleDraft,
    project: Option<PathBuf>,
) -> Result<PermissionSettingsView, String> {
    validate_draft(scope, &draft)?;

    let svc = service.clone();
    let project_for_write = project.clone();
    let write_scope = scope;
    let write_result = tokio::task::spawn_blocking(move || {
        svc.mutate_scope_blocking(write_scope, project_for_write.as_deref(), |doc| {
            let rule = doc
                .permissions
                .rules
                .iter_mut()
                .find(|r| r.id == id)
                .ok_or_else(|| SettingsError::Validation(format!("permission rule not found: {id}")))?;
            rule.effect = draft.effect;
            rule.tool = draft.tool;
            rule.matcher = serde_json::to_value(&draft.matcher)
                .map_err(|e| SettingsError::Storage(e.to_string()))?;
            Ok(())
        })
    })
    .await
    .map_err(|e| e.to_string())?;
    write_result.map_err(|e| e.to_string())?;

    runtime
        .broadcast_policy_change(scope, project.as_deref(), service.as_ref())
        .await;

    let svc = service.clone();
    let p = project.clone();
    tokio::task::spawn_blocking(move || build_permission_settings_view(&svc, p.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

pub async fn delete_permission_rule_impl(
    service: Arc<SettingsService>,
    runtime: &AgentRuntimeManager,
    scope: SettingsScope,
    id: String,
    project: Option<PathBuf>,
) -> Result<PermissionSettingsView, String> {
    let svc = service.clone();
    let project_for_write = project.clone();
    let write_scope = scope;
    let write_result = tokio::task::spawn_blocking(move || {
        svc.mutate_scope_blocking(write_scope, project_for_write.as_deref(), |doc| {
            let before = doc.permissions.rules.len();
            doc.permissions.rules.retain(|r| r.id != id);
            if doc.permissions.rules.len() == before {
                return Err(SettingsError::Validation(format!(
                    "permission rule not found: {id}"
                )));
            }
            Ok(())
        })
    })
    .await
    .map_err(|e| e.to_string())?;
    write_result.map_err(|e| e.to_string())?;

    runtime
        .broadcast_policy_change(scope, project.as_deref(), service.as_ref())
        .await;

    let svc = service.clone();
    let p = project.clone();
    tokio::task::spawn_blocking(move || build_permission_settings_view(&svc, p.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

pub fn explain_permission_decision_impl(
    service: &SettingsService,
    invocation: &PermissionExplanationRequest,
    project: Option<&Path>,
) -> Result<PermissionExplanationView, String> {
    let snapshot = service
        .permission_snapshot_blocking(project)
        .map_err(|e| e.to_string())?;
    let tool_invocation = ToolInvocation {
        tool: invocation.tool.clone(),
        input: invocation.input.clone(),
        cwd: None,
    };
    let decision = policy::evaluate(&snapshot, &tool_invocation);
    Ok(PermissionExplanationView {
        final_decision: decision.disposition.as_str().to_string(),
        winner: decision.winner,
        chain: decision.chain,
        reason: decision.reason,
    })
}

// ---- Tauri command wrappers ----

#[tauri::command]
pub async fn get_permission_settings(
    settings: State<'_, Arc<SettingsService>>,
    workspace: State<'_, WorkspaceState>,
) -> Result<PermissionSettingsView, String> {
    let service = settings.inner().clone();
    let project = current_project_root(&workspace);
    tokio::task::spawn_blocking(move || build_permission_settings_view(&service, project.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn create_permission_rule(
    scope: SettingsScope,
    rule: PermissionRuleDraft,
    settings: State<'_, Arc<SettingsService>>,
    runtime: State<'_, AgentRuntimeManager>,
    workspace: State<'_, WorkspaceState>,
) -> Result<PermissionSettingsView, String> {
    let service = settings.inner().clone();
    let project = current_project_root(&workspace);
    create_permission_rule_impl(service, runtime.inner(), scope, rule, project).await
}

#[tauri::command]
pub async fn update_permission_rule(
    scope: SettingsScope,
    id: String,
    rule: PermissionRuleDraft,
    settings: State<'_, Arc<SettingsService>>,
    runtime: State<'_, AgentRuntimeManager>,
    workspace: State<'_, WorkspaceState>,
) -> Result<PermissionSettingsView, String> {
    let service = settings.inner().clone();
    let project = current_project_root(&workspace);
    update_permission_rule_impl(service, runtime.inner(), scope, id, rule, project).await
}

#[tauri::command]
pub async fn delete_permission_rule(
    scope: SettingsScope,
    id: String,
    settings: State<'_, Arc<SettingsService>>,
    runtime: State<'_, AgentRuntimeManager>,
    workspace: State<'_, WorkspaceState>,
) -> Result<PermissionSettingsView, String> {
    let service = settings.inner().clone();
    let project = current_project_root(&workspace);
    delete_permission_rule_impl(service, runtime.inner(), scope, id, project).await
}

#[tauri::command]
pub async fn explain_permission_decision(
    invocation: PermissionExplanationRequest,
    settings: State<'_, Arc<SettingsService>>,
    workspace: State<'_, WorkspaceState>,
) -> Result<PermissionExplanationView, String> {
    let service = settings.inner().clone();
    let project = current_project_root(&workspace);
    tokio::task::spawn_blocking(move || {
        explain_permission_decision_impl(&service, &invocation, project.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_rule_id_is_uuid_shaped() {
        let id = generate_rule_id();
        assert_eq!(id.len(), 36, "must be 36 chars: {id}");
        let bytes = id.as_bytes();
        for &i in &[8, 13, 18, 23] {
            assert_eq!(bytes[i], b'-', "dash at {i} in {id}");
        }
        for (i, &b) in bytes.iter().enumerate() {
            if [8, 13, 18, 23].contains(&i) {
                continue;
            }
            assert!(b.is_ascii_hexdigit(), "hex digit at {i} in {id}");
        }
        // version nibble
        assert_eq!(bytes[14], b'4', "v4 version nibble in {id}");
    }

    #[test]
    fn generated_rule_ids_are_unique() {
        let a = generate_rule_id();
        let b = generate_rule_id();
        assert_ne!(a, b);
    }

    #[test]
    fn validate_draft_rejects_bash_contains_allow() {
        let draft = PermissionRuleDraft {
            effect: PermissionEffect::Allow,
            tool: "Bash".into(),
            matcher: PermissionMatcher::Bash {
                mode: policy::BashMode::Contains,
                value: Some("rm".into()),
            },
        };
        assert!(validate_draft(SettingsScope::User, &draft).is_err());
    }

    #[test]
    fn validate_draft_accepts_bash_prefix_allow() {
        let draft = PermissionRuleDraft {
            effect: PermissionEffect::Allow,
            tool: "Bash".into(),
            matcher: PermissionMatcher::Bash {
                mode: policy::BashMode::Prefix,
                value: Some("pnpm test".into()),
            },
        };
        assert!(validate_draft(SettingsScope::User, &draft).is_ok());
    }
}

#[cfg(test)]
mod permissions_test;