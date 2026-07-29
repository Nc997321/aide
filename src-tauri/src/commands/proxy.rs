//! 代理检测——扫常见本地端口 → env 变量 → git 全局配置 → app settings。
//!
//! 从 marketplace.rs 提取出来共享：marketplace 的 `git clone` 和 provider 的
//! HTTP 模型拉取都用同一套代理发现逻辑。检测策略：每层都先验证可达再返回，
//! 避免返回一个死代理把后续网络调用全拖垮。
//!
//! 跨平台：git config 调用在 Windows 上必须加 `CREATE_NO_WINDOW`（CLAUDE.md 红线），
//! 否则会弹控制台窗口。

use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use super::our_config_dir;

/// 扫描系统代理：常见本地端口 → `HTTPS_PROXY`/`HTTP_PROXY` env → git 全局配置 →
/// app settings。每层先验证 TCP 可达再返回。返回 `http://host:port` 形式的代理 URL。
pub(crate) fn detect_proxy() -> Option<String> {
    // 1. 先扫常见本地代理端口（最可靠——必须是活的）
    let common_ports = [7890u16, 10809, 7891, 1080, 8118, 8080];
    for port in &common_ports {
        if let Ok(_stream) = std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", port).parse().unwrap(),
            std::time::Duration::from_millis(300),
        ) {
            return Some(format!("http://127.0.0.1:{}", port));
        }
    }

    // 2. 环境变量（验证可达）
    for var in &["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] {
        if let Ok(val) = std::env::var(var) {
            if !val.is_empty() && is_proxy_reachable(&val) {
                return Some(val);
            }
        }
    }

    // 3. git 全局配置（验证可达）
    {
        let mut git_cmd = Command::new("git");
        git_cmd.args(["config", "--global", "http.proxy"]);
        #[cfg(windows)]
        { git_cmd.creation_flags(0x08000000); }
        if let Ok(output) = git_cmd.output() {
            let val = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !val.is_empty() && is_proxy_reachable(&val) {
                return Some(val);
            }
        }
    }

    // 4. app settings（设置面板里用户配的代理）——user-scope settings.json。
    //    `settings.proxy` 描述符作用域仅 USER（descriptors.rs），故直接读 user
    //    文件即完备，无需 effective-document 合并。迁移前这里读已删除的 config.json
    //    （`settings.proxy`），迁移后改读 settings.json 的 `values.settings.proxy`。
    let settings_path = our_config_dir().join("settings.json");
    if settings_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&settings_path) {
            if let Ok(doc) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(proxy) = doc
                    .get("values")
                    .and_then(|v| v.get("settings"))
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

/// 把 `detect_proxy()` 检测到的代理作为 git 全局 `-c http.proxy/https.proxy` 选项加到
/// 命令最前（必须在子命令之前才作为 git 全局选项生效）。
///
/// marketplace 两条 git 路径共用此函数：
/// - 源仓库克隆/拉取（`git_clone` → 列表能加载）
/// - 插件仓库克隆/拉取（`run_git` → `clone_ref_sha`/`clone_subdir` → 安装/更新）
///
/// 之前只有 `git_clone` 应用代理、`run_git` 不应用，导致源列表能拉取而插件安装/更新
/// 直连 github 挂死（前端更新按钮无 updating 态指示，spawn_blocking 一直阻塞 → 表现为
/// 「点击更新完全没有反应」）。两条路径必须一致走代理。
pub(crate) fn apply_git_proxy(cmd: &mut Command) {
    if let Some(ref proxy) = detect_proxy() {
        cmd.arg("-c").arg(format!("http.proxy={}", proxy));
        cmd.arg("-c").arg(format!("https.proxy={}", proxy));
    }
}

/// 解析代理 URL 并验证 TCP 可达。支持 `http://` / `https://` / `socks5://` 前缀。
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