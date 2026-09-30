//! 代理检测——app settings（用户显式配置）→ env 变量 → git 全局配置 → 常见本地端口。
//!
//! 从 marketplace.rs 提取出来共享：marketplace 的 `git clone` 和 provider 的
//! HTTP 模型拉取都用同一套代理发现逻辑。检测策略：每层都先验证可达再返回，
//! 避免返回一个死代理把后续网络调用全拖垮。
//!
//! 优先级原则：用户显式配置 > 可信环境（env / git config）> 端口猜测兜底。
//! 聊天主路径（`runtime::env::build_runtime_env_vars`）只认 settings 显式值、
//! 不做自动探测（核心流量出口必须可预期）；本函数服务 Rust 侧非关键路径
//! （marketplace git clone / 模型刷新 / 连接测试 / codegraph embed）。
//!
//! 跨平台：git config 调用在 Windows 上必须加 `CREATE_NO_WINDOW`（CLAUDE.md 红线），
//! 否则会弹控制台窗口。

use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use std::sync::Arc;

use crate::commands::NoArgs;
use crate::paths::our_config_dir;
use crate::registry::Command as HostCommand;
use crate::{command, Core};

pub static COMMANDS: &[HostCommand] = &[command!("detect_available_proxy", detect_available_proxy)];

/// 完整探测链：app settings（显式配置最优先）→ env → git 全局配置 → 常见本地端口。
/// 每层先验证 TCP 可达再返回。返回 `http://host:port` 形式的代理 URL。
pub fn detect_proxy() -> Option<String> {
    if let Some(proxy) = settings_proxy() {
        return Some(proxy);
    }
    detect_proxy_auto()
}

/// 自动探测（不含用户显式配置）：`HTTPS_PROXY`/`HTTP_PROXY` env → git 全局配置 →
/// 常见本地端口。设置面板「检测到可用代理」提示用它——只报告本机自动可用的代理，
/// 用户已配置的 settings 值不重复提示。
pub fn detect_proxy_auto() -> Option<String> {
    // 1. 环境变量（验证可达）
    for var in &["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] {
        if let Ok(val) = std::env::var(var) {
            if !val.is_empty() && is_proxy_reachable(&val) {
                return Some(val);
            }
        }
    }

    // 2. git 全局配置（验证可达）
    {
        let mut git_cmd = Command::new("git");
        git_cmd.args(["config", "--global", "http.proxy"]);
        #[cfg(windows)]
        {
            git_cmd.creation_flags(0x08000000);
        }
        if let Ok(output) = git_cmd.output() {
            let val = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !val.is_empty() && is_proxy_reachable(&val) {
                return Some(val);
            }
        }
    }

    // 3. 扫常见本地代理端口（兜底——必须是活的）
    let common_ports = [7890u16, 10809, 7891, 1080, 8118, 8080];
    for port in &common_ports {
        if let Ok(_stream) = std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", port).parse().unwrap(),
            std::time::Duration::from_millis(300),
        ) {
            return Some(format!("http://127.0.0.1:{}", port));
        }
    }

    None
}

/// 读 app settings 的 `settings.proxy`（user-scope settings.json）。
/// `settings.proxy` 描述符作用域仅 USER（descriptors.rs），故直接读 user
/// 文件即完备，无需 effective-document 合并。值非空且可达才返回。
///
/// `path` 为 `~/.aide/settings.json`（调用方经 `our_config_dir()` 拼出）；
/// 参数化仅为单测可注入临时目录，不碰进程 env。
fn settings_proxy() -> Option<String> {
    settings_proxy_at(&our_config_dir().join("settings.json"))
}

fn settings_proxy_at(path: &std::path::Path) -> Option<String> {
    if !path.exists() {
        return None;
    }
    let content = std::fs::read_to_string(path).ok()?;
    let doc: serde_json::Value = serde_json::from_str(&content).ok()?;
    let proxy = doc
        .get("values")
        .and_then(|v| v.get("settings"))
        .and_then(|s| s.get("proxy"))
        .and_then(|p| p.as_str())?;
    if proxy.is_empty() || !is_proxy_reachable(proxy) {
        return None;
    }
    Some(proxy.to_string())
}

/// 探测本机自动可用的代理（不含用户已配置值），供设置面板「一键填入」提示。
/// async + spawn_blocking：最多 6 次 300ms TCP 探测 + 1 次 git spawn，最坏约 2s，
/// 不能堵主线程（同步 command 禁止重 IO）。
async fn detect_available_proxy(_: Arc<Core>, _: NoArgs) -> Result<Option<String>, String> {
    Ok(tokio::task::spawn_blocking(detect_proxy_auto)
        .await
        .ok()
        .flatten())
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
pub fn apply_git_proxy(cmd: &mut Command) {
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
        if std::net::TcpStream::connect_timeout(&sock, std::time::Duration::from_millis(500))
            .is_ok()
        {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::net::{SocketAddr, TcpListener};

    /// 临时目录里造一个带 `settings.proxy` 的 settings.json。
    /// 返回 (root, json_path)：root 是 USERPROFILE 注入值（`our_config_dir()` =
    /// `$USERPROFILE/.aide`，故 settings.json 在 `root/.aide/settings.json`）。
    /// 目录名带递增序号：Rust 测试并行跑，共用 `<pid>` 目录会互相 remove 重建踩踏。
    static NEXT_DIR: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    fn write_settings(proxy: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let id = NEXT_DIR.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("aide_proxy_test_{}_{}", std::process::id(), id));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(".aide")).unwrap();
        let path = root.join(".aide").join("settings.json");
        fs::write(
            &path,
            serde_json::json!({
                "schemaVersion": 1,
                "values": { "settings": { "proxy": proxy } }
            })
            .to_string(),
        )
        .unwrap();
        (root, path)
    }

    /// 起一个真实 TCP listener（测试里的"活代理"），返回其 127.0.0.1 地址。
    fn live_listener() -> (TcpListener, SocketAddr) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        (listener, addr)
    }

    #[test]
    fn settings_proxy_returns_configured_value() {
        let (_l, addr) = live_listener();
        let (_dir, path) = write_settings(&format!("http://{}", addr));
        assert_eq!(settings_proxy_at(&path), Some(format!("http://{}", addr)));
    }

    #[test]
    fn settings_proxy_none_when_empty() {
        let (_dir, path) = write_settings("");
        assert_eq!(settings_proxy_at(&path), None);
    }

    #[test]
    fn settings_proxy_none_when_dead_endpoint() {
        // TEST-NET 保留地址（203.0.113.0/24）——任何系统都不会有服务，connect 必失败。
        let (_dir, path) = write_settings("http://203.0.113.1:9");
        assert_eq!(settings_proxy_at(&path), None);
    }

    #[test]
    fn settings_proxy_none_when_file_missing() {
        let path = std::env::temp_dir().join("aide_proxy_test_missing.json");
        let _ = fs::remove_file(&path);
        assert_eq!(settings_proxy_at(&path), None);
    }

    /// 回归：settings 显式配置必须最优先——即使本机端口扫描/环境变量有别的活代理，
    /// detect_proxy() 也要先返回 settings 值。注入方式是 settings.json 指向一个
    /// 真实可达的本地端口（settings 层验证可达后直接返回，不碰后续层，测试确定性成立）。
    #[test]
    fn detect_proxy_prefers_settings_over_auto() {
        let (_l, addr) = live_listener();
        let (root, _path) = write_settings(&format!("http://{}", addr));

        // our_config_dir() = $USERPROFILE/.aide → 临时注入后 detect_proxy() 只读这里。
        let old = std::env::var("USERPROFILE").ok();
        std::env::set_var("USERPROFILE", &root);
        let detected = detect_proxy();
        match old {
            Some(v) => std::env::set_var("USERPROFILE", v),
            None => std::env::remove_var("USERPROFILE"),
        }

        assert_eq!(detected, Some(format!("http://{}", addr)));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn is_proxy_reachable_true_for_live_listener() {
        let (_l, addr) = live_listener();
        assert!(is_proxy_reachable(&format!("http://{}", addr)));
    }

    #[test]
    fn is_proxy_reachable_false_for_dead_endpoint() {
        assert!(!is_proxy_reachable("http://203.0.113.1:9"));
    }
}
