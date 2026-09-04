//! 事件台账读取：sidecar memoryEvents hook 写的 events.jsonl + 观测台删除命令
//! 补写的 deleted 事件 → 按工作区过滤返回，附会话名映射（session_id → 显示名，
//! 供「使用场景」列）。聚合统计（GROUP BY / 趋势 / TOP N）在前端纯函数层做。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::resolve;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEvent {
    pub ts: i64,
    // sidecar hook 落盘用 snake_case（session_id 等），DTO 出参用 camelCase——
    // alias 只影响反序列化方向，两个方向各自对齐。
    #[serde(default, alias = "session_id")]
    pub session_id: String,
    #[serde(default, alias = "workspace_key")]
    pub workspace_key: String,
    pub op: String, // read | created | updated | deleted
    #[serde(alias = "memory_id")]
    pub memory_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsResult {
    pub events: Vec<MemoryEvent>,
    /// session_id → 会话显示名（~/.aide/sessions/<id>.json 的 name 字段，权威源）。
    pub session_names: HashMap<String, String>,
}

pub fn read_events(workspace_key: &str) -> Result<EventsResult, String> {
    read_events_inner(
        &resolve::events_log(),
        &crate::commands::our_sessions_dir(),
        workspace_key,
    )
}

/// 与路径来源解耦的读取本体（fixture 测试直接喂文件）。
fn read_events_inner(log: &Path, sessions_dir: &Path, workspace_key: &str) -> Result<EventsResult, String> {
    let mut events: Vec<MemoryEvent> = Vec::new();
    if let Ok(content) = fs::read_to_string(log) {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            // 单行损坏不拖垮整本台账
            let Ok(ev) = serde_json::from_str::<MemoryEvent>(line) else { continue };
            if ev.workspace_key == workspace_key {
                events.push(ev);
            }
        }
    }

    let ids: HashSet<&str> = events
        .iter()
        .map(|e| e.session_id.as_str())
        .filter(|s| !s.is_empty())
        .collect();
    let mut session_names = HashMap::new();
    for id in ids {
        let p = sessions_dir.join(format!("{id}.json"));
        if let Ok(content) = fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(name) = v.get("name").and_then(|n| n.as_str()) {
                    session_names.insert(id.to_string(), name.to_string());
                }
            }
        }
    }

    Ok(EventsResult { events, session_names })
}

/// 删除命令补写一条 deleted 事件（观测台自己的删除走这里；别的来源的消失
/// 由快照 diff 事后呈现，不伪造事件）。
pub fn append_deleted_event(workspace_key: &str, memory_id: &str) {
    let log = resolve::events_log();
    if let Some(parent) = log.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let line = serde_json::json!({
        "ts": resolve::now_ms(),
        "session_id": "",
        "workspace_key": workspace_key,
        "op": "deleted",
        "memory_id": memory_id,
    });
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&log) {
        use std::io::Write;
        let _ = writeln!(f, "{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("aide_mo_ev_{}_{}", std::process::id(), tag))
    }

    #[test]
    fn filters_by_workspace_and_skips_bad_lines() {
        let dir = tmp("filter");
        fs::create_dir_all(&dir).unwrap();
        let log = dir.join("events.jsonl");
        fs::write(
            &log,
            concat!(
                r#"{"ts":1,"session_id":"s1","workspace_key":"K","op":"read","memory_id":"a.md"}"#, "\n",
                "not-json\n",
                r#"{"ts":2,"session_id":"s2","workspace_key":"OTHER","op":"read","memory_id":"b.md"}"#, "\n",
                r#"{"ts":3,"session_id":"s1","workspace_key":"K","op":"created","memory_id":"c.md"}"#, "\n",
            ),
        )
        .unwrap();
        let sessions = dir.join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(sessions.join("s1.json"), r#"{"name":"修冻结的那轮"}"#).unwrap();

        let r = read_events_inner(&log, &sessions, "K").unwrap();
        assert_eq!(r.events.len(), 2);
        assert_eq!(r.events[0].memory_id, "a.md");
        assert_eq!(r.session_names.get("s1").unwrap(), "修冻结的那轮");
        assert!(!r.session_names.contains_key("s2"), "别的会话不查名");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_log_yields_empty() {
        let dir = tmp("missing");
        let r = read_events_inner(&dir.join("nope.jsonl"), &dir, "K").unwrap();
        assert!(r.events.is_empty());
        assert!(r.session_names.is_empty());
    }
}
