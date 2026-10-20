use std::sync::Arc;

use serde_json::{json, Value};

use super::{
    MemorySecretStore, SettingsError, SettingsPaths, SettingsScope, SettingsService,
};

struct TestStore {
    paths: SettingsPaths,
    service: SettingsService,
}

impl TestStore {
    fn new() -> Self {
        let root = temp_root();
        let paths = SettingsPaths::for_test(root);
        let secrets = Arc::new(MemorySecretStore::default());
        let service = SettingsService::new(paths.clone(), secrets);
        service.initialize_blocking().unwrap();
        Self {
            paths,
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
