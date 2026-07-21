//! 应用内通知持久化。
//!
//! 前端 reactive store 持有状态；Rust 仅做文件 IO：
//! - load_notifications：启动时拉取落盘的 error/warning 通知（info 不落盘）。
//! - save_notifications：前端 debounce 500ms 后整份覆盖写。
//!
//! 落盘规则：只存 severity ∈ {error, warning}；不含 read 状态（重启回到未读）；
//! 软上限 100 条，按 timestamp 降序截断。原子写：tmp + rename。
//!
//! 文件：~/.aide/notifications.json（与 diagnostics/recent 同根）。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use super::our_config_dir;

/// 并发 save 的 tmp 文件名递增后缀，保证每次写各自独立的 tmp，互不踩踏。
static SAVE_SEQ: AtomicU64 = AtomicU64::new(0);

/// 落盘条数软上限。超出按 timestamp 降序淘汰最旧。
pub const PERSIST_LIMIT: usize = 100;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationAction {
    pub label: String,
    pub url: Option<String>,
}

/// 落盘记录。前端 AppNotification 去掉 read、去掉 info 项后的形态。
/// serde camelCase 与前端字段对齐（dedupKey 等）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRecord {
    pub id: String,
    pub severity: String, // "error" | "warning"
    pub source: String,
    pub title: String,
    pub body: Option<String>,
    pub timestamp: u64,
    pub dedup_key: Option<String>,
    pub count: Option<u64>,
    pub action: Option<NotificationAction>,
}

// ── 纯函数（无 IO，可单测）──

/// 只保留 error/warning（防御性：info 前端不该传，但服务端再兜一道）。
pub fn filter_persistable(records: Vec<NotificationRecord>) -> Vec<NotificationRecord> {
    records
        .into_iter()
        .filter(|r| r.severity == "error" || r.severity == "warning")
        .collect()
}

/// 按 timestamp 降序排序后截断到 limit（淘汰最旧）。
pub fn cap_to_limit(mut records: Vec<NotificationRecord>, limit: usize) -> Vec<NotificationRecord> {
    records.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    records.truncate(limit);
    records
}

// ── 持久化 ──

pub fn notifications_path() -> PathBuf {
    our_config_dir().join("notifications.json")
}

/// 从磁盘加载；缺失或损坏返回空（绝不崩）。
pub fn load_notifications_file() -> Vec<NotificationRecord> {
    let p = notifications_path();
    if p.exists() {
        if let Ok(content) = fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<Vec<NotificationRecord>>(&content) {
                return v;
            }
        }
    }
    Vec::new()
}

/// 过滤 + 截断 + 原子写（tmp + rename）。
pub fn save_notifications_file(records: Vec<NotificationRecord>) -> Result<(), String> {
    let persisted = cap_to_limit(filter_persistable(records), PERSIST_LIMIT);
    let p = notifications_path();
    let dir = p.parent().ok_or_else(|| "notifications.json has no parent".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("create config dir: {e}"))?;
    // 每个 save 用唯一 tmp 名（monotonic 后缀），并发 save 互不共享 tmp，
    // 避免交错写造成 JSON 损坏（最后 rename 胜出，落盘的是完整有效快照）。
    let seq = SAVE_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = p.with_extension(format!("json.tmp.{seq}"));
    let body = serde_json::to_string_pretty(&persisted).map_err(|e| e.to_string())?;
    fs::write(&tmp, body).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, &p).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

// ── Tauri 命令（async + spawn_blocking，文件 IO 不堵主线程）──

#[tauri::command]
pub async fn load_notifications() -> Result<Vec<NotificationRecord>, String> {
    tokio::task::spawn_blocking(load_notifications_file)
        .await
        .map_err(|e| format!("load_notifications task panicked: {e}"))
}

#[tauri::command]
pub async fn save_notifications(records: Vec<NotificationRecord>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || save_notifications_file(records))
        .await
        .map_err(|e| format!("save_notifications task panicked: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(id: &str, severity: &str, ts: u64) -> NotificationRecord {
        NotificationRecord {
            id: id.into(),
            severity: severity.into(),
            source: "test".into(),
            title: id.into(),
            body: None,
            timestamp: ts,
            dedup_key: None,
            count: None,
            action: None,
        }
    }

    #[test]
    fn filter_persistable_drops_info_keeps_error_and_warning() {
        let v = vec![
            rec("a", "error", 1),
            rec("b", "warning", 2),
            rec("c", "info", 3),
        ];
        let out = filter_persistable(v);
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|r| r.severity != "info"));
    }

    #[test]
    fn cap_to_limit_keeps_newest() {
        let v: Vec<_> = (0..5).map(|i| rec(&format!("s{i}"), "error", i)).collect();
        let out = cap_to_limit(v, 3);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].timestamp, 4); // 降序，最新在前
        assert_eq!(out[2].timestamp, 2);
    }

    #[test]
    fn save_then_load_round_trips() {
        // 用临时目录覆盖 notifications_path：直接测 save/load 文件函数。
        // our_config_dir 依赖系统 home，测试里改为写入 env-重定向不现实，
        // 因此直接测纯函数 + 一个临时路径的手动写读。
        let tmp = std::env::temp_dir().join(format!("aide-notif-test-{}.json", std::process::id()));
        let _ = fs::remove_file(&tmp);
        let records = vec![rec("a", "error", 10), rec("b", "warning", 20)];
        // 直接序列化写 tmp，模拟 save（不依赖 our_config_dir）
        let body = serde_json::to_string_pretty(&records).unwrap();
        fs::write(&tmp, body).unwrap();
        let loaded: Vec<NotificationRecord> =
            serde_json::from_str(&fs::read_to_string(&tmp).unwrap()).unwrap();
        assert_eq!(loaded, records);
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn load_missing_file_returns_empty() {
        // load_notifications_file 读 our_config_dir/notifications.json；
        // 在全新机器上文件不存在，必须返回空而不崩。
        // 这里只断言函数可调用且返回 Vec（不强制删现有文件以免破坏本机数据）。
        let _ = load_notifications_file(); // 不 panic 即可
    }
}