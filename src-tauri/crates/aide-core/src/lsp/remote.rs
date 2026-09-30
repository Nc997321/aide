//! **过渡端口（P1 前）**：旧模型「远程工作区」的 LSP——服务器经 `aide-host lsp` 在目标机上起、
//! 工作区文件问目标机上的 aide-host。实现在桌面（`remote_workspace/lsp_bridge.rs`），启动时
//! [`set_remote`] 注入。
//!
//! P1（窗口连 Host）后 LSP 本来就跑在 Host 上、只碰本机文件，这个端口连同桌面实现一起删除。
//! 未注入（aide-host 自身、测试）= 没有「远程路径」这回事，一律本机。

use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;

use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// 目标机上起好的一台语言服务器：stdio 已套好 URI 互译（对 LspManager 就是又一个 stdio 进程）。
pub struct RemoteServer {
    pub to_server: Box<dyn AsyncWrite + Send + Unpin>,
    pub from_server: Box<dyn AsyncRead + Send + Unpin>,
    pub stderr: Option<tokio::process::ChildStderr>,
    pub child: tokio::process::Child,
}

pub trait RemoteLsp: Send + Sync + 'static {
    /// 桌面形态路径 → 目标机 POSIX 路径；本机路径 → None。
    fn to_posix(&self, path: &str) -> Option<String>;

    /// `root` 所在目标机上的 POSIX 路径 → 桌面形态。
    fn to_desktop(&self, root: &str, posix: &str) -> Option<String>;

    /// 向 `path` 所在目标机的 aide-host 发一条命令（参数里的路径由调用方给 POSIX 形态）。
    fn call<'a>(&'a self, path: &'a str, cmd: &'a str, args: Value) -> BoxFuture<'a, Result<Value, String>>;

    /// 在 `root` 所在目标机上起语言服务器：`argv` 是候选命令行（目标机登录 PATH 上解析）。
    fn spawn_server<'a>(&'a self, root: &'a str, argv: Vec<String>) -> BoxFuture<'a, Result<RemoteServer, String>>;
}

static REMOTE: OnceLock<Box<dyn RemoteLsp>> = OnceLock::new();

/// 启动时调一次（第二次调用被忽略）。
pub fn set_remote(bridge: Box<dyn RemoteLsp>) {
    let _ = REMOTE.set(bridge);
}

pub fn bridge() -> Option<&'static dyn RemoteLsp> {
    REMOTE.get().map(|b| b.as_ref())
}

/// 该路径是否是（旧模型的）远程工作区路径。
pub fn is_remote(path: &str) -> bool {
    bridge().is_some_and(|b| b.to_posix(path).is_some())
}
