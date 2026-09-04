//! Memory Observatory（记忆观测台）后端命令。
//!
//! 观测对象 = Claude Code auto memory：`~/.aide/claude/projects/<key>/memory/`
//! （MEMORY.md 索引 + topic 笔记）+ 用户级 `~/.aide/claude/CLAUDE.md`。
//! spec：docs/superpowers/specs/2026-09-04-memory-observatory-design.md
//!
//! 四条命令全部 async + spawn_blocking（遍历 + 读几十个小文件，遵守主线程禁令）。
//! 事件台账 hook（sidecar 侧 PostToolUse → events.jsonl）是 P1，本模块的
//! scan 暂不读 events。

mod delete;
mod events;
mod parse;
mod resolve;
mod scan;
mod snapshot;

/// MEMORY.md 截断上限：前 200 行 / 25KB，先到先截（Claude Code 加载语义）。
pub const MEMORY_INDEX_MAX_LINES: usize = 200;
pub const MEMORY_INDEX_MAX_BYTES: usize = 25 * 1024;

/// read_file 的 CLAUDE.md 特判名（confine_name 不收它，因为它不在 memory 目录）。
const CLAUDE_MD_ALIAS: &str = "__claude_md__";

#[tauri::command]
pub async fn memory_observatory_scan(workspace_key: String) -> Result<scan::ScanResult, String> {
    tokio::task::spawn_blocking(move || scan::scan(&workspace_key))
        .await
        .map_err(|e| format!("memory_observatory_scan task panicked: {e}"))?
}

#[tauri::command]
pub async fn memory_observatory_read_file(
    workspace_key: String,
    name: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        if name == CLAUDE_MD_ALIAS {
            return std::fs::read_to_string(resolve::claude_md_path())
                .map_err(|e| format!("read CLAUDE.md: {e}"));
        }
        let name = resolve::confine_name(&name)?;
        let dirs = resolve::memory_dirs(&workspace_key);
        resolve::locate(&dirs, &name)
            .first()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .ok_or_else(|| format!("memory not found: {name}"))
    })
    .await
    .map_err(|e| format!("memory_observatory_read_file task panicked: {e}"))?
}

#[tauri::command]
pub async fn memory_observatory_snapshot(
    workspace_key: String,
) -> Result<snapshot::SnapshotDiff, String> {
    tokio::task::spawn_blocking(move || {
        let scan = scan::scan(&workspace_key)?;
        let path = snapshot::snapshot_path_for(&workspace_key);
        snapshot::take_snapshot(&scan, &path)
    })
    .await
    .map_err(|e| format!("memory_observatory_snapshot task panicked: {e}"))?
}

#[tauri::command]
pub async fn memory_observatory_delete_file(
    workspace_key: String,
    name: String,
) -> Result<delete::DeleteResult, String> {
    tokio::task::spawn_blocking(move || {
        let r = delete::delete_memory(&workspace_key, &name)?;
        events::append_deleted_event(&workspace_key, &name);
        Ok(r)
    })
    .await
    .map_err(|e| format!("memory_observatory_delete_file task panicked: {e}"))?
}

#[tauri::command]
pub async fn memory_observatory_events(
    workspace_key: String,
) -> Result<events::EventsResult, String> {
    tokio::task::spawn_blocking(move || events::read_events(&workspace_key))
        .await
        .map_err(|e| format!("memory_observatory_events task panicked: {e}"))?
}
