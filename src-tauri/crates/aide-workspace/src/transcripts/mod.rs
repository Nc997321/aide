//! Claude CLI 会话转录（`<claude home>/projects/<编码 cwd>/<session>.jsonl`）的读取。
//!
//! 转录是 CLI 在**它运行的机器上**写的：本机会话在桌面，远程工作区的会话在目标机。
//! 这里的函数都是「给定目录 / 文件」的纯读写，不认识桌面的配置根，所以两个宿主共用：
//! 桌面按本机配置根调用，aide-host 按目标机的 `$HOME/.aide/claude` 调用。
//! 会话显示名、自动化标签等**桌面元数据**不在这里（它们只在桌面）。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub mod history;
pub mod jsonl;
pub mod parse;

/// 历史消息里的一个内容块——`load_messages` 解析会话 `.jsonl` 时按原始顺序重建，
/// 跟前端 `src/types/chat.ts` 的 `ContentBlock` 判别式联合镜像（`type` 字段一致）。
/// 目前只重建 text/tool_call 两种；子代理（Agent/Task）调用和图片维持原有降级
/// 行为——整段跳过，不出现在历史里（子代理内部的分步进度 Claude CLI 从不落盘，
/// 做了也补不全，图片重建暂不在这次修复范围）。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type")]
pub enum HistoryBlock {
    #[serde(rename = "text")]
    Text { text: String },
    // 注意：容器级 rename_all 只管 tag（variant 名）大小写，不会顺带改变 variant
    // 内部字段名——is_error → isError 必须在这个 variant 上单独再声明一次
    // rename_all，否则会原样落盘成 snake_case，前端读不出来（已被回归测试
    // history_block_serializes_to_the_shape_the_frontend_expects 坐实过一次）。
    #[serde(rename = "tool_call", rename_all = "camelCase")]
    ToolCall {
        id: String,
        name: String,
        input: serde_json::Value,
        /// 来自同一份 transcript 里稍后（也可能是更早，顺序不保证）出现的
        /// tool_result；找不到匹配的 tool_use_id 时为 None（这次会话记录不全，
        /// 或者本身就是最后一条尚未返回结果的调用）。
        result: Option<String>,
        is_error: Option<bool>,
    },
    /// 主线程思考块——Claude CLI 落盘的 assistant 消息 content 里的 thinking block。
    /// text 可能空（provider 用 display=omitted 时 block 在但 text 空）；前端按非空
    /// 才渲染思考区，空的不显示，故空值也照常保留以维持 block 顺序。
    #[serde(rename = "thinking")]
    Thinking { text: String },
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessageItem {
    pub role: String,
    pub blocks: Vec<HistoryBlock>,
    pub timestamp: u64,
}

/// `load_messages` 分页返回：消息页 + 下一页字节游标。
/// `next_offset_bytes` = 页首真实 user 行的起始字节；0 = 已到文件头（无更早页）。
/// 下一页从该字节继续往前读（不包含该行本身），页与页之间无重复。
/// `end_offset_bytes` = 本页排他末尾字节（= 本次读取的 end，整读时为 file_len）——
/// 前端页级回收（recycle）按 `(end_offset_bytes, end-start)` 确定性重取同一页。
/// ⚠️ camelCase 必须（前端读 `result.nextOffsetBytes`）：缺了它前端拿到 undefined、
/// tailOffset=undefined → hasMore 恒 false → 预览上滚取回永不触发（2026-08-26
/// 诊断环实测定位，测试全用 mock 所以从未暴露）。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoadMessagesResult {
    pub messages: Vec<ChatMessageItem>,
    pub next_offset_bytes: u64,
    pub end_offset_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LastEventInfo {
    pub event_type: Option<String>,
    pub stop_reason: Option<String>,
    pub timestamp: Option<String>,
}

impl LastEventInfo {
    /// 找不到转录 / 没有对话事件。
    pub fn empty() -> Self {
        LastEventInfo {
            event_type: None,
            stop_reason: None,
            timestamp: None,
        }
    }
}

/// 路径 → 编码 key：把 : \ / 替换为 -，与 Claude CLI
/// `~/.aide/claude/projects/` 目录命名一致。
pub fn path_to_key(path: &str) -> String {
    path.chars()
        .map(|c| match c {
            ':' | '\\' | '/' => '-',
            other => other,
        })
        .collect()
}

/// 按编码 key 解析实际的项目目录（可能命中多个）。
///
/// 新版 Agent SDK / claude.exe 编码 cwd 时把 `.` 也替换为 `-`
/// （`C--...-chennong4-0`），而 `path_to_key` 保留点号（`C--...-chennong4.0`），
/// 同一工作区因此可能分裂成两个目录（2026-07-24 实锤：chennong4.0 的新会话
/// 全部写进 `chennong4-0`，按 `path_to_key` 算出的目录去列会话自然读不到；
/// 同一案例此前已在 `find_session_jsonl_in` 的注释中记载）。这里按
/// 「`.` 归一成 `-` 后相等」匹配所有候选目录，调用方合并扫描。
pub fn resolve_project_dirs(projects_dir: &Path, key: &str) -> Vec<PathBuf> {
    let normalized = key.replace('.', "-");
    let mut dirs = Vec::new();
    if let Ok(entries) = fs::read_dir(projects_dir) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if entry.file_name().to_string_lossy().replace('.', "-") == normalized {
                dirs.push(entry.path());
            }
        }
    }
    dirs
}

/// Locate a session's transcript(s) by globally-unique session id.
///
/// Claude stores transcripts at `<claude_home>/projects/<encoded-cwd>/<id>.jsonl`
/// and `claude --resume <id>` finds them by scanning **every** project folder
/// for the id — the cwd encoding is irrelevant once you have the id. Aide must
/// do the same: the folder name Claude actually used can differ from the
/// cwd-encoding Aide would compute. Concretely observed: a Claude version
/// encoded `.` as `-` (`C--...-chennong4-0`) while Aide keeps the dot
/// (`C--...-chennong4.0`), so a cwd-based lookup pointed at the wrong folder
/// and `delete_session` silently no-op'd, leaving the transcript behind for
/// Claude to resume. Session ids are UUIDs and globally unique, so at most one
/// project folder ever matches.
///
/// `projects_dir` is a parameter so the lookup is unit-testable against a
/// temp dir; production callers pass `claude_projects_dir()`.
pub fn find_jsonl_in(projects_dir: &Path, id: &str) -> Vec<PathBuf> {
    let mut hits = Vec::new();
    if let Ok(entries) = fs::read_dir(projects_dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let p = entry.path().join(format!("{}.jsonl", id));
                if p.is_file() {
                    hits.push(p);
                }
            }
        }
    }
    hits
}

/// 一个项目目录里的转录条目（不含任何桌面元数据）。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranscriptEntry {
    pub id: String,
    /// 转录文件修改时间（毫秒）；CLI 会话元数据缺 startedAt 时的排序兜底。
    pub mtime_ms: u64,
    /// CLI 自己的会话元数据（`<claude home>/sessions/*.json`）里的名字与开始时间。
    pub cli_name: Option<String>,
    pub started_at: u64,
}

/// 列出工作区（按编码 key）下所有转录。同一工作区可能因编码差异分裂成多个目录，合并去重。
pub fn list_transcripts(claude_home: &Path, key: &str) -> Vec<TranscriptEntry> {
    let mut out: Vec<TranscriptEntry> = Vec::new();
    for dir in resolve_project_dirs(&claude_home.join("projects"), key) {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let path = entry.path();
            if !path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                continue;
            }
            let id = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            if id.is_empty() || out.iter().any(|t| t.id == id) {
                continue;
            }
            let mtime_ms = path
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let (cli_name, started_at) = match cli_session_meta(&claude_home.join("sessions"), &id) {
                Some((n, s)) => (Some(n), s),
                None => (None, 0),
            };
            out.push(TranscriptEntry { id, mtime_ms, cli_name, started_at });
        }
    }
    out
}

/// CLI 会话元数据（`<claude home>/sessions/*.json`，按 sessionId 匹配）→ (name, startedAt)。
pub fn cli_session_meta(sessions_dir: &Path, session_id: &str) -> Option<(String, u64)> {
    let read_dir = fs::read_dir(sessions_dir).ok()?;
    for entry in read_dir.flatten() {
        let path = entry.path();
        if !path.extension().map(|e| e == "json").unwrap_or(false) {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) else { continue };
        if v.get("sessionId").and_then(|s| s.as_str()) == Some(session_id) {
            let name = v.get("name").and_then(|n| n.as_str()).unwrap_or("未命名").to_string();
            let started_at = v.get("startedAt").and_then(|t| t.as_u64()).unwrap_or(0);
            return Some((name, started_at));
        }
    }
    None
}

/// 在一个 claude home 下按 session id 找转录。
pub fn find_in_home(claude_home: &Path, session_id: &str) -> Option<PathBuf> {
    find_jsonl_in(&claude_home.join("projects"), session_id).into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_to_key_windows_path() {
        assert_eq!(path_to_key(r"C:\Users\yangx\proj"), "C--Users-yangx-proj");
    }

    #[test]
    fn path_to_key_unix_path() {
        assert_eq!(path_to_key("/Users/x/proj"), "-Users-x-proj");
    }

    #[test]
    fn path_to_key_preserves_other_chars() {
        // 空格、中文、点不替换
        assert_eq!(
            path_to_key(r"C:\my project\文档.git"),
            "C--my project-文档.git"
        );
    }

    // ── resolve_project_dirs：dot 归一匹配 ──

    #[test]
    fn resolve_project_dirs_matches_dot_normalized_variants() {
        let root = std::env::temp_dir().join("aide_ws_test_resolve_project_dirs");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        // 同一工作区的两种编码：Aide 保留点号 / SDK 把点编码成横杠（chennong4.0 实锤案例）
        fs::create_dir_all(root.join("C--proj-chennong4.0")).unwrap();
        fs::create_dir_all(root.join("C--proj-chennong4-0")).unwrap();
        fs::create_dir_all(root.join("C--proj-other")).unwrap();

        let mut dirs = resolve_project_dirs(&root, "C--proj-chennong4.0");
        dirs.sort();
        assert_eq!(
            dirs,
            vec![
                root.join("C--proj-chennong4-0"),
                root.join("C--proj-chennong4.0")
            ]
        );

        // 反向 key（横杠版）同样命中两个目录
        assert_eq!(resolve_project_dirs(&root, "C--proj-chennong4-0").len(), 2);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_project_dirs_missing_projects_dir_returns_empty() {
        let root = std::env::temp_dir().join("aide_ws_test_resolve_missing");
        let _ = fs::remove_dir_all(&root);
        assert!(resolve_project_dirs(&root, "whatever").is_empty());
    }

    #[test]
    fn resolve_project_dirs_ignores_files() {
        let root = std::env::temp_dir().join("aide_ws_test_resolve_files");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("C--proj-x.0"), b"not a dir").unwrap();

        assert!(resolve_project_dirs(&root, "C--proj-x.0").is_empty());

        let _ = fs::remove_dir_all(&root);
    }
}
