use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

use super::settings::{load_config, save_config};

/// TUI 时代通过 `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` 把 Claude 别名
/// 偷偷映射到第三方模型的机制已移除——SDK 版模型下拉直接展示供应商的真实
/// 模型 id。只保留子代理模型指定（`CLAUDE_CODE_SUBAGENT_MODEL`，合法能力）。
/// 旧配置里的 opus/sonnet/haiku 字段 serde 反序列化时自动忽略。
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelMappings {
    #[serde(default)]
    pub subagent: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub auth_token: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub model_mappings: ProviderModelMappings,
    #[serde(default)]
    pub effort_level: String,
    #[serde(default)]
    pub known_models: Vec<String>,
}

pub fn provider_to_env_vars(p: &ProviderConfig) -> HashMap<String, String> {
    let mut env = HashMap::new();
    let pairs: &[(&str, &str)] = &[
        ("ANTHROPIC_BASE_URL", &p.base_url),
        ("ANTHROPIC_API_KEY", &p.api_key),
        ("ANTHROPIC_AUTH_TOKEN", &p.auth_token),
        ("ANTHROPIC_MODEL", &p.model),
        ("CLAUDE_CODE_SUBAGENT_MODEL", &p.model_mappings.subagent),
        ("CLAUDE_CODE_EFFORT_LEVEL", &p.effort_level),
    ];
    for (key, val) in pairs {
        if !val.is_empty() {
            env.insert(key.to_string(), val.to_string());
        }
    }
    env
}

/// 决定子进程是否需要因连接身份变化而重启的字段白名单：base_url / api_key /
/// auth_token / 配置目录 / 代理。故意不含 ANTHROPIC_MODEL 等模型相关字段——
/// 模型切换有专门的运行时 `set_model` 通道，不该触发整进程重启（见
/// `chat.rs::set_model`）。
const CONNECTION_ENV_KEYS: &[&str] = &[
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
/// `SidecarManager` 的指纹注册表。返回 owned 是因为 env_vars 在 spawn 后即释放，
/// 指纹要在 stop 后 respawn 时仍可读。
pub fn connection_fingerprint(env: &HashMap<String, String>) -> BTreeMap<String, String> {
    CONNECTION_ENV_KEYS
        .iter()
        .filter_map(|&k| env.get(k).map(|v| (k.to_string(), v.clone())))
        .collect()
}

pub fn load_active_provider() -> Option<ProviderConfig> {
    let config = load_config();
    let active_id = config
        .get("active_provider")
        .and_then(|v| v.as_str())
        .unwrap_or("__system_default__");
    if active_id == "__system_default__" {
        return None;
    }
    let providers = config.get("providers").and_then(|v| v.as_array())?;
    for p in providers {
        if let Ok(pc) = serde_json::from_value::<ProviderConfig>(p.clone()) {
            if pc.id == active_id {
                return Some(pc);
            }
        }
    }
    None
}

#[tauri::command]
pub fn get_providers() -> Result<Vec<ProviderConfig>, String> {
    let _trace = crate::diagnostics::trace_command("get_providers");
    let config = load_config();
    if let Some(arr) = config.get("providers").and_then(|v| v.as_array()) {
        let mut out = Vec::new();
        for item in arr {
            if let Ok(p) = serde_json::from_value::<ProviderConfig>(item.clone()) {
                out.push(p);
            }
        }
        Ok(out)
    } else {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub fn set_providers(providers: Vec<ProviderConfig>) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("set_providers");
    let mut config = load_config();
    if config.is_null() {
        config = serde_json::json!({});
    }
    config["providers"] =
        serde_json::to_value(&providers).map_err(|e| format!("Serialize error: {}", e))?;
    save_config(&config)
}

#[tauri::command]
pub fn get_active_provider_id() -> Result<String, String> {
    let _trace = crate::diagnostics::trace_command("get_active_provider_id");
    let config = load_config();
    let id = config
        .get("active_provider")
        .and_then(|v| v.as_str())
        .unwrap_or("__system_default__")
        .to_string();
    Ok(id)
}

#[tauri::command]
pub fn set_active_provider_id(provider_id: String) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("set_active_provider_id");
    let mut config = load_config();
    if config.is_null() {
        config = serde_json::json!({});
    }
    config["active_provider"] = Value::String(provider_id);
    save_config(&config)
}
