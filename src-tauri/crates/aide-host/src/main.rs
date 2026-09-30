//! aide-host 入口。三种模式：
//!
//! - `aide-host serve`：工作区 RPC（fs / 搜索 / git / 文件监听），协议见 `protocol.rs`
//! - `aide-host agent`：首行读 `AgentInit`，拉起 sidecar（node runtime.js），之后透传 stdio
//! - `aide-host version`：打印版本（桌面据此判断是否需要重装）

mod agent;
mod dispatch;
mod git_dispatch;
mod serve;

use aide_host::protocol;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[tokio::main]
async fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    let code = match mode.as_str() {
        "serve" => serve::run().await,
        "agent" => agent::run().await,
        "version" | "--version" => {
            println!("{VERSION} protocol={}", protocol::PROTOCOL_VERSION);
            0
        }
        _ => {
            eprintln!("usage: aide-host <serve|agent|version>");
            2
        }
    };
    std::process::exit(code);
}
