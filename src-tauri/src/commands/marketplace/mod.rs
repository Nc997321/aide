use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

pub mod sources;
pub mod install;
pub mod manifest;

use super::claude_home;

// ── Types (API response) ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PluginEntry {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub repo: String,
    #[serde(default)]
    pub homepage: String,
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

// ── Commands ──

/// 同步命令 + `git clone` 子进程 + 网络 = 理论上可无限期阻塞主线程（网络慢/大
/// 仓库），没有超时保护。埋 trace_command：真堵住时诊断报告能直接点名，不用再
/// 靠「看进程列表猜」（2026-07-08 diag_freeze 报告首次实锤主线程被同步命令堵死
/// 之后补上，同批连带修的还有 session_jsonl_size 等）。暂不改 async——涉及子
/// 进程生命周期与代理配置，留作单独评估。
#[tauri::command]
pub fn fetch_marketplace(url: String) -> Result<Vec<PluginEntry>, String> {
    let _trace = crate::diagnostics::trace_command("fetch_marketplace");
    let cache_dir = marketplace_cache_dir();

    // Clean any stale cache
    if cache_dir.exists() {
        fs::remove_dir_all(&cache_dir)
            .map_err(|e| format!("Failed to clean marketplace cache: {}", e))?;
    }
    fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create marketplace cache dir: {}", e))?;

    // Shallow clone (auto proxy detection)
    let output = install::git_clone(&url, &cache_dir)
        .map_err(|e| format!("Failed to run git clone: {}. Is Git installed?", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Git 克隆失败: {}", install::git_err(&stderr)));
    }

    // 1. Try .claude-plugin/marketplace.json → registry.json → plugins.json
    let official_path = cache_dir.join(".claude-plugin").join("marketplace.json");
    let registry_path = cache_dir.join("registry.json");
    let fallback_path = cache_dir.join("plugins.json");

    if official_path.exists() || registry_path.exists() || fallback_path.exists() {
        let path = if official_path.exists() {
            official_path
        } else if registry_path.exists() {
            registry_path
        } else {
            fallback_path
        };
        let content =
            fs::read_to_string(&path).map_err(|e| format!("Failed to read registry: {}", e))?;
        let manifest = sources::parse_marketplace_json(&content)?;
        let plugins: Vec<PluginEntry> = manifest.plugins.into_iter().map(|p| PluginEntry {
            name: p.name,
            description: p.description.unwrap_or_default(),
            repo: p.repository.unwrap_or_default(),
            homepage: p.homepage.unwrap_or_default(),
        }).collect();
        return Ok(plugins);
    }

    // 2. Fallback: scan repo for .claude-plugin/plugin.json manifests in subdirs
    let mut plugins = Vec::new();
    if let Ok(entries) = fs::read_dir(&cache_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let manifest_path = path.join(".claude-plugin").join("plugin.json");
            if !manifest_path.exists() {
                continue;
            }
            if let Ok(content) = fs::read_to_string(&manifest_path) {
                if let Ok(manifest) = serde_json::from_str::<manifest::PluginManifest>(&content) {
                    let name = path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let repo = install::get_remote_url(&path).unwrap_or_else(|| url.clone());
                    plugins.push(PluginEntry {
                        name: name.clone(),
                        description: manifest.description,
                        repo,
                        homepage: String::new(),
                    });
                }
            }
        }
    }
    Ok(plugins)
}

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
