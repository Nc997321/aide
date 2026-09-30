//! 会话 ↔ 远程主机：会话转录住在 agent 运行的机器上。桌面的会话命令（历史 / 末事件 /
//! 尺寸 / 截断 / 列表）先用这里判定会话属于哪台主机，远程的向 aide-host 取转录原料。

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::path::{self, HostId};
use super::RemoteWorkspaces;

/// 会话所在主机：会话档案的工作区归属（`wsPath`）→ 当前进程里的车道绑定。本机会话 → None。
pub fn host_of_session(app: &AppHandle, session_id: &str) -> Option<HostId> {
    if let Some(p) = crate::commands::our_session_workspace(session_id).path {
        if let Some((h, _)) = path::parse(&p) {
            return Some(h);
        }
    }
    app.try_state::<crate::runtime::AgentRuntimeManager>()
        .and_then(|m| m.lane_of(session_id))
}

/// 向主机取一份转录原料（`aide_host::commands::TRANSCRIPT_COMMANDS`）。
pub async fn transcript_call(
    app: &AppHandle,
    host: &HostId,
    cmd: &str,
    args: Value,
) -> Result<Value, String> {
    let svc: Arc<RemoteWorkspaces> = app
        .try_state::<Arc<RemoteWorkspaces>>()
        .ok_or("remote workspaces not initialised")?
        .inner()
        .clone();
    svc.connection(host).await?.invoke(cmd, args, None).await
}
