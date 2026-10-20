use super::{all_descriptors, descriptor, validate_descriptor_catalog, SettingsDocument, SettingsScope};

#[test]
fn settings_document_keeps_unknown_safe_values() {
    let mut doc: SettingsDocument = serde_json::from_value(serde_json::json!({
        "schemaVersion": 1,
        "values": { "futurePlugin": { "enabled": true } },
        "permissions": { "rules": [] }
    }))
    .unwrap();
    doc.values
        .insert("settings".into(), serde_json::json!({ "theme": "glass" }));
    let saved = serde_json::to_value(&doc).unwrap();
    assert_eq!(saved["values"]["futurePlugin"]["enabled"], true);
}

#[test]
fn every_persisted_field_has_exactly_one_descriptor() {
    validate_descriptor_catalog().unwrap();
    let ids: std::collections::BTreeSet<_> = all_descriptors().iter().map(|d| d.id).collect();
    for expected in [
        "settings.fontSize",
        "settings.fontFamily",
        "settings.proxy",
        "providers",
        "activeProvider",
        "workspace",
        "hiddenWorkspaces",
        "systemDefaultModelMappings",
        "claudeMigrationDone",
        "claudeMigrationDismissed",
    ] {
        assert!(ids.contains(expected), "missing descriptor: {expected}");
    }
    assert_eq!(ids.len(), all_descriptors().len());
}

#[test]
fn permission_rules_are_available_to_user_project_and_local_scopes() {
    let rules = descriptor("permissions.rules").expect("permissions descriptor must exist");
    assert_eq!(
        rules.scopes,
        &[
            SettingsScope::User,
            SettingsScope::Project,
            SettingsScope::Local
        ]
    );
}
