//! .jsonl 直读的命令外壳：定位会话转录（Host 的配置根）；读写实现在
//! aide_workspace::transcripts::jsonl。远程工作区的会话由桌面前门的远程路由接管。

#[allow(unused_imports)]
use crate::registry::Command as HostCommand;
#[allow(unused_imports)]
use crate::{command, Core};
#[allow(unused_imports)]
use serde::Deserialize;
#[allow(unused_imports)]
use std::sync::Arc;

pub static COMMANDS: &[HostCommand] = &[
    command!("session_last_event", session_last_event),
    command!("session_jsonl_size", session_jsonl_size),
    command!("session_truncate_jsonl", session_truncate_jsonl),
];

use crate::session_store::find_session_jsonl_globally;
use aide_workspace::transcripts::LastEventInfo;
use aide_workspace::transcripts::jsonl;

// 供自动化 RunRecord.summary 读取末条消息摘要（automation/scheduler.rs）
pub use aide_workspace::transcripts::jsonl::last_jsonl_message;

async fn blocking<T: Send + 'static>(
    name: &'static str,
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("{name} task panicked: {e}"))?
}

/// 同 load_messages：整读 .jsonl 再反向扫描，转 blocking 线程。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLastEventArgs {
    session_id: String,
}

async fn session_last_event(_core: Arc<Core>, a: SessionLastEventArgs) -> Result<LastEventInfo, String> {
    let SessionLastEventArgs { session_id } = a;
    {
    blocking("session_last_event", move || {
        match find_session_jsonl_globally(&session_id).into_iter().next() {
            Some(p) => jsonl::last_event_at(&p),
            None => Ok(LastEventInfo::empty()),
        }
    })
    .await
}
}

/// 每轮对话结束都会调用一次（takeSnapshot 记录撤回锚点），必须 async——同步版本
/// 曾在诊断黑匣子里被实锤为 Rust 主线程冻结的嫌疑对象：`find_session_jsonl_globally`
/// 遍历 `~/.aide/claude/projects/` 是同步磁盘 IO，杀软实时扫描 / 磁盘争抢时可能被拖到
/// 秒级甚至更久，堵在 Tauri 主线程上会连累所有后续命令排队（详见 CLAUDE.md「同步
/// command 禁止重 IO」）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionJsonlSizeArgs {
    session_id: String,
}

async fn session_jsonl_size(_core: Arc<Core>, a: SessionJsonlSizeArgs) -> Result<u64, String> {
    let SessionJsonlSizeArgs { session_id } = a;
    {
    blocking("session_jsonl_size", move || {
        match find_session_jsonl_globally(&session_id).into_iter().next() {
            Some(p) => jsonl::size_at(&p),
            None => Ok(0),
        }
    })
    .await
}
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTruncateJsonlArgs {
    session_id: String,
    byte_pos: u64,
}

async fn session_truncate_jsonl(_core: Arc<Core>, a: SessionTruncateJsonlArgs) -> Result<(), String> {
    let SessionTruncateJsonlArgs { session_id, byte_pos } = a;
    {
    blocking("session_truncate_jsonl", move || {
        match find_session_jsonl_globally(&session_id).into_iter().next() {
            Some(p) => jsonl::truncate_at(&p, byte_pos),
            None => Ok(()),
        }
    })
    .await
}
}
