//! aide-host 入口。三种模式：
//!
//! - `aide-host serve`：Host 命令（aide-core 命令表）+ 文件监听，协议见 `protocol.rs`
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

#[tokio::main]
async fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    let code = match mode.as_str() {
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
    };
    std::process::exit(code);
}
