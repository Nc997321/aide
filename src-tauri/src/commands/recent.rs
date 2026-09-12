use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::State;

use super::{find_session_jsonl_globally, our_config_dir, our_session_name};
use crate::settings::SettingsService;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RecentSession {
    pub ws_key: String,
    pub ws_name: String,
    pub session_id: String,
    pub name: String,
    pub ts: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RecentFile {
    pub path: String,
    pub name: String,
    pub ts: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct RecentState {
    pub sessions: Vec<RecentSession>,
    pub files: HashMap<String, Vec<RecentFile>>,
}

#[derive(Serialize, Clone)]
pub struct RecentView {
    pub sessions: Vec<RecentSession>,
    pub files: Vec<RecentFile>,
}

// ── 纯函数（无 IO，可单测） ──

/// 把会话条目插入队首；按 session_id 去重；裁剪到 limit。
pub fn push_session(state: &mut RecentState, e: RecentSession, limit: usize) {
    state.sessions.retain(|s| s.session_id != e.session_id);
    state.sessions.insert(0, e);
    if state.sessions.len() > limit {
        state.sessions.truncate(limit);
    }
}

/// 在 ws_key 对应列表内插入队首；按 path 去重；裁剪到 limit。
pub fn push_file(state: &mut RecentState, ws_key: &str, e: RecentFile, limit: usize) {
    let list = state.files.entry(ws_key.to_string()).or_default();
    list.retain(|f| f.path != e.path);
    list.insert(0, e);
    if list.len() > limit {
        list.truncate(limit);
    }
}

/// 会话存活检查的新鲜度宽限：SDK 在 session_init 后要过几秒才写出首个 jsonl，
/// 宽限期内的条目跳过 jsonl 存活检查，否则 record→refresh→prune 竞态会把
/// 刚入列的会话当死会话剪掉。
pub const PRUNE_GRACE_MS: u64 = 10 * 60 * 1000;

/// 用外部提供的存活判定函数清理失效会话与当前 ws_key 的失效文件，返回是否有变化。
pub fn prune_stale_with(
    state: &mut RecentState,
    ws_key: &str,
    now_ms: u64,
    session_alive: impl Fn(&str) -> bool,
    file_alive: impl Fn(&str) -> bool,
) -> bool {
    let mut changed = false;
    let before = state.sessions.len();
    state
        .sessions
        .retain(|s| now_ms.saturating_sub(s.ts) < PRUNE_GRACE_MS || session_alive(&s.session_id));
    if state.sessions.len() != before {
        changed = true;
    }
    if let Some(list) = state.files.get_mut(ws_key) {
        let b = list.len();
        list.retain(|f| file_alive(&f.path));
        if list.len() != b {
            changed = true;
        }
    }
    changed
}

/// 生产环境清理：会话按 jsonl 是否存在判定，文件按路径 metadata 判定。
pub fn prune_stale(state: &mut RecentState, ws_key: &str) -> bool {
    prune_stale_with(
        state,
        ws_key,
        now_ms(),
        |id| !find_session_jsonl_globally(id).is_empty(),
        |p| Path::new(p).metadata().is_ok(),
    )
}

/// 用外部提供的权威名查询函数覆盖会话条目的快照名，返回是否有变化。
/// 权威名缺失（元数据 json 不在）时保留快照兜底。
pub fn overlay_session_names_with(
    state: &mut RecentState,
    lookup: impl Fn(&str) -> Option<String>,
) -> bool {
    let mut changed = false;
    for s in state.sessions.iter_mut() {
        if let Some(name) = lookup(&s.session_id) {
            if s.name != name {
                s.name = name;
                changed = true;
            }
        }
    }
    changed
}

/// 生产环境覆盖：权威名来自 `~/.aide/sessions/<id>.json`（create/rename/auto_rename
/// 三处写，见 `our_session_name`）。recent.json 的 name 只是入列那一刻的快照——
/// 自动标题/手动改名后不回写，读取时以此自愈，与侧栏会话列表保持同源。
pub fn overlay_session_names(state: &mut RecentState) -> bool {
    overlay_session_names_with(state, our_session_name)
}

// ── 持久化 ──

pub fn recent_path() -> PathBuf {
    our_config_dir().join("recent.json")
}

/// 从磁盘加载；缺失或损坏返回 Default。
pub fn load_recent_file() -> RecentState {
    let p = recent_path();
    if p.exists() {
        if let Ok(content) = fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<RecentState>(&content) {
                return v;
            }
        }
    }
    RecentState::default()
}

/// 原子写：先写 .tmp 再 rename，防半写入。
pub fn save_recent_file(state: &RecentState) -> Result<(), String> {
    let p = recent_path();
    let dir = p
        .parent()
        .ok_or_else(|| "recent.json has no parent".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("create config dir: {e}"))?;
    let tmp = p.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    fs::write(&tmp, body).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, &p).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

// ── 内存缓存 ──

static RECENT: Lazy<Mutex<RecentState>> = Lazy::new(|| Mutex::new(load_recent_file()));

// ── 辅助 ──

/// 从设置体系（settings.json）读取 recent_limit，默认 10。
///
/// `set_settings` 落盘到 SettingsService（values.settings.recentLimit），这里必须
/// 从同一个家读——曾读 config.json 的 settings 子树，设置体系迁移后那个家没了，
/// 用户改的条数静默失效、永远拿默认 10。
pub fn current_limit(service: &crate::settings::SettingsService) -> usize {
    super::settings::public_settings(service)
        .map(|s| s.recent_limit as usize)
        .unwrap_or(10)
}

pub fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

// ── Tauri 命令 ──
//
// 全部 async + spawn_blocking。这些命令做的是 recent.json 落盘，`list_recent`
// 还要逐会话做一次全局 jsonl 搜索 + 逐条读元数据——落在主线程就是冻结。
//
// 实锤（2026-09-05 freeze-1788610528313）：`remove_recent_session` 的
// `cmd_enter`→`cmd_exit` 跨了 **7.87 秒**，全程主线程被占（探针 pending 爬升、
// IsHungAppWindow 真、无人烧 CPU = 纯 IO 等待）；一份 2.9 秒的同类阻塞紧随
// `session_init`（见 `create_session`）。
//
// 搬离主线程后不再埋 `trace_command`：guard 在 dispatch 后立刻 drop，对 async
// 命令没有意义（见 CLAUDE.md「trace_command 兜底」）。

#[tauri::command]
pub async fn record_recent_session(
    service: State<'_, Arc<SettingsService>>,
    ws_key: String,
    ws_name: String,
    session_id: String,
    name: String,
) -> Result<(), String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || {
        record_recent_session_blocking(&service, ws_key, ws_name, session_id, name)
    })
    .await
    .map_err(|e| format!("record_recent_session task panicked: {e}"))?
}

fn record_recent_session_blocking(
    service: &SettingsService,
    ws_key: String,
    ws_name: String,
    session_id: String,
    name: String,
) -> Result<(), String> {
    let entry = RecentSession {
        ws_key,
        ws_name,
        session_id,
        name,
        ts: now_ms(),
    };
    let mut guard = RECENT.lock().map_err(|e| e.to_string())?;
    push_session(&mut guard, entry, current_limit(service));
    save_recent_file(&guard)
}

#[tauri::command]
pub async fn record_recent_file(
    service: State<'_, Arc<SettingsService>>,
    ws_key: String,
    path: String,
    name: String,
) -> Result<(), String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || record_recent_file_blocking(&service, ws_key, path, name))
        .await
        .map_err(|e| format!("record_recent_file task panicked: {e}"))?
}

fn record_recent_file_blocking(
    service: &SettingsService,
    ws_key: String,
    path: String,
    name: String,
) -> Result<(), String> {
    let entry = RecentFile {
        path,
        name,
        ts: now_ms(),
    };
    let mut guard = RECENT.lock().map_err(|e| e.to_string())?;
    push_file(&mut guard, &ws_key, entry, current_limit(service));
    save_recent_file(&guard)
}

#[tauri::command]
pub async fn list_recent(
    ws_key: String,
    service: State<'_, Arc<SettingsService>>,
) -> Result<RecentView, String> {
    let service = service.inner().clone();
    tokio::task::spawn_blocking(move || list_recent_blocking(ws_key, &service))
        .await
        .map_err(|e| format!("list_recent task panicked: {e}"))?
}

fn list_recent_blocking(ws_key: String, service: &SettingsService) -> Result<RecentView, String> {
    let mut guard = RECENT.lock().map_err(|e| e.to_string())?;
    let limit = current_limit(service);
    let mut need_save = prune_stale(&mut guard, &ws_key);
    // 名字自愈：快照名过期（自动标题/手动改名）时以权威名覆盖并落盘
    if overlay_session_names(&mut guard) {
        need_save = true;
    }
    if guard.sessions.len() > limit {
        guard.sessions.truncate(limit);
        need_save = true;
    }
    if let Some(list) = guard.files.get_mut(&ws_key) {
        if list.len() > limit {
            list.truncate(limit);
            need_save = true;
        }
    }
    if need_save {
        save_recent_file(&guard)?;
    }
    let files = guard.files.get(&ws_key).cloned().unwrap_or_default();
    let sessions = guard.sessions.clone();
    Ok(RecentView { sessions, files })
}

#[tauri::command]
pub async fn remove_recent_session(session_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || remove_recent_session_blocking(&session_id))
        .await
        .map_err(|e| format!("remove_recent_session task panicked: {e}"))?
}

/// 阻塞实现。`delete_session` 自己就在阻塞线程上（它也要删 jsonl），直接调这个
/// 而不是回调 async 命令——省一次跨线程往返。
pub(crate) fn remove_recent_session_blocking(session_id: &str) -> Result<(), String> {
    let mut guard = RECENT.lock().map_err(|e| e.to_string())?;
    let before = guard.sessions.len();
    guard.sessions.retain(|s| s.session_id != session_id);
    if guard.sessions.len() != before {
        save_recent_file(&guard)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn clear_recent(category: Option<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || clear_recent_blocking(category.as_deref()))
        .await
        .map_err(|e| format!("clear_recent task panicked: {e}"))?
}

fn clear_recent_blocking(category: Option<&str>) -> Result<(), String> {
    let mut guard = RECENT.lock().map_err(|e| e.to_string())?;
    match category {
        Some("sessions") => guard.sessions.clear(),
        Some("files") => guard.files.clear(),
        _ => {
            guard.sessions.clear();
            guard.files.clear();
        }
    }
    save_recent_file(&guard)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sess(id: &str, ts: u64) -> RecentSession {
        RecentSession {
            ws_key: "k".into(),
            ws_name: "n".into(),
            session_id: id.into(),
            name: id.into(),
            ts,
        }
    }
    fn file(path: &str, ts: u64) -> RecentFile {
        RecentFile {
            path: path.into(),
            name: path.into(),
            ts,
        }
    }

    #[test]
    fn push_session_dedups_and_moves_to_front() {
        let mut st = RecentState::default();
        push_session(&mut st, sess("a", 1), 10);
        push_session(&mut st, sess("b", 2), 10);
        push_session(&mut st, sess("a", 3), 10);
        assert_eq!(st.sessions.len(), 2);
        assert_eq!(st.sessions[0].session_id, "a");
        assert_eq!(st.sessions[0].ts, 3);
    }

    #[test]
    fn push_session_caps_to_limit() {
        let mut st = RecentState::default();
        for i in 0..5 {
            push_session(&mut st, sess(&format!("s{i}"), i), 3);
        }
        assert_eq!(st.sessions.len(), 3);
        assert_eq!(st.sessions[0].session_id, "s4");
    }

    #[test]
    fn push_file_dedups_per_workspace_and_caps() {
        let mut st = RecentState::default();
        push_file(&mut st, "k", file("/a", 1), 2);
        push_file(&mut st, "k", file("/b", 2), 2);
        push_file(&mut st, "k", file("/a", 3), 2);
        let list = st.files.get("k").unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].path, "/a");
        assert_eq!(list[0].ts, 3);
    }

    #[test]
    fn push_file_isolates_workspaces() {
        let mut st = RecentState::default();
        push_file(&mut st, "k1", file("/a", 1), 10);
        push_file(&mut st, "k2", file("/b", 2), 10);
        assert_eq!(st.files.get("k1").unwrap().len(), 1);
        assert_eq!(st.files.get("k2").unwrap().len(), 1);
    }

    #[test]
    fn prune_stale_removes_dead_entries() {
        let mut st = RecentState::default();
        push_session(&mut st, sess("alive", 1), 10);
        push_session(&mut st, sess("dead", 2), 10);
        push_file(&mut st, "k", file("/exists", 1), 10);
        push_file(&mut st, "k", file("/gone", 2), 10);
        let now = PRUNE_GRACE_MS + 100; // 条目 ts 均为 1/2，已过宽限期
        let changed = prune_stale_with(&mut st, "k", now, |id| id == "alive", |p| p == "/exists");
        assert!(changed);
        assert_eq!(st.sessions.len(), 1);
        assert_eq!(st.sessions[0].session_id, "alive");
        let list = st.files.get("k").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].path, "/exists");
    }

    #[test]
    fn prune_stale_spares_fresh_sessions_without_jsonl() {
        // 回归：session_init 时记录的会话，SDK 还没写出首个 jsonl，
        // record→refresh→prune 竞态曾把刚入列的条目当死会话剪掉。
        let mut st = RecentState::default();
        let now: u64 = 1_800_000_000_000;
        push_session(&mut st, sess("fresh", now - 5_000), 10); // 5 秒前记录
        push_session(&mut st, sess("old-dead", now - PRUNE_GRACE_MS - 1), 10);
        let changed = prune_stale_with(&mut st, "k", now, |_| false, |_| true);
        assert!(changed);
        assert_eq!(st.sessions.len(), 1);
        assert_eq!(st.sessions[0].session_id, "fresh");
    }

    #[test]
    fn prune_stale_no_change_returns_false() {
        let mut st = RecentState::default();
        push_session(&mut st, sess("a", 1), 10);
        push_file(&mut st, "k", file("/a", 1), 10);
        let changed = prune_stale_with(&mut st, "k", PRUNE_GRACE_MS + 100, |_| true, |_| true);
        assert!(!changed);
    }

    #[test]
    fn overlay_session_names_overrides_stale_snapshot() {
        // 回归：自动标题/手动改名只更新权威元数据，recent.json 快照名不回写，
        // 「最近会话」与会话列表名字不一致——读取时必须以权威名覆盖。
        let mut st = RecentState::default();
        let mut e = sess("a", 1);
        e.name = "a1b2c3d4".into(); // 入列时的占位快照名
        push_session(&mut st, e, 10);
        let changed = overlay_session_names_with(&mut st, |id| {
            (id == "a").then(|| "修复登录 Bug".to_string())
        });
        assert!(changed);
        assert_eq!(st.sessions[0].name, "修复登录 Bug");
    }

    #[test]
    fn overlay_session_names_keeps_snapshot_when_metadata_missing() {
        // 权威元数据缺失（会话 json 不在）时保留快照名兜底，不清空、不判变化。
        let mut st = RecentState::default();
        let mut e = sess("a", 1);
        e.name = "旧名".into();
        push_session(&mut st, e, 10);
        let changed = overlay_session_names_with(&mut st, |_| None);
        assert!(!changed);
        assert_eq!(st.sessions[0].name, "旧名");
    }

    #[test]
    fn overlay_session_names_no_change_returns_false() {
        let mut st = RecentState::default();
        let mut e = sess("a", 1);
        e.name = "同名".into();
        push_session(&mut st, e, 10);
        let changed = overlay_session_names_with(&mut st, |_| Some("同名".to_string()));
        assert!(!changed);
    }
}
