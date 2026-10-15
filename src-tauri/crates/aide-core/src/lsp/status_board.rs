//! 语言服务器状态板：每个（工作区, 语言）一份**唯一**的状态，变化即广播 `lsp-status`。
//!
//! 设计见 docs/superpowers/specs/2026-10-14-lsp-switch-readiness-design.md §4。
//!
//! 为什么要它：以前有两套「就绪」各说各话——标题栏认 jdtls 自报的 `ServiceReady`，agent 认
//! sidecar 的预热结果。实测（po-api，jdtls 1.58）`ServiceReady` 之后第一次按名查询还要 25s：
//! 界面亮「就绪」时 agent 查不到。这里的「就绪」只认**实测**（`readiness.rs` 的探针），server
//! 自报的信号（jdtls `language/status`、标准 `$/progress`）只用来推进阶段和显示进度。
//!
//! 语言无关：本文件不出现任何语言特判。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tokio::sync::watch;

use crate::lsp::agent_status::AgentLspStatus;
use crate::lsp::detector::LanguageId;
use crate::EventSink;

/// 阶段。`Ready` 仅当跳转能力实测通过、且按名查询实测通过或 server 不支持。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// 没在跑（从没起过 / 已停）。
    Off,
    /// 本工作区开关关着。
    Disabled,
    /// 没装（查找链解析不出 server）。
    Missing,
    /// 进程起来了，握手中。
    Starting,
    /// 握手完，server 自己还在导入工程（jdtls `ServiceReady` 之前）。
    Loading,
    /// 工程已加载，实测探针还没全过（跳转或按名查询仍不可用）。
    Indexing,
    Ready,
    Failed,
    /// 空闲休眠：进程已停、开关仍开，用到即唤醒（与用户关闭的 `Disabled` 区分）。
    Sleeping,
}

/// 按名查询（`workspace/symbol`）能力位。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SymbolsCap {
    Unknown,
    Ready,
    /// 握手没声明 `workspaceSymbolProvider`（如 Volar）：不等它。
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LangStatus {
    pub phase: Phase,
    /// 跳转类请求实测可用（`probe_ready` 通过）。
    pub nav: bool,
    pub symbols: SymbolsCap,
    /// server 自报的百分比（jdtls `language/status` 的 `NN%`、`$/progress` 的 percentage）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
    /// server 自报的阶段说明（原文，不翻译）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 进入当前阶段的时间（unix ms）：前端据此显示「已等待 N 秒」。
    pub since: u64,
    /// 预计休眠的时间点（unix ms）：前端本地每秒算倒计时，Host 不按秒推。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sleep_at: Option<u64>,
    /// 不休眠的原因（目前只有 "editor"：编辑器开着该语言的文件）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kept_by: Option<&'static str>,
    /// 进程树实际占用的内存（字节；Windows 是工作集，Linux 是 RSS），巡检时采样，约 30s 一次。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<u64>,
}

impl LangStatus {
    fn new(phase: Phase) -> Self {
        Self {
            phase,
            nav: false,
            symbols: SymbolsCap::Unknown,
            progress: None,
            message: None,
            error: None,
            since: now_ms(),
            sleep_at: None,
            kept_by: None,
            memory: None,
        }
    }

    /// 由能力位推导的阶段（只在已过握手的阶段上推导；Off/Disabled/Missing/Failed/Starting 不动）。
    fn derive_phase(&mut self) {
        if matches!(self.phase, Phase::Indexing | Phase::Ready) {
            let next = if self.nav && self.symbols != SymbolsCap::Unknown { Phase::Ready } else { Phase::Indexing };
            self.set_phase(next);
        }
    }

    fn set_phase(&mut self, phase: Phase) {
        if self.phase != phase {
            self.phase = phase;
            self.since = now_ms();
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

type Key = (String, LanguageId);

/// 进行中的就绪探测：完成时 `watch` 写入 `Some(结果状态词)`（跳转实测通过 = `Ready`）。
struct Warm {
    rx: watch::Receiver<Option<AgentLspStatus>>,
    abort: tokio::task::AbortHandle,
}

/// 内存采样的重发阈值（见 [`StatusBoard::set_memory`]）。
const MEMORY_SLACK_BYTES: u64 = 16 * 1024 * 1024;

/// 休眠时间点的重发阈值（见 [`StatusBoard::set_sleep`]）。
const SLEEP_AT_SLACK_MS: u64 = 30_000;

/// 进度广播节流间隔（见 [`StatusBoard::progress`]）。
const PROGRESS_EMIT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);

pub struct StatusBoard {
    events: Arc<dyn EventSink>,
    map: Mutex<HashMap<Key, LangStatus>>,
    warms: Mutex<HashMap<Key, Warm>>,
    last_progress: Mutex<HashMap<Key, std::time::Instant>>,
}

impl StatusBoard {
    pub fn new(events: Arc<dyn EventSink>) -> Self {
        Self {
            events,
            map: Mutex::new(HashMap::new()),
            warms: Mutex::new(HashMap::new()),
            last_progress: Mutex::new(HashMap::new()),
        }
    }

    pub fn get(&self, workspace: &str, lang: LanguageId) -> Option<LangStatus> {
        self.map.lock().ok()?.get(&(workspace.to_string(), lang)).cloned()
    }

    /// 某工作区全部语言的当前状态（前端打开面板时回种用）。
    pub fn snapshot(&self, workspace: &str) -> Vec<(LanguageId, LangStatus)> {
        let Ok(map) = self.map.lock() else { return vec![] };
        let mut v: Vec<_> = map.iter().filter(|((w, _), _)| w == workspace).map(|((_, l), s)| (*l, s.clone())).collect();
        v.sort_by_key(|(l, _)| l.id_str());
        v
    }

    /// 改一份状态；有变化才广播。不存在则从 `Off` 起。
    pub fn update(&self, workspace: &str, lang: LanguageId, f: impl FnOnce(&mut LangStatus)) {
        let changed = {
            let Ok(mut map) = self.map.lock() else { return };
            let entry = map.entry((workspace.to_string(), lang)).or_insert_with(|| LangStatus::new(Phase::Off));
            let before = entry.clone();
            f(entry);
            entry.derive_phase();
            (*entry != before).then(|| entry.clone())
        };
        if let Some(s) = changed {
            self.emit(workspace, lang, &s);
        }
    }

    fn emit(&self, workspace: &str, lang: LanguageId, s: &LangStatus) {
        let mut payload = serde_json::to_value(s).unwrap_or(Value::Null);
        if let Value::Object(o) = &mut payload {
            o.insert("workspaceRoot".into(), Value::String(workspace.to_string()));
            o.insert("lang".into(), Value::String(lang.id_str().to_string()));
        }
        self.events.emit("lsp-status", payload);
    }

    /// 进入新阶段：清掉上一阶段的进度 / 错误；回到 Off/Starting 等起点时能力位一并作废。
    pub fn enter(&self, workspace: &str, lang: LanguageId, phase: Phase, error: Option<String>) {
        self.update(workspace, lang, |s| {
            if matches!(
                phase,
                Phase::Off | Phase::Disabled | Phase::Missing | Phase::Starting | Phase::Failed | Phase::Sleeping
            ) {
                s.nav = false;
                s.symbols = SymbolsCap::Unknown;
                s.sleep_at = None;
                s.kept_by = None;
                s.memory = None;
            }
            s.set_phase(phase);
            s.progress = None;
            s.message = None;
            s.error = error;
        });
    }

    /// server 自报进度（只更新显示，不改阶段、不改能力位）。`None, None` = 这一段进度结束，清掉。
    ///
    /// **节流**：rust-analyzer 之类每个 crate 报一次，一秒几十条；这里同一份状态
    /// [`PROGRESS_EMIT_INTERVAL`] 内最多广播一次（状态照常更新，下一次变化时带出最新值；
    /// 阶段变化不受节流，永远即时）。
    pub fn progress(&self, workspace: &str, lang: LanguageId, percent: Option<u8>, message: Option<String>) {
        let key = (workspace.to_string(), lang);
        let throttled = self
            .last_progress
            .lock()
            .ok()
            .and_then(|m| m.get(&key).copied())
            .is_some_and(|t| t.elapsed() < PROGRESS_EMIT_INTERVAL);
        let changed = {
            let Ok(mut map) = self.map.lock() else { return };
            let entry = map.entry(key.clone()).or_insert_with(|| LangStatus::new(Phase::Off));
            let before = (entry.progress, entry.message.clone());
            if percent.is_none() && message.is_none() {
                entry.progress = None;
                entry.message = None;
            } else {
                if percent.is_some() {
                    entry.progress = percent;
                }
                if message.is_some() {
                    entry.message = message;
                }
            }
            ((entry.progress, entry.message.clone()) != before).then(|| entry.clone())
        };
        if let Some(s) = changed {
            if !throttled {
                if let Ok(mut m) = self.last_progress.lock() {
                    m.insert(key, std::time::Instant::now());
                }
                self.emit(workspace, lang, &s);
            }
        }
    }

    /// server 自报「工程加载完」（如 jdtls `ServiceReady`）：`Loading` → `Indexing`。
    /// 不是就绪——就绪只认实测探针。
    pub fn loaded(&self, workspace: &str, lang: LanguageId) {
        self.update(workspace, lang, |s| {
            if s.phase == Phase::Loading {
                s.set_phase(Phase::Indexing);
            }
        });
    }

    /// 空闲倒计时（巡检任务每轮调）。`last_used` 刷新很频繁，时间点只在移动超过
    /// [`SLEEP_AT_SLACK_MS`] 或「不休眠原因」变化时才重发——倒计时误差 ≤ 这个量。
    pub fn set_sleep(&self, workspace: &str, lang: LanguageId, sleep_at: Option<u64>, kept_by: Option<&'static str>) {
        self.update(workspace, lang, |s| {
            let moved = match (s.sleep_at, sleep_at) {
                (Some(a), Some(b)) => a.abs_diff(b) > SLEEP_AT_SLACK_MS,
                (a, b) => a != b,
            };
            if moved {
                s.sleep_at = sleep_at;
            }
            s.kept_by = kept_by;
        });
    }

    /// 实际内存占用（巡检采样）。变化不到 [`MEMORY_SLACK_BYTES`] 且不到 5% 不重发——jdtls 的工作集
    /// 每秒都在抖，界面只要量级。
    pub fn set_memory(&self, workspace: &str, lang: LanguageId, bytes: u64) {
        self.update(workspace, lang, |s| {
            let moved = match s.memory {
                Some(old) => {
                    let diff = old.abs_diff(bytes);
                    diff > MEMORY_SLACK_BYTES || diff * 20 > old
                }
                None => true,
            };
            if moved {
                s.memory = Some(bytes);
            }
        });
    }

    /// 停一台（工作区, 语言）：取消它进行中的探测，再进 `phase`（休眠用）。顺序同 `stop_workspace`。
    pub fn stop_lang(&self, workspace: &str, lang: LanguageId, phase: Phase) {
        if let Ok(mut warms) = self.warms.lock() {
            if let Some(w) = warms.remove(&(workspace.to_string(), lang)) {
                w.abort.abort();
            }
        }
        self.enter(workspace, lang, phase, None);
    }

    pub fn set_nav(&self, workspace: &str, lang: LanguageId, ok: bool) {
        self.update(workspace, lang, |s| {
            s.nav = ok;
            // 实测通过 = 工程已加载（即便 server 没发过「加载完」信号）
            if ok && s.phase == Phase::Loading {
                s.set_phase(Phase::Indexing);
            }
        });
    }

    pub fn set_symbols(&self, workspace: &str, lang: LanguageId, cap: SymbolsCap) {
        self.update(workspace, lang, |s| s.symbols = cap);
    }

    pub fn symbols_ready(&self, workspace: &str, lang: LanguageId) -> bool {
        self.get(workspace, lang).is_some_and(|s| s.symbols != SymbolsCap::Unknown)
    }

    pub fn nav_ready(&self, workspace: &str, lang: LanguageId) -> bool {
        self.get(workspace, lang).is_some_and(|s| s.nav)
    }

    /// 该（工作区, 语言）进行中的就绪探测（单飞）：有就返回它的接收端。
    pub fn warm_in_flight(&self, workspace: &str, lang: LanguageId) -> Option<watch::Receiver<Option<AgentLspStatus>>> {
        let warms = self.warms.lock().ok()?;
        let rx = warms.get(&(workspace.to_string(), lang)).map(|w| w.rx.clone())?;
        drop(warms);
        let pending = rx.borrow().is_none();
        pending.then_some(rx)
    }

    /// 登记一次就绪探测（单飞）。已有进行中的 → 返回它的接收端，**不**启动新的。
    /// `start` 只在需要新开时调用，拿到发送端，完成时写 `Some(状态词)`。
    pub fn begin_warm(
        &self,
        workspace: &str,
        lang: LanguageId,
        start: impl FnOnce(watch::Sender<Option<AgentLspStatus>>) -> tokio::task::AbortHandle,
    ) -> watch::Receiver<Option<AgentLspStatus>> {
        let Ok(mut warms) = self.warms.lock() else {
            let (_tx, rx) = watch::channel(Some(AgentLspStatus::Error));
            return rx;
        };
        let key = (workspace.to_string(), lang);
        if let Some(w) = warms.get(&key) {
            if w.rx.borrow().is_none() {
                return w.rx.clone();
            }
        }
        let (tx, rx) = watch::channel(None);
        let abort = start(tx);
        warms.insert(key, Warm { rx: rx.clone(), abort });
        rx
    }

    /// 关闭 / 停机：取消该工作区进行中的探测，全部语言回到 `phase`（`Off` 或 `Disabled`）。
    /// 必须先取消探测再改状态——否则导入到一半被关、探测随后完成，会把状态写回就绪。
    pub fn stop_workspace(&self, workspace: &str, phase: Phase) {
        if let Ok(mut warms) = self.warms.lock() {
            warms.retain(|(w, _), warm| {
                if w == workspace {
                    warm.abort.abort();
                    false
                } else {
                    true
                }
            });
        }
        let langs: Vec<LanguageId> = self
            .map
            .lock()
            .map(|m| m.keys().filter(|(w, _)| w == workspace).map(|(_, l)| *l).collect())
            .unwrap_or_default();
        for lang in langs {
            self.enter(workspace, lang, phase, None);
        }
    }
}

/// 从 server 自报的文字里取百分比：jdtls 的 `language/status` 形如 `50% Starting Java Language
/// Server - Project 'po-api'`（实测）。取第一个 `NN%`，越界（jdtls 会报 1000%、1100%）一律截到 100。
pub fn percent_in(message: &str) -> Option<u8> {
    let bytes = message.as_bytes();
    let pct = message.find('%')?;
    let start = bytes[..pct].iter().rposition(|b| !b.is_ascii_digit()).map(|i| i + 1).unwrap_or(0);
    let n: u32 = message.get(start..pct)?.parse().ok()?;
    Some(n.min(100) as u8)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    #[derive(Default)]
    struct Rec(StdMutex<Vec<(String, Value)>>);
    impl EventSink for Rec {
        fn emit(&self, event: &str, payload: Value) {
            self.0.lock().unwrap().push((event.to_string(), payload));
        }
    }

    fn board() -> (Arc<Rec>, StatusBoard) {
        let rec = Arc::new(Rec::default());
        (rec.clone(), StatusBoard::new(rec))
    }

    #[test]
    fn ready_requires_both_probes() {
        let (_, b) = board();
        b.enter("/w", LanguageId::Java, Phase::Loading, None);
        b.set_nav("/w", LanguageId::Java, true);
        assert_eq!(b.get("/w", LanguageId::Java).unwrap().phase, Phase::Indexing, "跳转好了、按名还没好：仍是索引中");
        b.set_symbols("/w", LanguageId::Java, SymbolsCap::Ready);
        assert_eq!(b.get("/w", LanguageId::Java).unwrap().phase, Phase::Ready);
    }

    #[test]
    fn unsupported_symbols_do_not_block_ready() {
        let (_, b) = board();
        b.enter("/w", LanguageId::Python, Phase::Indexing, None);
        b.set_symbols("/w", LanguageId::Python, SymbolsCap::Unsupported);
        b.set_nav("/w", LanguageId::Python, true);
        assert_eq!(b.get("/w", LanguageId::Python).unwrap().phase, Phase::Ready);
    }

    #[test]
    fn broadcasts_only_on_change_with_routing_keys() {
        let (rec, b) = board();
        b.enter("/w", LanguageId::Rust, Phase::Starting, None);
        b.enter("/w", LanguageId::Rust, Phase::Starting, None);
        let ev = rec.0.lock().unwrap();
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].0, "lsp-status");
        assert_eq!(ev[0].1["workspaceRoot"], "/w");
        assert_eq!(ev[0].1["lang"], "rust");
        assert_eq!(ev[0].1["phase"], "starting");
    }

    #[test]
    fn restart_resets_capabilities() {
        let (_, b) = board();
        b.enter("/w", LanguageId::Rust, Phase::Indexing, None);
        b.set_nav("/w", LanguageId::Rust, true);
        b.set_symbols("/w", LanguageId::Rust, SymbolsCap::Ready);
        b.enter("/w", LanguageId::Rust, Phase::Off, None);
        let s = b.get("/w", LanguageId::Rust).unwrap();
        assert!(!s.nav);
        assert_eq!(s.symbols, SymbolsCap::Unknown);
    }

    #[test]
    fn progress_is_throttled_but_state_kept() {
        let (rec, b) = board();
        b.progress("/w", LanguageId::Rust, Some(10), Some("a".into()));
        b.progress("/w", LanguageId::Rust, Some(20), Some("b".into()));
        assert_eq!(rec.0.lock().unwrap().len(), 1, "500ms 内第二条不广播");
        assert_eq!(b.get("/w", LanguageId::Rust).unwrap().progress, Some(20), "状态照常更新");
        b.enter("/w", LanguageId::Rust, Phase::Starting, None);
        assert_eq!(rec.0.lock().unwrap().len(), 2, "阶段变化不受节流");
    }

    #[test]
    fn loaded_moves_loading_to_indexing_only() {
        let (_, b) = board();
        b.enter("/w", LanguageId::Java, Phase::Loading, None);
        b.loaded("/w", LanguageId::Java);
        assert_eq!(b.get("/w", LanguageId::Java).unwrap().phase, Phase::Indexing);
        b.enter("/w", LanguageId::Java, Phase::Off, None);
        b.loaded("/w", LanguageId::Java);
        assert_eq!(b.get("/w", LanguageId::Java).unwrap().phase, Phase::Off);
    }

    #[test]
    fn sleep_at_rebroadcasts_only_on_real_moves() {
        let (rec, b) = board();
        b.enter("/w", LanguageId::Java, Phase::Indexing, None);
        let n0 = rec.0.lock().unwrap().len();
        b.set_sleep("/w", LanguageId::Java, Some(1_000_000), None);
        b.set_sleep("/w", LanguageId::Java, Some(1_010_000), None); // 只挪了 10s：不重发
        assert_eq!(rec.0.lock().unwrap().len(), n0 + 1);
        assert_eq!(b.get("/w", LanguageId::Java).unwrap().sleep_at, Some(1_000_000));
        b.set_sleep("/w", LanguageId::Java, Some(1_100_000), None); // 挪了 100s：重发
        b.set_sleep("/w", LanguageId::Java, None, Some("editor")); // 原因变化：重发
        assert_eq!(rec.0.lock().unwrap().len(), n0 + 3);
        assert_eq!(rec.0.lock().unwrap().last().unwrap().1["keptBy"], "editor");
    }

    #[test]
    fn sleeping_resets_capabilities_and_countdown() {
        let (_, b) = board();
        b.enter("/w", LanguageId::Rust, Phase::Indexing, None);
        b.set_nav("/w", LanguageId::Rust, true);
        b.set_sleep("/w", LanguageId::Rust, Some(5), None);
        b.stop_lang("/w", LanguageId::Rust, Phase::Sleeping);
        let s = b.get("/w", LanguageId::Rust).unwrap();
        assert_eq!(s.phase, Phase::Sleeping);
        assert!(!s.nav);
        assert_eq!(s.sleep_at, None);
    }

    #[test]
    fn memory_rebroadcasts_only_on_meaningful_change() {
        let (rec, b) = board();
        b.enter("/w", LanguageId::Java, Phase::Indexing, None);
        let n0 = rec.0.lock().unwrap().len();
        b.set_memory("/w", LanguageId::Java, 1_000 << 20);
        b.set_memory("/w", LanguageId::Java, 1_010 << 20); // +10MB、1%：不重发
        assert_eq!(rec.0.lock().unwrap().len(), n0 + 1);
        b.set_memory("/w", LanguageId::Java, 1_200 << 20);
        assert_eq!(rec.0.lock().unwrap().len(), n0 + 2);
        assert_eq!(rec.0.lock().unwrap().last().unwrap().1["memory"], 1_200u64 << 20);
        b.enter("/w", LanguageId::Java, Phase::Sleeping, None);
        assert_eq!(b.get("/w", LanguageId::Java).unwrap().memory, None, "停了就没有占用");
    }

    #[test]
    fn percent_parsing() {
        assert_eq!(percent_in("50% Starting Java Language Server - Project 'po-api'"), Some(50));
        assert_eq!(percent_in("1100% Starting"), Some(100));
        assert_eq!(percent_in("Refreshing projects"), None);
        assert_eq!(percent_in("Building 7%"), Some(7));
    }

    #[tokio::test]
    async fn warm_is_single_flight_and_stop_cancels_it() {
        let (_, b) = board();
        let mut started = 0;
        let mk = |started: &mut i32| {
            *started += 1;
            tokio::spawn(std::future::pending::<()>()).abort_handle()
        };
        let rx1 = b.begin_warm("/w", LanguageId::Java, |_tx| mk(&mut started));
        let _rx2 = b.begin_warm("/w", LanguageId::Java, |_tx| mk(&mut started));
        assert_eq!(started, 1, "进行中的探测不重复启动");
        assert!(b.warm_in_flight("/w", LanguageId::Java).is_some());
        b.enter("/w", LanguageId::Java, Phase::Indexing, None);
        b.stop_workspace("/w", Phase::Disabled);
        assert!(b.warm_in_flight("/w", LanguageId::Java).is_none());
        assert_eq!(b.get("/w", LanguageId::Java).unwrap().phase, Phase::Disabled);
        drop(rx1);
    }
}
