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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SettingValueKind {
    #[default]
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
    pub default: Value,
    pub kind: SettingValueKind,
    pub scopes: &'static [SettingsScope],
    pub ui_owner: &'static str,
    pub sensitive: bool,
    pub project_overridable: bool,
}

/// `SettingDescriptor::new` 的构造元数据。身份字段（id/default/kind/scopes/
/// ui_owner）必填；sensitive / project_overridable 是策略开关，默认关闭，
/// 需要的调用点显式打开——替代 7 位置参数 + 2 相邻 bool。
#[derive(Default)]
struct DescriptorMeta {
    id: &'static str,
    default: Value,
    kind: SettingValueKind,
    scopes: &'static [SettingsScope],
    ui_owner: &'static str,
    sensitive: bool,
    project_overridable: bool,
}

impl SettingDescriptor {
    fn new(meta: DescriptorMeta) -> Self {
        Self {
            id: meta.id,
            default: meta.default,
            kind: meta.kind,
            scopes: meta.scopes,
            ui_owner: meta.ui_owner,
            sensitive: meta.sensitive,
            project_overridable: meta.project_overridable,
        }
    }
}

static DESCRIPTORS: Lazy<Vec<SettingDescriptor>> = Lazy::new(|| {
    // 界面状态（paneLayouts / workbenchHeight / leftSidebarPinned / jdkPromptDismissed /
    // onboarded）已搬到 state.json（见 `app_settings::UI_STATE_KEYS`）。它们的描述符只为
    // 读得进旧文档而留——新的界面状态不要再往这张表里加。
    vec![
        ui("settings.fontSize", json!(14), SettingValueKind::Number),
        ui("settings.fontFamily", json!("'Maple Mono NF CN', 'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', 'PingFang SC', 'Microsoft YaHei', monospace"), SettingValueKind::String),
        ui("settings.notificationsEnabled", json!(true), SettingValueKind::Boolean),
        ui("settings.showThinking", json!(false), SettingValueKind::Boolean),
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
        ),
        ui("settings.recentLimit", json!(10), SettingValueKind::Number),
        ui("settings.paneLayouts", Value::Null, SettingValueKind::Object),
        user("settings.enabledMarketplaces", json!([]), SettingValueKind::Array, "marketplace"),
        user("settings.enabledPlugins", json!({}), SettingValueKind::Object, "marketplace"),
        user("settings.jdkRegistry", json!([]), SettingValueKind::Array, "jdk"),
        user("settings.jdkPromptDismissed", json!([]), SettingValueKind::Array, "jdk"),
        ui("settings.leftSidebarPinned", json!(true), SettingValueKind::Boolean),
        ui("settings.onboarded", json!(false), SettingValueKind::Boolean),
        user("providers", json!([]), SettingValueKind::Array, "provider"),
        user("providers[].id", json!(""), SettingValueKind::String, "provider"),
        user("providers[].kind", json!("custom"), SettingValueKind::String, "provider"),
        user("providers[].name", json!(""), SettingValueKind::String, "provider"),
        user("providers[].icon", json!(""), SettingValueKind::String, "provider"),
        user("providers[].baseUrl", json!(""), SettingValueKind::String, "provider"),
        secret("providers[].apiKey", "provider"),
        secret("providers[].authToken", "provider"),
        user("providers[].model", json!(""), SettingValueKind::String, "provider"),
        user("providers[].modelMappings", json!({}), SettingValueKind::Object, "provider"),
        user("providers[].modelMappings.anthropicModel", json!(""), SettingValueKind::String, "provider"),
        user("providers[].modelMappings.defaultOpusModel", json!(""), SettingValueKind::String, "provider"),
        user("providers[].modelMappings.defaultSonnetModel", json!(""), SettingValueKind::String, "provider"),
        user("providers[].modelMappings.defaultHaikuModel", json!(""), SettingValueKind::String, "provider"),
        user("providers[].modelMappings.subagent", json!(""), SettingValueKind::String, "provider"),
        user("providers[].effortLevel", json!(""), SettingValueKind::String, "provider"),
        user("providers[].autoCompactWindow", json!(""), SettingValueKind::String, "provider"),
        user("providers[].autocompactPctOverride", json!(""), SettingValueKind::String, "provider"),
        user("providers[].maxContextTokens", json!(""), SettingValueKind::String, "provider"),
        user("providers[].knownModels", json!([]), SettingValueKind::Array, "provider"),
        user("activeProvider", json!("__system_default__"), SettingValueKind::String, "provider"),
        user("workspace", Value::Null, SettingValueKind::String, "workspace"),
        user("hiddenWorkspaces", json!([]), SettingValueKind::Array, "workspace"),
        user(
            "systemDefaultModelMappings",
            json!({}),
            SettingValueKind::Object,
            "provider",
        ),
        user(
            "systemDefaultModelMappings.anthropicModel",
            json!(""),
            SettingValueKind::String,
            "provider",
        ),
        user(
            "systemDefaultModelMappings.defaultOpusModel",
            json!(""),
            SettingValueKind::String,
            "provider",
        ),
        user(
            "systemDefaultModelMappings.defaultSonnetModel",
            json!(""),
            SettingValueKind::String,
            "provider",
        ),
        user(
            "systemDefaultModelMappings.defaultHaikuModel",
            json!(""),
            SettingValueKind::String,
            "provider",
        ),
        user(
            "systemDefaultModelMappings.subagent",
            json!(""),
            SettingValueKind::String,
            "provider",
        ),
        user("claudeMigrationDone", json!(false), SettingValueKind::Boolean, "migration"),
        user("claudeMigrationDismissed", json!(false), SettingValueKind::Boolean, "migration"),
        SettingDescriptor::new(DescriptorMeta {
            id: "permissions.rules",
            default: json!([]),
            kind: SettingValueKind::Array,
            scopes: USER_PROJECT_LOCAL,
            ui_owner: "permissions",
            project_overridable: true,
            ..Default::default()
        }),
        user("settings.remote.permissionMode", json!("auto"), SettingValueKind::String, "remote"),
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

pub fn validate_descriptor_catalog() -> Result<(), String> {
    validate_descriptor_entries(all_descriptors())
}

pub(crate) fn validate_descriptor_entries(entries: &[SettingDescriptor]) -> Result<(), String> {
    let mut canonical_ids = BTreeSet::new();
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
    Ok(())
}

fn ui(id: &'static str, default: Value, kind: SettingValueKind) -> SettingDescriptor {
    SettingDescriptor::new(DescriptorMeta {
        id,
        default,
        kind,
        scopes: USER_PROJECT_LOCAL,
        ui_owner: "settings",
        project_overridable: true,
        ..Default::default()
    })
}

fn user(
    id: &'static str,
    default: Value,
    kind: SettingValueKind,
    ui_owner: &'static str,
) -> SettingDescriptor {
    SettingDescriptor::new(DescriptorMeta {
        id,
        default,
        kind,
        scopes: USER,
        ui_owner,
        ..Default::default()
    })
}

fn secret(id: &'static str, ui_owner: &'static str) -> SettingDescriptor {
    SettingDescriptor::new(DescriptorMeta {
        id,
        default: Value::Null,
        kind: SettingValueKind::Secret,
        scopes: USER,
        ui_owner,
        sensitive: true,
        ..Default::default()
    })
}
