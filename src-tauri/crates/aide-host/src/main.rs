//! aide-host 入口：
//!
//! - `aide-host daemon`：常驻的 Host（aide-core：命令表 + agent runtime + 自动化 + LSP…），监听
//!   用户级套接字，多个客户端来去；进程整体跑在用户登录环境里
//! - `aide-host serve`：桌面一条连接与守护进程之间的桥（没有守护进程就拉起一个），协议见
//!   `protocol.rs`
//! - `aide-host version`：打印版本（桌面据此判断是否需要重装）

mod daemon;
mod dispatch;
mod kit;
mod login;
mod serve;
mod session;

use aide_host::protocol;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// 这份套件的**构建身份**：安装目录名 `<版本>-<内容哈希>`（桌面按 aide-host 与 runtime.js
/// 的内容算出、装进 `~/.aide/host/<身份>/`，见 src/remote_workspace/install.rs）。
///
/// 守护进程新旧只能按它判，不能按 [`VERSION`]：包版本号在两次发版之间不变，开发期每次重构建
/// 都还是 `0.8.0`——按它比，新部署的 `serve` 会把旧守护进程当同版直接接上，新加的 Host 命令
/// 一条都用不上（2026-10-04：语言包命令在 WSL 上「不存在」，就是旧守护进程在答）。
pub fn build_id() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|exe| build_id_from(&exe))
        .unwrap_or_else(|| VERSION.to_string())
}

/// 从可执行文件路径取构建身份：父目录名以版本号开头才算（开发时 `cargo run` 的
/// target/debug 不是套件目录，回退版本号）。
fn build_id_from(exe: &std::path::Path) -> Option<String> {
    let dir = exe.parent()?.file_name()?.to_str()?;
    dir.starts_with(&format!("{VERSION}-")).then(|| dir.to_string())
}

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    if mode == "daemon" {
        // Host 进程整体用用户登录环境：必须在建 tokio runtime（多线程）之前改进程环境。
        login::apply_login_env();
    }
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("[aide-host] tokio runtime: {e}");
            std::process::exit(1);
        }
    };
    let code = rt.block_on(async {
        match mode.as_str() {
            "daemon" => daemon::run().await,
            "serve" => serve::run().await,
            "version" | "--version" => {
                println!("{VERSION} protocol={}", protocol::PROTOCOL_VERSION);
                0
            }
            _ => {
                eprintln!("usage: aide-host <daemon|serve|version>");
                2
            }
        }
    });
    std::process::exit(code);
}

#[cfg(test)]
mod build_id_tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn kit_dir_name_is_the_build_id() {
        let exe = format!("/home/u/.aide/host/{VERSION}-df962cc9e3f9/aide-host");
        assert_eq!(build_id_from(Path::new(&exe)).as_deref(), Some(format!("{VERSION}-df962cc9e3f9").as_str()));
    }

    #[test]
    fn dev_build_falls_back_to_version() {
        assert_eq!(build_id_from(Path::new("/repo/target/debug/aide-host")), None);
    }
}
