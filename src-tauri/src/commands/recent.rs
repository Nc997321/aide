use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::{find_session_jsonl_globally, our_config_dir};

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

/// 用外部提供的存活判定函数清理失效会话与当前 ws_key 的失效文件，返回是否有变化。
pub fn prune_stale_with(
    state: &mut RecentState,
    ws_key: &str,
    session_alive: impl Fn(&str) -> bool,
    file_alive: impl Fn(&str) -> bool,
) -> bool {
    let mut changed = false;
    let before = state.sessions.len();
    state.sessions.retain(|s| session_alive(&s.session_id));
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
        |id| !find_session_jsonl_globally(id).is_empty(),
        |p| Path::new(p).metadata().is_ok(),
    )
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
    let dir = p.parent().ok_or_else(|| "recent.json has no parent".to_string())?;
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

/// 从主 config.json 读取 recent_limit，默认 10。
pub fn current_limit() -> usize {
    let cfg = super::settings::load_config();
    cfg.get("settings")
        .and_then(|s| s.get("recent_limit"))
        .and_then(|v| v.as_u64())
        .unwrap_or(10) as usize
}

pub fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
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
        RecentFile { path: path.into(), name: path.into(), ts }
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
        let changed = prune_stale_with(&mut st, "k", |id| id == "alive", |p| p == "/exists");
        assert!(changed);
        assert_eq!(st.sessions.len(), 1);
        assert_eq!(st.sessions[0].session_id, "alive");
        let list = st.files.get("k").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].path, "/exists");
    }

    #[test]
    fn prune_stale_no_change_returns_false() {
        let mut st = RecentState::default();
        push_session(&mut st, sess("a", 1), 10);
        push_file(&mut st, "k", file("/a", 1), 10);
        let changed = prune_stale_with(&mut st, "k", |_| true, |_| true);
        assert!(!changed);
    }
}