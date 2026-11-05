//! GUI 资源消费者固定到打开时的 Host，读取仍查唯一 core 命令表。

use std::sync::Arc;
use std::time::Duration;

use aide_core::{Core, Reply};
use base64::Engine;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::host_window::HostWindows;
use crate::remote_workspace::connection::HostConnection;
use crate::remote_workspace::path::HostId;
use crate::remote_workspace::RemoteWorkspaces;

#[derive(Clone)]
pub(crate) enum HostTarget {
    Local(Arc<Core>),
    Remote { host: HostId, connection: Arc<HostConnection> },
}

impl HostTarget {
    pub async fn capture(app: &AppHandle, window: &str) -> Result<Self, String> {
        match app.state::<HostWindows>().host_of(window) {
            None => Ok(Self::Local(app.state::<Arc<Core>>().inner().clone())),
            Some(host) => {
                let service = app.state::<Arc<RemoteWorkspaces>>().inner().clone();
                let connection = service.connection(&host).await?;
                Ok(Self::Remote { host, connection })
            }
        }
    }

    pub fn belongs_to(&self, app: &AppHandle, window: &str) -> bool {
        if app.get_window(window).is_none() {
            return false;
        }
        let bound = app.state::<HostWindows>().host_of(window);
        match self {
            Self::Local(_) => bound.is_none(),
            Self::Remote { host, connection } => bound.as_ref() == Some(host) && connection.is_alive(),
        }
    }

    pub async fn invoke(&self, command: &str, args: Value) -> Result<Reply, String> {
        match self {
            Self::Local(core) => {
                let run = aide_core::lookup(command).ok_or_else(|| format!("未知 Host 命令：{command}"))?;
                run(Arc::clone(core), args).await
            }
            Self::Remote { connection, .. } => decode_reply(connection.invoke(command, args).await?),
        }
    }

    pub async fn media_call(&self, command: &str, args: Value) -> Result<Reply, String> {
        tokio::time::timeout(Duration::from_secs(15), self.invoke(command, args))
            .await
            .map_err(|_| "媒体读取超时，请检查 Host 连接后重新打开".to_string())?
    }
}

fn decode_reply(reply: Value) -> Result<Reply, String> {
    match reply.get(aide_host::protocol::BYTES_KEY).and_then(Value::as_str) {
        Some(encoded) => base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map(Reply::Bytes)
            .map_err(|e| format!("Host 字节回复损坏：{e}")),
        None => Ok(Reply::Json(reply)),
    }
}
