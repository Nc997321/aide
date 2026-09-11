//! 后台 shell 任务注册表：桌面侧从 chat-event 流顺手累积的 per-session 快照，
//! 供远程客户端（手机/PWA）打开会话或重连时对账（`list_bg_tasks` RPC）。
//!
//! 为什么需要：bg_task_* 是纯事件流，relay 只做实时转发（broadcast 无重放）；
//! 手机端未连接/未进会话页期间的事件永久丢失。桌面进程与 sidecar 同生共死、
//! 永远在线，是唯一能持有全量状态的一端。
//!
//! 生命周期：
//!  - started：按 id upsert（started 事件双源重发——system/task_started 与
//!    tool_result 后台回执——只补 command/description，首见时刻不覆盖）
//!  - output：增量追加，尾部截断保新鲜（与客户端 BG_OUTPUT_CAP 同策略 64KiB）
//!  - ended：落终态；ENDED_TTL 后自动清——完成态只服务「错过结束的手机补看
//!    一眼」，不清会变成每次打开会话都闪一次「✓ 已完成」
//!  - Runtime 进程死亡（emit_runtime_dead）：全清——sidecar 没机会发终态事件

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

/// 尾部输出保留上限（字节；截头保尾，与 ohos 端 BG_OUTPUT_CAP 同值）。
const OUTPUT_CAP_BYTES: usize = 64 * 1024;
/// 终态任务保留时长：超时即清（见模块注释）。
const ENDED_TTL_MS: u64 = 5 * 60 * 1000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 快照条目（list_bg_tasks 返回形状；serde camelCase 与前端 DTO 对齐）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BgTaskSnapshot {
    pub id: String,
    pub command: String,
    pub description: String,
    /// running | completed | failed | stopped（sidecar finalize 已归一）。
    pub status: String,
    pub summary: String,
    /// 首见 started 的桌面接收时刻（毫秒；事件不带时间戳，走表时长以此为准）。
    pub started_at: u64,
    pub ended_at: u64,
    pub output: String,
    pub truncated_bytes: u64,
}

/// 桌面侧后台任务注册表（session_id → 任务列表，按首见顺序）。
#[derive(Default)]
pub struct BgTaskRegistry {
    inner: Mutex<HashMap<String, Vec<BgTaskSnapshot>>>,
}

impl BgTaskRegistry {
    /// 喂事件：只认 bg_task_* 三种，其余零成本直通（挂在事件泵出口）。
    pub fn feed(&self, event: &Value) {
        let Some(typ) = event.get("type").and_then(|t| t.as_str()) else {
            return;
        };
        if !matches!(typ, "bg_task_started" | "bg_task_output" | "bg_task_ended") {
            return;
        }
        let Some(sid) = event.get("session_id").and_then(|s| s.as_str()) else {
            return;
        };
        if sid.is_empty() {
            return;
        }
        let id = event.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if id.is_empty() {
            return;
        }
        let now = now_ms();
        let mut g = self.inner.lock().unwrap();
        {
            let tasks = g.entry(sid.to_string()).or_default();
            match typ {
                "bg_task_started" => {
                    if let Some(t) = tasks.iter_mut().find(|t| t.id == id) {
                        merge_str(&mut t.command, event, "command");
                        merge_str(&mut t.description, event, "description");
                    } else {
                        tasks.push(BgTaskSnapshot {
                            id: id.to_string(),
                            command: event
                                .get("command")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            description: event
                                .get("description")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            status: "running".to_string(),
                            summary: String::new(),
                            started_at: now,
                            ended_at: 0,
                            output: String::new(),
                            truncated_bytes: 0,
                        });
                    }
                }
                "bg_task_output" => {
                    if let Some(t) = tasks.iter_mut().find(|t| t.id == id) {
                        let delta = event.get("delta").and_then(|v| v.as_str()).unwrap_or("");
                        t.output.push_str(delta);
                        cap_output(t);
                    }
                }
                "bg_task_ended" => {
                    if let Some(t) = tasks.iter_mut().find(|t| t.id == id) {
                        t.status = event
                            .get("status")
                            .and_then(|v| v.as_str())
                            .unwrap_or("completed")
                            .to_string();
                        merge_str(&mut t.summary, event, "summary");
                        t.ended_at = now;
                    }
                }
                _ => {}
            }
        }
        prune(&mut g, now);
    }

    /// 会话快照（读时先清过期终态）。
    pub fn list(&self, session_id: &str) -> Vec<BgTaskSnapshot> {
        self.list_at(session_id, now_ms())
    }

    /// Runtime 进程死亡兜底：全清（sidecar 没机会发终态事件，防任务永卡 running）。
    pub fn clear_all(&self) {
        self.inner.lock().unwrap().clear();
    }

    /// 可注入时钟的 list（单测用）。
    fn list_at(&self, session_id: &str, now: u64) -> Vec<BgTaskSnapshot> {
        let mut g = self.inner.lock().unwrap();
        prune(&mut g, now);
        g.get(session_id).cloned().unwrap_or_default()
    }
}

/// 非空才覆盖（started 重发补字段 / ended summary 缺省保留）。
fn merge_str(dst: &mut String, event: &Value, key: &str) {
    if let Some(v) = event.get(key).and_then(|v| v.as_str()) {
        if !v.is_empty() {
            *dst = v.to_string();
        }
    }
}

/// 截头保尾：累积超 2×上限才截（与客户端摊还策略一致，防每帧 O(n) 搬运）。
fn cap_output(t: &mut BgTaskSnapshot) {
    if t.output.len() > OUTPUT_CAP_BYTES * 2 {
        let mut boundary = t.output.len() - OUTPUT_CAP_BYTES;
        while boundary > 0 && !t.output.is_char_boundary(boundary) {
            boundary -= 1;
        }
        t.truncated_bytes += boundary as u64;
        t.output = t.output.split_off(boundary);
    }
}

/// 过期终态清理（feed/list 顺手过一遍；任务量个位数，成本可忽略）。
fn prune(map: &mut HashMap<String, Vec<BgTaskSnapshot>>, now: u64) {
    map.retain(|_, tasks| {
        tasks.retain(|t| t.status == "running" || now.saturating_sub(t.ended_at) <= ENDED_TTL_MS);
        !tasks.is_empty()
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn started(id: &str, sid: &str) -> Value {
        json!({ "type": "bg_task_started", "id": id, "session_id": sid, "command": "pnpm dev" })
    }

    #[test]
    fn upsert_keeps_first_seen_started_at() {
        let reg = BgTaskRegistry::default();
        reg.feed(&started("t1", "s1"));
        reg.feed(&json!({
            "type": "bg_task_started", "id": "t1", "session_id": "s1",
            "command": "pnpm dev", "description": "启动开发服务器"
        }));
        let list = reg.list("s1");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].command, "pnpm dev");
        assert_eq!(list[0].description, "启动开发服务器");
        assert_eq!(list[0].status, "running");
        assert!(list[0].started_at > 0);
    }

    #[test]
    fn output_caps_tail() {
        let reg = BgTaskRegistry::default();
        reg.feed(&started("t1", "s1"));
        let big = "x".repeat(OUTPUT_CAP_BYTES * 2 + 100);
        reg.feed(
            &json!({ "type": "bg_task_output", "id": "t1", "session_id": "s1", "delta": big }),
        );
        let list = reg.list("s1");
        assert!(list[0].output.len() <= OUTPUT_CAP_BYTES + 3); // 尾部对齐可能多吃几个字节
        assert!(list[0].truncated_bytes > 0);
    }

    #[test]
    fn ended_prunes_after_ttl_keeps_running() {
        let reg = BgTaskRegistry::default();
        reg.feed(&started("t1", "s1"));
        reg.feed(&started("t2", "s1"));
        reg.feed(&json!({ "type": "bg_task_ended", "id": "t1", "session_id": "s1", "status": "completed", "summary": "done" }));
        let now = now_ms();
        // TTL 内：终态保留，running 恒保留
        assert_eq!(reg.list_at("s1", now + 1000).len(), 2);
        // TTL 外：终态清走，running 不受影响
        let after = reg.list_at("s1", now + ENDED_TTL_MS + 1000);
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].id, "t2");
        assert_eq!(after[0].status, "running");
    }

    #[test]
    fn ended_marks_status_and_summary() {
        let reg = BgTaskRegistry::default();
        reg.feed(&started("t1", "s1"));
        reg.feed(&json!({ "type": "bg_task_ended", "id": "t1", "session_id": "s1", "status": "stopped" }));
        let list = reg.list("s1");
        assert_eq!(list[0].status, "stopped");
        assert!(list[0].ended_at >= list[0].started_at);
    }

    #[test]
    fn clear_all_wipes_every_session() {
        let reg = BgTaskRegistry::default();
        reg.feed(&started("t1", "s1"));
        reg.feed(&started("t2", "s2"));
        reg.clear_all();
        assert!(reg.list("s1").is_empty());
        assert!(reg.list("s2").is_empty());
    }

    #[test]
    fn non_bg_events_are_ignored() {
        let reg = BgTaskRegistry::default();
        reg.feed(&json!({ "type": "text_delta", "session_id": "s1", "delta": "hi" }));
        reg.feed(&json!({ "type": "bg_task_output", "session_id": "s1", "delta": "x" })); // 缺 id
        assert!(reg.list("s1").is_empty());
    }
}
