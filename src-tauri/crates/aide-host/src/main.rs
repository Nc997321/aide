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
