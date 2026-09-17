//! emit 归因实验：worker 跨线程 emit 到底会不会把主线程堵死（dev / 诊断包专用）。
//!
//! 背景：2026-07 曾把偶发卡死归因于「worker 跨线程 `app.emit` → 主线程在
//! WebView2 投递路径 park」，并据此选了「内存缓冲 + 同步轮询」的架构方案 C。
//! 该归因从来没有栈帧证实（stackwalk 是那次结论之后才加的）。2026-08 起 20 份
//! 冻结报告显示主线程探针延迟全程 0.08–0.60ms、IsHungAppWindow 全 false——
//! 与「主线程被堵」互斥。本模块用受控实验直接判决，不再靠推断。
//!
//! 场景表（每行是一组对照）：
//!
//! | 场景 | 风暴 | 堵渲染进程 | 测什么 |
//! |---|---|---|---|
//! | `idle` | — | ✗ | 基线 |
//! | `eval` | `webview.eval` | ✗ | **投递路径本身**（不依赖任何 JS 监听器） |
//! | `emit` | `app.emit` | ✗ | 7 月被指控的那条路（= eval + 监听器分发） |
//! | `block` | — | ✓ | 渲染进程被卡时主线程受不受牵连 |
//! | `block_emit` | `app.emit` | ✓ | 卡住 + 事件流（真实卡死现场的形状） |
//!
//! 判读：`emit` ≈ `idle` → emit 无罪；`block` ≈ `block_emit` → 主线程若 park
//! 是渲染进程被卡的连带，与 emit 无关。
//!
//! 两个易踩的坑，本模块各堵一个：
//!
//! 1. **假阴性**：`app.emit` 只在**存在监听器**时才会调到 `eval`；前端还没注册
//!    `chat-event` 监听就开测，测到的是「什么都没发生」。故 `eval` 场景直接从
//!    后台线程 `webview.eval`——与 emit 在 `send_user_message` 之后**同一条路径**，
//!    但不依赖监听器。两者一起读，空结果才有意义。
//! 2. **污染**：压测事件走真实事件名 `chat-event`，但**不带 `session_id`**——
//!    前端 `handleChatEvent` 在 `getStore` 之前就早退（useChatSession/events.ts），
//!    压测不会在 store 里留僵尸会话。

use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use super::watchdog;

/// 探针投掷间隔：主线程响应延迟的采样粒度。比 watchdog 的 500ms 密，单次实验
/// 窗口内样本足够多，又不至于让探针自己成为负载。
const PROBE_INTERVAL_MS: u64 = 100;
/// 风暴频率。真实流式是 1–15 事件/秒，这里两个数量级碾压。
const STORM_RATE_HZ: u32 = 1000;
/// 收尾兑现窗口：采样结束后给在途探针一点时间落袋，超时即判定「投出去没回来」。
const SETTLE_WINDOW: Duration = Duration::from_millis(1500);
const MIN_DURATION_MS: u64 = 500;
const MAX_DURATION_MS: u64 = 60_000;
/// 无人值守复跑的场景顺序（也是全部场景）。
const SCENARIOS: [Scenario; 5] = [
    Scenario::Idle,
    Scenario::Eval,
    Scenario::Emit,
    Scenario::Block,
    Scenario::BlockEmit,
];
/// 等前端心跳就绪的上限，以及就绪后的静置——`listen()` 是异步注册的。
const READY_TIMEOUT: Duration = Duration::from_secs(60);
const READY_SETTLE: Duration = Duration::from_secs(2);
/// 心跳新鲜度判据：前端 500ms 一跳，2s 内有过就算活着。
const HEARTBEAT_FRESH: Duration = Duration::from_millis(2000);

// ── 场景 ────────────────────────────────────────────────────────────

/// 风暴形态。刻意做成枚举而非「裸 bool 墙」——三个取值各有各的语义，
/// 用 bool 表达不出「不风暴 / emit / eval」。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum StormKind {
    None,
    Emit,
    Eval,
}

impl StormKind {
    fn rate_hz(self) -> Option<u32> {
        (!matches!(self, Self::None)).then_some(STORM_RATE_HZ)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Scenario {
    Idle,
    Eval,
    Emit,
    Block,
    BlockEmit,
}

impl Scenario {
    fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "idle" => Ok(Self::Idle),
            "eval" => Ok(Self::Eval),
            "emit" => Ok(Self::Emit),
            "block" => Ok(Self::Block),
            "block_emit" => Ok(Self::BlockEmit),
            other => Err(format!(
                "未知场景 {other}（idle/eval/emit/block/block_emit）"
            )),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Eval => "eval",
            Self::Emit => "emit",
            Self::Block => "block",
            Self::BlockEmit => "block_emit",
        }
    }

    fn storm(self) -> StormKind {
        match self {
            Self::Eval => StormKind::Eval,
            Self::Emit | Self::BlockEmit => StormKind::Emit,
            Self::Idle | Self::Block => StormKind::None,
        }
    }

    fn blocks_renderer(self) -> bool {
        matches!(self, Self::Block | Self::BlockEmit)
    }
}

// ── 采样结果 ────────────────────────────────────────────────────────

#[derive(Default, serde::Serialize)]
pub struct LatencyStats {
    /// 落袋的样本数。被堵死时它会偏小甚至为 0——所以必须配 `missed` 一起读。
    pub samples: u32,
    pub max_ms: f64,
    pub p50_ms: f64,
    pub p99_ms: f64,
    /// 投出去、到收尾仍未执行的探针数（主线程没回来兑现）。
    pub missed: u32,
}

#[derive(serde::Serialize)]
pub struct ExperimentReport {
    pub scenario: String,
    pub duration_ms: u64,
    /// IsHungAppWindow 为 true 的帧数 / 总帧数。
    pub hung_frames: u32,
    pub frames: u32,
    /// 主线程 no-op 探针延迟（健康应 <1ms，被堵则飙到秒级或直接 miss）。
    pub probe: LatencyStats,
    /// 风暴次数（eval 场景是 eval 次数，emit 场景是 emit 次数）。
    pub stormed: u64,
    /// 风暴侧自身耗时（worker 线程视角——7 月的 `tauri/tracing` 阻塞就发生在这里）。
    pub storm: LatencyStats,
}

/// 采样槽。采样线程写、风暴线程写、汇总时读——三处并发，故内部全原子/加锁。
#[derive(Default)]
struct ProbeSink {
    probe_ms: Mutex<Vec<f64>>,
    storm_ms: Mutex<Vec<f64>>,
    in_flight: AtomicU32,
    hung_frames: AtomicU32,
    frames: AtomicU32,
}

impl ProbeSink {
    fn finish(&self, scenario: Scenario, duration: Duration, stormed: u64) -> ExperimentReport {
        ExperimentReport {
            scenario: scenario.name().to_string(),
            duration_ms: duration.as_millis() as u64,
            frames: self.frames.load(Ordering::Relaxed),
            hung_frames: self.hung_frames.load(Ordering::Relaxed),
            probe: stats(
                &self.probe_ms.lock().unwrap(),
                self.in_flight.load(Ordering::Relaxed),
            ),
            stormed,
            storm: stats(&self.storm_ms.lock().unwrap(), 0),
        }
    }
}

/// 分位统计。`missed` 单独统计：被堵死的探针根本没落袋，只看延迟样本会把
/// 最严重的形态误读成「样本少」。
fn stats(raw: &[f64], missed: u32) -> LatencyStats {
    let mut v = raw.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    LatencyStats {
        samples: v.len() as u32,
        max_ms: v.last().copied().unwrap_or(0.0),
        p50_ms: percentile(&v, 0.5),
        p99_ms: percentile(&v, 0.99),
        missed,
    }
}

/// p 分位（0..=1），nearest-rank：idx = round((n-1)·p)。空样本返回 0——报告
/// 路径不该因缺样本 panic。偶数样本取靠上的那个（对延迟诊断偏保守）。
fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

// ── 命令 ────────────────────────────────────────────────────────────

/// 跑一次归因实验。`scenario` ∈ idle/eval/emit/block/block_emit，
/// `duration_ms` 夹在 0.5–60s。返回本次的探针与风暴统计。
#[cfg(any(debug_assertions, feature = "devtools"))]
#[tauri::command]
pub async fn diag_emit_experiment(
    app: AppHandle,
    scenario: String,
    duration_ms: u64,
) -> Result<ExperimentReport, String> {
    let scenario = Scenario::parse(&scenario)?;
    let duration = clamp_duration(duration_ms);
    tauri::async_runtime::spawn_blocking(move || run(&app, scenario, duration))
        .await
        .map_err(|e| e.to_string())
}

fn clamp_duration(ms: u64) -> Duration {
    Duration::from_millis(ms.clamp(MIN_DURATION_MS, MAX_DURATION_MS))
}

/// 编排：起采样 →（可选）起风暴 →（可选）堵渲染进程 → 等采样收尾 → 汇总。
fn run(app: &AppHandle, scenario: Scenario, duration: Duration) -> ExperimentReport {
    let sink = Arc::new(ProbeSink::default());
    let hwnd = watchdog::resolve_hwnd(app);
    let sampler = spawn_sampler(app, hwnd, duration, Arc::clone(&sink));
    let storm = scenario
        .storm()
        .rate_hz()
        .map(|hz| spawn_storm(app, scenario.storm(), hz, duration, Arc::clone(&sink)));
    if scenario.blocks_renderer() {
        block_renderer(app, duration);
    }
    sampler.join().ok();
    let stormed = storm.map(|h| h.join().unwrap_or(0)).unwrap_or(0);
    sink.finish(scenario, duration, stormed)
}

/// 无人值守复跑：`AIDE_EMIT_EXPERIMENT=<每场景毫秒>` 启动后依次跑完全部场景、
/// 落盘 JSON、退出进程。没有它，同一个实验只能靠人肉点 devtools，结论不可复现。
pub fn autorun_on_startup(app: &AppHandle) {
    let Some(ms) = std::env::var("AIDE_EMIT_EXPERIMENT")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
    else {
        return;
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let duration = clamp_duration(ms);
        if !wait_frontend_ready(&app, READY_TIMEOUT) {
            eprintln!("[emit-experiment] 前端心跳未就绪，放弃——空监听器下测不出东西");
            app.exit(1);
            return;
        }
        let reports: Vec<ExperimentReport> =
            SCENARIOS.iter().map(|s| run(&app, *s, duration)).collect();
        match write_report(&reports) {
            Ok(p) => println!("[emit-experiment] 结果: {}", p.display()),
            Err(e) => eprintln!("[emit-experiment] 落盘失败: {e}"),
        }
        app.exit(0);
    });
}

/// 无人值守自检：`AIDE_FREEZE_SELFCHECK=<阻塞毫秒>` 启动后堵死渲染进程那么久
/// （制造一场**真冻结**），等 watchdog 落盘报告，再逐项审这份报告是否「现场拿全」，
/// 结论落 `selfcheck-<epoch>.json`，退出码 = verdict（0 全绿）。
///
/// 为什么要有它（2026-09-17 教训）：上一轮「LoAF 必能抓到根因」是**没验投递链就
/// 许的愿**——全量明细落在 `frontend` 字段，而该字段在 20/20 份历史报告里都是空的
/// （报告收尾重写把它抹了）。自检把「仪器真的产出完整现场」变成可复跑的一条命令：
/// 它不过，就不该拿这份报告去定案。
pub fn selfcheck_on_startup(app: &AppHandle) {
    let Some(ms) = std::env::var("AIDE_FREEZE_SELFCHECK")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
    else {
        return;
    };
    let app = app.clone();
    std::thread::spawn(move || {
        if !wait_frontend_ready(&app, READY_TIMEOUT) {
            eprintln!("[freeze-selfcheck] 前端心跳未就绪，放弃（空监听器下测不出东西）");
            app.exit(2);
            return;
        }
        let block = clamp_duration(ms);
        let since = super::report::epoch_ms();
        println!(
            "[freeze-selfcheck] 注入 {}ms 渲染阻塞，制造真冻结…",
            block.as_millis()
        );
        block_renderer(&app, block);
        let Some((path, finalized)) = wait_for_freeze_report(since, Duration::from_secs(30)) else {
            eprintln!("[freeze-selfcheck] 30s 内没有冻结报告——watchdog 没判定这次阻塞");
            app.exit(3);
            return;
        };
        if !finalized {
            eprintln!(
                "[freeze-selfcheck] ⚠ 报告在 30s 内没收尾（recovered=false）——冻结未恢复，\
                 补交与收尾重写都不会来；下面按「手上这份」审，缺的格子就是缺"
            );
        }
        let verdict = super::report::audit(&path, block.as_millis() as u64);
        let dir = crate::commands::our_config_dir().join("diagnostics");
        match super::report::write_selfcheck(&dir, &verdict) {
            Ok(p) => println!("[freeze-selfcheck] 结论: {}", p.display()),
            Err(e) => eprintln!("[freeze-selfcheck] 结论落盘失败: {e}"),
        }
        for c in &verdict.checks {
            println!(
                "[freeze-selfcheck] {} {} — {}",
                if c.ok { " ok " } else { "FAIL" },
                c.id,
                c.detail
            );
        }
        println!("[freeze-selfcheck] 报告: {}", path.display());
        println!(
            "[freeze-selfcheck] verdict: {}",
            if verdict.ok {
                "PASS（现场拿全）"
            } else {
                "FAIL（还有格子没拿到，见上面 FAIL 行）"
            }
        );
        app.exit(if verdict.ok { 0 } else { 1 });
    });
}

/// 等一份**收尾完成**的冻结报告：本次注入之后判定、且 `freeze.recovered == true`
/// （= 补交与收尾重写都已落盘）。
///
/// 为什么必须等收尾（2026-09-17 自检首跑实测）：报告是「进行中增量写 + 恢复后收尾
/// 重写」两次落盘，**第一份文件在冻结判定那一刻就出现了**（注入 8s 阻塞，2s 就判定）。
/// 谁只等「文件出现」谁就会量到半成品：1 帧样本、无补交、`recovered=false`——
/// 首跑就是这么误判成 FAIL 的（把「还没写完」读成了「拿不到」）。
///
/// watchdog 用**最后一拍心跳**当冻结起点，所以文件名的 epoch 会比注入时刻略早
/// ——按 5s 余量过滤，取窗口内最新的那份。
/// 返回 `(路径, 是否已收尾)`；30s 内始终没收尾时退回手上那份 + false（「冻结永不
/// 恢复」本身是要报出来的事实，不能静默丢掉）。
fn wait_for_freeze_report(
    since_epoch_ms: u64,
    timeout: Duration,
) -> Option<(std::path::PathBuf, bool)> {
    /// 收尾写完之后再静置：补交与恢复心跳同拍发出，而收尾重写是 watchdog 下一个
    /// tick（≤500ms）——两种到达顺序都让补交落进文件需要一点余量。
    const SUPPLEMENT_SETTLE: Duration = Duration::from_millis(1200);
    let dir = crate::commands::our_config_dir().join("diagnostics");
    let deadline = Instant::now() + timeout;
    let mut fallback: Option<std::path::PathBuf> = None;
    loop {
        let mut best: Option<(u64, std::path::PathBuf)> = None;
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let Some(epoch) = name
                    .strip_prefix("freeze-")
                    .and_then(|s| s.strip_suffix(".json"))
                    .and_then(|s| s.parse::<u64>().ok())
                else {
                    continue;
                };
                let newer = match best.as_ref() {
                    None => true,
                    Some((b, _)) => epoch > *b,
                };
                if newer && epoch + 5_000 >= since_epoch_ms {
                    best = Some((epoch, e.path()));
                }
            }
        }
        if let Some((_, path)) = best {
            if report_is_recovered(&path) {
                std::thread::sleep(SUPPLEMENT_SETTLE);
                return Some((path, true));
            }
            fallback = Some(path);
        }
        if Instant::now() >= deadline {
            return fallback.map(|p| (p, false));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// 报告是否已收尾（`freeze.recovered == true`）。读不动/解析失败按未收尾算。
fn report_is_recovered(path: &std::path::Path) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| {
            v.get("freeze")
                .and_then(|f| f.get("recovered"))
                .and_then(|b| b.as_bool())
        })
        .unwrap_or(false)
}

/// 等前端心跳新鲜。`main.ts` 是「先 mount 再 startDiagnostics」，心跳跳起来就
/// 说明 App.vue 的 setup 跑过了、`useChatSession` 的全局 chat-event 监听已在
/// 注册路上；再静置一段等 `listen()` 的 promise 落地。
fn wait_frontend_ready(app: &AppHandle, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let fresh = app.try_state::<super::DiagnosticsState>().is_some_and(|s| {
            s.0.last_heartbeat
                .lock()
                .unwrap()
                .is_some_and(|t| t.elapsed() < HEARTBEAT_FRESH)
        });
        if fresh {
            std::thread::sleep(READY_SETTLE);
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

fn write_report(reports: &[ExperimentReport]) -> Result<std::path::PathBuf, String> {
    let dir = crate::commands::our_config_dir().join("diagnostics");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create diagnostics dir: {e}"))?;
    let path = dir.join(format!(
        "emit-experiment-{}.json",
        super::report::epoch_ms()
    ));
    let body = serde_json::to_string_pretty(reports).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("write report: {e}"))?;
    Ok(path)
}

// ── 采样与风暴 ──────────────────────────────────────────────────────

/// 每 `PROBE_INTERVAL_MS` 往主线程投一枚 no-op 探针，记下它被兑现的耗时。
/// 探针走 `run_on_main_thread`，与 emit/eval 投递**同一条** `send_user_message`
/// 消息路径——这正是 7 月归因指向的那条路。
fn spawn_sampler(
    app: &AppHandle,
    hwnd: Arc<AtomicIsize>,
    duration: Duration,
    sink: Arc<ProbeSink>,
) -> JoinHandle<()> {
    let app = app.clone();
    std::thread::spawn(move || {
        let deadline = Instant::now() + duration;
        while Instant::now() < deadline {
            post_probe(&app, &sink);
            sink.frames.fetch_add(1, Ordering::Relaxed);
            if watchdog::is_hung_window(hwnd.load(Ordering::Relaxed)) == Some(true) {
                sink.hung_frames.fetch_add(1, Ordering::Relaxed);
            }
            std::thread::sleep(Duration::from_millis(PROBE_INTERVAL_MS));
        }
        settle(&sink);
    })
}

fn post_probe(app: &AppHandle, sink: &Arc<ProbeSink>) {
    sink.in_flight.fetch_add(1, Ordering::Relaxed);
    let sent = Instant::now();
    let s = Arc::clone(sink);
    let posted = app.run_on_main_thread(move || {
        s.probe_ms
            .lock()
            .unwrap()
            .push(sent.elapsed().as_secs_f64() * 1000.0);
        s.in_flight.fetch_sub(1, Ordering::Relaxed);
    });
    if posted.is_err() {
        sink.in_flight.fetch_sub(1, Ordering::Relaxed);
    }
}

/// 收尾：等在途探针兑现，超时即判定主线程没回来。
fn settle(sink: &ProbeSink) {
    let deadline = Instant::now() + SETTLE_WINDOW;
    while sink.in_flight.load(Ordering::Relaxed) > 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// 风暴：后台线程以 `rate_hz` 持续投递，直到时长用尽。同时记下**投递调用本身**
/// 的耗时——worker 视角，7 月的 `tauri/tracing` 阻塞就发生在这里。
fn spawn_storm(
    app: &AppHandle,
    kind: StormKind,
    rate_hz: u32,
    duration: Duration,
    sink: Arc<ProbeSink>,
) -> JoinHandle<u64> {
    let app = app.clone();
    std::thread::spawn(move || {
        let interval = Duration::from_secs_f64(1.0 / rate_hz as f64);
        let deadline = Instant::now() + duration;
        let payload = serde_json::json!({ "type": "diag_stress" });
        let mut sent = 0u64;
        while Instant::now() < deadline {
            let t0 = Instant::now();
            match kind {
                // 真实事件名 → 前端监听器在 → 走完 dispatch 再逐监听器 eval。
                // 不带 session_id：前端在 getStore 之前早退，不留僵尸会话。
                StormKind::Emit => {
                    let _ = app.emit("chat-event", payload.clone());
                }
                // 直达投递路径，不依赖任何监听器——emit 场景空结果的对照组。
                StormKind::Eval => eval_noop(&app),
                StormKind::None => break,
            }
            sink.storm_ms
                .lock()
                .unwrap()
                .push(t0.elapsed().as_secs_f64() * 1000.0);
            sent += 1;
            let spent = t0.elapsed();
            if spent < interval {
                std::thread::sleep(interval - spent);
            }
        }
        sent
    })
}

fn eval_noop(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.eval("void 0");
    }
}

/// 把渲染进程的 JS 线程钉死 `duration`。与 Rust 主线程无关——`eval` 是排队，
/// 忙循环在渲染进程里跑。
fn block_renderer(app: &AppHandle, duration: Duration) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let script = format!(
        "const __t=Date.now();while(Date.now()-__t<{}){{}}",
        duration.as_millis()
    );
    let _ = win.eval(script);
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── 场景分派：五个场景各自的 storm / blocks_renderer 组合必须恰好对应上方
    //    的场景表，任一格写反都会让实验结论指向错误的行列。

    #[test]
    fn scenario_parse_accepts_all_five_and_rejects_unknown() {
        assert!(matches!(Scenario::parse("idle"), Ok(Scenario::Idle)));
        assert!(matches!(Scenario::parse("eval"), Ok(Scenario::Eval)));
        assert!(matches!(Scenario::parse("emit"), Ok(Scenario::Emit)));
        assert!(matches!(Scenario::parse("block"), Ok(Scenario::Block)));
        assert!(matches!(
            Scenario::parse("block_emit"),
            Ok(Scenario::BlockEmit)
        ));
        let err = Scenario::parse("turbo").expect_err("未知场景应报错");
        assert!(err.contains("turbo"), "错误信息要点名非法值: {err}");
    }

    #[test]
    fn scenario_matrix_matches_design_table() {
        // (场景, 风暴形态, 是否堵渲染进程)
        let expected = [
            (Scenario::Idle, StormKind::None, false),
            (Scenario::Eval, StormKind::Eval, false),
            (Scenario::Emit, StormKind::Emit, false),
            (Scenario::Block, StormKind::None, true),
            (Scenario::BlockEmit, StormKind::Emit, true),
        ];
        for (s, storm, block) in expected {
            assert_eq!(s.storm(), storm, "{} 的风暴形态不符", s.name());
            assert_eq!(s.blocks_renderer(), block, "{} 的阻塞开关不符", s.name());
        }
    }

    #[test]
    fn scenario_name_roundtrips_through_parse() {
        for s in SCENARIOS {
            assert!(matches!(Scenario::parse(s.name()), Ok(p) if p == s));
        }
    }

    #[test]
    fn storm_kind_none_has_no_rate() {
        assert_eq!(StormKind::None.rate_hz(), None, "无风暴不该有频率");
        assert_eq!(StormKind::Emit.rate_hz(), Some(STORM_RATE_HZ));
        assert_eq!(StormKind::Eval.rate_hz(), Some(STORM_RATE_HZ));
    }

    #[test]
    fn autorun_covers_every_parseable_scenario() {
        // 无人值守复跑必须覆盖全部场景，且顺序把 idle 放最前（基线先跑）。
        assert_eq!(SCENARIOS[0], Scenario::Idle);
        for s in SCENARIOS {
            assert_eq!(Scenario::parse(s.name()).unwrap(), s);
        }
    }

    // ── 统计：空样本 + 分位边界 + missed 透传。missed 是「主线程被堵死」的唯一
    //    表征（堵住时延迟样本根本不落袋），漏读它 = 把最严重的形态看成「样本少」。

    #[test]
    fn percentile_empty_returns_zero() {
        assert_eq!(percentile(&[], 0.5), 0.0);
        assert_eq!(percentile(&[], 1.0), 0.0);
    }

    #[test]
    fn percentile_single_sample_ignores_p() {
        assert_eq!(percentile(&[7.0], 0.0), 7.0);
        assert_eq!(percentile(&[7.0], 0.5), 7.0);
        assert_eq!(percentile(&[7.0], 1.0), 7.0);
    }

    #[test]
    fn percentile_hits_expected_indices() {
        let v = [1.0, 2.0, 3.0, 4.0, 5.0];
        assert_eq!(percentile(&v, 0.0), 1.0);
        assert_eq!(percentile(&v, 0.5), 3.0);
        assert_eq!(percentile(&v, 1.0), 5.0);
    }

    #[test]
    fn stats_sorts_before_percentiling_and_passes_missed_through() {
        // 未排序输入：先排序再取分位。约定是 nearest-rank 上中位（idx =
        // round((n-1)·p)），偶数样本取靠上的那个——对延迟诊断略偏保守，宁可
        // 高估尾部也不低估。
        let out = stats(&[30.0, 1.0, 20.0, 3.0], 2);
        assert_eq!(out.samples, 4);
        assert_eq!(out.max_ms, 30.0, "max 必须取排序后的尾元素");
        assert_eq!(out.p50_ms, 20.0, "排序后 [1,3,20,30] 的上中位是 20");
        assert_eq!(out.missed, 2, "在途未兑现的探针必须单独上报");
    }

    #[test]
    fn stats_p99_lands_just_below_the_max() {
        // 1..=100 的 p99 应落在 99，不是 max——两者分开才能看出「偶发一次尖峰」
        // 与「整段都在尖峰」的区别。
        let v: Vec<f64> = (1..=100).map(|i| i as f64).collect();
        let out = stats(&v, 0);
        assert_eq!(out.p99_ms, 99.0);
        assert_eq!(out.max_ms, 100.0);
    }

    #[test]
    fn stats_on_empty_is_all_zero_except_missed() {
        let out = stats(&[], 5);
        assert_eq!(out.samples, 0);
        assert_eq!(out.max_ms, 0.0);
        assert_eq!(out.p50_ms, 0.0);
        assert_eq!(out.p99_ms, 0.0);
        assert_eq!(out.missed, 5, "全堵死时样本为 0，但 missed 必须点破");
    }

    #[test]
    fn finish_reports_scenario_duration_and_both_channels() {
        let sink = ProbeSink::default();
        sink.probe_ms.lock().unwrap().extend([0.2, 0.4]);
        sink.storm_ms.lock().unwrap().extend([1.0]);
        sink.frames.store(3, Ordering::Relaxed);
        sink.hung_frames.store(1, Ordering::Relaxed);

        let r = sink.finish(Scenario::Emit, Duration::from_millis(2000), 42);
        assert_eq!(r.scenario, "emit");
        assert_eq!(r.duration_ms, 2000);
        assert_eq!(r.frames, 3);
        assert_eq!(r.hung_frames, 1);
        assert_eq!(r.probe.samples, 2);
        assert_eq!(r.stormed, 42);
        assert_eq!(r.storm.samples, 1);
        assert_eq!(r.storm.missed, 0, "风暴侧不统计在途");
    }

    #[test]
    fn clamp_duration_holds_both_ends() {
        assert_eq!(clamp_duration(0), Duration::from_millis(MIN_DURATION_MS));
        assert_eq!(
            clamp_duration(u64::MAX),
            Duration::from_millis(MAX_DURATION_MS)
        );
        assert_eq!(clamp_duration(3000), Duration::from_millis(3000));
    }
}
