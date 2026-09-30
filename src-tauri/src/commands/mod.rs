pub mod app;
pub mod browser;
pub mod chat;
pub mod clipboard;
pub mod customizations;
pub mod detectors;
pub mod file_assoc;
pub mod filesystem;
pub mod knowledge;
pub mod marketplace;
pub mod memory_observatory;
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
pub mod session;
pub mod settings;
pub mod shell;
pub mod workspace;

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

// ── Shared Types ──

// 工作区操作的共享类型与实现住在 aide-workspace（桌面与 aide-host 共用）。
pub use aide_workspace::transcripts::{
    find_jsonl_in as find_session_jsonl_in, ChatMessageItem, HistoryBlock, LastEventInfo,
    LoadMessagesResult,
};
pub use aide_workspace::{detect_git_branch, DiffEntry, FileEntry, GrepMatch};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Session {
    pub id: String,
    pub name: String,
    pub timestamp: u64,
}




#[derive(Debug, Serialize, Clone)]
pub struct WorkspaceInfo {
    pub key: String,
    pub name: String,
    pub missing: bool,
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

/// 一轮变更在 `<id>-changes.json` 里的一行。
///
/// **线上名一律 camelCase**（`rename_all`）：TS 侧 `ChangeRound` 是唯一消费者，而 Tauri
/// 只转换**命令的参数名**、嵌套 struct 的字段名走 serde 原样。这里曾经没有 `rename_all`——
/// `rewind_to` 与 TS 的 `rewindTo` 对不上，两个方向都**静默**失效（写盘被当未知键丢掉 →
/// 恒 null；读回 TS 恒 undefined），历史轮的「撤回到此处」因此从不出现（2026-09-28 修）。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRoundData {
    pub index: u32,
    pub time: String,
    pub files: Vec<ChangeFileData>,
    /// 本轮回退锚点（.jsonl 字节位置）。`alias` 读改名之前落盘的 snake_case 键——
    /// 老会话的回退锚点不能因为一次改名而丢。
    #[serde(default, alias = "rewind_to")]
    pub rewind_to: Option<u64>,
    /// 本轮对应的用户提问（变更面板轮次标题用）；旧数据无此字段，默认空。
    #[serde(default)]
    pub prompt: Option<String>,
    /// 「改前」引用：**该轮开轮时刻**会话工作区仓库的 HEAD 提交。
    /// 旧数据 / 非 git 仓库 / 取失败都没有它 —— 消费端据此退回 HEAD 累计，不追溯。
    #[serde(default)]
    pub base_rev: Option<String>,
}

// ── WorkspaceState（Host 自持状态，住在 aide-core；Tauri 以 `Arc` 共享同一实例） ──

pub use aide_core::WorkspaceState;

// ── Shared Helpers ──

pub fn project_root_for_commands(ws: &WorkspaceState) -> PathBuf {
    if let Ok(path_guard) = ws.path.lock() {
        if let Some(path) = path_guard.as_ref() {
            // 远程工作区按存在处理（见 remote_workspace::path::present）
            if crate::remote_workspace::path::present(path) {
                return path.clone();
            }
        }
    }
    // No workspace explicitly set — fall back to user's home directory.
    // Using the install directory (cwd) is never useful.
    user_home().unwrap_or_else(|| PathBuf::from("."))
}

/// 带可选工作区覆写的根解析：调用方显式给了 cwd 就用它，否则回落全局活动工作区。
///
/// 存在理由：会话归属于某个工作区，但 `WorkspaceState` 是**全局单例**、随用户切 tab 改写
/// （`workspace/mod.rs:362-377` `set_workspace`，由 `SidebarLeft.vue:261` 触发）。
/// 任何「按会话」的 git 操作（变更归集、撤回、取 diff）若不带 cwd，就会打到用户
/// 当前正看着的那个工作区 —— 这正是变更面板窜数据的根因。调用方拿得到会话工作区时
/// **必须**传 cwd；传 None 仅用于确实只关心当前工作区的场景。
pub fn project_root_for(ws: &WorkspaceState, cwd: Option<&str>) -> PathBuf {
    match cwd {
        Some(c) if !c.trim().is_empty() => PathBuf::from(c),
        _ => project_root_for_commands(ws),
    }
}


// ── Path Helpers（Host 数据目录布局，住在 aide-core） ──

pub use aide_core::paths::{
    claude_home, claude_projects_dir, claude_sessions_dir, config_path, our_config_dir,
    our_sessions_dir, scoped_claude_home, session_config_roots, session_config_roots_in, state_path,
    user_home,
};


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

/// 会话档案里记的工作区归属（`wsPath` / `wsKey`）。两个字段由同一次
/// `set_session_workspace` 成对落盘，所以也成对读取——拆成两个 getter 只会让
/// "读一半"（有 path 没 key）成为可能。空串视为未记（filter）。
///
/// 这是「会话属于哪个工作区」的**权威源**：send_message 的 cwd 兜底
/// （显式 workspace_root 缺席时）与前端 `session_workspace` 命令共用此口径。
/// 只读不推断：档案里没有就是没有，调用方自己决定兜底与留痕。
#[derive(Clone, Debug, Default, Serialize)]
pub struct SessionWorkspaceRef {
    #[serde(rename = "wsPath")]
    pub path: Option<String>,
    #[serde(rename = "wsKey")]
    pub key: Option<String>,
}

pub(crate) fn our_session_workspace(session_id: &str) -> SessionWorkspaceRef {
    let path = our_sessions_dir().join(format!("{}.json", session_id));
    let Ok(content) = fs::read_to_string(&path) else {
        return SessionWorkspaceRef::default();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) else {
        return SessionWorkspaceRef::default();
    };
    let field = |k: &str| {
        v.get(k)
            .and_then(|s| s.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    };
    SessionWorkspaceRef {
        path: field("wsPath"),
        key: field("wsKey"),
    }
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

/// 多根查找核心：对每个配置根的 `projects/` 做一次 [`find_session_jsonl_in`]。
fn find_session_jsonl_across_roots(roots: &[PathBuf], id: &str) -> Vec<PathBuf> {
    roots
        .iter()
        .flat_map(|root| find_session_jsonl_in(&root.join("projects"), id))
        .collect()
}

/// `find_session_jsonl_in` scoped to **所有已知配置根**：先全局，再各作用域。
///
/// session id 全局唯一（UUID），多根扫描至多命中一处；全局排第一保证
/// 历史会话（会话目录隔离落地之前落的盘）优先命中，行为与改动前兼容。
pub fn find_session_jsonl_globally(id: &str) -> Vec<PathBuf> {
    find_session_jsonl_across_roots(&session_config_roots(), id)
}

// Re-export from workspace module
pub use workspace::{load_workspace_state, resolve_path_from_key, resolve_project_dirs};

#[cfg(test)]
mod tests {
    use super::*;

    fn ws_with_path(p: &std::path::Path) -> WorkspaceState {
        let ws = WorkspaceState::new();
        *ws.path.lock().unwrap() = Some(p.to_path_buf());
        ws
    }

    /// 显式 cwd 必须赢过全局工作区 —— 否则按会话的 git 操作仍会打到用户当前所看的那个工作区。
    #[test]
    fn project_root_prefers_explicit_cwd() {
        let global = std::env::temp_dir().join("aide_root_global");
        let mine = std::env::temp_dir().join("aide_root_session");
        fs::create_dir_all(&global).unwrap();
        fs::create_dir_all(&mine).unwrap();
        let ws = ws_with_path(&global);
        assert_eq!(project_root_for(&ws, Some(&mine.to_string_lossy())), mine);
    }

    /// 省略 cwd 走全局，行为与改动前完全一致（向后兼容既有调用方）。
    #[test]
    fn project_root_falls_back_to_global() {
        let global = std::env::temp_dir().join("aide_root_global2");
        fs::create_dir_all(&global).unwrap();
        let ws = ws_with_path(&global);
        assert_eq!(project_root_for(&ws, None), global);
    }

    /// 空串 / 纯空白视同省略：旧版主进程会传空串，拼出 "" 会把 git 打到安装目录。
    #[test]
    fn blank_cwd_is_treated_as_absent() {
        let global = std::env::temp_dir().join("aide_root_global3");
        fs::create_dir_all(&global).unwrap();
        let ws = ws_with_path(&global);
        assert_eq!(project_root_for(&ws, Some("")), global);
        assert_eq!(project_root_for(&ws, Some("   ")), global);
    }

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

    /// 会话目录隔离（2026-09-07）：automation 的转录落在作用域配置根下，
    /// 读侧必须对称——只扫全局的话，点开运行记录就是空白（线上实锤）。
    #[test]
    fn finds_jsonl_in_scoped_config_root_not_just_global() {
        let base = std::env::temp_dir().join("aide_mod_test_scoped_roots");
        let _ = fs::remove_dir_all(&base);

        // 全局配置根（历史会话形态）不放目标 id，防误命中
        let global_proj = base.join("claude").join("projects").join("C--ws");
        fs::create_dir_all(&global_proj).unwrap();
        fs::write(global_proj.join("other-id.jsonl"), b"{}").unwrap();

        // 作用域配置根（automation 隔离形态）：目标 jsonl 在这里
        let scoped_proj = base
            .join("scopes")
            .join("automation")
            .join("aut_x")
            .join("claude")
            .join("projects")
            .join("C--ws");
        fs::create_dir_all(&scoped_proj).unwrap();
        let id = "11111111-2222-3333-4444-555555555555";
        fs::write(scoped_proj.join(format!("{id}.jsonl")), b"{}").unwrap();

        let roots = session_config_roots_in(&base);
        assert_eq!(roots.len(), 2, "全局 + 一个作用域");
        assert_eq!(roots[0], base.join("claude"), "全局恒排第一");

        let hits = find_session_jsonl_across_roots(&roots, id);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].starts_with(&base.join("scopes")));

        let _ = fs::remove_dir_all(&base);
    }

    /// scopes 目录不存在（没人用过隔离）→ 退化为只有全局，不报错。
    #[test]
    fn session_config_roots_fall_back_to_global_only() {
        let base = std::env::temp_dir().join("aide_mod_test_no_scopes");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("claude")).unwrap();
        let roots = session_config_roots_in(&base);
        assert_eq!(roots, vec![base.join("claude")]);
        let _ = fs::remove_dir_all(&base);
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
