//! 卡死诊断黑匣子（Freeze Flight Recorder）主控。
//!
//! 设计文档：docs/superpowers/specs/2026-07-08-freeze-diagnostics-design.md
//!
//! 常驻低开销记录（环形缓冲），watchdog 线程检测心跳断流，
//! 冻结期主动采样，恢复后自动落盘 JSON 报告到
//! `~/.claude-code-desktop/diagnostics/`。
//!
//! 对外接口：
//! - `DiagnosticsState`：Tauri managed state；
//! - `start()`：setup 里启动 watchdog；
//! - `diag_heartbeat` / `diag_freeze_supplement`：前端命令；
//! - `DiagnosticsState::record_chat_event()`：sidecar 事件出口计数钩子；
//! - `trace_command()`：同步命令入口埋点，冻结时报告直接点名卡在哪条命令上
//!   （2026-07-08 首次真实冻结实锤主线程被同步命令堵死后补上，见
//!   `docs/superpowers/specs/2026-07-08-freeze-diagnostics-design.md`）。

mod report;
mod ring;
mod watchdog;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, State};

use report::{EventRateBucket, HeartbeatEntry, HeartbeatPayload};
use ring::Ring;

/// 心跳环容量：300 × 500ms ≈ 最近 2.5 分钟
const HEARTBEAT_RING_CAP: usize = 300;
/// 事件速率环容量：按 (秒, 会话) 分桶，≈ 最近数分钟
const EVENT_RATE_RING_CAP: usize = 360;
/// 前端补交的挂靠窗口：报告落盘后多久内的补交才被合并
const SUPPLEMENT_WINDOW: Duration = Duration::from_secs(30);

pub struct DiagnosticsState(pub Arc<DiagInner>);

pub struct DiagInner {
    /// 最后一次前端心跳时刻；None = 前端尚未启动，watchdog 静默
    pub last_heartbeat: Mutex<Option<Instant>>,
    /// document.hidden——true 时浏览器节流定时器，watchdog 暂停判定
    pub hidden: AtomicBool,
    pub heartbeats: Mutex<Ring<HeartbeatEntry>>,
    pub event_rates: Mutex<EventRates>,
    /// 最近一份落盘报告（路径 + 落盘时刻），前端补交挂靠用
    pub last_report: Mutex<Option<(PathBuf, Instant)>>,
}

impl DiagnosticsState {
    pub fn new() -> Self {
        Self(Arc::new(DiagInner {
            last_heartbeat: Mutex::new(None),
            hidden: AtomicBool::new(false),
            heartbeats: Mutex::new(Ring::new(HEARTBEAT_RING_CAP)),
            event_rates: Mutex::new(EventRates::new(EVENT_RATE_RING_CAP)),
            last_report: Mutex::new(None),
        }))
    }

    /// sidecar `chat-event` 出口计数钩子：纯内存，微秒级。
    pub fn record_chat_event(&self, session_id: &str) {
        self.0.event_rates.lock().unwrap().record(session_id);
    }
}

/// 每秒每会话的 chat-event 计数：当前秒在 HashMap 累加，跨秒冲进环。
pub struct EventRates {
    current_sec: u64,
    counts: HashMap<String, u32>,
    ring: Ring<EventRateBucket>,
}

impl EventRates {
    fn new(cap: usize) -> Self {
        Self { current_sec: 0, counts: HashMap::new(), ring: Ring::new(cap) }
    }

    fn record(&mut self, session_id: &str) {
        let sec = report::epoch_ms() / 1000;
        if sec != self.current_sec {
            self.flush();
            self.current_sec = sec;
        }
        *self.counts.entry(session_id.to_string()).or_default() += 1;
    }

    fn flush(&mut self) {
        let sec = self.current_sec;
        for (session_id, count) in self.counts.drain() {
            self.ring.push(EventRateBucket { t_sec: sec, session_id, count });
        }
    }

    /// 落盘快照（含当前未满一秒的桶；同秒可能出现多桶，分析端求和即可）。
    pub fn snapshot(&mut self) -> Vec<EventRateBucket> {
        self.flush();
        self.ring.to_vec()
    }
}

/// setup 里调用：启动 watchdog 线程。须在主窗口创建之后（要解析 HWND）。
pub fn start(app: &AppHandle) {
    watchdog::spawn(app.clone());
}

// ── 同步命令埋点：冻结时报告直接点名卡在哪条命令上 ──────────────────
//
// Tauri 非 async command 在本项目里跑在主线程上（见 CLAUDE.md「同步 command
// 禁止重 IO」），单线程串行执行——同一时刻至多一条同步命令在跑，不存在并发/
// 重入，全局单槽足够。`trace_command` 在命令入口写入自己的名字，返回的 guard
// 在命令返回/panic 时（RAII）清空；若命令卡死在中间，guard 的 Drop 永远不会
// 执行，槽位正好把肇事命令的名字留住。
//
// 关键：`CURRENT_COMMAND` 这把锁本身从不长期持有（trace_command 写完立刻释放），
// 所以哪怕主线程被卡命令堵死，watchdog 线程读这把锁完全不受影响——这正是
// 2026-07-08 首次真实冻结报告拿不到「卡在哪条命令」这一环之后补上的（当时只能
// 靠 isHungWindow + processes 间接判定是主线程被堵，定不到具体命令）。
static CURRENT_COMMAND: Mutex<Option<(&'static str, Instant)>> = Mutex::new(None);

/// 同步命令入口调用：`let _g = diagnostics::trace_command("git_log");`
/// 只用于确认会做重 IO / 遍历 / 等子进程的同步命令，轻量命令不必埋（噪音无益）。
pub fn trace_command(name: &'static str) -> CommandGuard {
    *CURRENT_COMMAND.lock().unwrap() = Some((name, Instant::now()));
    CommandGuard(name)
}

pub struct CommandGuard(&'static str);

impl Drop for CommandGuard {
    fn drop(&mut self) {
        let mut slot = CURRENT_COMMAND.lock().unwrap();
        // 只清自己：防御性检查，避免（理论上不该发生的）重入把别人的记录清掉。
        if matches!(slot.as_ref(), Some((name, _)) if *name == self.0) {
            *slot = None;
        }
    }
}

/// watchdog 冻结期采样调用：当前卡在哪条命令、已经跑了多久。
pub fn current_stuck_command() -> Option<(&'static str, Duration)> {
    CURRENT_COMMAND
        .lock()
        .unwrap()
        .as_ref()
        .map(|(name, started)| (*name, started.elapsed()))
}

// ── 前端命令 ────────────────────────────────────────────────────────

/// 前端每 500ms 一次的心跳。纯内存写入，必须保持轻——它本身就在被测的
/// 渲染主线程上发出，任何重操作都会污染测量。
#[tauri::command]
pub fn diag_heartbeat(state: State<DiagnosticsState>, payload: HeartbeatPayload) {
    let inner = &state.0;
    inner.hidden.store(payload.hidden, Ordering::Relaxed);
    *inner.last_heartbeat.lock().unwrap() = Some(Instant::now());
    inner
        .heartbeats
        .lock()
        .unwrap()
        .push(HeartbeatEntry { t: report::epoch_ms(), payload });
}

/// 前端从卡死中恢复后补交现场（longtask 明细 + 面包屑快照）。
/// 合并进最近 30s 内落盘的报告；没有可挂靠的报告则静默丢弃
/// （watchdog 视角没成立的冻结，比如纯后台节流，不值得留档）。
#[tauri::command]
pub async fn diag_freeze_supplement(
    state: State<'_, DiagnosticsState>,
    payload: serde_json::Value,
) -> Result<(), String> {
    let path = state
        .0
        .last_report
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|(p, at)| (at.elapsed() < SUPPLEMENT_WINDOW).then(|| p.clone()));
    let Some(path) = path else { return Ok(()) };
    tauri::async_runtime::spawn_blocking(move || report::merge_supplement(&path, payload))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_rates_buckets_by_second_and_session() {
        let mut rates = EventRates::new(10);
        // 手工驱动，不依赖真实时钟跨秒
        rates.current_sec = 100;
        *rates.counts.entry("s1".into()).or_default() += 3;
        *rates.counts.entry("s2".into()).or_default() += 1;
        rates.flush();
        rates.current_sec = 101;
        *rates.counts.entry("s1".into()).or_default() += 2;

        let mut snap = rates.snapshot();
        snap.sort_by_key(|b| (b.t_sec, b.session_id.clone()));
        let flat: Vec<(u64, &str, u32)> = snap
            .iter()
            .map(|b| (b.t_sec, b.session_id.as_str(), b.count))
            .collect();
        assert_eq!(flat, vec![(100, "s1", 3), (100, "s2", 1), (101, "s1", 2)]);
    }

    #[test]
    fn snapshot_is_repeatable_without_double_counting() {
        let mut rates = EventRates::new(10);
        rates.current_sec = 50;
        *rates.counts.entry("s1".into()).or_default() += 5;
        let first = rates.snapshot();
        let second = rates.snapshot();
        // 第二次快照不新增桶（counts 已清空）
        assert_eq!(first.len(), second.len());
        assert_eq!(first.iter().map(|b| b.count).sum::<u32>(), 5);
    }

    // trace_command 用模块级 static，cargo test 默认并行跑测试线程——把所有
    // 断言放进同一个测试函数，避免不同测试互相踩 CURRENT_COMMAND 导致 flaky。
    #[test]
    fn trace_command_lifecycle_and_guard_scoping() {
        {
            let _g = trace_command("test_command_a");
            let (name, dur) = current_stuck_command().expect("guard 存活期间应有值");
            assert_eq!(name, "test_command_a");
            assert!(dur.as_millis() < 1000, "刚开始计时应该很短");
        } // guard drop
        assert!(current_stuck_command().is_none(), "guard drop 后应清空");

        // 手动 drop 后再开始新的一条，新记录不受旧 guard 影响
        let ga = trace_command("cmd_a");
        drop(ga);
        let gb = trace_command("cmd_b");
        let (name, _) = current_stuck_command().unwrap();
        assert_eq!(name, "cmd_b");
        drop(gb);
        assert!(current_stuck_command().is_none());
    }
}
