//! Integration tests for the permission commands: broadcast-after-write timing
//! and the explanation chain shape. Uses a real `SettingsService` against a temp
//! dir + `MemorySecretStore`, and an `AgentRuntimeManager::new_for_test()` that
//! records `send_to_runtime` calls instead of writing to a real stdin.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::policy::{BashMode, ChainStatus, PermissionMatcher};
use crate::runtime::AgentRuntimeManager;
use crate::settings::{
    MemorySecretStore, PermissionEffect, PermissionSection, SettingsDocument, SettingsPaths,
    SettingsScope, SettingsService, StoredPermissionRule,
};

use super::{
    create_permission_rule_impl, explain_permission_decision_impl, PermissionExplanationRequest,
    PermissionRuleDraft,
};

fn make_service(root: &std::path::Path) -> Arc<SettingsService> {
    let secrets = Arc::new(MemorySecretStore::default());
    let service = SettingsService::new(SettingsPaths::for_test(root.to_path_buf()), secrets);
    service.initialize_blocking().unwrap();
    Arc::new(service)
}

/// Write a managed rule directly to the managed document file. The managed
/// scope is read-only via `mutate_scope_blocking`, so tests bypass the service
/// write path and seed the file — `effective_document_blocking` re-reads it
/// from disk on the next snapshot build.
fn write_managed_rule(service: &SettingsService, rule: StoredPermissionRule) {
    let path = service.paths().managed().to_path_buf();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut doc = SettingsDocument::default();
    doc.permissions = PermissionSection { rules: vec![rule] };
    let value = serde_json::to_value(&doc).unwrap();
    std::fs::write(&path, serde_json::to_string_pretty(&value).unwrap()).unwrap();
}

fn draft_allow_bash_prefix(prefix: &str) -> PermissionRuleDraft {
    PermissionRuleDraft {
        effect: PermissionEffect::Allow,
        tool: "Bash".to_string(),
        matcher: PermissionMatcher::Bash {
            mode: BashMode::Prefix,
            value: Some(prefix.to_string()),
        },
    }
}

#[tokio::test]
async fn save_broadcasts_only_after_atomic_store_success() {
    let root = std::env::temp_dir().join(format!("aide-perm-broadcast-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let project = root.join("repo");
    std::fs::create_dir_all(&project).unwrap();

    let service = make_service(&root);
    let runtime = AgentRuntimeManager::new_for_test();

    runtime.register_session_route("s-1", Some(&project));
    create_permission_rule_impl(
        service.clone(),
        &runtime,
        SettingsScope::Project,
        draft_allow_bash_prefix("pnpm test"),
        Some(project.clone()),
    )
    .await
    .unwrap();
    assert!(
        runtime
            .sent_commands()
            .iter()
            .any(|c| c["cmd"] == "update_permission_policy"),
        "successful write must broadcast update_permission_policy"
    );

    runtime.clear_sent_commands();
    service.fail_next_persist_for_test();
    let result = create_permission_rule_impl(
        service.clone(),
        &runtime,
        SettingsScope::Project,
        draft_allow_bash_prefix("pnpm lint"),
        Some(project.clone()),
    )
    .await;
    assert!(
        result.is_err(),
        "injected persist failure must surface as an error"
    );
    assert!(
        runtime.sent_commands().is_empty(),
        "failed write must NOT broadcast any policy update"
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn broadcast_only_reaches_sessions_matching_affected_root() {
    let root =
        std::env::temp_dir().join(format!("aide-perm-broadcast-scope-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let project_a = root.join("repo-a");
    let project_b = root.join("repo-b");
    std::fs::create_dir_all(&project_a).unwrap();
    std::fs::create_dir_all(&project_b).unwrap();

    let service = make_service(&root);
    let runtime = AgentRuntimeManager::new_for_test();
    runtime.register_session_route("in-a", Some(&project_a));
    runtime.register_session_route("in-b", Some(&project_b));

    // Project-scope write at repo-a must only reach in-a.
    create_permission_rule_impl(
        service.clone(),
        &runtime,
        SettingsScope::Project,
        draft_allow_bash_prefix("pnpm test"),
        Some(project_a.clone()),
    )
    .await
    .unwrap();

    let updates: Vec<(String, Option<Value>)> = runtime
        .sent_commands()
        .iter()
        .filter(|c| c["cmd"] == "update_permission_policy")
        .map(|c| {
            (
                c["session_id"].as_str().unwrap_or("").to_string(),
                c.get("policy").cloned(),
            )
        })
        .collect();
    assert_eq!(
        updates.len(),
        1,
        "only the matching session must be notified"
    );
    assert_eq!(updates[0].0, "in-a");

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn user_scope_change_broadcasts_to_all_sessions() {
    let root =
        std::env::temp_dir().join(format!("aide-perm-broadcast-user-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let project_a = root.join("repo-a");
    let project_b = root.join("repo-b");
    std::fs::create_dir_all(&project_a).unwrap();
    std::fs::create_dir_all(&project_b).unwrap();

    let service = make_service(&root);
    let runtime = AgentRuntimeManager::new_for_test();
    runtime.register_session_route("in-a", Some(&project_a));
    runtime.register_session_route("in-b", Some(&project_b));

    // User-scope write has no project root and must reach every session.
    create_permission_rule_impl(
        service.clone(),
        &runtime,
        SettingsScope::User,
        draft_allow_bash_prefix("pnpm test"),
        None,
    )
    .await
    .unwrap();

    let sids: Vec<String> = runtime
        .sent_commands()
        .iter()
        .filter(|c| c["cmd"] == "update_permission_policy")
        .map(|c| c["session_id"].as_str().unwrap_or("").to_string())
        .collect();
    assert!(sids.contains(&"in-a".to_string()));
    assert!(sids.contains(&"in-b".to_string()));

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn explanation_shows_managed_deny_and_shadowed_local_allow() {
    let root = std::env::temp_dir().join(format!("aide-perm-explain-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let project = root.join("proj");
    std::fs::create_dir_all(&project).unwrap();

    let service = make_service(&root);

    write_managed_rule(
        &service,
        StoredPermissionRule {
            id: "11111111-1111-1111-1111-111111111111".to_string(),
            effect: PermissionEffect::Deny,
            tool: "Bash".to_string(),
            matcher: json!({"kind":"bash","mode":"prefix","value":"rm"}),
            order: 0,
        },
    );
    service
        .mutate_scope_blocking(SettingsScope::Local, Some(&project), |doc| {
            doc.permissions.rules.push(StoredPermissionRule {
                id: "22222222-2222-2222-2222-222222222222".to_string(),
                effect: PermissionEffect::Allow,
                tool: "Bash".to_string(),
                matcher: json!({"kind":"bash","mode":"prefix","value":"rm -rf build"}),
                order: 0,
            });
            Ok(())
        })
        .unwrap();

    let mut input = Map::new();
    input.insert("command".to_string(), json!("rm -rf build"));
    let invocation = PermissionExplanationRequest {
        tool: "Bash".to_string(),
        input,
    };
    let view = explain_permission_decision_impl(&service, &invocation, Some(&project)).unwrap();
    assert_eq!(view.final_decision, "deny");
    assert!(
        view.chain
            .iter()
            .any(|line| line.status == ChainStatus::OverriddenByDeny),
        "local allow must be recorded as overridden_by_deny: {:?}",
        view.chain
    );
    assert!(view.winner.is_some());
    assert_eq!(
        view.winner.as_ref().unwrap().id,
        "11111111-1111-1111-1111-111111111111"
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn explanation_defers_when_no_rule_matches() {
    let root = std::env::temp_dir().join(format!("aide-perm-defer-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let service = make_service(&root);

    let mut input = Map::new();
    input.insert("command".to_string(), json!("pnpm test"));
    let invocation = PermissionExplanationRequest {
        tool: "Bash".to_string(),
        input,
    };
    let view = explain_permission_decision_impl(&service, &invocation, None).unwrap();
    assert_eq!(view.final_decision, "defer");
    assert!(view.winner.is_none());
    assert!(view.chain.is_empty());
    let _ = std::fs::remove_dir_all(&root);
}
