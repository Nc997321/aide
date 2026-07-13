use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::commands::marketplace::{sources, manifest, source_cache_dir, PluginEntry};
use crate::commands::marketplace::sources::{parse_marketplace_json, RawSource};

// ── fetch_marketplace (async, source-aware) ──

#[tauri::command]
pub async fn fetch_marketplace(source_id: String) -> Result<Vec<PluginEntry>, String> {
    // async 命令不埋 trace_command（CLAUDE.md：async 的 spawn_blocking 任务不在主线程）
    tokio::task::spawn_blocking(move || -> Result<Vec<PluginEntry>, String> {
        let repo = sources::fixed_repo(&source_id).ok_or("未知市场源")?.to_string();
        let market_name = sources::default_market_name(&source_id).unwrap_or(&source_id).to_string();
        let cache = source_cache_dir(&source_id);
        // 克隆或拉取
        if !cache.exists() {
            std::fs::create_dir_all(cache.parent().unwrap_or(&cache)).map_err(|e| e.to_string())?;
            let url = format!("https://github.com/{}.git", repo);
            git_clone(&url, &cache).map_err(|e| format!("git clone 失败: {e}"))?;
        }
        let mjson = cache.join(".claude-plugin").join("marketplace.json");
        let content = std::fs::read_to_string(&mjson)
            .or_else(|_| std::fs::read_to_string(cache.join("registry.json")))
            .or_else(|_| std::fs::read_to_string(cache.join("plugins.json")))
            .map_err(|e| format!("读 marketplace.json 失败: {e}"))?;
        let m = parse_marketplace_json(&content)?;
        let plugins = m.plugins.into_iter().map(|raw| {
            let (avail, unsup) = manifest::classify_availability(&raw);
            let version = raw.version.clone().unwrap_or_else(|| resolved_version_from_source(&raw.source));
            PluginEntry {
                name: raw.name.clone(),
                display_name: raw.display_name.clone().unwrap_or_else(|| raw.name.clone()),
                description: raw.description.clone().unwrap_or_default(),
                version,
                source_id: source_id.clone(),
                market_name: market_name.clone(),
                category: raw.category.clone().unwrap_or_default(),
                homepage: raw.homepage.clone().unwrap_or_default(),
                repository: raw.repository.clone().unwrap_or_default(),
                availability: avail,
                unsupported: unsup,
            }
        }).collect();
        Ok(plugins)
    }).await.map_err(|e| e.to_string())?
}

/// Resolve version from source (short sha if available; empty otherwise — full resolution at install).
fn resolved_version_from_source(src: &Option<RawSource>) -> String {
    match src {
        Some(RawSource::Github{sha: Some(s), ..})
        | Some(RawSource::Url{sha: Some(s), ..})
        | Some(RawSource::GitSubdir{sha: Some(s), ..}) => short_sha(s),
        _ => String::new(),
    }
}
fn short_sha(s: &str) -> String { s.chars().take(12).collect() }

/// Classify a git clone error and return a prefixed error string.
/// The prefix is a machine-readable code; the frontend maps it to
/// user-facing messages and actions.
pub(super) fn git_err(stderr: &str) -> String {
    let code = if stderr.contains("Could not connect")
        || stderr.contains("Failed to connect")
        || stderr.contains("Could not resolve")
    {
        "NETWORK_FAILURE"
    } else if stderr.contains("not found") || stderr.contains("remote: Repository") {
        "REPO_NOT_FOUND"
    } else if stderr.contains("timeout") || stderr.contains("timed out") {
        "TIMEOUT"
    } else {
        "UNKNOWN_ERROR"
    };
    format!("{}: {}", code, stderr.trim())
}

/// Run git clone with optional proxy and return output.
pub(super) fn git_clone(url: &str, target: &std::path::Path) -> Result<std::process::Output, std::io::Error> {
    let mut cmd = Command::new("git");
    cmd.args(["clone", "--depth", "1"]);
    #[cfg(windows)]
    { cmd.creation_flags(0x08000000); }

    // Apply proxy if detected
    if let Some(ref proxy) = crate::commands::proxy::detect_proxy() {
        cmd.arg("-c");
        cmd.arg(format!("http.proxy={}", proxy));
        cmd.arg("-c");
        cmd.arg(format!("https.proxy={}", proxy));
    }

    cmd.arg(url).arg(target).output()
}

pub(super) fn get_remote_url(path: &std::path::Path) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.args(["remote", "get-url", "origin"])
        .current_dir(path);
    #[cfg(windows)]
    { cmd.creation_flags(0x08000000); }
    let output = cmd.output().ok()?;

    if output.status.success() {
        let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !url.is_empty() {
            return Some(url);
        }
    }
    None
}
