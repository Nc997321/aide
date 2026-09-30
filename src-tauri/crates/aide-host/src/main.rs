//! aide-host 入口。三种模式：
//!
//! - `aide-host serve`：完整 Host（aide-core：命令表 + agent runtime + 自动化 + LSP…），
//!   协议见 `protocol.rs`；进程整体跑在用户登录环境里
//! - `aide-host agent`：首行读 `AgentInit`，拉起 sidecar（node runtime.js），之后透传 stdio
//! - `aide-host lsp`：首行读 `LspInit`，在登录环境里拉起语言服务器，之后透传 stdio
//! - `aide-host version`：打印版本（桌面据此判断是否需要重装）

mod agent;
mod dispatch;
mod login;
mod lsp;
mod serve;

use aide_host::protocol;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    if mode == "serve" {
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
            "serve" => serve::run().await,
            "agent" => agent::run().await,
            "lsp" => lsp::run().await,
            "version" | "--version" => {
                println!("{VERSION} protocol={}", protocol::PROTOCOL_VERSION);
                0
            }
            _ => {
                eprintln!("usage: aide-host <serve|agent|lsp|version>");
                2
            }
        }
    });
    std::process::exit(code);
}
