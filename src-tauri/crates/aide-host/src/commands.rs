//! aide-host 能执行的命令清单（**可审计暴露面**）。桌面的 IPC 拦截层据此判定
//! 「转发 / 大声拒绝」。
//!
//! 主体是 [`aide_core`] 的命令表（与桌面本机 Host 同一张表，命令名 = 前端 invoke 名）；
//! 另有两组还没迁进 core 的 host 专属命令（会话转录原料、LSP 探测）。

/// 会话转录（目标机 claude home 下的 `.jsonl`）。**不是** Tauri 命令名——桌面的会话
/// 命令判定会话属于远程工作区后，用这些名字向 host 取转录原料，再叠加桌面元数据。
pub const TRANSCRIPT_COMMANDS: &[&str] = &[
    "transcript_list",
    "transcript_load",
    "transcript_last_event",
    "transcript_size",
    "transcript_truncate",
];

/// 是否是 aide-host 认识的命令。
pub fn is_supported(cmd: &str) -> bool {
    aide_core::lookup(cmd).is_some()
        || TRANSCRIPT_COMMANDS.contains(&cmd)
        || crate::protocol::LSP_COMMANDS.contains(&cmd)
}
