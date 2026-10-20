//! Provider 后端身份：数据模型 + env 组装 + 连接指纹 + 持久化读取。
//! 归位进 runtime 层（原躺 commands/provider.rs，造成 runtime→commands 倒置）。
//! IPC 薄命令留在 commands/provider.rs，调本模块。

pub mod catalog;
pub mod roster_cache;
pub mod strategy;

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

use crate::provider::catalog::resolve_preset_identity;

/// Provider 类型判别。预置 kind 的 base_url/name/icon 由 catalog 派生、不落盘。
/// `#[default] Custom` 让缺 `kind` 字段的旧配置反序列化成 Custom（迁移后不会缺）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    SystemDefault,
    CpaGpt,
    Ollama,
    Kimi,
    #[serde(rename = "deepseek")]
    DeepSeek,
    Zhipu,
    Qwen,
    #[default]
    Custom,
}

impl ProviderKind {
    /// 预置 kind（在 catalog 里）。Custom 不是预置。
    pub fn is_preset(self) -> bool {
        !matches!(self, ProviderKind::Custom)
    }
}

/// Claude 专属的模型 env 变量映射——5 个变量统一在此，换 provider 时整块重写，
/// 不污染调用方（chat.rs 调 runtime::env::build_runtime_env_vars；本模块只暴露
/// provider_to_env_vars / mappings_to_env / load_* 给 runtime/env.rs 和 commands 层用）。
///
/// 与会话面板模型下拉（models_available + set_model 运行时切换）互补：下拉是
/// "用户在 UI 选真实模型 id 并运行时切换"，本块是"spawn 时 env 变量层的默认值 +
/// 别名→具体模型映射"。两者不冲突——apply_initial_model_override 最后覆盖
/// ANTHROPIC_MODEL，会话面板选的模型优先级最高。
///
/// - anthropicModel      → ANTHROPIC_MODEL（spawn 时默认模型）
/// - defaultOpusModel    → ANTHROPIC_DEFAULT_OPUS_MODEL（opus 别名→具体模型）
/// - defaultSonnetModel  → ANTHROPIC_DEFAULT_SONNET_MODEL（sonnet 别名→具体模型）
/// - defaultHaikuModel   → ANTHROPIC_DEFAULT_HAIKU_MODEL（haiku 别名→具体模型）
/// - subagent            → CLAUDE_CODE_SUBAGENT_MODEL（子代理默认模型——只是配置载体）
///
/// default*Model 的用途：子代理模型填 opus/sonnet/haiku 别名时，CLI 靠这些解析成
/// 具体模型 id（尤其第三方 provider，别名叫 sonnet 但实际模型 id 不同）；sidecar 把
/// subagent 全 id 反查成别名时也靠它们（subagentModelDefault.ts 的折算表）。
///
/// 注意 CLAUDE_CODE_SUBAGENT_MODEL 在 CLI 内是优先级最高的硬覆盖（高于 Agent 工具
/// 调用的 model 参数）——sidecar 不会把它原样透传给 CLI，而是压成 "inherit" 放行
/// 主代理的逐次动态派发，配置值改由 PreToolUse hook 按「未指定才注入别名」下发
/// （详见 agent-sidecar/src/subagentModelDefault.ts 顶部注释）。本函数只管把配置
/// 值送进 sidecar 进程 env，语义转换全在 sidecar。
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelMappings {
    #[serde(default)]
    pub anthropic_model: String,
    #[serde(default)]
    pub default_opus_model: String,
    #[serde(default)]
    pub default_sonnet_model: String,
    #[serde(default)]
    pub default_haiku_model: String,
    #[serde(default)]
    pub subagent: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    #[serde(default)]
    pub kind: ProviderKind,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub api_key: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub auth_token: String,
    /// 已废弃：模型默认值的权威源改到 `model_mappings.anthropic_model`。字段保留
    /// 仅用于读旧配置——`migrate_provider_model` 在反序列化后把非空的顶层 model
    /// 回填到 anthropic_model。新写入不再读它（provider_to_env_vars 只看 model_mappings）。
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub model_mappings: ProviderModelMappings,
    #[serde(default)]
    pub effort_level: String,
    /// → CLAUDE_CODE_AUTO_COMPACT_WINDOW：auto-compact 计算用的上下文容量（token 数），
    /// 默认取模型上下文窗口（200K/1M，Sonnet 5 自带阈值）。填低值（如 500000）可提前
    /// 触发压缩，上限为模型实际窗口。空 = 不注入 = CLI 自带默认。
    #[serde(default)]
    pub auto_compact_window: String,
    /// → CLAUDE_AUTOCOMPACT_PCT_OVERRIDE：1–100，作用在 auto_compact_window 之上微调
    /// 触发时机。空 = 不注入 = CLI 自带默认百分比。
    #[serde(default)]
    pub autocompact_pct_override: String,
    /// → CLAUDE_CODE_MAX_CONTEXT_TOKENS：模型上下文窗口本身（token 数），直接定窗口
    /// 大小。与 auto_compact_window 区别——后者控 auto-compact 阈值且被本窗口夹住，本
    /// 字段定窗口上限。ollama 等非官方模型 CLI 默认 200K；抬高可推迟压缩，但勿超模型
    /// 真实窗口（越过模型硬限 → 模型端报错/截断/丢内容）。空 = 不注入 = CLI 默认。
    #[serde(default)]
    pub max_context_tokens: String,
    #[serde(default)]
    pub known_models: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfigView {
    pub id: String,
    pub kind: ProviderKind,
    pub name: String,
    pub icon: String,
    pub base_url: String,
    pub api_key_configured: bool,
    pub auth_token_configured: bool,
    pub model: String,
    pub model_mappings: ProviderModelMappings,
    pub effort_level: String,
    pub auto_compact_window: String,
    pub autocompact_pct_override: String,
    pub max_context_tokens: String,
    pub known_models: Vec<String>,
    /// 模型取值 → 显示名（只读、不落盘）。目前只有官方供应商在用：给静态别名贴上
    /// CLI 最近一次报回的版本（见 `roster_cache`）。没有条目的模型前端显示取值本身。
    pub model_labels: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfigInput {
    pub id: String,
    #[serde(default)]
    pub kind: ProviderKind,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: crate::settings::SecretMutation,
    #[serde(default)]
    pub auth_token: crate::settings::SecretMutation,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub model_mappings: ProviderModelMappings,
    #[serde(default)]
    pub effort_level: String,
    #[serde(default)]
    pub auto_compact_window: String,
    #[serde(default)]
    pub autocompact_pct_override: String,
    #[serde(default)]
    pub max_context_tokens: String,
    #[serde(default)]
    pub known_models: Vec<String>,
}

/// Provider 凭证配置状态的视图——替代 `api_key_configured` + `auth_token_configured`
/// 相邻 bool。四个组合都合法，但用枚举把「组合决策」集中在调用点一次做掉，
/// `view` 只负责展开回两个序列化 bool（ProviderConfigView 的 JSON schema 不变）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthStatus {
    None,
    ApiKey,
    AuthToken,
    Both,
}

impl ProviderConfig {
    fn view(self, auth: AuthStatus) -> ProviderConfigView {
        // SystemDefault 没有"用户自配的 known_models"——它的模型列表唯一来源是
        // 编译进 catalog 的预设（Anthropic 官方 4 个别名：opus/sonnet/haiku/fable）。
        // 此前 view() 输出 known_models=Vec::new()，前端只能用 default-models.json 兜底；
        // 改后：catalog 是单一真源，default-models.json 整个文件可删。
        let known_models = if self.kind == ProviderKind::SystemDefault {
            crate::provider::catalog::catalog_find(self.kind)
                .map(|p| p.models.clone())
                .unwrap_or_default()
        } else {
            self.known_models
        };
        // 版本标签只在别名仍指向 CLI 默认模型时成立：配了映射就不贴（会贴错）。
        let model_labels = if self.kind == ProviderKind::SystemDefault
            && mappings_to_env(&self.model_mappings).is_empty()
        {
            roster_cache::system_default_labels()
        } else {
            BTreeMap::new()
        };
        ProviderConfigView {
            id: self.id,
            kind: self.kind,
            name: self.name,
            icon: self.icon,
            base_url: self.base_url,
            api_key_configured: matches!(auth, AuthStatus::ApiKey | AuthStatus::Both),
            auth_token_configured: matches!(auth, AuthStatus::AuthToken | AuthStatus::Both),
            model: self.model,
            model_mappings: self.model_mappings,
            effort_level: self.effort_level,
            auto_compact_window: self.auto_compact_window,
            autocompact_pct_override: self.autocompact_pct_override,
            max_context_tokens: self.max_context_tokens,
            known_models,
            model_labels,
        }
    }
}

/// 把模型变量映射注入 env（5 个变量，非空才注入）。Claude 专属——自定义 provider
/// 和系统默认两条 spawn 路径共用本函数，注入逻辑单一入口。
pub fn mappings_to_env(m: &ProviderModelMappings) -> HashMap<String, String> {
    let mut env = HashMap::new();
    let pairs: &[(&str, &str)] = &[
        ("ANTHROPIC_MODEL", &m.anthropic_model),
        ("ANTHROPIC_DEFAULT_OPUS_MODEL", &m.default_opus_model),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL", &m.default_sonnet_model),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL", &m.default_haiku_model),
        ("CLAUDE_CODE_SUBAGENT_MODEL", &m.subagent),
    ];
    for (key, val) in pairs {
        if !val.is_empty() {
            env.insert(key.to_string(), val.to_string());
        }
    }
    env
}

pub fn provider_to_env_vars(p: &ProviderConfig) -> HashMap<String, String> {
    let mut env = HashMap::new();
    let pairs: &[(&str, &str)] = &[
        ("ANTHROPIC_BASE_URL", &p.base_url),
        ("ANTHROPIC_API_KEY", &p.api_key),
        ("ANTHROPIC_AUTH_TOKEN", &p.auth_token),
        ("CLAUDE_CODE_EFFORT_LEVEL", &p.effort_level),
        ("CLAUDE_CODE_AUTO_COMPACT_WINDOW", &p.auto_compact_window),
        (
            "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
            &p.autocompact_pct_override,
        ),
        ("CLAUDE_CODE_MAX_CONTEXT_TOKENS", &p.max_context_tokens),
    ];
    for (key, val) in pairs {
        if !val.is_empty() {
            env.insert(key.to_string(), val.to_string());
        }
    }
    env.extend(mappings_to_env(&p.model_mappings));
    env
}

/// 旧配置把默认模型放在 ProviderConfig.model 顶层；新结构统一到
/// model_mappings.anthropic_model。反序列化后做一次性迁移：顶层 model 非空且
/// anthropic_model 为空时回填，避免旧配置丢失默认模型。
pub fn migrate_provider_model(p: &mut ProviderConfig) {
    if !p.model.is_empty() && p.model_mappings.anthropic_model.is_empty() {
        p.model_mappings.anthropic_model = p.model.clone();
    }
}

/// 预置 kind：从 catalog 派生 base_url/name/icon 填入（内存态，不持久化）。
pub fn enrich(p: &mut ProviderConfig) {
    if !p.kind.is_preset() {
        return;
    }
    if let Some((name, icon, base_url)) = resolve_preset_identity(p.kind) {
        p.name = name;
        p.icon = icon;
        p.base_url = base_url;
    }
}

/// 预置 kind：清空 base_url/name/icon（持久化前调，保证不落盘）。
pub fn strip(p: &mut ProviderConfig) {
    if !p.kind.is_preset() {
        return;
    }
    p.name = String::new();
    p.icon = String::new();
    p.base_url = String::new();
}

/// Sentinel provider returned when the requested id is not found.
pub fn system_default_provider() -> ProviderConfig {
    ProviderConfig {
        id: "__system_default__".to_string(),
        kind: ProviderKind::SystemDefault,
        name: String::new(),
        icon: String::new(),
        base_url: String::new(),
        api_key: String::new(),
        auth_token: String::new(),
        model: String::new(),
        model_mappings: ProviderModelMappings::default(),
        effort_level: String::new(),
        auto_compact_window: String::new(),
        autocompact_pct_override: String::new(),
        max_context_tokens: String::new(),
        known_models: Vec::new(),
    }
}

impl crate::settings::SettingsService {
    pub fn list_provider_views(
        &self,
    ) -> Result<Vec<ProviderConfigView>, crate::settings::SettingsError> {
        let values = self.effective_document_blocking(None)?.values;
        let entries = values
            .get("providers")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        entries
            .into_iter()
            .filter_map(|entry| serde_json::from_value::<ProviderConfig>(entry).ok())
            .map(|mut provider| {
                migrate_provider_model(&mut provider);
                enrich(&mut provider);
                let api = self
                    .secrets()
                    .get(&format!("provider/{}/apiKey", provider.id))?
                    .is_some();
                let token = self
                    .secrets()
                    .get(&format!("provider/{}/authToken", provider.id))?
                    .is_some();
                let auth = match (api, token) {
                    (true, true) => AuthStatus::Both,
                    (true, false) => AuthStatus::ApiKey,
                    (false, true) => AuthStatus::AuthToken,
                    (false, false) => AuthStatus::None,
                };
                Ok(provider.view(auth))
            })
            .collect()
    }

    pub fn resolve_runtime_provider(
        &self,
        id: &str,
    ) -> Result<ProviderConfig, crate::settings::SettingsError> {
        let values = self.effective_document_blocking(None)?.values;
        self.resolve_runtime_provider_from_values(&values, id)
    }

    pub fn active_provider_id(&self) -> Result<String, crate::settings::SettingsError> {
        let values = &self.effective_document_blocking(None)?.values;
        let id = values
            .get("activeProvider")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("__system_default__");
        Ok(id.to_string())
    }

    pub fn resolve_active_runtime_provider(
        &self,
    ) -> Result<ProviderConfig, crate::settings::SettingsError> {
        let doc = self.effective_document_blocking(None)?;
        let id = doc
            .values
            .get("activeProvider")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("__system_default__");
        self.resolve_runtime_provider_from_values(&doc.values, id)
    }

    /// Returns all providers WITH secrets resolved (for action paths that may need creds).
    /// Mirrors `list_provider_views` but builds `ProviderConfig` with api_key/auth_token.
    pub fn list_runtime_providers(
        &self,
    ) -> Result<Vec<ProviderConfig>, crate::settings::SettingsError> {
        let values = self.effective_document_blocking(None)?.values;
        let entries = values
            .get("providers")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut out = Vec::with_capacity(entries.len());
        for entry in entries {
            if let Ok(mut provider) = serde_json::from_value::<ProviderConfig>(entry) {
                provider.api_key = self
                    .secrets()
                    .get(&format!("provider/{}/apiKey", provider.id))?
                    .unwrap_or_default();
                provider.auth_token = self
                    .secrets()
                    .get(&format!("provider/{}/authToken", provider.id))?
                    .unwrap_or_default();
                migrate_provider_model(&mut provider);
                enrich(&mut provider);
                out.push(provider);
            }
        }
        Ok(out)
    }

    /// Persist model_mappings for a single provider entry. Mutates the `providers[]` entry
    /// whose id matches. If no matching entry, no-op (does NOT create a top-level key).
    pub fn save_provider_model_mappings(
        &self,
        id: &str,
        mappings: &ProviderModelMappings,
    ) -> Result<(), crate::settings::SettingsError> {
        let m_val = serde_json::to_value(mappings)
            .map_err(|e| crate::settings::SettingsError::Storage(e.to_string()))?;
        self.mutate_scope_blocking(crate::settings::SettingsScope::User, None, |document| {
            if let Some(arr) = document
                .values
                .get_mut("providers")
                .and_then(|v| v.as_array_mut())
            {
                for p in arr.iter_mut() {
                    if p.get("id").and_then(|v| v.as_str()) == Some(id) {
                        // ProviderConfig uses #[serde(rename_all = "camelCase")],
                        // so the JSON key is "modelMappings", not "model_mappings".
                        p["modelMappings"] = m_val.clone();
                        break;
                    }
                }
            }
            Ok(())
        })?;
        Ok(())
    }

    fn resolve_runtime_provider_from_values(
        &self,
        values: &serde_json::Value,
        id: &str,
    ) -> Result<ProviderConfig, crate::settings::SettingsError> {
        let entries = values
            .get("providers")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut provider = entries
            .into_iter()
            .filter_map(|entry| serde_json::from_value::<ProviderConfig>(entry).ok())
            .find(|candidate| candidate.id == id)
            .unwrap_or_else(system_default_provider);
        provider.api_key = self
            .secrets()
            .get(&format!("provider/{}/apiKey", provider.id))?
            .unwrap_or_default();
        provider.auth_token = self
            .secrets()
            .get(&format!("provider/{}/authToken", provider.id))?
            .unwrap_or_default();
        migrate_provider_model(&mut provider);
        enrich(&mut provider);
        Ok(provider)
    }

    pub fn save_provider_inputs(
        &self,
        inputs: Vec<ProviderConfigInput>,
    ) -> Result<(), crate::settings::SettingsError> {
        let mut ids = std::collections::BTreeSet::new();
        for input in &inputs {
            if input.id.trim().is_empty() || !ids.insert(input.id.clone()) {
                return Err(crate::settings::SettingsError::Validation(
                    "provider ids must be non-empty and unique".to_string(),
                ));
            }
        }

        let mut persisted = Vec::with_capacity(inputs.len());
        let mut changed_secret_keys = Vec::new();
        for input in &inputs {
            for (suffix, mutation) in [("apiKey", &input.api_key), ("authToken", &input.auth_token)]
            {
                let key = format!("provider/{}/{}", input.id, suffix);
                match mutation {
                    crate::settings::SecretMutation::Unchanged => {}
                    crate::settings::SecretMutation::Set(value) if value.is_empty() => {}
                    crate::settings::SecretMutation::Set(value) => {
                        self.secrets().set(&key, value)?;
                        changed_secret_keys.push(key);
                    }
                    crate::settings::SecretMutation::Clear => {
                        self.secrets().delete(&key)?;
                        changed_secret_keys.push(key);
                    }
                }
            }
            let mut provider = ProviderConfig {
                id: input.id.clone(),
                kind: input.kind,
                name: input.name.clone(),
                icon: input.icon.clone(),
                base_url: input.base_url.clone(),
                api_key: String::new(),
                auth_token: String::new(),
                model: input.model.clone(),
                model_mappings: input.model_mappings.clone(),
                effort_level: input.effort_level.clone(),
                auto_compact_window: input.auto_compact_window.clone(),
                autocompact_pct_override: input.autocompact_pct_override.clone(),
                max_context_tokens: input.max_context_tokens.clone(),
                known_models: input.known_models.clone(),
            };
            strip(&mut provider);
            persisted.push(provider);
        }
        if let Err(error) = self.mutate_scope_blocking(
            crate::settings::SettingsScope::User,
            None,
            move |document| {
                document.values.insert(
                    "providers".to_string(),
                    serde_json::to_value(persisted).map_err(|error| {
                        crate::settings::SettingsError::Storage(error.to_string())
                    })?,
                );
                Ok(())
            },
        ) {
            if !changed_secret_keys.is_empty() {
                tracing::warn!(
                    secret_key_count = changed_secret_keys.len(),
                    "provider metadata persistence failed after keychain mutation; unreachable orphan credentials may require cleanup"
                );
            }
            return Err(error);
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn save_provider_input_for_test(
        &self,
        id: &str,
        secret: &str,
    ) -> Result<(), crate::settings::SettingsError> {
        self.save_provider_inputs(vec![ProviderConfigInput {
            id: id.to_string(),
            kind: ProviderKind::Custom,
            name: "test".to_string(),
            icon: String::new(),
            base_url: String::new(),
            api_key: crate::settings::SecretMutation::Set(secret.to_string()),
            auth_token: crate::settings::SecretMutation::Unchanged,
            model: String::new(),
            model_mappings: ProviderModelMappings::default(),
            effort_level: String::new(),
            auto_compact_window: String::new(),
            autocompact_pct_override: String::new(),
            max_context_tokens: String::new(),
            known_models: Vec::new(),
        }])
    }
}

/// 决定子进程是否需要因连接身份变化而重启的字段白名单：base_url / api_key /
/// auth_token / 配置目录 / 代理。故意不含 ANTHROPIC_MODEL 等模型相关字段——
/// 模型切换有专门的运行时 `set_model` 通道，不该触发整进程重启（见
/// `chat.rs::set_model`）。
pub const CONNECTION_ENV_KEYS: &[&str] = &[
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
];

/// 从完整环境变量表里只摘出「连接身份」相关字段并按 key 排序（owned），用于
/// 比较两次 env 快照是不是同一个供应商连接，并可跨 kill 持久存进
/// `AgentRuntimeManager` 的指纹注册表。返回 owned 是因为 env_vars 在 spawn 后即释放，
/// 指纹要在 stop 后 respawn 时仍可读。
pub fn connection_fingerprint(env: &HashMap<String, String>) -> BTreeMap<String, String> {
    CONNECTION_ENV_KEYS
        .iter()
        .filter_map(|&k| env.get(k).map(|v| (k.to_string(), v.clone())))
        .collect()
}

#[cfg(test)]
mod secret_boundary_tests {
    use std::sync::Arc;


    use crate::settings::{MemorySecretStore, SettingsPaths, SettingsService};

    #[test]
    fn provider_view_redacts_credentials_but_runtime_resolution_gets_them() {
        let root = std::env::temp_dir().join("aide-provider-secret-boundary-red");
        let secrets = Arc::new(MemorySecretStore::default());
        let service = SettingsService::new(SettingsPaths::for_test(root), secrets);
        service.initialize_blocking().unwrap();
        service
            .save_provider_input_for_test("p1", "top-secret")
            .unwrap();
        let view = service.list_provider_views().unwrap();
        assert!(view[0].api_key_configured);
        assert!(!serde_json::to_string(&view).unwrap().contains("top-secret"));
        assert_eq!(
            service.resolve_runtime_provider("p1").unwrap().api_key,
            "top-secret"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider_with(model: String, anthropic: String) -> ProviderConfig {
        ProviderConfig {
            id: "x".to_string(),
            kind: ProviderKind::Custom,
            name: String::new(),
            icon: String::new(),
            base_url: String::new(),
            api_key: String::new(),
            auth_token: String::new(),
            model,
            model_mappings: ProviderModelMappings {
                anthropic_model: anthropic,
                ..Default::default()
            },
            effort_level: String::new(),
            auto_compact_window: String::new(),
            autocompact_pct_override: String::new(),
            max_context_tokens: String::new(),
            known_models: Vec::new(),
        }
    }

    /// 旧配置把默认模型放在顶层 model，新结构统一到 model_mappings.anthropic_model。
    /// 反序列化后迁移：顶层 model 非空且 anthropic_model 为空 → 回填，避免丢默认模型。
    #[test]
    fn migrate_backfills_legacy_top_level_model() {
        let mut p = provider_with("claude-sonnet-5".to_string(), String::new());
        migrate_provider_model(&mut p);
        assert_eq!(p.model_mappings.anthropic_model, "claude-sonnet-5");
        assert_eq!(p.model, "claude-sonnet-5"); // 原顶层值保留不丢
    }

    /// anthropic_model 已有值时，旧顶层 model 不覆盖（新配置权威优先）。
    #[test]
    fn migrate_skips_when_anthropic_model_already_set() {
        let mut p = provider_with("legacy".to_string(), "new".to_string());
        migrate_provider_model(&mut p);
        assert_eq!(p.model_mappings.anthropic_model, "new");
    }

    /// 注入逻辑：5 字段非空才注入，空的不进 env。自定义 provider 和系统默认共用。
    #[test]
    fn mappings_to_env_skips_empty_injects_nonempty() {
        let m = ProviderModelMappings {
            anthropic_model: "claude-sonnet-5".to_string(),
            default_sonnet_model: "claude-sonnet-5".to_string(),
            ..Default::default()
        };
        let env = mappings_to_env(&m);
        assert_eq!(
            env.get("ANTHROPIC_MODEL"),
            Some(&"claude-sonnet-5".to_string())
        );
        assert_eq!(
            env.get("ANTHROPIC_DEFAULT_SONNET_MODEL"),
            Some(&"claude-sonnet-5".to_string())
        );
        // 空字段不注入
        assert!(env.get("ANTHROPIC_DEFAULT_OPUS_MODEL").is_none());
        assert!(env.get("ANTHROPIC_DEFAULT_HAIKU_MODEL").is_none());
        assert!(env.get("CLAUDE_CODE_SUBAGENT_MODEL").is_none());
    }

    /// ProviderModelMappings 全空时 mappings_to_env 不注入任何 env（系统默认未配置的
    /// 安全默认——不会污染 spawn env）。
    #[test]
    fn mappings_to_env_empty_yields_nothing() {
        let env = mappings_to_env(&ProviderModelMappings::default());
        assert!(env.is_empty());
    }

    /// auto_compact_window / autocompact_pct_override 非空时注入对应 env，空时不注入
    /// （空 = CLI 自带默认，与 effort_level 同一注入契约）。
    #[test]
    fn provider_to_env_vars_injects_auto_compact_when_nonempty() {
        let p = ProviderConfig {
            auto_compact_window: "500000".to_string(),
            autocompact_pct_override: "80".to_string(),
            ..provider_with(String::new(), String::new())
        };
        let env = provider_to_env_vars(&p);
        assert_eq!(
            env.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW"),
            Some(&"500000".to_string())
        );
        assert_eq!(
            env.get("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"),
            Some(&"80".to_string())
        );
    }

    /// 两个字段为空时不注入，避免污染 spawn env（旧配置无此字段时的安全默认）。
    #[test]
    fn provider_to_env_vars_omits_auto_compact_when_empty() {
        let p = provider_with(String::new(), String::new());
        let env = provider_to_env_vars(&p);
        assert!(env.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW").is_none());
        assert!(env.get("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE").is_none());
    }

    /// max_context_tokens 非空时注入 CLAUDE_CODE_MAX_CONTEXT_TOKENS——直接定模型上下文窗口
    /// 本身（与 auto_compact_window 区别：后者控 auto-compact 阈值且被本窗口夹住）。
    #[test]
    fn provider_to_env_vars_injects_max_context_tokens_when_nonempty() {
        let p = ProviderConfig {
            max_context_tokens: "800000".to_string(),
            ..provider_with(String::new(), String::new())
        };
        let env = provider_to_env_vars(&p);
        assert_eq!(
            env.get("CLAUDE_CODE_MAX_CONTEXT_TOKENS"),
            Some(&"800000".to_string())
        );
    }

    #[test]
    fn provider_to_env_vars_omits_max_context_tokens_when_empty() {
        let env = provider_to_env_vars(&provider_with(String::new(), String::new()));
        assert!(env.get("CLAUDE_CODE_MAX_CONTEXT_TOKENS").is_none());
    }

    #[test]
    fn enrich_fills_preset_identity_from_catalog() {
        let mut p = ProviderConfig {
            id: "cpa".into(),
            kind: ProviderKind::CpaGpt,
            name: "".into(),
            icon: "".into(),
            base_url: "".into(),
            api_key: "".into(),
            auth_token: "".into(),
            model: String::new(),
            model_mappings: ProviderModelMappings::default(),
            effort_level: "".into(),
            auto_compact_window: "".into(),
            autocompact_pct_override: "".into(),
            max_context_tokens: "".into(),
            known_models: vec![],
        };
        enrich(&mut p);
        assert_eq!(p.name, "CPA 中转");
        assert_eq!(p.base_url, "http://127.0.0.1:8317");
    }

    #[test]
    fn strip_clears_preset_identity_keeps_custom() {
        let mut p = ProviderConfig {
            id: "cpa".into(),
            kind: ProviderKind::CpaGpt,
            name: "CPA 中转".into(),
            icon: "C".into(),
            base_url: "http://127.0.0.1:8317".into(),
            api_key: "k".into(),
            auth_token: "t".into(),
            model: String::new(),
            model_mappings: ProviderModelMappings::default(),
            effort_level: "".into(),
            auto_compact_window: "".into(),
            autocompact_pct_override: "".into(),
            max_context_tokens: "".into(),
            known_models: vec![],
        };
        strip(&mut p);
        assert_eq!(p.name, "");
        assert_eq!(p.base_url, "");
        assert_eq!(p.api_key, "k", "credential kept");
        assert_eq!(p.auth_token, "t");
    }

    #[test]
    fn strip_does_not_touch_custom() {
        let mut p = ProviderConfig {
            id: "c".into(),
            kind: ProviderKind::Custom,
            name: "my".into(),
            icon: "M".into(),
            base_url: "https://gw".into(),
            api_key: "".into(),
            auth_token: "".into(),
            model: String::new(),
            model_mappings: ProviderModelMappings::default(),
            effort_level: "".into(),
            auto_compact_window: "".into(),
            autocompact_pct_override: "".into(),
            max_context_tokens: "".into(),
            known_models: vec![],
        };
        strip(&mut p);
        assert_eq!(p.name, "my", "custom identity preserved");
        assert_eq!(p.base_url, "https://gw");
    }

    /// view 把 AuthStatus 合成枚举展开回两个序列化 bool——四个组合逐一验证，
    /// 保证 ProviderConfigView 的 JSON schema 语义不变（前端依赖这两个字段）。
    #[test]
    fn view_expands_auth_status_to_credential_flags() {
        let cfg = provider_with(String::new(), String::new());
        let cases = [
            (AuthStatus::None, false, false),
            (AuthStatus::ApiKey, true, false),
            (AuthStatus::AuthToken, false, true),
            (AuthStatus::Both, true, true),
        ];
        for (status, api, token) in cases {
            let view = cfg.clone().view(status);
            assert_eq!(view.api_key_configured, api, "api_key flag for {status:?}");
            assert_eq!(
                view.auth_token_configured, token,
                "auth_token flag for {status:?}"
            );
        }
    }

    /// view() 转换：SystemDefault kind 的 known_models 从 catalog 预设拿，
    /// 而不是读 self.known_models（持久化里写空 / 没写都无所谓）。
    /// 第三方 kind 走 self.known_models，行为不变。
    #[test]
    fn system_default_view_reads_known_models_from_catalog() {
        let cfg = system_default_provider();
        let view = cfg.view(AuthStatus::None);
        assert_eq!(
            view.known_models,
            vec!["opus", "sonnet", "haiku", "fable"],
            "SystemDefault view().known_models must come from catalog preset, not cfg.known_models"
        );
    }

    #[test]
    fn non_system_default_view_keeps_self_known_models() {
        let mut cfg = system_default_provider();
        cfg.kind = ProviderKind::Ollama;
        cfg.known_models = vec!["qwen2.5:7b".to_string(), "llama3.1:8b".to_string()];
        let view = cfg.view(AuthStatus::None);
        assert_eq!(view.known_models, vec!["qwen2.5:7b", "llama3.1:8b"]);
    }
}
