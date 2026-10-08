//! 历史消息读取的命令外壳：定位会话转录（Host 的配置根），分页与解析在
//! aide_workspace::transcripts。Host 窗口里会话住在那台 Host 的 aide-core 里，同一份实现。

#[allow(unused_imports)]
use crate::registry::{blocking, Command as HostCommand};
#[allow(unused_imports)]
use crate::{command, Core};
#[allow(unused_imports)]
use serde::Deserialize;
#[allow(unused_imports)]
use std::sync::Arc;

pub static COMMANDS: &[HostCommand] = &[
    command!("load_messages", load_messages),
];

use crate::session_store::find_session_jsonl_globally;
use aide_workspace::transcripts::LoadMessagesResult;
use aide_workspace::transcripts::history::load_messages_at;

/// transcript 会随会话增长到多 MB，整读 + 逐行解析必须离开主线程（切会话时触发，
/// 同步跑等于切一次长会话卡一次窗口）。
///
/// 分页参数（均为可选，缺省 = 现有整读行为，向后兼容）：
/// - `offset_bytes`：从该字节位置**往前**（向文件头方向）取一页；None = 从文件尾取。
///   游标语义：下一页从「页首真实 user 行的起始字节」继续往前读，页与页之间无重复。
/// - `limit`：单页**字节预算**（UTF-8 行字节累计；至少 1 条保底）。2026-08-26 由
///   「目标条数」改字节预算：窗口/取回按内容量自适应（大 tool_result 占预算多则少取），
///   与前端 useMessageWindow 的字节预算窗口对齐；页首裁到真实 user 行保证回合完整。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadMessagesArgs {
    session_id: String,
    #[serde(default)]
    offset_bytes: Option<u64>,
    #[serde(default)]
    limit: Option<u32>,
}

async fn load_messages(_core: Arc<Core>, a: LoadMessagesArgs) -> Result<LoadMessagesResult, String> {
    let LoadMessagesArgs { session_id, offset_bytes, limit } = a;
    tokio::task::spawn_blocking(move || load_messages_blocking(session_id, offset_bytes, limit))
        .await
        .map_err(|e| format!("load_messages task panicked: {}", e))?
}

fn load_messages_blocking(
    session_id: String,
    offset_bytes: Option<u64>,
    limit: Option<u32>,
) -> Result<LoadMessagesResult, String> {
    match find_session_jsonl_globally(&session_id).into_iter().next() {
        Some(p) => load_messages_at(&p, offset_bytes, limit),
        None => Ok(LoadMessagesResult {
            messages: Vec::new(),
            next_offset_bytes: 0,
            end_offset_bytes: 0,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_messages_blocking_missing_file_returns_empty() {
        let result =
            load_messages_blocking(format!("aide-page-none-{}", std::process::id()), None, None)
                .unwrap();
        assert!(result.messages.is_empty());
        assert_eq!(result.next_offset_bytes, 0);
    }
}
