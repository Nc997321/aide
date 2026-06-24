use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

use super::settings::{load_config, save_config};

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelMappings {
    #[serde(default)]
    pub opus: String,
    #[serde(default)]
    pub sonnet: String,
    #[serde(default)]
    pub haiku: String,
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
        ("ANTHROPIC_DEFAULT_OPUS_MODEL", &p.model_mappings.opus),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL", &p.model_mappings.sonnet),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL", &p.model_mappings.haiku),
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
    let mut config = load_config();
    if config.is_null() {
        config = serde_json::json!({});
    }
    config["active_provider"] = Value::String(provider_id);
    save_config(&config)
}
