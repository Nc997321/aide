use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub mod sources;
pub mod install;
pub mod manifest;

use super::claude_home;

// ── Types (API response) ──

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntry {
    pub name: String,
    #[serde(default)] pub display_name: String,
    #[serde(default)] pub description: String,
    #[serde(default)] pub version: String,
    #[serde(default)] pub source_id: String,
    #[serde(default)] pub market_name: String,
    #[serde(default)] pub category: String,
    #[serde(default)] pub homepage: String,
    #[serde(default)] pub repository: String,
    /// available | mixed | unavailable | unknown
    pub availability: String,
    #[serde(default)] pub unsupported: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]   // display_name→displayName, installed_at→installedAt
pub struct InstalledPlugin {
    pub name: String,
    pub market: String,
    pub version: String,
    pub display_name: String,
    #[serde(default)] pub description: String,
    #[serde(default)] pub author: String,
    pub path: String,
    pub installed_at: u64,
    pub enabled: bool,
}

/// 桥接清单路径：sidecar 经 env `AIDE_ENABLED_PLUGINS_FILE` 读它。
pub fn enabled_plugins_manifest_path() -> PathBuf {
    super::our_config_dir().join("enabled-plugins.json")
}

pub fn plugins_dir() -> PathBuf {
    claude_home().join("plugins")
}

pub fn marketplace_cache_dir() -> PathBuf {
    super::our_config_dir().join("marketplace-cache")
}

pub fn source_cache_dir(source_id: &str) -> PathBuf {
    marketplace_cache_dir().join(source_id)
}

/// Task 6 实现：扫 cache 最新版本 + 过滤 enabled=true → 写 enabled-plugins.json
/// 本 Task 先放空实现保证编译，Task 6 完善。
pub fn write_enabled_plugins_manifest() -> Result<(), String> {
    Ok(())
}

// ── Commands ──

#[tauri::command]
pub fn list_marketplace_sources() -> Result<Vec<sources::SourceInfo>, String> {
    let s = crate::commands::settings::load_config();
    let enabled: Vec<String> = s.get("settings").and_then(|x| x["enabledMarketplaces"].as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let list = sources::FIXED_SOURCES.iter().map(|(id, repo, name, def)| {
        let never_set = enabled.is_empty();
        let on = enabled.iter().any(|e| e == id) || (never_set && *def);
        sources::SourceInfo { id: id.to_string(), name: name.to_string(), repo: repo.to_string(), enabled: on }
    }).collect();
    Ok(list)
}

#[tauri::command]
pub fn set_marketplace_enabled(source_id: String, enabled: bool) -> Result<(), String> {
    crate::commands::settings::with_config_mut(|cfg| {
        let settings = cfg["settings"].as_object_mut().ok_or("settings missing")?;
        let arr = settings.entry("enabledMarketplaces").or_insert(serde_json::json!([]));
        let a = arr.as_array_mut().ok_or("enabledMarketplaces not array")?;
        let has = a.iter().any(|v| v.as_str() == Some(&source_id));
        if enabled && !has { a.push(serde_json::json!(source_id)); }
        if !enabled { a.retain(|v| v.as_str() != Some(&source_id)); }
        Ok(())
    })
}
