use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

use tauri::State;

use crate::settings::{SettingsError, SettingsScope, SettingsService};

pub mod bundled;
pub mod install;
pub mod manifest;
pub mod sources;

// ── Types (API response) ──

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntry {
    pub name: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub description: String,
    /// 给用户看的语义版本（marketplace.json 的 `version` 字段）。sha-pinned 插件
    /// 此字段为空——marketplace.json 不带语义版本，只有 sha，前端展示时回退 "—"。
    #[serde(default)]
    pub version: String,
    /// 安装身份 = marketplace 的 version 或 short_sha(sha)（与 `install_git` 落盘的
    /// 版本目录名同源）。**仅用于 hasUpdate 比对**，不展示给用户。
    #[serde(default)]
    pub version_id: String,
    #[serde(default)]
    pub source_id: String,
    #[serde(default)]
    pub market_name: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub homepage: String,
    #[serde(default)]
    pub repository: String,
    /// available | mixed | unavailable | unknown
    pub availability: String,
    #[serde(default)]
    pub unsupported: Vec<String>,
    /// Aide 内置清单提供的图标（data:image/png;base64 URL，字节内嵌于二进制，
    /// 不依赖 resource 协议/网络）。无图标 → None，前端回退首字母占位。
    #[serde(default)]
    pub icon: Option<String>,
    /// Aide 精选推荐标记（内置清单驱动，前端「精选推荐」区块用）。
    #[serde(default)]
    pub is_featured: bool,
    /// 这个插件声明了语言服务器（marketplace.json 的 `lspServers`，见 manifest::provides_lsp）。
    /// 前端据它给卡片加一行「已由 Aide 接管」说明：C3 起 aide-lsp 会在受信任工作区退役
    /// 这类插件（运行时抑制），卡片上却仍显示「已启用」——不说明用户无从理解。
    #[serde(default)]
    pub provides_lsp: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")] // display_name→displayName, installed_at→installedAt, version_id→versionId
pub struct InstalledPlugin {
    pub name: String,
    pub market: String,
    /// 给用户看的语义版本（来自 plugin.json 的 `version` 字段，如 "6.2.0"）。
    /// 仅用于显示；sha-pinned 插件无 plugin.json version 时为空。
    pub version: String,
    /// 安装身份 = 版本目录名（sha-pinned 源为 short_sha、version 字段源为 marketplace
    /// version、relative 源为 "local" 或源 plugin.json version）。**仅用于 hasUpdate
    /// 比对**（与 `entry.version` 同源，可比），不展示给用户——sha 对用户无意义。
    pub version_id: String,
    pub display_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    pub path: String,
    pub installed_at: u64,
    pub enabled: bool,
}

/// 桥接清单路径：sidecar 经 env `AIDE_ENABLED_PLUGINS_FILE` 读它。
/// `~/.aide/claude/plugins/enabled-plugins.json`
pub fn enabled_plugins_manifest_path() -> PathBuf {
    super::claude_home()
        .join("plugins")
        .join("enabled-plugins.json")
}

/// 已安装插件本体所在目录：`~/.aide/claude/plugins/`。
/// 与迁移目标 `~/.claude/plugins/` 对齐，Aide 经 `AIDE_ENABLED_PLUGINS_FILE`
/// 显式控制加载，不与 CLI 的 `installed_plugins.json` 混用账本。
pub fn plugins_dir() -> PathBuf {
    super::claude_home().join("plugins")
}

/// 市场源仓库克隆目录（marketplace.json 来源）：
/// `~/.aide/claude/plugins/marketplace-cache/`
pub fn marketplace_cache_dir() -> PathBuf {
    super::claude_home()
        .join("plugins")
        .join("marketplace-cache")
}

pub fn source_cache_dir(source_id: &str) -> PathBuf {
    marketplace_cache_dir().join(source_id)
}

#[derive(Serialize)]
struct EnabledPluginEntry {
    name: String,
    marketplace: String,
    path: String,
}

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
pub fn write_enabled_plugins_manifest(service: &SettingsService) -> Result<(), String> {
    let settings = read_user_settings(service)?.unwrap_or_else(|| serde_json::json!({}));
    let enabled: std::collections::BTreeMap<String, bool> = settings
        .get("enabledPlugins")
        .and_then(|v| v.as_object())
        .map(|o| {
            o.iter()
                .filter_map(|(k, v)| v.as_bool().map(|b| (k.clone(), b)))
                .collect()
        })
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
                    if !plugin_enabled(&enabled, &key) {
                        continue;
                    }
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
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

/// 读 user-scope `settings` 子对象的克隆（settings.json 迁移后是唯一真源；
/// 键缺失返回 None）。市场模块禁止再走 `load_config`/`with_config_mut`——
/// 旧 config.json 已删除，那条路径会读到 Null 并报 "settings missing"。
fn read_user_settings(service: &SettingsService) -> Result<Option<serde_json::Value>, String> {
    let effective = service
        .effective_document_blocking(None)
        .map_err(|e| e.to_string())?;
    Ok(effective.values.get("settings").cloned())
}

/// 在 user-scope `settings` 子对象上做一次原子改写（读→改→校验→写）。
/// `settings` 键缺失时播种为 `{}`，闭包内可直接 `entry()/insert`。与 `set_settings`
/// 同一条 `mutate_scope_blocking` 路径，确保落盘到 settings.json 而非复活的 config.json。
fn mutate_user_settings<F>(service: &SettingsService, f: F) -> Result<(), String>
where
    F: FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> Result<(), String>,
{
    service
        .mutate_scope_blocking(SettingsScope::User, None, |document| {
            let target = document
                .values
                .entry("settings".to_string())
                .or_insert_with(|| serde_json::json!({}));
            let target = target.as_object_mut().ok_or_else(|| {
                SettingsError::Validation("settings must be an object".to_string())
            })?;
            f(target).map_err(SettingsError::Validation)
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_plugin_enabled(
    marketplace: String,
    plugin: String,
    enabled: bool,
    service: State<'_, Arc<SettingsService>>,
) -> Result<(), String> {
    // 重 IO（settings 读写 + cache 目录扫描 + 清单落盘）→ spawn_blocking，不占主线程
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let key = format!("{plugin}@{marketplace}");
        mutate_user_settings(&service, |s| {
            let m = s.entry("enabledPlugins").or_insert(serde_json::json!({}));
            if let Some(obj) = m.as_object_mut() {
                obj.insert(key.clone(), serde_json::json!(enabled));
            }
            Ok(())
        })?;
        write_enabled_plugins_manifest(&service)
    })
    .await
    .map_err(|e| e.to_string())?
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
    sources::FIXED_SOURCES
        .iter()
        .map(|(id, _, _, def)| {
            if configured {
                explicit.iter().any(|e| e == id)
            } else {
                *def
            }
        })
        .collect()
}

#[tauri::command]
pub async fn list_marketplace_sources(
    service: State<'_, Arc<SettingsService>>,
) -> Result<Vec<sources::SourceInfo>, String> {
    // 读 settings.json → spawn_blocking，不占主线程
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<Vec<sources::SourceInfo>, String> {
        let settings = read_user_settings(&service)?;
        // 键存在 = 已配置（按字面量，空=全关）；键不存在 = 从未配置（取默认）
        let configured = settings
            .as_ref()
            .and_then(|x| x.get("enabledMarketplaces"))
            .is_some();
        let explicit: Vec<String> = settings
            .as_ref()
            .and_then(|x| x["enabledMarketplaces"].as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let states = resolve_source_states(configured, &explicit);
        let list = sources::FIXED_SOURCES
            .iter()
            .zip(states.into_iter())
            .map(|((id, repo, name, _), on)| sources::SourceInfo {
                id: id.to_string(),
                name: name.to_string(),
                repo: repo.to_string(),
                enabled: on,
            })
            .collect();
        Ok(list)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_marketplace_enabled(
    source_id: String,
    enabled: bool,
    service: State<'_, Arc<SettingsService>>,
) -> Result<(), String> {
    // settings 读写 → spawn_blocking，不占主线程
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        mutate_user_settings(&service, |s| {
            // 首次配置（键此前不存在）→ 先用默认启用源播种，再应用本次显式选择。
            // 否则关闭一个默认启用的源时，它从未入表，retain 无效，数组仍空，
            // list_marketplace_sources 会按「从未配置」把所有默认源重新点亮。
            let first_config = !s.contains_key("enabledMarketplaces");
            let arr = s
                .entry("enabledMarketplaces")
                .or_insert(serde_json::json!([]));
            let a = arr.as_array_mut().ok_or("enabledMarketplaces not array")?;
            if first_config {
                for (id, _, _, def) in sources::FIXED_SOURCES.iter() {
                    if *def {
                        a.push(serde_json::json!(id));
                    }
                }
            }
            let has = a.iter().any(|v| v.as_str() == Some(&source_id));
            if enabled && !has {
                a.push(serde_json::json!(source_id));
            }
            if !enabled {
                a.retain(|v| v.as_str() != Some(&source_id));
            }
            Ok(())
        })
    })
    .await
    .map_err(|e| e.to_string())?
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
        assert!(plugin_enabled(
            &empty,
            "superpowers@claude-plugins-official"
        ));
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
        assert!(sources::FIXED_SOURCES
            .iter()
            .any(|(id, _, _, def)| *id == official && *def));
        assert!(sources::FIXED_SOURCES
            .iter()
            .any(|(id, _, _, def)| *id == community && *def));

        // 从未配置（键不存在）→ 取默认：两者都开
        let s = resolve_source_states(false, &[]);
        assert_eq!(s, vec![true, true]);

        // 首次配置播种后关闭 community → 显式列表只剩 official
        let explicit: Vec<String> = vec![official.to_string()];
        let s = resolve_source_states(true, &explicit);
        assert_eq!(s, vec![true, false], "official on, community off");

        // 全部显式关闭 → 空列表，但已配置 → 全关（不回弹为默认开）
        let s = resolve_source_states(true, &[]);
        assert_eq!(
            s,
            vec![false, false],
            "configured+empty = all off, not defaults"
        );

        // 重新只开 official
        let s = resolve_source_states(true, &vec![official.to_string()]);
        assert_eq!(s, vec![true, false]);
    }
}
