//! Memory Observatory（记忆观测台）后端命令。
//!
//! 观测对象 = Claude Code auto memory：`~/.aide/claude/projects/<key>/memory/`
//! （MEMORY.md 索引 + topic 笔记）+ 用户级 `~/.aide/claude/CLAUDE.md`。
//! spec：docs/superpowers/specs/2026-09-04-memory-observatory-design.md
//!
//! 命令全部 async + spawn_blocking（遍历 + 读几十个小文件，遵守主线程禁令）。
//! P1：事件台账（sidecar PostToolUse → events.jsonl，events.rs 读取聚合）。
//! P2：跨项目只读聚合（scan_all 遍历 projects/*/memory/；events 传 None 不过滤）。

#[allow(unused_imports)]
use crate::registry::{blocking, Command as HostCommand};
#[allow(unused_imports)]
use crate::{command, Core};
#[allow(unused_imports)]
use serde::Deserialize;
#[allow(unused_imports)]
use std::sync::Arc;

pub static COMMANDS: &[HostCommand] = &[
    command!("memory_observatory_scan", memory_observatory_scan),
    command!("memory_observatory_read_file", memory_observatory_read_file),
    command!("memory_observatory_snapshot", memory_observatory_snapshot),
    command!("memory_observatory_delete_file", memory_observatory_delete_file),
    command!("memory_observatory_events", memory_observatory_events),
    command!("memory_observatory_scan_all", memory_observatory_scan_all),
    command!("memory_index_for_dir", memory_index_for_dir),
];

mod delete;
mod events;
mod index;
mod parse;
mod resolve;
mod scan;
mod snapshot;

/// MEMORY.md 截断上限：前 200 行 / 25KB，先到先截（Claude Code 加载语义）。
pub const MEMORY_INDEX_MAX_LINES: usize = 200;
pub const MEMORY_INDEX_MAX_BYTES: usize = 25 * 1024;

/// read_file 的 CLAUDE.md 特判名（confine_name 不收它，因为它不在 memory 目录）。
const CLAUDE_MD_ALIAS: &str = "__claude_md__";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryObservatoryScanArgs {
    workspace_key: String,
}

async fn memory_observatory_scan(_core: Arc<Core>, a: MemoryObservatoryScanArgs) -> Result<scan::ScanResult, String> {
    let MemoryObservatoryScanArgs { workspace_key } = a;
    tokio::task::spawn_blocking(move || scan::scan(&workspace_key))
        .await
        .map_err(|e| format!("memory_observatory_scan task panicked: {e}"))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryObservatoryReadFileArgs {
    workspace_key: String,
    name: String,
}

async fn memory_observatory_read_file(_core: Arc<Core>, a: MemoryObservatoryReadFileArgs) -> Result<String, String> {
    let MemoryObservatoryReadFileArgs { workspace_key, name } = a;
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryObservatorySnapshotArgs {
    workspace_key: String,
}

async fn memory_observatory_snapshot(_core: Arc<Core>, a: MemoryObservatorySnapshotArgs) -> Result<snapshot::SnapshotDiff, String> {
    let MemoryObservatorySnapshotArgs { workspace_key } = a;
    tokio::task::spawn_blocking(move || {
        let scan = scan::scan(&workspace_key)?;
        let path = snapshot::snapshot_path_for(&workspace_key);
        snapshot::take_snapshot(&scan, &path)
    })
    .await
    .map_err(|e| format!("memory_observatory_snapshot task panicked: {e}"))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryObservatoryDeleteFileArgs {
    workspace_key: String,
    name: String,
}

async fn memory_observatory_delete_file(_core: Arc<Core>, a: MemoryObservatoryDeleteFileArgs) -> Result<delete::DeleteResult, String> {
    let MemoryObservatoryDeleteFileArgs { workspace_key, name } = a;
    tokio::task::spawn_blocking(move || {
        let r = delete::delete_memory(&workspace_key, &name)?;
        events::append_deleted_event(&workspace_key, &name);
        Ok(r)
    })
    .await
    .map_err(|e| format!("memory_observatory_delete_file task panicked: {e}"))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryObservatoryEventsArgs {
    #[serde(default)]
    workspace_key: Option<String>,
}

async fn memory_observatory_events(_core: Arc<Core>, a: MemoryObservatoryEventsArgs) -> Result<events::EventsResult, String> {
    let MemoryObservatoryEventsArgs { workspace_key } = a;
    tokio::task::spawn_blocking(move || events::read_events(workspace_key.as_deref()))
        .await
        .map_err(|e| format!("memory_observatory_events task panicked: {e}"))?
}

/// P2 跨项目聚合：全量扫描 projects/*/memory/（只读）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryObservatoryScanAllArgs {
}

async fn memory_observatory_scan_all(_core: Arc<Core>, a: MemoryObservatoryScanAllArgs) -> Result<scan::ScanAllResult, String> {
    let _ = a;
    tokio::task::spawn_blocking(scan::scan_all)
        .await
        .map_err(|e| format!("memory_observatory_scan_all task panicked: {e}"))?
}

/// 按**目录**取该工作区的记忆索引原文（不是观测台 UI 要的）：供 `@目录` 的当轮注入
/// 带上对方仓的记忆（单会话跨目录工作，判据与截断见 `index.rs`）。
/// 与观测台共用解析与截断规则，所以落在这个模块；REGISTRY 不收录——mention 解析
/// 是桌面独有路径（PWA/鸿蒙没有芯片条）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryIndexForDirArgs {
    dir: String,
}

async fn memory_index_for_dir(_core: Arc<Core>, a: MemoryIndexForDirArgs) -> Result<Option<String>, String> {
    let MemoryIndexForDirArgs { dir } = a;
    tokio::task::spawn_blocking(move || index::for_dir(&dir))
        .await
        .map_err(|e| format!("memory_index_for_dir task panicked: {e}"))
}
