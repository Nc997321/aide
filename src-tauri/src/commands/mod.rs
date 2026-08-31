pub mod app;
pub mod chat;
pub mod clipboard;
pub mod customizations;
pub mod detectors;
pub mod file_assoc;
pub mod filesystem;
pub mod git;
pub mod jdk;
pub mod marketplace;
pub mod migration;
pub mod notifications;
pub mod onboarding;
pub mod permissions;
pub mod provider;
pub mod proxy;
pub mod recent;
pub mod remote;
pub mod run_configs;
pub mod run_process;
pub mod search;
pub mod session;
pub mod settings;
pub mod shell;
pub mod workspace;

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

// ── Shared Types ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileEntry>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Session {
    pub id: String,
    pub name: String,
    pub timestamp: u64,
}

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

#[derive(Debug, Serialize, Clone)]
pub struct WorkspaceInfo {
    pub key: String,
    pub name: String,
    pub missing: bool,
}

#[derive(Debug, Serialize)]
pub struct ProjectInfo {
    pub root: String,
    pub name: String,
    pub branch: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct DiffEntry {
    pub path: String,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Serialize, Clone)]
pub struct GrepMatch {
    pub file: String,
    pub line: u32,
    pub content: String,
    pub match_type: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct LastEventInfo {
    pub event_type: Option<String>,
    pub stop_reason: Option<String>,
    pub timestamp: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChangeFileData {
    pub path: String,
    #[serde(default = "default_status")]
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
}

fn default_status() -> String {
    "M".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChangeRoundData {
    pub index: u32,
    pub time: String,
    pub files: Vec<ChangeFileData>,
    #[serde(default)]
    pub rewind_to: Option<u64>,
    /// 本轮对应的用户提问（变更面板轮次标题用）；旧数据无此字段，默认空。
    #[serde(default)]
    pub prompt: Option<String>,
}

// ── WorkspaceState ──

pub struct WorkspaceState {
    pub key: Mutex<Option<String>>,
    pub path: Mutex<Option<PathBuf>>,
}

impl WorkspaceState {
    pub fn new() -> Self {
        Self {
            key: Mutex::new(None),
            path: Mutex::new(None),
        }
    }
}

// ── Shared Helpers ──

pub fn project_root_for_commands(ws: &WorkspaceState) -> PathBuf {
    if let Ok(path_guard) = ws.path.lock() {
        if let Some(path) = path_guard.as_ref() {
            if path.exists() {
                return path.clone();
            }
        }
    }
    // No workspace explicitly set — fall back to user's home directory.
    // Using the install directory (cwd) is never useful.
    user_home().unwrap_or_else(|| PathBuf::from("."))
}

pub fn detect_git_branch(root: &PathBuf) -> String {
    let head = root.join(".git").join("HEAD");
    if let Ok(content) = fs::read_to_string(&head) {
        if let Some(line) = content.lines().next() {
            if let Some(branch) = line.strip_prefix("ref: refs/heads/") {
                return branch.to_string();
            }
        }
    }
    String::new()
}

// ── Path Helpers ──

pub fn user_home() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .ok()
}

/// claude.exe 的「家目录」——所有 Claude 自有数据（settings.json / CLAUDE.md /
/// agents/ / skills/ / projects/ / sessions/ / plugins/）的根。
///
/// 指向 Aide 自管理目录下的 `claude/` 子目录，而非用户系统的 `~/.claude/`：
/// runtime/mod.rs 会把 `CLAUDE_CONFIG_DIR` 注入 sidecar 指向同一处，使内置
/// claude.exe 把所有自有数据写到 Aide 自己的目录树里，彻底切断对系统 Claude CLI
/// 的依赖。用子目录而非顶层是为了与 Aide 自己的 `our_sessions_dir()`
/// （`~/.aide/sessions/`，schema 不同）按所有权天然分离，零碰撞。
pub fn claude_home() -> PathBuf {
    our_config_dir().join("claude")
}

pub fn claude_projects_dir() -> PathBuf {
    claude_home().join("projects")
}

pub fn claude_sessions_dir() -> PathBuf {
    claude_home().join("sessions")
}

/// Aide 自管理配置根目录：`~/.aide/`。
///
/// 历史路径是 `~/.claude-code-desktop/`；启动时 `migration::ensure_aide_data_dir_migrated()`
/// 会把老目录原子 rename 到此处（同文件系统、瞬时、无需用户确认）。所有 Aide 自有数据
/// （state.json / sessions / recent / notifications / diagnostics / log / claude-agent-sdk/
/// 以及 claude/ 子目录）都在这棵树下。
pub fn our_config_dir() -> PathBuf {
    user_home()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".aide")
}

pub fn our_sessions_dir() -> PathBuf {
    our_config_dir().join("sessions")
}

/// 会话显示名的权威源：`~/.aide/sessions/<id>.json` 的 `name` 字段
/// （create/rename/auto_rename 三处写）。任何「按 id 展示会话名」的地方都应
/// 以它为准，元数据缺失时由调用方决定兜底。list_sessions 与 list_recent
/// （recent.json 只存快照名）都经此对齐。
pub(crate) fn our_session_name(session_id: &str) -> Option<String> {
    let path = our_sessions_dir().join(format!("{}.json", session_id));
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                return v
                    .get("name")
                    .and_then(|n| n.as_str())
                    .map(|s| s.to_string());
            }
        }
    }
    None
}

/// 会话绑定的供应商 id 权威源：`~/.aide/sessions/<id>.json` 的 `provider` 字段
/// （set_session_provider / 前端 stampProvider 写）。空串视为未记（filter）。
/// 「会话属于哪个供应商」的 Rust 侧解析（send_message 按会话 provider 构造 env）
/// 与前端 session_provider 命令共用此口径。
pub(crate) fn our_session_provider_field(session_id: &str) -> Option<String> {
    let path = our_sessions_dir().join(format!("{}.json", session_id));
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                return v
                    .get("provider")
                    .and_then(|p| p.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
            }
        }
    }
    None
}

/// 会话是否是自动化运行产物（tags 含 "automation"）。
/// 运行转录仍是普通 session JSONL（查看器直接复用），但不进正常会话列表——
/// 一个每天跑的任务 30 天产生 30+ 条记录，会把列表冲垮。tags 由
/// AutomationService 发起运行时写入 `~/.aide/sessions/<id>.json`。
pub(crate) fn our_session_is_automation(session_id: &str) -> bool {
    let path = our_sessions_dir().join(format!("{}.json", session_id));
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
            return v
                .get("tags")
                .and_then(|t| t.as_array())
                .map(|a| a.iter().any(|x| x.as_str() == Some("automation")))
                .unwrap_or(false);
        }
    }
    false
}

/// legacy `config.json`——**纯遗留导入源**：老版本的设置+状态都写在这个文件里，
/// 设置体系迁移（`settings::migration`）读它一次、导入 `settings.json` 后即可整体
/// 删除。没有任何活代码应该再读写它；运行时状态的家是 `state_path()`。
pub fn config_path() -> PathBuf {
    our_config_dir().join("config.json")
}

/// `state.json`——应用自记账的运行时状态（当前工作区、隐藏工作区黑名单、
/// Claude 数据迁移标记、文件关联注册基线等「不是用户偏好」的状态）。用户设置
/// 走 `settings.json` 的 descriptor 体系，不进这里。
pub fn state_path() -> PathBuf {
    our_config_dir().join("state.json")
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
pub fn find_session_jsonl_in(projects_dir: &std::path::Path, id: &str) -> Vec<PathBuf> {
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

/// `find_session_jsonl_in` scoped to Claude's real `<claude_home>/projects/` dir.
pub fn find_session_jsonl_globally(id: &str) -> Vec<PathBuf> {
    find_session_jsonl_in(&claude_projects_dir(), id)
}

// Re-export from workspace module
pub use workspace::{load_workspace_state, resolve_path_from_key, resolve_project_dirs};

#[cfg(test)]
mod tests {
    use super::*;

    /// Aide's cwd→folder encoding: replace `:`, `\`, `/` with `-` (keeps `.`).
    /// Used here only to model the folder name Aide *would* compute, so the test
    /// can contrast it with a differently-encoded folder Claude created.
    fn aide_encode(path: &str) -> String {
        path.replace(':', "-").replace('\\', "-").replace('/', "-")
    }

    /// The lookup must find a transcript by id even when the folder name Claude
    /// used differs from the cwd-encoding Aide would compute. We model the
    /// observed divergence (a `.` in the cwd: Aide keeps it, an older Claude
    /// encoded it as `-`) with synthetic data — no real paths or ids in the test.
    #[test]
    fn finds_jsonl_when_folder_encoding_differs_from_aide_encode() {
        let root = std::env::temp_dir().join("aide_mod_test_encode_mismatch");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        let cwd = r"C:\fake\proj\test4.0";
        // Folder Aide computes from the cwd (keeps the dot):
        let aide_folder = root.join(aide_encode(cwd));
        // Folder a Claude version that encodes '.' as '-' would have created:
        let claude_folder = root.join(aide_encode(cwd).replace('.', "-"));
        assert_ne!(aide_folder, claude_folder, "test setup must diverge");
        fs::create_dir_all(&aide_folder).unwrap();
        fs::create_dir_all(&claude_folder).unwrap();

        let id = "00000000-0000-0000-0000-000000000000";
        // Claude wrote the transcript into ITS folder, not Aide's:
        fs::write(claude_folder.join(format!("{id}.jsonl")), b"{}").unwrap();

        let hits = find_session_jsonl_in(&root, id);
        assert_eq!(hits.len(), 1);
        assert_eq!(
            hits[0]
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str()),
            claude_folder.file_name().and_then(|n| n.to_str()),
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn returns_empty_when_no_transcript() {
        let root = std::env::temp_dir().join("aide_mod_test_empty");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        assert!(find_session_jsonl_in(&root, "no-such-id").is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    // 回归：HistoryBlock 的线上 JSON 形状要跟前端 src/types/chat.ts 的 ContentBlock
    // 判别式联合镜像——`type` 取值和字段名（尤其 is_error → isError）一旦跑偏，
    // 前端 hydrate() 就会认不出这个 block，历史消息又会静默退化成纯文字。
    #[test]
    fn history_block_serializes_to_the_shape_the_frontend_expects() {
        let text = HistoryBlock::Text {
            text: "hi".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&text).unwrap(),
            serde_json::json!({ "type": "text", "text": "hi" }),
        );

        let tool_call = HistoryBlock::ToolCall {
            id: "t1".to_string(),
            name: "Bash".to_string(),
            input: serde_json::json!({ "command": "ls" }),
            result: Some("ok".to_string()),
            is_error: Some(false),
        };
        assert_eq!(
            serde_json::to_value(&tool_call).unwrap(),
            serde_json::json!({
                "type": "tool_call",
                "id": "t1",
                "name": "Bash",
                "input": { "command": "ls" },
                "result": "ok",
                "isError": false,
            }),
        );
    }
}
