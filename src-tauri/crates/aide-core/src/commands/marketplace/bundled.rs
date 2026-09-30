//! Aide 内置插件清单：启动时自动安装 + 图标/精选元数据合并 + 卸载墓碑。
//!
//! 设计决策（见 docs/builtin-plugins-plan.md 第八节风险）：
//! - **离线首次启动**（风险 8.1）：接受风险（方案 A）。源克隆/插件安装失败只记日志
//!   跳过，不阻塞启动；下次有网启动时重试。不打包含插件本体 fallback。
//! - **内置插件更新**（风险 8.2）：启动时比对已安装版本目录名（version_id）与源
//!   缓存 marketplace.json 的安装身份（version 或 short_sha），不一致则重装到新
//!   版本目录。更新不动 enabled 状态（用户手动禁用优先）。
//! - **清单位置**（待确认 2）：硬编码在代码里（与 sources.rs FIXED_SOURCES 同风格），
//!   发版时更新。
//! - **图标下发**：PNG 经 `include_bytes!` 内嵌进二进制，以 data URL 形式挂在
//!   `PluginEntry.icon` 上下发。不走 Tauri resource 协议——asset protocol 未开启，
//!   data URL 在桌面与 remote-pwa 下行为一致，且 dev/release 无路径差异。
//! - **卸载墓碑**（计划外补充）：用户显式卸载内置插件后，启动时不得复活安装——
//!   卸载时把 `{name}@{market}` 记入 settings 的 `uninstalledBundledPlugins`，
//!   手动重新安装时清除。

use base64::Engine as _;

use crate::settings::SettingsService;

use super::{install, sources, PluginEntry};

/// 内置/精选插件元数据（硬编码，发版时更新）。
pub struct BundledPlugin {
    pub name: &'static str,
    pub source_id: &'static str,
    /// 内嵌图标 PNG 字节（include_bytes!）；None → 前端首字母占位。
    pub icon_png: Option<&'static [u8]>,
    /// 精选推荐（前端「精选推荐」区块）。
    pub is_featured: bool,
    /// 启动时自动安装。false = 仅挂图标/精选元数据，不装。
    pub auto_install: bool,
    /// 首次安装的默认启用态（仅首次写入；用户之后的禁用/卸载优先）。
    pub default_enabled: bool,
}

macro_rules! icon {
    ($file:literal) => {
        Some(include_bytes!(concat!(
            "icons/",
            $file
        )))
    };
}

/// 内置插件清单。
///
/// 首批自动安装（auto_install=true）：无需外部账号即可用的工作流插件。
/// MCP 集成类（github/slack/…）需要凭证，只挂图标与精选标记，不自动安装。
static BUNDLED: &[BundledPlugin] = &[
    BundledPlugin {
        name: "superpowers",
        source_id: "claude-plugins-official",
        icon_png: icon!("superpowers.png"),
        is_featured: true,
        auto_install: true,
        default_enabled: true,
    },
    BundledPlugin {
        name: "commit-commands",
        source_id: "claude-plugins-official",
        icon_png: icon!("commit-commands.png"),
        is_featured: true,
        auto_install: true,
        default_enabled: true,
    },
    BundledPlugin {
        name: "pr-review-toolkit",
        source_id: "claude-plugins-official",
        icon_png: icon!("pr-review-toolkit.png"),
        is_featured: true,
        auto_install: true,
        default_enabled: true,
    },
    BundledPlugin {
        name: "security-guidance",
        source_id: "claude-plugins-official",
        icon_png: icon!("security-guidance.png"),
        is_featured: true,
        auto_install: true,
        default_enabled: true,
    },
    // ── 精选推荐但不自动安装（需要外部账号/凭证）──
    BundledPlugin {
        name: "github",
        source_id: "claude-plugins-official",
        icon_png: icon!("github.png"),
        is_featured: true,
        auto_install: false,
        default_enabled: true,
    },
    BundledPlugin {
        name: "playwright",
        source_id: "claude-plugins-official",
        icon_png: icon!("playwright.png"),
        is_featured: true,
        auto_install: false,
        default_enabled: true,
    },
    // ── 仅挂图标 ──
    BundledPlugin {
        name: "hookify",
        source_id: "claude-plugins-official",
        icon_png: icon!("hookify.png"),
        is_featured: false,
        auto_install: false,
        default_enabled: true,
    },
    BundledPlugin {
        name: "frontend-design",
        source_id: "claude-plugins-official",
        icon_png: icon!("frontend-design.png"),
        is_featured: false,
        auto_install: false,
        default_enabled: true,
    },
    BundledPlugin {
        name: "agent-sdk-dev",
        source_id: "claude-plugins-official",
        icon_png: icon!("agent-sdk-dev.png"),
        is_featured: false,
        auto_install: false,
        default_enabled: true,
    },
    BundledPlugin {
        name: "plugin-dev",
        source_id: "claude-plugins-official",
        icon_png: icon!("plugin-dev.png"),
        is_featured: false,
        auto_install: false,
        default_enabled: true,
    },
    BundledPlugin {
        name: "typescript-lsp",
        source_id: "claude-plugins-official",
        icon_png: icon!("typescript-lsp.png"),
        is_featured: false,
        auto_install: false,
        default_enabled: true,
    },
    BundledPlugin {
        name: "pyright-lsp",
        source_id: "claude-plugins-official",
        icon_png: icon!("pyright-lsp.png"),
        is_featured: false,
        auto_install: false,
        default_enabled: true,
    },
];

pub fn bundled_plugins() -> &'static [BundledPlugin] {
    BUNDLED
}

fn icon_data_url(bytes: &[u8]) -> String {
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// 给 marketplace 条目合并内置清单的图标与精选标记（fetch_marketplace 后处理）。
pub fn merge_bundled_metadata(entries: &mut [PluginEntry]) {
    for entry in entries.iter_mut() {
        if let Some(b) = BUNDLED
            .iter()
            .find(|b| b.name == entry.name && b.source_id == entry.source_id)
        {
            entry.icon = b.icon_png.map(icon_data_url);
            entry.is_featured = b.is_featured;
        }
    }
}

// ── 卸载墓碑 ──
// settings.uninstalledBundledPlugins: ["{name}@{market}", ...]
// 用户显式卸载内置插件 = 明确意图，启动时不得复活安装；手动重装时清除。

const TOMBSTONE_KEY: &str = "uninstalledBundledPlugins";

fn tombstone_add(map: &mut serde_json::Map<String, serde_json::Value>, key: &str) {
    let arr = map
        .entry(TOMBSTONE_KEY)
        .or_insert_with(|| serde_json::json!([]));
    if let Some(a) = arr.as_array_mut() {
        if !a.iter().any(|v| v.as_str() == Some(key)) {
            a.push(serde_json::json!(key));
        }
    }
}

fn tombstone_remove(map: &mut serde_json::Map<String, serde_json::Value>, key: &str) {
    if let Some(a) = map.get_mut(TOMBSTONE_KEY).and_then(|v| v.as_array_mut()) {
        a.retain(|v| v.as_str() != Some(key));
    }
}

fn tombstones(service: &SettingsService) -> Vec<String> {
    super::read_user_settings(service)
        .ok()
        .flatten()
        .and_then(|s| {
            s.get(TOMBSTONE_KEY)?.as_array().map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
        })
        .unwrap_or_default()
}

fn is_tombstoned(service: &SettingsService, name: &str, market: &str) -> bool {
    let key = format!("{name}@{market}");
    tombstones(service).contains(&key)
}

/// 卸载内置插件时记墓碑（仅 auto_install 的插件需要；非自动安装的卸载无需拦截）。
pub fn mark_uninstalled_if_bundled(service: &SettingsService, name: &str, market: &str) {
    let is_bundled = BUNDLED.iter().any(|b| {
        b.auto_install
            && b.name == name
            && sources::default_market_name(b.source_id).unwrap_or(b.source_id) == market
    });
    if !is_bundled {
        return;
    }
    let key = format!("{name}@{market}");
    let _ = super::mutate_user_settings(service, |s| {
        tombstone_add(s, &key);
        Ok(())
    });
}

/// 安装（手动或自动）时清除墓碑——用户重新安装 = 撤销卸载意图。
pub fn clear_tombstone(service: &SettingsService, name: &str, market: &str) {
    let key = format!("{name}@{market}");
    let _ = super::mutate_user_settings(service, |s| {
        tombstone_remove(s, &key);
        Ok(())
    });
}

// ── 启动时自动安装 ──

/// 启动时确保内置插件已安装：缺失→安装；版本落后源缓存→更新；被卸载（墓碑）→跳过。
/// 单插件失败只记日志，不阻塞启动；离线时源克隆失败整轮记 warn，下次启动重试。
pub fn ensure_bundled_plugins_installed(service: &SettingsService) {
    for bp in BUNDLED.iter().filter(|b| b.auto_install) {
        let market = sources::default_market_name(bp.source_id).unwrap_or(bp.source_id);
        if is_tombstoned(service, bp.name, market) {
            tracing::info!("内置插件 {}@{} 已被用户卸载，跳过自动安装", bp.name, market);
            continue;
        }
        match ensure_one(service, bp, market) {
            Ok(outcome) => {
                if outcome != Outcome::AlreadyCurrent {
                    tracing::info!("内置插件 {}@{}: {:?}", bp.name, market, outcome);
                }
            }
            Err(e) => {
                tracing::warn!(
                    "内置插件 {}@{} 安装/更新失败（跳过，不影响启动）: {e}",
                    bp.name,
                    market
                );
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    AlreadyCurrent,
    Installed,
    Updated,
}

fn ensure_one(
    service: &SettingsService,
    bp: &BundledPlugin,
    market: &str,
) -> Result<Outcome, String> {
    install::ensure_source_cache(bp.source_id)?;
    let installed_ver = install::installed_version_id(market, bp.name);
    let Some(installed_ver) = installed_ver else {
        // 未安装 → 首次安装（写入默认启用态）
        install::install_plugin_blocking(service, bp.source_id, bp.name, Some(bp.default_enabled))?;
        return Ok(Outcome::Installed);
    };
    // 已安装 → 比对安装身份（version 或 short_sha），不一致则更新；enabled 状态不动。
    let (_, entry) = install::lookup_entry(bp.source_id, bp.name)?;
    let catalog_ver = entry
        .version
        .clone()
        .unwrap_or_else(|| install::resolved_version_from_source(&entry.source));
    if catalog_ver.is_empty() || installed_ver == catalog_ver {
        return Ok(Outcome::AlreadyCurrent);
    }
    let plugin_root = install::read_marketplace_plugin_root(bp.source_id);
    install::resolve_and_install(
        bp.source_id,
        market,
        bp.name,
        &entry,
        plugin_root.as_deref(),
    )?;
    super::write_enabled_plugins_manifest(service)?;
    Ok(Outcome::Updated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_list_references_fixed_sources_and_unique_names() {
        let mut seen = std::collections::HashSet::new();
        for bp in BUNDLED {
            assert!(
                sources::default_market_name(bp.source_id).is_some(),
                "{} 的 source_id {} 不在 FIXED_SOURCES",
                bp.name,
                bp.source_id
            );
            assert!(seen.insert(bp.name), "重复的内置插件名 {}", bp.name);
        }
        // 至少要有一个自动安装 + 一个精选，否则功能形同虚设
        assert!(BUNDLED.iter().any(|b| b.auto_install));
        assert!(BUNDLED.iter().any(|b| b.is_featured));
    }

    #[test]
    fn embedded_icons_are_valid_png() {
        for bp in BUNDLED {
            if let Some(bytes) = bp.icon_png {
                assert!(
                    bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
                    "{} 的图标不是有效 PNG",
                    bp.name
                );
            }
        }
    }

    #[test]
    fn merge_sets_icon_and_featured_only_for_listed_plugins() {
        let mut entries = vec![
            PluginEntry {
                name: "superpowers".into(),
                source_id: "claude-plugins-official".into(),
                ..Default::default()
            },
            PluginEntry {
                name: "not-bundled".into(),
                source_id: "claude-plugins-official".into(),
                ..Default::default()
            },
        ];
        merge_bundled_metadata(&mut entries);
        assert!(entries[0].is_featured);
        assert!(entries[0]
            .icon
            .as_deref()
            .unwrap_or("")
            .starts_with("data:image/png;base64,"));
        assert!(!entries[1].is_featured);
        assert!(entries[1].icon.is_none());
    }

    #[test]
    fn tombstone_add_is_idempotent_and_remove_works() {
        let mut map = serde_json::Map::new();
        tombstone_add(&mut map, "a@m");
        tombstone_add(&mut map, "a@m");
        tombstone_add(&mut map, "b@m");
        let arr = map[TOMBSTONE_KEY].as_array().unwrap();
        assert_eq!(arr.len(), 2, "重复添加去重");
        tombstone_remove(&mut map, "a@m");
        let arr = map[TOMBSTONE_KEY].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0].as_str(), Some("b@m"));
        // 移除不存在的键不 panic
        tombstone_remove(&mut map, "zzz@m");
    }
}
