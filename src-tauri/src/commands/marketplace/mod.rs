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

/// 一个已安装插件是否启用。键不存在 = 启用（与安装时 `default_enabled.unwrap_or(true)`
/// 对齐：插件出现在 cache 里即视为已安装且启用，除非用户显式置 false）。
///
/// 这解决了「CLI/SDK 直接装进 cache 的插件在 Aide 里显示已禁用」的问题——它们从未经
/// Aide 的 install 按钮写入 enabledPlugins 映射，旧逻辑用 `unwrap_or(false)`/`!= Some(&true)`
/// 把「不在映射里」当成禁用，既与安装默认启用矛盾，又导致这些插件不被注入 sidecar。
/// `list_installed_plugins` 与 `write_enabled_plugins_manifest` 共用此判定，保持一致。
fn plugin_enabled(enabled: &std::collections::BTreeMap<String, bool>, key: &str) -> bool {
    enabled.get(key) != Some(&false)
}

/// 扫 cache 最新版本 + 过滤启用项 → 写 enabled-plugins.json
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
                    if !plugin_enabled(&enabled, &key) { continue; }
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

/// 纯逻辑：据配置状态计算每个固定源的启用状态（与 IO 分离以便单测）。
///
/// `configured=false`（`enabledMarketplaces` 键不存在，从未配置）→ 各源取默认值；
/// `configured=true`（键存在，用户已显式配置）→ 按显式列表，空列表=全关。
///
/// 用「键是否存在」而非「数组是否为空」区分这两种状态——否则关闭一个默认启用的
/// 源后数组仍空，会被误判回「从未配置」而回弹为开。
fn resolve_source_states(configured: bool, explicit: &[String]) -> Vec<bool> {
    sources::FIXED_SOURCES.iter().map(|(id, _, _, def)| {
        if configured { explicit.iter().any(|e| e == id) } else { *def }
    }).collect()
}

#[tauri::command]
pub async fn list_marketplace_sources() -> Result<Vec<sources::SourceInfo>, String> {
    // 读 config 文件 → spawn_blocking，不占主线程
    tokio::task::spawn_blocking(|| -> Result<Vec<sources::SourceInfo>, String> {
        let s = crate::commands::settings::load_config();
        let settings = s.get("settings");
        // 键存在 = 已配置（按字面量，空=全关）；键不存在 = 从未配置（取默认）
        let configured = settings.and_then(|x| x.get("enabledMarketplaces")).is_some();
        let explicit: Vec<String> = settings.and_then(|x| x["enabledMarketplaces"].as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let states = resolve_source_states(configured, &explicit);
        let list = sources::FIXED_SOURCES.iter().zip(states.into_iter())
            .map(|((id, repo, name, _), on)| sources::SourceInfo {
                id: id.to_string(), name: name.to_string(), repo: repo.to_string(), enabled: on,
            }).collect();
        Ok(list)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_marketplace_enabled(source_id: String, enabled: bool) -> Result<(), String> {
    // config 读写 → spawn_blocking，不占主线程
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        crate::commands::settings::with_config_mut(|cfg| {
            let settings = cfg["settings"].as_object_mut().ok_or("settings missing")?;
            // 首次配置（键此前不存在）→ 先用默认启用源播种，再应用本次显式选择。
            // 否则关闭一个默认启用的源时，它从未入表，retain 无效，数组仍空，
            // list_marketplace_sources 会按「从未配置」把所有默认源重新点亮。
            let first_config = !settings.contains_key("enabledMarketplaces");
            let arr = settings.entry("enabledMarketplaces").or_insert(serde_json::json!([]));
            let a = arr.as_array_mut().ok_or("enabledMarketplaces not array")?;
            if first_config {
                for (id, _, _, def) in sources::FIXED_SOURCES.iter() {
                    if *def { a.push(serde_json::json!(id)); }
                }
            }
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

    /// 回归：CLI/SDK 直接装进 cache 的插件未经 Aide install 按钮写入 enabledPlugins 映射，
    /// 旧逻辑 `unwrap_or(false)` 把「不在映射里」当成禁用。现在键不存在 = 启用。
    #[test]
    fn plugin_enabled_treats_absent_as_enabled() {
        let empty: std::collections::BTreeMap<String, bool> = std::collections::BTreeMap::new();
        // 空 map（CLI 装的、未经 Aide install）→ 启用
        assert!(plugin_enabled(&empty, "superpowers@claude-plugins-official"));
        // 显式 true → 启用
        let mut m = std::collections::BTreeMap::new();
        m.insert("a@m".into(), true);
        assert!(plugin_enabled(&m, "a@m"));
        // 显式 false → 禁用（用户手动禁用）
        m.insert("a@m".into(), false);
        assert!(!plugin_enabled(&m, "a@m"));
        // 别的键存在、本键缺失 → 仍启用
        m.remove("a@m");
        m.insert("other@m".into(), false);
        assert!(plugin_enabled(&m, "a@m"));
    }

    /// 回归：关闭一个默认启用的源不应让其他默认源跟着关，也不应回弹为开。
    /// 根因曾是把「数组为空」当作「从未配置」，导致关闭默认源后 list 仍返回开。
    #[test]
    fn source_enabled_resolution_distinguishes_unconfigured_from_all_off() {
        // 两个固定源都默认开
        let official = "claude-plugins-official";
        let community = "claude-community";
        assert!(sources::FIXED_SOURCES.iter().any(|(id, _, _, def)| *id == official && *def));
        assert!(sources::FIXED_SOURCES.iter().any(|(id, _, _, def)| *id == community && *def));

        // 从未配置（键不存在）→ 取默认：两者都开
        let s = resolve_source_states(false, &[]);
        assert_eq!(s, vec![true, true]);

        // 首次配置播种后关闭 community → 显式列表只剩 official
        let explicit: Vec<String> = vec![official.to_string()];
        let s = resolve_source_states(true, &explicit);
        assert_eq!(s, vec![true, false], "official on, community off");

        // 全部显式关闭 → 空列表，但已配置 → 全关（不回弹为默认开）
        let s = resolve_source_states(true, &[]);
        assert_eq!(s, vec![false, false], "configured+empty = all off, not defaults");

        // 重新只开 official
        let s = resolve_source_states(true, &vec![official.to_string()]);
        assert_eq!(s, vec![true, false]);
    }
}
