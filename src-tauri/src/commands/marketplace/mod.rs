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

#[derive(Serialize)]
struct EnabledPluginEntry { name: String, marketplace: String, path: String }

/// 扫 cache 最新版本 + 过滤 enabled=true → 写 enabled-plugins.json
pub fn write_enabled_plugins_manifest() -> Result<(), String> {
    let cfg = crate::commands::settings::load_config();
    let enabled: std::collections::BTreeMap<String, bool> = cfg.get("settings")
        .and_then(|s| s["enabledPlugins"].as_object())
        .map(|o| o.iter().filter_map(|(k, v)| v.as_bool().map(|b| (k.clone(), b))).collect())
        .unwrap_or_default();
    let cache = plugins_dir().join("cache");
    let mut entries = Vec::new();
    if let Ok(markets) = std::fs::read_dir(&cache) {
        for mk in markets.flatten() {
            let market = mk.file_name().to_string_lossy().to_string();
            if let Ok(plugins) = std::fs::read_dir(mk.path()) {
                for p in plugins.flatten() {
                    let plugin = p.file_name().to_string_lossy().to_string();
                    let key = format!("{plugin}@{market}");
                    if enabled.get(&key) != Some(&true) { continue; }
                    if let Some(latest) = install::latest_version_dir(&p.path()) {
                        entries.push(EnabledPluginEntry {
                            name: plugin.clone(),
                            marketplace: market.clone(),
                            path: latest.to_string_lossy().to_string(),
                        });
                    }
                }
            }
        }
    }
    let json = serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())?;
    atomic_write(&enabled_plugins_manifest_path(), &json)
}

fn atomic_write(path: &std::path::Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

fn with_config_mut_settings<F: FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> Result<(), String>>(f: F) -> Result<(), String> {
    crate::commands::settings::with_config_mut(|cfg| {
        if cfg["settings"].is_null() { cfg["settings"] = serde_json::json!({}); }
        let s = cfg["settings"].as_object_mut().ok_or("settings not object")?;
        f(s)
    })
}

#[tauri::command]
pub async fn set_plugin_enabled(marketplace: String, plugin: String, enabled: bool) -> Result<(), String> {
    // 重 IO（config 读写 + cache 目录扫描 + 清单落盘）→ spawn_blocking，不占主线程
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let key = format!("{plugin}@{marketplace}");
        with_config_mut_settings(|s| {
            let m = s.entry("enabledPlugins").or_insert(serde_json::json!({}));
            if let Some(obj) = m.as_object_mut() {
                obj.insert(key.clone(), serde_json::json!(enabled));
            }
            Ok::<_, String>(())
        })?;
        write_enabled_plugins_manifest()
    }).await.map_err(|e| e.to_string())?
}

// ── Commands ──

#[tauri::command]
pub async fn list_marketplace_sources() -> Result<Vec<sources::SourceInfo>, String> {
    // 读 config 文件 → spawn_blocking，不占主线程
    tokio::task::spawn_blocking(|| -> Result<Vec<sources::SourceInfo>, String> {
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
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_plugin_details(source_id: String, plugin_name: String) -> Result<manifest::PluginDetails, String> {
    tokio::task::spawn_blocking(move || -> Result<manifest::PluginDetails, String> {
        let (_market, entry) = install::lookup_entry(&source_id, &plugin_name)?;
        Ok(manifest::build_details_from_entry(&entry))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_marketplace_enabled(source_id: String, enabled: bool) -> Result<(), String> {
    // config 读写 → spawn_blocking，不占主线程
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        crate::commands::settings::with_config_mut(|cfg| {
            let settings = cfg["settings"].as_object_mut().ok_or("settings missing")?;
            let arr = settings.entry("enabledMarketplaces").or_insert(serde_json::json!([]));
            let a = arr.as_array_mut().ok_or("enabledMarketplaces not array")?;
            let has = a.iter().any(|v| v.as_str() == Some(&source_id));
            if enabled && !has { a.push(serde_json::json!(source_id)); }
            if !enabled { a.retain(|v| v.as_str() != Some(&source_id)); }
            Ok(())
        })
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manifest_path_under_config_dir() {
        let p = enabled_plugins_manifest_path();
        assert!(p.to_string_lossy().contains("enabled-plugins.json"));
    }
}
