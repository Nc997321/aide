use std::sync::Arc;

use serde_json::{json, Value};

use super::{
    MemorySecretStore, SecretStore, SettingsError, SettingsPaths, SettingsScope, SettingsService,
};

struct TestStore {
    paths: SettingsPaths,
    secrets: Arc<MemorySecretStore>,
    service: SettingsService,
}

impl TestStore {
    fn new() -> Self {
        let root = temp_root();
        let paths = SettingsPaths::for_test(root);
        let secrets = Arc::new(MemorySecretStore::default());
        let service = SettingsService::new(paths.clone(), secrets.clone());
        service.initialize_blocking().unwrap();
        Self {
            paths,
            secrets,
            service,
        }
    }

    fn with_legacy_config(config: Value) -> Self {
        let root = temp_root();
        let paths = SettingsPaths::for_test(root);
        std::fs::create_dir_all(paths.legacy_config().parent().unwrap()).unwrap();
        std::fs::write(
            paths.legacy_config(),
            serde_json::to_string_pretty(&config).unwrap(),
        )
        .unwrap();
        let secrets = Arc::new(MemorySecretStore::default());
        let service = SettingsService::new(paths.clone(), secrets.clone());
        Self {
            paths,
            secrets,
            service,
        }
    }

    fn service(&self) -> &SettingsService {
        &self.service
    }

    fn write_document(&self, path: &std::path::Path, value: Value) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_string_pretty(&value).unwrap()).unwrap();
    }

    fn write_user(&self, value: Value) {
        self.write_document(self.paths.user(), value);
        self.service.initialize_blocking().unwrap();
    }

    fn read_user(&self) -> Value {
        self.read_json(self.paths.user())
    }

    fn read_json(&self, path: &std::path::Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn fail_next_persist(&self) {
        self.service.fail_next_persist_for_test();
    }
}

fn temp_root() -> std::path::PathBuf {
    let unique = format!(
        "aide-settings-store-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    std::env::temp_dir().join(unique)
}

fn document(values: Value) -> Value {
    json!({"schemaVersion": 1, "values": values, "permissions": {"rules": []}})
}

#[test]
fn failed_atomic_write_keeps_previous_document_and_cached_snapshot() {
    let fixture = TestStore::new();
    fixture.write_user(document(json!({"settings": {"theme": "warm-dark"}})));
    fixture.fail_next_persist();
    assert!(fixture
        .service()
        .mutate_scope_blocking(SettingsScope::User, None, |doc| {
            doc.values
                .insert("settings".into(), json!({"theme": "glass"}));
            Ok(())
        })
        .is_err());
    assert_eq!(
        fixture.read_user()["values"]["settings"]["theme"],
        "warm-dark"
    );
    assert_eq!(fixture.service().cached_theme(), "warm-dark");
}

#[test]
fn project_paths_use_the_exact_aide_directory_layout() {
    let fixture = TestStore::new();
    let root = temp_root();
    assert_eq!(
        fixture.paths.project_shared(Some(&root)).unwrap(),
        root.join(".aide").join("settings.json")
    );
    assert_eq!(
        fixture.paths.project_local(Some(&root)).unwrap(),
        root.join(".aide").join("settings.local.json")
    );
    assert_eq!(fixture.paths.project_shared(None), None);
    assert_eq!(fixture.paths.project_local(None), None);
}

#[test]
fn first_project_and_local_mutations_create_the_aide_directory() {
    let fixture = TestStore::new();
    let project = temp_root();
    let local_project = temp_root();

    let project_result = fixture
        .service()
        .mutate_scope_blocking(SettingsScope::Project, Some(&project), |doc| {
            doc.values
                .insert("settings".into(), json!({"theme": "project"}));
            Ok(())
        })
        .unwrap();
    let local_result = fixture
        .service()
        .mutate_scope_blocking(SettingsScope::Local, Some(&local_project), |doc| {
            doc.values
                .insert("settings".into(), json!({"theme": "local"}));
            Ok(())
        })
        .unwrap();

    assert_eq!(
        project_result.path,
        project.join(".aide").join("settings.json")
    );
    assert_eq!(
        local_result.path,
        local_project.join(".aide").join("settings.local.json")
    );
    assert!(project_result.path.is_file());
    assert!(local_result.path.is_file());
    assert_eq!(fixture.read_json(&project_result.path)["schemaVersion"], 1);
    assert_eq!(fixture.read_json(&local_result.path)["schemaVersion"], 1);
    assert!(!project.join(".gitignore").exists());
    assert!(!local_project.join(".gitignore").exists());
}

#[test]
fn cleaned_project_preflight_does_not_create_real_target_before_atomic_write() {
    let fixture = TestStore::new();
    let project = temp_root();
    let target = project.join(".aide").join("settings.json");

    fixture.fail_next_persist();
    assert!(fixture
        .service()
        .mutate_scope_blocking(SettingsScope::Project, Some(&project), |doc| {
            doc.values
                .insert("settings".into(), json!({"theme": "project"}));
            Ok(())
        })
        .is_err());
    assert!(!target.exists());

    fixture
        .service()
        .mutate_scope_blocking(SettingsScope::Project, Some(&project), |doc| {
            doc.values
                .insert("settings".into(), json!({"theme": "project"}));
            Ok(())
        })
        .unwrap();
    assert_eq!(fixture.read_json(&target)["schemaVersion"], 1);
    assert_eq!(
        fixture.read_json(&target)["values"]["settings"]["theme"],
        "project"
    );
    assert!(!project.join(".gitignore").exists());
}

#[test]
fn project_preflight_parent_failure_maps_scope_not_writable_without_target_or_gitignore() {
    let fixture = TestStore::new();
    let project = temp_root();
    let aide_path = project.join(".aide");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(&aide_path, "not a directory").unwrap();
    let target = aide_path.join("settings.json");

    let error = fixture
        .service()
        .mutate_scope_blocking(SettingsScope::Project, Some(&project), |doc| {
            doc.values
                .insert("settings".into(), json!({"theme": "project"}));
            Ok(())
        })
        .unwrap_err();
    assert_eq!(
        error,
        SettingsError::ScopeNotWritable {
            scope: SettingsScope::Project,
            path: target.clone()
        }
    );
    assert!(!target.exists());
    assert!(!project.join(".gitignore").exists());
}

#[test]
fn managed_layer_is_loaded_before_user_project_and_local_layers() {
    let fixture = TestStore::new();
    let project = temp_root();
    fixture.write_document(
        fixture.paths.managed(),
        document(json!({"settings": {"theme": "managed"}, "managedOnly": true})),
    );
    fixture.write_user(document(json!({"settings": {"theme": "user"}})));
    fixture.write_document(
        &fixture.paths.project_shared(Some(&project)).unwrap(),
        document(json!({"settings": {"theme": "project"}})),
    );
    fixture.write_document(
        &fixture.paths.project_local(Some(&project)).unwrap(),
        document(json!({"settings": {"theme": "local"}})),
    );

    let effective = fixture
        .service()
        .effective_document_blocking(Some(&project))
        .unwrap();
    assert_eq!(effective.values["settings"]["theme"], "local");
    assert_eq!(effective.values["managedOnly"], true);
    assert_eq!(
        effective
            .documents
            .iter()
            .map(|layer| layer.scope)
            .collect::<Vec<_>>(),
        vec![
            SettingsScope::Managed,
            SettingsScope::User,
            SettingsScope::Project,
            SettingsScope::Local
        ]
    );
}

#[test]
fn migration_moves_secret_and_never_keeps_it_in_settings_json() {
    let fixture = TestStore::with_legacy_config(json!({
        "settings": {"codegraphEmbedder": {"apiKey": "cg-secret"}},
        "providers": [{"id": "p1", "apiKey": "provider-secret", "authToken": "token"}]
    }));
    fixture.service().initialize_blocking().unwrap();
    let text = std::fs::read_to_string(fixture.paths.user()).unwrap();
    assert!(
        !text.contains("cg-secret") && !text.contains("provider-secret") && !text.contains("token")
    );
    assert_eq!(
        fixture
            .secrets
            .get("codegraph/default/apiKey")
            .unwrap()
            .as_deref(),
        Some("cg-secret")
    );
    assert!(!fixture.paths.legacy_config().exists());
    assert!(fixture.paths.legacy_backup().exists());
}

#[test]
fn invalid_legacy_document_does_not_persist_collected_secrets() {
    let fixture = TestStore::with_legacy_config(json!({
        "settings": {
            "theme": 42,
            "codegraphEmbedder": {"apiKey": "cg-secret"}
        }
    }));

    assert!(fixture.service().initialize_blocking().is_err());
    assert_eq!(
        fixture
            .secrets
            .get("codegraph/default/apiKey")
            .unwrap()
            .as_deref(),
        None
    );
    assert!(!fixture.paths.user().exists());
}

#[test]
fn migration_is_idempotent_and_does_not_read_legacy_after_new_document_exists() {
    let fixture = TestStore::with_legacy_config(json!({"settings": {"theme": "glass"}}));
    fixture.service().initialize_blocking().unwrap();
    std::fs::write(
        fixture.paths.legacy_config(),
        r#"{"settings":{"theme":"bad"}}"#,
    )
    .unwrap();
    fixture.service().initialize_blocking().unwrap();
    assert_eq!(fixture.service().cached_theme(), "glass");
}

#[test]
fn migration_cleanup_is_non_fatal_and_retries_after_a_new_document_exists() {
    let fixture = TestStore::new();
    fixture.write_user(document(json!({"settings": {"theme": "glass"}})));
    std::fs::create_dir_all(fixture.paths.legacy_config()).unwrap();

    fixture.service().initialize_blocking().unwrap();
    assert_eq!(fixture.service().cached_theme(), "glass");

    std::fs::remove_dir(fixture.paths.legacy_config()).unwrap();
    std::fs::write(
        fixture.paths.legacy_config(),
        r#"{"settings":{"codegraphEmbedder":{"apiKey":"legacy-secret"}}}"#,
    )
    .unwrap();
    fixture.service().initialize_blocking().unwrap();
    assert!(!fixture.paths.legacy_config().exists());
    let backup = std::fs::read_to_string(fixture.paths.legacy_backup()).unwrap();
    assert!(!backup.contains("legacy-secret"));
    assert_eq!(fixture.service().cached_theme(), "glass");
}

#[test]
fn migration_cleanup_moves_live_keys_to_state_and_deletes_legacy() {
    // legacy config.json 里仍住着非设置体系的 live key（workspace / 迁移标记等）：
    // 清理时必须先把它们搬到 state.json（missing-only），再整体删除 legacy 文件。
    // 曾直接整删，导致 claudeMigrationDone 每次启动被抹掉、迁移引导弹窗反复出现。
    let fixture = TestStore::with_legacy_config(json!({
        "settings": {"theme": "glass"},
        "providers": [],
        "active_provider": "__system_default__",
        "workspace": "C--proj",
        "claudeMigrationDone": true,
        "claudeMigrationDismissed": false
    }));
    fixture.service().initialize_blocking().unwrap();
    assert!(
        !fixture.paths.legacy_config().exists(),
        "live key 搬走后 legacy 文件应整体删除"
    );
    let text = std::fs::read_to_string(fixture.paths.state()).unwrap();
    let state: Value = serde_json::from_str(&text).unwrap();
    assert!(
        state.get("settings").is_none(),
        "settings 归设置文档，不进 state"
    );
    assert!(
        state.get("providers").is_none(),
        "providers 归设置文档，不进 state"
    );
    assert!(state.get("active_provider").is_none());
    assert_eq!(
        state.get("workspace").and_then(Value::as_str),
        Some("C--proj")
    );
    assert_eq!(
        state.get("claudeMigrationDone").and_then(Value::as_bool),
        Some(true)
    );
    // 再来一次启动（重试清理路径）：state.json 不被覆盖、不丢 key
    fixture.service().initialize_blocking().unwrap();
    let text = std::fs::read_to_string(fixture.paths.state()).unwrap();
    let state: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        state.get("claudeMigrationDone").and_then(Value::as_bool),
        Some(true)
    );
}

#[test]
fn migration_backup_is_redacted_and_unknown_safe_fields_are_preserved() {
    let fixture = TestStore::with_legacy_config(json!({
        "settings": {
            "theme": "warm-dark",
            "futureSafe": {"enabled": true},
            "codegraphEmbedder": {"backend": "http", "apiKey": "cg-secret"}
        },
        "providers": [{"id": "p2", "future": true, "apiKey": "provider-secret"}]
    }));
    fixture.service().initialize_blocking().unwrap();

    let user = fixture.read_user();
    assert_eq!(user["values"]["settings"]["futureSafe"]["enabled"], true);
    assert_eq!(user["values"]["providers"][0]["future"], true);
    assert!(!user.to_string().contains("cg-secret"));
    assert!(!user.to_string().contains("provider-secret"));

    let backup_text = std::fs::read_to_string(fixture.paths.legacy_backup()).unwrap();
    assert!(backup_text.contains("configured"));
    assert!(!backup_text.contains("cg-secret"));
    assert!(!backup_text.contains("provider-secret"));
}

#[test]
fn read_rejects_known_values_with_wrong_type_or_scope() {
    let fixture = TestStore::new();
    fixture.write_document(
        fixture.paths.user(),
        document(json!({"settings": {"theme": 42}})),
    );
    assert!(fixture.service().initialize_blocking().is_err());

    let project = temp_root();
    fixture.write_user(document(json!({"settings": {"theme": "warm-dark"}})));
    fixture.write_document(
        &fixture.paths.project_shared(Some(&project)).unwrap(),
        document(json!({"providers": []})),
    );
    assert!(fixture
        .service()
        .effective_document_blocking(Some(&project))
        .is_err());
}

#[test]
fn mutations_reject_descriptor_and_permission_rule_violations() {
    let fixture = TestStore::new();
    assert!(fixture
        .service()
        .mutate_scope_blocking(SettingsScope::User, None, |doc| {
            doc.values
                .insert("settings".into(), json!({"theme": false}));
            Ok(())
        })
        .is_err());

    assert!(fixture
        .service()
        .mutate_scope_blocking(SettingsScope::User, None, |doc| {
            doc.permissions.rules.push(super::StoredPermissionRule {
                id: "not-a-uuid".to_string(),
                effect: super::PermissionEffect::Ask,
                tool: "Bash".to_string(),
                matcher: json!({}),
                order: 0,
            });
            Ok(())
        })
        .is_err());
}

/// 并发写不许互相覆盖：每条写都基于上一条写完的文档。无锁时两条写各读各的旧文档，
/// 后写的把先写的那一项盖掉；Windows 上换文件的瞬间还会读到「没有文件」、整份清零。
#[test]
fn concurrent_mutations_do_not_lose_each_others_writes() {
    let fixture = TestStore::new();
    fixture.write_user(document(json!({"providers": [{"id": "p1", "kind": "custom"}]})));
    let (threads, rounds) = (8, 12);
    std::thread::scope(|scope| {
        for t in 0..threads {
            let service = fixture.service();
            scope.spawn(move || {
                for r in 0..rounds {
                    service
                        .mutate_scope_blocking(SettingsScope::User, None, |doc| {
                            let mut hidden = doc
                                .values
                                .get("hiddenWorkspaces")
                                .and_then(Value::as_array)
                                .cloned()
                                .unwrap_or_default();
                            hidden.push(json!(format!("ws-{t}-{r}")));
                            doc.values.insert("hiddenWorkspaces".into(), Value::Array(hidden));
                            Ok(())
                        })
                        .unwrap();
                }
            });
        }
    });
    let saved = fixture.read_user();
    assert_eq!(
        saved["values"]["hiddenWorkspaces"].as_array().unwrap().len(),
        threads * rounds
    );
    assert_eq!(saved["values"]["providers"][0]["id"], "p1");
}

/// 已加载过的用户文档，文件被外力拿走后再写一项：其余设置必须还在，
/// 不能当成「用户从没设置过」写回一份只有这一项的文档。
#[test]
fn mutation_after_the_user_file_vanishes_keeps_the_loaded_document() {
    let fixture = TestStore::new();
    fixture
        .service()
        .mutate_scope_blocking(SettingsScope::User, None, |doc| {
            doc.values
                .insert("providers".into(), json!([{"id": "p1", "kind": "custom"}]));
            doc.values
                .insert("settings".into(), json!({"theme": "glass"}));
            Ok(())
        })
        .unwrap();
    std::fs::remove_file(fixture.paths.user()).unwrap();
    fixture
        .service()
        .mutate_scope_blocking(SettingsScope::User, None, |doc| {
            doc.values.insert("activeProvider".into(), json!("p1"));
            Ok(())
        })
        .unwrap();
    let saved = fixture.read_user();
    assert_eq!(saved["values"]["activeProvider"], "p1");
    assert_eq!(saved["values"]["providers"][0]["id"], "p1");
    assert_eq!(saved["values"]["settings"]["theme"], "glass");
}

#[cfg(windows)]
#[test]
fn windows_atomic_write_replaces_an_existing_destination() {
    let fixture = TestStore::new();
    fixture.write_user(document(json!({"settings": {"theme": "warm-dark"}})));
    fixture
        .service()
        .mutate_scope_blocking(SettingsScope::User, None, |doc| {
            doc.values
                .insert("settings".into(), json!({"theme": "glass"}));
            Ok(())
        })
        .unwrap();
    assert_eq!(fixture.read_user()["values"]["settings"]["theme"], "glass");
}
