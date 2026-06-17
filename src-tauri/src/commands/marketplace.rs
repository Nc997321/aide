use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;

use super::{claude_home, config_path};

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
    #[serde(default)]
    pub path: String,
    pub installed_at: u64,
}

// ── Raw deserialization types for official marketplace.json ──
// source can be:
//   { source: "url",        url: "https://github.com/..." }         — external plugin
//   { source: "git-subdir", url: "owner/repo", path: "...", ... }   — subdir of another repo
//   "./relative/path"                                                — bundled in marketplace

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawSource {
    Object {
        #[serde(default)]
        source: String,   // "url" | "git-subdir"
        #[serde(default)]
        url: String,       // full URL for "url", "owner/repo" for "git-subdir"
        #[serde(default)]
        path: String,      // subdirectory path for "git-subdir"
    },
    Bundled(String),       // "./relative/path" string
}

#[derive(Debug, Deserialize)]
struct RawPluginEntry {
    name: String,
    #[serde(default)]
    description: String,
    source: Option<RawSource>,
    #[serde(default)]
    homepage: String,
}

#[derive(Debug, Deserialize)]
struct RegistryManifest {
    plugins: Vec<RawPluginEntry>,
}

// ── Plugin manifest (for installed plugins) ──

#[derive(Debug, Deserialize)]
struct PluginManifest {
    #[serde(default)]
    name: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    author: String,
}

// ── Conversion ──

impl From<RawPluginEntry> for PluginEntry {
    fn from(raw: RawPluginEntry) -> Self {
        let repo = match raw.source {
            Some(RawSource::Object { ref url, path: _, ref source, .. }) => {
                // "url" type: url is the full git clone URL
                // "git-subdir" type: url is "owner/repo", construct full GitHub URL
                if source == "git-subdir" && !url.starts_with("http") {
                    // url looks like "owner/repo" — prepend github.com
                    format!("https://github.com/{}.git", url.trim_end_matches('/'))
                } else {
                    url.clone()
                }
            }
            Some(RawSource::Bundled(path)) => path,
            None => String::new(),
        };
        PluginEntry {
            name: raw.name,
            description: raw.description,
            repo,
            homepage: raw.homepage,
        }
    }
}

// ── Git proxy helpers ──

/// Try to detect the system proxy on Windows.
/// Checks: git global config → HTTPS_PROXY env var → common local ports.
fn detect_proxy() -> Option<String> {
    // 1. Scan common local proxy ports FIRST (most reliable — needs to be live)
    let common_ports = [7890u16, 10809, 7891, 1080, 8118, 8080];
    for port in &common_ports {
        if let Ok(_stream) = std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", port).parse().unwrap(),
            std::time::Duration::from_millis(300),
        ) {
            return Some(format!("http://127.0.0.1:{}", port));
        }
    }

    // 2. Check environment variables (and verify reachable)
    for var in &["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] {
        if let Ok(val) = std::env::var(var) {
            if !val.is_empty() && is_proxy_reachable(&val) {
                return Some(val);
            }
        }
    }

    // 3. Check git global config (only if still reachable)
    if let Ok(output) = Command::new("git")
        .args(["config", "--global", "http.proxy"])
        .output()
    {
        let val = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !val.is_empty() && is_proxy_reachable(&val) {
            return Some(val);
        }
    }

    // 4. Check app settings (user-configured proxy in the settings panel)
    let cfg_path = config_path();
    if cfg_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&cfg_path) {
            if let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(proxy) = config
                    .get("settings")
                    .and_then(|s| s.get("proxy"))
                    .and_then(|p| p.as_str())
                {
                    if !proxy.is_empty() && is_proxy_reachable(proxy) {
                        return Some(proxy.to_string());
                    }
                }
            }
        }
    }

    None
}

/// Parse proxy URL and verify it's actually reachable via TCP.
fn is_proxy_reachable(proxy: &str) -> bool {
    // Parse "http://host:port" or "socks5://host:port"
    let addr = proxy
        .trim()
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_start_matches("socks5://")
        .trim_end_matches('/');
    // addr should be "host:port"
    if let Ok(sock) = addr.parse::<std::net::SocketAddr>() {
        if std::net::TcpStream::connect_timeout(&sock, std::time::Duration::from_millis(500)).is_ok() {
            return true;
        }
    }
    false
}

/// Classify a git clone error and return a prefixed error string.
/// The prefix is a machine-readable code; the frontend maps it to
/// user-facing messages and actions.
fn git_err(stderr: &str) -> String {
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
fn git_clone(url: &str, target: &std::path::Path) -> Result<std::process::Output, std::io::Error> {
    let mut cmd = Command::new("git");
    cmd.args(["clone", "--depth", "1"]);

    // Apply proxy if detected
    if let Some(ref proxy) = detect_proxy() {
        cmd.arg("-c");
        cmd.arg(format!("http.proxy={}", proxy));
        cmd.arg("-c");
        cmd.arg(format!("https.proxy={}", proxy));
    }

    cmd.arg(url).arg(target).output()
}

// ── Paths ──

fn plugins_dir() -> PathBuf {
    claude_home().join("plugins")
}

fn marketplace_cache_dir() -> PathBuf {
    super::our_config_dir().join("marketplace-cache")
}

// ── Commands ──

#[tauri::command]
pub fn fetch_marketplace(url: String) -> Result<Vec<PluginEntry>, String> {
    let cache_dir = marketplace_cache_dir();

    // Clean any stale cache
    if cache_dir.exists() {
        fs::remove_dir_all(&cache_dir)
            .map_err(|e| format!("Failed to clean marketplace cache: {}", e))?;
    }
    fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create marketplace cache dir: {}", e))?;

    // Shallow clone (auto proxy detection)
    let output = git_clone(&url, &cache_dir)
        .map_err(|e| format!("Failed to run git clone: {}. Is Git installed?", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Git 克隆失败: {}", git_err(&stderr)));
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
        let manifest: RegistryManifest = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse marketplace JSON: {}", e))?;
        let plugins: Vec<PluginEntry> = manifest.plugins.into_iter().map(Into::into).collect();
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
                if let Ok(manifest) = serde_json::from_str::<PluginManifest>(&content) {
                    let name = path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let repo = get_remote_url(&path).unwrap_or_else(|| url.clone());
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

#[tauri::command]
pub fn install_plugin(repo_url: String, name: String) -> Result<(), String> {
    let target_dir = plugins_dir().join(&name);

    if target_dir.exists() {
        return Err(format!("插件 '{}' 已安装", name));
    }

    fs::create_dir_all(plugins_dir())
        .map_err(|e| format!("Failed to create plugins directory: {}", e))?;

    let output = git_clone(&repo_url, &target_dir)
        .map_err(|e| format!("Failed to run git clone: {}. Is Git installed?", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if target_dir.exists() {
            let _ = fs::remove_dir_all(&target_dir);
        }
        return Err(format!("Git 克隆失败: {}", git_err(&stderr)));
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
                    if let Ok(manifest) = serde_json::from_str::<PluginManifest>(&content) {
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

            let repo_url = get_remote_url(&path).unwrap_or_default();
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

fn get_remote_url(path: &std::path::Path) -> Option<String> {
    let output = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(path)
        .output()
        .ok()?;

    if output.status.success() {
        let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !url.is_empty() {
            return Some(url);
        }
    }
    None
}
