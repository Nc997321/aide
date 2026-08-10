use std::collections::BTreeSet;

use once_cell::sync::Lazy;
use serde_json::{json, Value};

use super::schema::SettingsScope;

const USER: &[SettingsScope] = &[SettingsScope::User];
const USER_PROJECT_LOCAL: &[SettingsScope] = &[
    SettingsScope::User,
    SettingsScope::Project,
    SettingsScope::Local,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingValueKind {
    String,
    Number,
    Boolean,
    Array,
    Object,
    Secret,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SettingDescriptor {
    /// Canonical identifier for the new settings document schema.
    pub id: &'static str,
    /// Legacy config.json identifiers that migrate to this canonical descriptor.
    pub legacy_ids: &'static [&'static str],
    pub default: Value,
    pub kind: SettingValueKind,
    pub scopes: &'static [SettingsScope],
    pub ui_owner: &'static str,
    pub sensitive: bool,
    pub project_overridable: bool,
}

impl SettingDescriptor {
    fn new(
        id: &'static str,
        default: Value,
        kind: SettingValueKind,
        scopes: &'static [SettingsScope],
        ui_owner: &'static str,
        sensitive: bool,
        project_overridable: bool,
    ) -> Self {
        Self {
            id,
            legacy_ids: &[],
            default,
            kind,
            scopes,
            ui_owner,
            sensitive,
            project_overridable,
        }
    }

    fn with_legacy_ids(mut self, legacy_ids: &'static [&'static str]) -> Self {
        self.legacy_ids = legacy_ids;
        self
    }
}

static DESCRIPTORS: Lazy<Vec<SettingDescriptor>> = Lazy::new(|| {
    vec![
        ui("settings.fontSize", json!(14), SettingValueKind::Number),
        ui("settings.fontFamily", json!("'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', 'PingFang SC', 'Microsoft YaHei', monospace"), SettingValueKind::String),
        ui("settings.notificationsEnabled", json!(true), SettingValueKind::Boolean),
        ui("settings.autoNaming", json!(true), SettingValueKind::Boolean),
        user("settings.proxy", json!(""), SettingValueKind::String, "settings"),
        user("settings.shellPath", json!(""), SettingValueKind::String, "settings"),
        ui("settings.workbenchHeight", json!(0), SettingValueKind::Number),
        ui("settings.keybindings", json!({}), SettingValueKind::Object),
        ui("settings.theme", json!("glass"), SettingValueKind::String),
        user(
            "settings.openWithExtensions",
            json!([]),
            SettingValueKind::Array,
            "file-assoc",
        )
        .with_legacy_ids(&["settings.open_with_extensions"]),
        ui("settings.recentLimit", json!(10), SettingValueKind::Number),
        ui("settings.paneLayouts", Value::Null, SettingValueKind::Object),
        project("settings.codegraphEmbedder", json!({
            "backend": "fastembed",
            "baseUrl": "",
            "model": "nomic-embed-text",
            "format": "ollama",
            "dim": 0,
            "scoreThreshold": null
        }), SettingValueKind::Object, "codegraph"),
        project("settings.codegraphEmbedder.backend", json!("fastembed"), SettingValueKind::String, "codegraph"),
        project("settings.codegraphEmbedder.baseUrl", json!(""), SettingValueKind::String, "codegraph"),
        secret("settings.codegraphEmbedder.apiKey", "codegraph"),
        project("settings.codegraphEmbedder.model", json!("nomic-embed-text"), SettingValueKind::String, "codegraph"),
        project("settings.codegraphEmbedder.format", json!("ollama"), SettingValueKind::String, "codegraph"),
        project("settings.codegraphEmbedder.dim", json!(0), SettingValueKind::Number, "codegraph"),
        project("settings.codegraphEmbedder.scoreThreshold", Value::Null, SettingValueKind::Number, "codegraph"),
        user("settings.enabledMarketplaces", json!([]), SettingValueKind::Array, "marketplace"),
        user("settings.enabledPlugins", json!({}), SettingValueKind::Object, "marketplace"),
        user("settings.jdkRegistry", json!([]), SettingValueKind::Array, "jdk"),
        user("settings.jdkPromptDismissed", json!([]), SettingValueKind::Array, "jdk"),
        ui("settings.leftSidebarPinned", json!(true), SettingValueKind::Boolean),
        user("providers", json!([]), SettingValueKind::Array, "provider"),
        user("providers[].id", json!(""), SettingValueKind::String, "provider"),
        user("providers[].kind", json!("custom"), SettingValueKind::String, "provider"),
        user("providers[].name", json!(""), SettingValueKind::String, "provider"),
        user("providers[].icon", json!(""), SettingValueKind::String, "provider"),
        user("providers[].baseUrl", json!(""), SettingValueKind::String, "provider")
            .with_legacy_ids(&["providers[].base_url"]),
        secret("providers[].apiKey", "provider").with_legacy_ids(&["providers[].api_key"]),
        secret("providers[].authToken", "provider")
            .with_legacy_ids(&["providers[].auth_token"]),
        user("providers[].model", json!(""), SettingValueKind::String, "provider"),
        user("providers[].modelMappings", json!({}), SettingValueKind::Object, "provider")
            .with_legacy_ids(&["providers[].model_mappings"]),
        user("providers[].modelMappings.anthropicModel", json!(""), SettingValueKind::String, "provider")
            .with_legacy_ids(&["providers[].model_mappings.anthropic_model"]),
        user("providers[].modelMappings.defaultOpusModel", json!(""), SettingValueKind::String, "provider")
            .with_legacy_ids(&["providers[].model_mappings.default_opus_model"]),
        user("providers[].modelMappings.defaultSonnetModel", json!(""), SettingValueKind::String, "provider")
            .with_legacy_ids(&["providers[].model_mappings.default_sonnet_model"]),
        user("providers[].modelMappings.defaultHaikuModel", json!(""), SettingValueKind::String, "provider")
            .with_legacy_ids(&["providers[].model_mappings.default_haiku_model"]),
        user("providers[].modelMappings.subagent", json!(""), SettingValueKind::String, "provider")
            .with_legacy_ids(&["providers[].model_mappings.subagent"]),
        user("providers[].effortLevel", json!(""), SettingValueKind::String, "provider")
            .with_legacy_ids(&["providers[].effort_level"]),
        user("providers[].autoCompactWindow", json!(""), SettingValueKind::String, "provider")
            .with_legacy_ids(&["providers[].auto_compact_window"]),
        user("providers[].autocompactPctOverride", json!(""), SettingValueKind::String, "provider")
            .with_legacy_ids(&["providers[].autocompact_pct_override"]),
        user("providers[].knownModels", json!([]), SettingValueKind::Array, "provider")
            .with_legacy_ids(&["providers[].known_models"]),
        user("activeProvider", json!("__system_default__"), SettingValueKind::String, "provider")
            .with_legacy_ids(&["active_provider"]),
        user("workspace", Value::Null, SettingValueKind::String, "workspace"),
        user("hiddenWorkspaces", json!([]), SettingValueKind::Array, "workspace"),
        user(
            "systemDefaultModelMappings",
            json!({}),
            SettingValueKind::Object,
            "provider",
        )
        .with_legacy_ids(&["system_default_model_mappings"]),
        user(
            "systemDefaultModelMappings.anthropicModel",
            json!(""),
            SettingValueKind::String,
            "provider",
        )
        .with_legacy_ids(&["system_default_model_mappings.anthropic_model"]),
        user(
            "systemDefaultModelMappings.defaultOpusModel",
            json!(""),
            SettingValueKind::String,
            "provider",
        )
        .with_legacy_ids(&["system_default_model_mappings.default_opus_model"]),
        user(
            "systemDefaultModelMappings.defaultSonnetModel",
            json!(""),
            SettingValueKind::String,
            "provider",
        )
        .with_legacy_ids(&["system_default_model_mappings.default_sonnet_model"]),
        user(
            "systemDefaultModelMappings.defaultHaikuModel",
            json!(""),
            SettingValueKind::String,
            "provider",
        )
        .with_legacy_ids(&["system_default_model_mappings.default_haiku_model"]),
        user(
            "systemDefaultModelMappings.subagent",
            json!(""),
            SettingValueKind::String,
            "provider",
        )
        .with_legacy_ids(&["system_default_model_mappings.subagent"]),
        user("claudeMigrationDone", json!(false), SettingValueKind::Boolean, "migration"),
        user("claudeMigrationDismissed", json!(false), SettingValueKind::Boolean, "migration"),
        user("onboarded", json!(false), SettingValueKind::Boolean, "general"),
        SettingDescriptor::new(
            "permissions.rules",
            json!([]),
            SettingValueKind::Array,
            USER_PROJECT_LOCAL,
            "permissions",
            false,
            true,
        ),
    ]
});

pub fn all_descriptors() -> &'static [SettingDescriptor] {
    DESCRIPTORS.as_slice()
}

// Single-descriptor lookups are only used by the settings test modules; the
// non-test path in `store.rs` calls `all_descriptors().iter().find(...)` inline.
#[cfg(test)]
pub fn descriptor(id: &str) -> Option<&'static SettingDescriptor> {
    all_descriptors().iter().find(|entry| entry.id == id)
}

#[cfg(test)]
pub fn descriptor_for_legacy_id(legacy_id: &str) -> Option<&'static SettingDescriptor> {
    all_descriptors()
        .iter()
        .find(|entry| entry.legacy_ids.contains(&legacy_id))
}

pub fn validate_descriptor_catalog() -> Result<(), String> {
    validate_descriptor_entries(all_descriptors())
}

pub(crate) fn validate_descriptor_entries(entries: &[SettingDescriptor]) -> Result<(), String> {
    let mut canonical_ids = BTreeSet::new();
    let mut legacy_ids = BTreeSet::new();
    for entry in entries {
        if entry.id.trim().is_empty() {
            return Err("setting descriptor id must not be empty".to_string());
        }
        if !canonical_ids.insert(entry.id) {
            return Err(format!("duplicate setting descriptor id: {}", entry.id));
        }
        if entry.scopes.is_empty() {
            return Err(format!("setting descriptor has no scopes: {}", entry.id));
        }
        if entry.ui_owner.trim().is_empty() {
            return Err(format!("setting descriptor has no ui_owner: {}", entry.id));
        }
        if entry.sensitive && !entry.default.is_null() {
            return Err(format!(
                "sensitive setting descriptor must not define a plaintext default: {}",
                entry.id
            ));
        }
        if entry.project_overridable
            && !entry
                .scopes
                .iter()
                .any(|scope| matches!(scope, SettingsScope::Project | SettingsScope::Local))
        {
            return Err(format!(
                "project-overridable setting has no project/local scope: {}",
                entry.id
            ));
        }
    }
    for entry in entries {
        for &legacy_id in entry.legacy_ids {
            if legacy_id.trim().is_empty() {
                return Err(format!(
                    "legacy setting descriptor id must not be empty: {}",
                    entry.id
                ));
            }
            if canonical_ids.contains(legacy_id) {
                return Err(format!(
                    "legacy setting descriptor id conflicts with canonical id: {legacy_id}"
                ));
            }
            if !legacy_ids.insert(legacy_id) {
                return Err(format!(
                    "duplicate legacy setting descriptor id: {legacy_id}"
                ));
            }
        }
    }
    Ok(())
}

fn ui(id: &'static str, default: Value, kind: SettingValueKind) -> SettingDescriptor {
    SettingDescriptor::new(
        id,
        default,
        kind,
        USER_PROJECT_LOCAL,
        "settings",
        false,
        true,
    )
}

fn project(
    id: &'static str,
    default: Value,
    kind: SettingValueKind,
    ui_owner: &'static str,
) -> SettingDescriptor {
    SettingDescriptor::new(id, default, kind, USER_PROJECT_LOCAL, ui_owner, false, true)
}

fn user(
    id: &'static str,
    default: Value,
    kind: SettingValueKind,
    ui_owner: &'static str,
) -> SettingDescriptor {
    SettingDescriptor::new(id, default, kind, USER, ui_owner, false, false)
}

fn secret(id: &'static str, ui_owner: &'static str) -> SettingDescriptor {
    SettingDescriptor::new(
        id,
        Value::Null,
        SettingValueKind::Secret,
        USER,
        ui_owner,
        true,
        false,
    )
}
