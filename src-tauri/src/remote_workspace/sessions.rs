//! 会话 ↔ 远程主机：会话转录住在 agent 运行的机器上。
//!
//! **过渡期路由**（Host 模型 P1 随 routes.rs 一起删除）：会话命令本身是 aide-core 的本地实现；
//! 调用落在远程工作区的会话时，两个前门（桌面 IPC 的 `routes::intercept`、手机远程的
//! `rpc::dispatch`）都先问 [`route`]，命中就由 [`run`] 向 aide-host 取转录原料、叠加桌面元数据。
//! 两个前门必须都接——只接一个，另一个前门就会静默读到本机（跑错机器）。

use std::sync::Arc;

use serde_json::{json, Value};
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
    app.try_state::<std::sync::Arc<super::lanes::RemoteLanes>>()
        .and_then(|l| l.lane_of(session_id))
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

/// 一次落在远程主机上的会话调用。
pub enum SessionRoute {
    /// 列会话（工作区在远程）：`transcript_list` + 桌面元数据叠加。
    List { host: HostId, posix_root: String },
    /// 单会话转录操作：原样转成 host 的 `transcript_*` 命令。
    Transcript { host: HostId, cmd: &'static str, args: Value },
}

/// 同步判定：这条会话命令是否落在远程主机上。None = 本机，交给 aide-core。
pub fn route(app: &AppHandle, cmd: &str, args: &Value) -> Option<SessionRoute> {
    let arg = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_string);
    let transcript = |host_cmd: &'static str, a: Value| {
        let sid = arg("sessionId")?;
        let host = host_of_session(app, &sid)?;
        Some(SessionRoute::Transcript { host, cmd: host_cmd, args: a })
    };
    match cmd {
        "list_sessions" => {
            let ws = app.try_state::<Arc<aide_core::WorkspaceState>>()?;
            let root = ws.root_for(None);
            let (host, posix_root) = root.to_str().and_then(path::parse)?;
            Some(SessionRoute::List { host, posix_root })
        }
        "list_sessions_for_workspace" => {
            // key 不能反解成路径（UNC 形态），查注册表
            let registered = crate::commands::workspace::registered_path_for_key(
                &crate::commands::settings::load_state(),
                &arg("wsKey")?,
            )?;
            let (host, posix_root) = path::parse(&registered)?;
            Some(SessionRoute::List { host, posix_root })
        }
        "load_messages" => transcript(
            "transcript_load",
            json!({ "sessionId": arg("sessionId"), "offsetBytes": args.get("offsetBytes"), "limit": args.get("limit") }),
        ),
        "session_last_event" => transcript("transcript_last_event", json!({ "sessionId": arg("sessionId") })),
        "session_jsonl_size" => transcript("transcript_size", json!({ "sessionId": arg("sessionId") })),
        "session_truncate_jsonl" => transcript(
            "transcript_truncate",
            json!({ "sessionId": arg("sessionId"), "bytePos": args.get("bytePos") }),
        ),
        _ => None,
    }
}

/// 执行 [`route`] 命中的远程会话调用。结果形状与 aide-core 的本机实现一致。
pub async fn run(app: AppHandle, r: SessionRoute) -> Result<Value, String> {
    match r {
        SessionRoute::List { host, posix_root } => {
            let sessions = remote_sessions(&app, &host, &posix_root).await?;
            serde_json::to_value(sessions).map_err(|e| e.to_string())
        }
        SessionRoute::Transcript { host, cmd, args } => {
            let v = transcript_call(&app, &host, cmd, args).await?;
            // 截断在 host 侧返回 null；其余原样
            Ok(v)
        }
    }
}

/// 远程工作区的会话列表：目标机给转录原料（id / CLI 元数据 / mtime），桌面叠加自己的
/// 元数据（显示名、自动化标签过滤）——与本机列表同一口径。
async fn remote_sessions(
    app: &tauri::AppHandle,
    host: &HostId,
    posix_root: &str,
) -> Result<Vec<crate::commands::Session>, String> {
    let v = transcript_call(
        app,
        host,
        "transcript_list",
        serde_json::json!({ "root": posix_root }),
    )
    .await?;
    let entries: Vec<aide_workspace::transcripts::TranscriptEntry> =
        serde_json::from_value(v).map_err(|e| e.to_string())?;
    let mut sessions: Vec<crate::commands::Session> = entries
        .into_iter()
        .filter(|e| !crate::commands::our_session_is_automation(&e.id))
        .map(|e| crate::commands::Session {
            name: crate::commands::our_session_name(&e.id)
                .or(e.cli_name)
                .unwrap_or_else(|| e.id.clone()),
            timestamp: if e.started_at == 0 { e.mtime_ms } else { e.started_at },
            id: e.id,
        })
        .collect();
    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(sessions)
}

