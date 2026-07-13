use serde::{Deserialize, Serialize};
use std::fs;
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
pub struct InstalledPlugin {
    pub name: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub repo_url: String,
    pub path: String,
    pub installed_at: u64,
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

// ── Commands ──

/// 同步命令 + git clone 子进程，同 fetch_marketplace 的风险，见其上注释。
#[tauri::command]
pub fn install_plugin(repo_url: String, name: String) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("install_plugin");
    let target_dir = plugins_dir().join(&name);

    if target_dir.exists() {
        return Err(format!("插件 '{}' 已安装", name));
    }

    fs::create_dir_all(plugins_dir())
        .map_err(|e| format!("Failed to create plugins directory: {}", e))?;

    let output = install::git_clone(&repo_url, &target_dir)
        .map_err(|e| format!("Failed to run git clone: {}. Is Git installed?", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if target_dir.exists() {
            let _ = fs::remove_dir_all(&target_dir);
        }
        return Err(format!("Git 克隆失败: {}", install::git_err(&stderr)));
    }

    let manifest_path = target_dir.join(".claude-plugin").join("plugin.json");
    if !manifest_path.exists() {
        let _ = fs::remove_dir_all(&target_dir);
        return Err(format!(
            "插件 '{}' 缺少 .claude-plugin/plugin.json 清单文件",
            name
        ));
    }

    Ok(())
}

#[tauri::command]
pub fn uninstall_plugin(name: String) -> Result<(), String> {
    let target_dir = plugins_dir().join(&name);

    if !target_dir.exists() {
        return Err(format!("插件 '{}' 未找到", name));
    }

    fs::remove_dir_all(&target_dir)
        .map_err(|e| format!("Failed to uninstall plugin '{}': {}", name, e))
}

#[tauri::command]
pub fn list_installed_plugins() -> Result<Vec<InstalledPlugin>, String> {
    let dir = plugins_dir();

    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut plugins = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let manifest_path = path.join(".claude-plugin").join("plugin.json");
            let (title, description, author) = if manifest_path.exists() {
                if let Ok(content) = fs::read_to_string(&manifest_path) {
                    if let Ok(manifest) = serde_json::from_str::<manifest::PluginManifest>(&content) {
                        (
                            if manifest.title.is_empty() {
                                manifest.name.clone()
                            } else {
                                manifest.title
                            },
                            manifest.description,
                            manifest.author,
                        )
                    } else {
                        (String::new(), String::new(), String::new())
                    }
                } else {
                    (String::new(), String::new(), String::new())
                }
            } else {
                (String::new(), String::new(), String::new())
            };

            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();

            let repo_url = install::get_remote_url(&path).unwrap_or_default();
            let installed_at = fs::metadata(&path)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);

            plugins.push(InstalledPlugin {
                name: name.clone(),
                title: if title.is_empty() { name } else { title },
                description,
                author,
                repo_url,
                path: path.to_string_lossy().to_string(),
                installed_at,
            });
        }
    }

    Ok(plugins)
}

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
