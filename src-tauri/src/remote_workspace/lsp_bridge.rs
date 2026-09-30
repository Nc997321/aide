//! aide-core LSP 的过渡端口实现（`aide_core::lsp::remote::RemoteLsp`）：旧模型远程工作区的
//! 语言服务器经 `aide-host lsp` 在目标机上起，工作区文件问目标机上的 aide-host。
//!
//! P1（窗口连 Host）后 LSP 本来就跑在 Host 上，本文件连同端口一起删除。

use std::sync::Arc;

use aide_core::lsp::remote::{BoxFuture, RemoteLsp, RemoteServer};
use serde_json::Value;
use tokio::io::AsyncWriteExt;

use super::path::{self as rpath, HostId};
use super::{launcher, lsp_pipe, RemoteWorkspaces};

pub struct LspBridge(pub Arc<RemoteWorkspaces>);

fn host_of(path: &str) -> Result<HostId, String> {
    rpath::parse(path)
        .map(|(host, _)| host)
        .ok_or_else(|| format!("not a remote path: {path}"))
}

impl RemoteLsp for LspBridge {
    fn to_posix(&self, path: &str) -> Option<String> {
        rpath::parse(path).map(|(_, posix)| posix)
    }

    fn to_desktop(&self, root: &str, posix: &str) -> Option<String> {
        rpath::parse(root).map(|(host, _)| rpath::to_desktop(&host, posix))
    }

    fn call<'a>(&'a self, path: &'a str, cmd: &'a str, args: Value) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            let host = host_of(path)?;
            self.0.connection(&host).await?.invoke(cmd, args, None).await
        })
    }

    /// 目标机上没装该语言的服务器 → aide-host 退出码 127、stderr 说明试了什么；那几行随
    /// 握手失败的原因回到面板（与本机「找不到 server」同一条可见路径）。
    fn spawn_server<'a>(&'a self, root: &'a str, argv: Vec<String>) -> BoxFuture<'a, Result<RemoteServer, String>> {
        Box::pin(async move {
            let (host, posix_root) = rpath::parse(root).ok_or_else(|| format!("not a remote path: {root}"))?;
            let inst = self.0.installed(&host).await?;
            let init = aide_host::protocol::LspInit {
                candidates: vec![argv],
                cwd: posix_root,
            };
            let script = format!("exec {} lsp", launcher::sh_quote(&inst.host_bin));
            let mut child = launcher::command(&host, &script)?
                .spawn()
                .map_err(|e| format!("{}: {e}", host.label()))?;
            let mut stdin = child.stdin.take().ok_or("no stdin")?;
            let stdout = child.stdout.take().ok_or("no stdout")?;
            let mut line = serde_json::to_string(&init).map_err(|e| e.to_string())?;
            line.push('\n');
            stdin
                .write_all(line.as_bytes())
                .await
                .map_err(|e| format!("send lsp init: {e}"))?;
            let stderr = child.stderr.take();
            let (to_server, from_server) = lsp_pipe::translate(host, stdin, stdout);
            Ok(RemoteServer {
                to_server: Box::new(to_server),
                from_server: Box::new(from_server),
                stderr,
                child,
            })
        })
    }
}
