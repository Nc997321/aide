// .jsonl 直读的命令外壳：定位会话转录（本机配置根 / 远程主机）；读写实现在
// aide_workspace::transcripts::jsonl（桌面与远程 aide-host 共用）。

use serde_json::json;
use tauri::State;

use crate::commands::{find_session_jsonl_globally, LastEventInfo, WorkspaceState};
use crate::remote_workspace::sessions::{host_of_session, transcript_call};
use aide_workspace::transcripts::jsonl;

// 供自动化 RunRecord.summary 读取末条消息摘要（automation/scheduler.rs）
pub(crate) use aide_workspace::transcripts::jsonl::last_jsonl_message;

async fn blocking<T: Send + 'static>(
    name: &'static str,
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("{name} task panicked: {e}"))?
}

/// 同 load_messages：整读 .jsonl 再反向扫描，转 blocking 线程。
#[tauri::command]
pub async fn session_last_event(
    _workspace_state: State<'_, WorkspaceState>,
    app: tauri::AppHandle,
    session_id: String,
) -> Result<LastEventInfo, String> {
    if let Some(host) = host_of_session(&app, &session_id) {
        let v = transcript_call(&app, &host, "transcript_last_event", json!({ "sessionId": session_id })).await?;
        return serde_json::from_value(v).map_err(|e| e.to_string());
    }
    blocking("session_last_event", move || {
        match find_session_jsonl_globally(&session_id).into_iter().next() {
            Some(p) => jsonl::last_event_at(&p),
            None => Ok(LastEventInfo::empty()),
        }
    })
    .await
}

/// 每轮对话结束都会调用一次（takeSnapshot 记录撤回锚点），必须 async——同步版本
/// 曾在诊断黑匣子里被实锤为 Rust 主线程冻结的嫌疑对象：`find_session_jsonl_globally`
/// 遍历 `~/.aide/claude/projects/` 是同步磁盘 IO，杀软实时扫描 / 磁盘争抢时可能被拖到
/// 秒级甚至更久，堵在 Tauri 主线程上会连累所有后续命令排队（详见 CLAUDE.md「同步
/// command 禁止重 IO」）。
#[tauri::command]
pub async fn session_jsonl_size(
    _workspace_state: State<'_, WorkspaceState>,
    app: tauri::AppHandle,
    session_id: String,
) -> Result<u64, String> {
    if let Some(host) = host_of_session(&app, &session_id) {
        let v = transcript_call(&app, &host, "transcript_size", json!({ "sessionId": session_id })).await?;
        return serde_json::from_value(v).map_err(|e| e.to_string());
    }
    blocking("session_jsonl_size", move || {
        match find_session_jsonl_globally(&session_id).into_iter().next() {
            Some(p) => jsonl::size_at(&p),
            None => Ok(0),
        }
    })
    .await
}

#[tauri::command]
pub async fn session_truncate_jsonl(
    _workspace_state: State<'_, WorkspaceState>,
    app: tauri::AppHandle,
    session_id: String,
    byte_pos: u64,
) -> Result<(), String> {
    if let Some(host) = host_of_session(&app, &session_id) {
        transcript_call(
            &app,
            &host,
            "transcript_truncate",
            json!({ "sessionId": session_id, "bytePos": byte_pos }),
        )
        .await?;
        return Ok(());
    }
    blocking("session_truncate_jsonl", move || {
        match find_session_jsonl_globally(&session_id).into_iter().next() {
            Some(p) => jsonl::truncate_at(&p, byte_pos),
            None => Ok(()),
        }
    })
    .await
}
