use super::{
    all_descriptors, descriptor, descriptor_for_legacy_id, validate_descriptor_catalog,
    validate_descriptor_entries, SettingDescriptor, SettingValueKind, SettingsDocument,
    SettingsScope,
};

const USER_SCOPE: &[SettingsScope] = &[SettingsScope::User];

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
fn every_legacy_persisted_field_has_exactly_one_descriptor() {
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

#[test]
fn legacy_provider_paths_resolve_to_their_canonical_descriptors() {
    for (legacy_id, canonical_id) in [
        ("active_provider", "activeProvider"),
        (
            "system_default_model_mappings",
            "systemDefaultModelMappings",
        ),
        ("providers[].model_mappings", "providers[].modelMappings"),
        (
            "providers[].model_mappings.anthropic_model",
            "providers[].modelMappings.anthropicModel",
        ),
        (
            "providers[].model_mappings.default_opus_model",
            "providers[].modelMappings.defaultOpusModel",
        ),
        (
            "providers[].model_mappings.default_sonnet_model",
            "providers[].modelMappings.defaultSonnetModel",
        ),
        (
            "providers[].model_mappings.default_haiku_model",
            "providers[].modelMappings.defaultHaikuModel",
        ),
        (
            "providers[].model_mappings.subagent",
            "providers[].modelMappings.subagent",
        ),
    ] {
        assert_eq!(
            descriptor_for_legacy_id(legacy_id).map(|entry| entry.id),
            Some(canonical_id),
            "legacy descriptor missing: {legacy_id}"
        );
    }
}

#[test]
fn descriptor_validation_rejects_legacy_alias_ambiguity() {
    let canonical_conflict = SettingDescriptor {
        id: "canonicalId",
        legacy_ids: &["otherId"],
        default: serde_json::Value::Null,
        kind: SettingValueKind::String,
        scopes: USER_SCOPE,
        ui_owner: "test",
        sensitive: false,
        project_overridable: false,
    };
    let conflicting_canonical = SettingDescriptor {
        id: "otherId",
        legacy_ids: &[],
        ..canonical_conflict.clone()
    };
    let error = validate_descriptor_entries(&[canonical_conflict, conflicting_canonical])
        .expect_err("legacy id must not conflict with a canonical id");
    assert!(error.contains("conflicts with canonical"), "{error}");

    let first = SettingDescriptor {
        id: "first",
        legacy_ids: &["duplicate_legacy"],
        default: serde_json::Value::Null,
        kind: SettingValueKind::String,
        scopes: USER_SCOPE,
        ui_owner: "test",
        sensitive: false,
        project_overridable: false,
    };
    let second = SettingDescriptor {
        id: "second",
        legacy_ids: &["duplicate_legacy"],
        ..first.clone()
    };
    let error = validate_descriptor_entries(&[first, second])
        .expect_err("legacy ids must be globally unique");
    assert!(error.contains("duplicate legacy"), "{error}");
}
