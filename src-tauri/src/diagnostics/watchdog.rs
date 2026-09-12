//! 看门狗线程：站在被监控者外面的检测者。
//!
//! 独立 `std::thread`（不占 Tauri 主线程、不进 tokio runtime），谁卡它都活着：
//! - 空闲态：每 tick 只做一次心跳缺口比较 + 投一枚主线程 no-op 探针（微秒级）；
//! - 心跳断流 ≥ `FREEZE_GAP_MS` → 冻结采样模式：每 tick 采一帧
//!   进程 CPU/内存（aide 全家族）+ 主线程探针积压 + IsHungAppWindow（Windows）；
//! - **飞行记录仪落盘**：冻结进行中每 `FLUSH_EVERY_TICKS` 个 tick（≈2s）
//!   原子重写同一份报告文件（文件名按 `started` 锚定，稳定不变）。
//!   进程被强杀时最后一次成功写入留在磁盘上——这才是黑匣子该有的样子，
//!   而不是等「恢复」才写（实际症状是永不恢复、一直未响应直到被强杀）。
//! - 心跳真恢复 → 最终一次 flush（`recovered=true`），前端 30s 内补交明细。
//!
//! 防误报 / 防噪声：
//! - 首心跳前不判定（前端还没起）；
//! - `hidden` 心跳期间不判定（浏览器节流后台定时器，可退化到分钟级）；
//! - watchdog 自己的 tick 缺口 > `SUSPEND_GAP_MS` 说明整机休眠/挂起，
//!   进行中的冻结标 `suspected_sleep` 收尾，不新开冻结；
//! - 因 hidden 收尾或恢复且时长 < `MIN_REPORT_MS` 的短冻结丢弃（节流伪影/抖动）。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicIsize, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use sysinfo::{ProcessesToUpdate, System};
use tauri::{AppHandle, Manager};

use super::report::{
    self, FreezeInfo, FreezeReport, FreezeSample, MainThreadProbe, ParkFrameRecord, ProcessSample,
    ReportMeta, RingSnapshot, StackFrameRecord,
};
use super::stackwalk;
use super::{DiagInner, DiagnosticsState};

/// watchdog 检查周期 = 冻结期采样周期
const TICK_MS: u64 = 500;
/// 心跳断流判定阈值
pub const FREEZE_GAP_MS: u64 = 2000;
/// watchdog 自身 tick 缺口超过此值 = 系统休眠/挂起
const SUSPEND_GAP_MS: u64 = 5000;
/// 冻结采样帧上限（500ms × 600 = 5 分钟，再长只更新头部计时不再采新帧）
const MAX_SAMPLES: usize = 600;
/// 冻结进行中每多少个 tick 落一次盘（4 × 500ms = 2s）
const FLUSH_EVERY_TICKS: u32 = 4;
/// 短于此时长（ms）的冻结丢弃——隐藏节流伪影 / 抖动，不值得留档。
/// 真正的「一直未响应」远超此值，且其报告在强杀前早已增量落盘，不受此过滤影响。
const MIN_REPORT_MS: u64 = 4000;

/// 主线程探针的共享状态：watchdog 投递、主线程闭包回执。
struct ProbeState {
    /// 已投递未返回数——持续增长 = Tauri 主线程本身卡死
    pending: AtomicU32,
    /// 最近一次往返延迟（µs）
    last_latency_us: AtomicU64,
}

struct ActiveFreeze {
    started_epoch: u64,
    detected_gap_ms: u64,
    samples: Vec<FreezeSample>,
    /// 已落盘报告路径（按 started 锚定，增量重写同一文件）
    path: Option<PathBuf>,
    tick_since_flush: u32,
}

/// 落盘/收尾时的冻结结局——替代 `suspected_sleep` + `recovered` 相邻 bool，
/// 杜绝无意义的 (true, true) 组合。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FreezeOutcome {
    /// 心跳仍断流：落一份进行中快照（增量重写同一文件），或按非结局收尾（hidden 节流）。
    /// 短于此结局的冻结被 close_freeze 丢弃。
    Ongoing,
    /// 心跳恢复，一次完整收尾的瞬时冻结。
    Recovered,
    /// 整机休眠/挂起导致的中断，标 suspected_sleep 收尾。
    SuspectedSleep,
}

pub fn spawn(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("diag-watchdog".into())
        .spawn(move || run(app));
}

fn run(app: AppHandle) {
    let inner = Arc::clone(&app.state::<DiagnosticsState>().0);
    let probe = Arc::new(ProbeState {
        pending: AtomicU32::new(0),
        last_latency_us: AtomicU64::new(0),
    });
    let hwnd = resolve_hwnd(&app);
    let main_tid = resolve_main_thread_id(&app);

    let mut sys = System::new();
    let mut freeze: Option<ActiveFreeze> = None;
    let mut last_tick = Instant::now();

    loop {
        std::thread::sleep(Duration::from_millis(TICK_MS));
        let tick_gap_ms = last_tick.elapsed().as_millis() as u64;
        last_tick = Instant::now();
        let suspended = tick_gap_ms > SUSPEND_GAP_MS;

        if suspended {
            // 整机休眠恢复：进行中的冻结按 suspected_sleep 收尾，不新开
            if let Some(fz) = freeze.take() {
                close_freeze(&inner, fz, FreezeOutcome::SuspectedSleep);
            }
            continue;
        }

        post_probe(&app, &probe);

        let heartbeat_at = *inner.last_heartbeat.lock().unwrap();
        let Some(heartbeat_at) = heartbeat_at else {
            continue; // 前端尚未发出首心跳
        };

        if inner.hidden.load(Ordering::Relaxed) {
            // 窗口隐藏：定时器被浏览器节流，缺口不可信。停止监测，收尾进行中的冻结。
            if let Some(fz) = freeze.take() {
                close_freeze(&inner, fz, FreezeOutcome::Ongoing);
            }
            continue;
        }

        let gap_ms = heartbeat_at.elapsed().as_millis() as u64;
        match freeze.as_mut() {
            None if gap_ms >= FREEZE_GAP_MS => {
                tracing::warn!("diag: heartbeat gap {gap_ms}ms — freeze sampling started");
                let mut fz = ActiveFreeze {
                    started_epoch: report::epoch_ms().saturating_sub(gap_ms),
                    detected_gap_ms: gap_ms,
                    samples: Vec::new(),
                    path: None,
                    tick_since_flush: 0,
                };
                // 立即预热一次进程表：sysinfo 的 cpu_usage 是两次刷新间的差值，
                // 预热让下一帧就有有效 CPU 数据
                let _ = sample_processes(&mut sys);
                fz.samples
                    .push(make_sample(&mut sys, &probe, &hwnd, &main_tid, true));
                fz.path = flush_report(&inner, &fz, FreezeOutcome::Ongoing);
                freeze = Some(fz);
            }
            Some(fz) if gap_ms >= FREEZE_GAP_MS => {
                if fz.samples.len() < MAX_SAMPLES {
                    fz.samples
                        .push(make_sample(&mut sys, &probe, &hwnd, &main_tid, false));
                }
                fz.tick_since_flush += 1;
                if fz.tick_since_flush >= FLUSH_EVERY_TICKS {
                    fz.path = flush_report(&inner, fz, FreezeOutcome::Ongoing);
                    fz.tick_since_flush = 0;
                }
            }
            Some(_) => {
                // 心跳恢复 → 最终落盘（recovered=true），前端随后补交明细
                let fz = freeze.take().expect("freeze checked Some");
                close_freeze(&inner, fz, FreezeOutcome::Recovered);
            }
            None => {}
        }
    }
}

/// 投一枚 no-op 探针到 Tauri 主线程，测响应延迟与积压。
fn post_probe(app: &AppHandle, probe: &Arc<ProbeState>) {
    probe.pending.fetch_add(1, Ordering::Relaxed);
    let sent = Instant::now();
    let p = Arc::clone(probe);
    let posted = app.run_on_main_thread(move || {
        p.pending.fetch_sub(1, Ordering::Relaxed);
        p.last_latency_us
            .store(sent.elapsed().as_micros() as u64, Ordering::Relaxed);
    });
    if posted.is_err() {
        probe.pending.fetch_sub(1, Ordering::Relaxed);
    }
}

fn make_sample(
    sys: &mut System,
    probe: &ProbeState,
    hwnd: &AtomicIsize,
    main_tid: &AtomicU32,
    walk_full: bool,
) -> FreezeSample {
    let stuck = super::current_stuck_command();
    // 跨线程抓主线程顶帧：SuspendThread + GetThreadContext + 解析模块名。
    // stuck_command 看不到的框架路径（emit 投递 / 事件循环 / 锁 / 系统调用）靠这帧点名。
    // walk_full=true 时进一步 StackWalk64 走完整调用链（仅冻结首帧，栈静态）。
    // 非目标平台 / 抓取失败为 None，不污染报告。
    let park = stackwalk::capture_main_thread_park(main_tid.load(Ordering::Relaxed), walk_full)
        .map(|f| ParkFrameRecord {
            module: f.module,
            address: f.address,
            offset: f.offset,
            frames: f
                .frames
                .into_iter()
                .map(|fr| StackFrameRecord {
                    module: fr.module,
                    address: fr.address,
                    offset: fr.offset,
                })
                .collect(),
        });
    FreezeSample {
        t: report::epoch_ms(),
        processes: sample_processes(sys),
        main_thread: MainThreadProbe {
            pending: probe.pending.load(Ordering::Relaxed),
            last_latency_ms: probe.last_latency_us.load(Ordering::Relaxed) as f64 / 1000.0,
            stuck_command: stuck.map(|(name, _)| name.to_string()),
            stuck_for_ms: stuck.map(|(_, dur)| dur.as_millis() as u64),
            park,
        },
        is_hung_window: is_hung_window(hwnd.load(Ordering::Relaxed)),
    }
}

/// 采样诊断目标进程的 CPU/内存：aide 进程家族（node sidecar / git 等子进程）
/// + WebView2 运行时进程（渲染/GPU——按名匹配，因为它们不可靠地挂在 aide 进程树下）。
/// 每帧按活跃度裁剪，丢掉别的 app 的空闲 WebView 进程以控制报告体积。
/// 只在冻结期被调用——空闲态零成本。
fn sample_processes(sys: &mut System) -> Vec<ProcessSample> {
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let me = std::process::id();
    let parents: HashMap<u32, u32> = sys
        .processes()
        .iter()
        .filter_map(|(pid, p)| p.parent().map(|pp| (pid.as_u32(), pp.as_u32())))
        .collect();
    let family = report::family_of(me, &parents);
    let candidates: Vec<ProcessSample> = sys
        .processes()
        .iter()
        .filter(|(pid, p)| {
            report::is_diagnostic_target(pid.as_u32(), &p.name().to_string_lossy(), &family)
        })
        .map(|(pid, p)| ProcessSample {
            pid: pid.as_u32(),
            name: p.name().to_string_lossy().into_owned(),
            cpu: p.cpu_usage(),
            mem: p.memory(),
        })
        .collect();
    report::select_frame_processes(candidates, &family, report::MAX_WEBVIEW_PER_FRAME)
}

/// 组装并落盘一份报告。返回报告路径（按 started 锚定，增量重写同一文件）。
/// `FreezeOutcome::Recovered` 表示心跳已恢复、是一次完整收尾的瞬时冻结。
fn flush_report(inner: &DiagInner, fz: &ActiveFreeze, outcome: FreezeOutcome) -> Option<PathBuf> {
    let ended = report::epoch_ms();
    let report = FreezeReport {
        meta: ReportMeta::current(),
        freeze: FreezeInfo {
            started: fz.started_epoch,
            ended,
            duration_ms: ended.saturating_sub(fz.started_epoch),
            detected_gap_ms: fz.detected_gap_ms,
            suspected_sleep: outcome == FreezeOutcome::SuspectedSleep,
            recovered: outcome == FreezeOutcome::Recovered,
        },
        samples: fz.samples.clone(),
        ring: RingSnapshot {
            heartbeats: inner.heartbeats.lock().unwrap().to_vec(),
            event_rates: inner.event_rates.lock().unwrap().snapshot(),
            trace: super::trace::snapshot(),
        },
        frontend: None,
    };
    let dir = crate::commands::our_config_dir().join("diagnostics");
    match report::write_report(&dir, &report) {
        Ok(path) => {
            match outcome {
                FreezeOutcome::Recovered => tracing::warn!(
                    "diag: freeze recovered after {}ms: {}",
                    report.freeze.duration_ms,
                    path.display()
                ),
                _ => tracing::warn!(
                    "diag: freeze ongoing ({}ms, {} samples): {}",
                    report.freeze.duration_ms,
                    report.samples.len(),
                    path.display()
                ),
            }
            *inner.last_report.lock().unwrap() = Some((path.clone(), Instant::now()));
            Some(path)
        }
        Err(e) => {
            tracing::error!("diag: failed to write freeze report: {e}");
            None
        }
    }
}

/// 收尾一次冻结。短冻结（非恢复、非休眠、< MIN_REPORT_MS）丢弃，避免节流伪影噪声。
fn close_freeze(inner: &DiagInner, fz: ActiveFreeze, outcome: FreezeOutcome) {
    let duration = report::epoch_ms().saturating_sub(fz.started_epoch);
    if outcome == FreezeOutcome::Ongoing && duration < MIN_REPORT_MS {
        if let Some(p) = &fz.path {
            let _ = std::fs::remove_file(p);
        }
        let mut lr = inner.last_report.lock().unwrap();
        if let Some((p, _)) = lr.as_ref() {
            if fz.path.as_ref() == Some(p) {
                *lr = None;
            }
        }
        return;
    }
    flush_report(inner, &fz, outcome);
}

/// 主窗口 HWND（Windows 判「未响应」用）。在主线程解析一次，存成整数共享。
pub(super) fn resolve_hwnd(app: &AppHandle) -> Arc<AtomicIsize> {
    let hwnd = Arc::new(AtomicIsize::new(0));
    #[cfg(windows)]
    {
        let hwnd_c = Arc::clone(&hwnd);
        let app_c = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = app_c.get_webview_window("main") {
                if let Ok(h) = w.hwnd() {
                    hwnd_c.store(h.0 as isize, Ordering::Relaxed);
                }
            }
        });
    }
    hwnd
}

/// 主线程 OS TID：冻结期跨线程抓栈用（OpenThread + SuspendThread）。在主线程
/// 调 GetCurrentThreadId 记下，watchdog 据此挂起主线程走栈。非 Windows 为 0（抓栈
/// 函数自行返回 None）。
fn resolve_main_thread_id(app: &AppHandle) -> Arc<AtomicU32> {
    let tid = Arc::new(AtomicU32::new(0));
    #[cfg(windows)]
    {
        let tid_c = Arc::clone(&tid);
        let _ = app.run_on_main_thread(move || {
            // SAFETY: GetCurrentThreadId 无副作用，仅返回调用线程的 OS TID。
            tid_c.store(unsafe { GetCurrentThreadId() }, Ordering::Relaxed);
        });
    }
    tid
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentThreadId() -> u32;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::Mutex;

    /// 构造一个最小的 DiagInner（空环）。close_freeze 的丢弃路径只碰
    /// last_report + 磁盘，不依赖心跳/事件环内容。
    fn test_inner() -> Arc<DiagInner> {
        Arc::new(DiagInner {
            last_heartbeat: Mutex::new(None),
            hidden: AtomicBool::new(false),
            heartbeats: Mutex::new(super::super::ring::Ring::new(4)),
            event_rates: Mutex::new(super::super::EventRates::new(4)),
            last_report: Mutex::new(None),
        })
    }

    /// 现在开始的短冻结（duration≈0 < MIN_REPORT_MS），路径可控。
    fn freeze_now(path: Option<PathBuf>) -> ActiveFreeze {
        ActiveFreeze {
            started_epoch: report::epoch_ms(),
            detected_gap_ms: FREEZE_GAP_MS,
            samples: Vec::new(),
            path,
            tick_since_flush: 0,
        }
    }

    /// Ongoing + 短于 MIN_REPORT_MS → 丢弃：已落盘报告文件删除、last_report 清空。
    /// 不触发 flush_report，不污染真实配置目录。
    #[test]
    fn ongoing_short_discard_deletes_file_and_clears_last_report() {
        let inner = test_inner();
        let dir = std::env::temp_dir().join(format!("diag-watchdog-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("freeze.json");
        std::fs::write(&path, "{}").unwrap();
        *inner.last_report.lock().unwrap() = Some((path.clone(), Instant::now()));

        close_freeze(
            &inner,
            freeze_now(Some(path.clone())),
            FreezeOutcome::Ongoing,
        );

        assert!(!path.exists(), "短冻结丢弃应删除已落盘的报告文件");
        assert!(
            inner.last_report.lock().unwrap().is_none(),
            "last_report 应随文件清空"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Ongoing + 短：fz 没有已落盘路径时不动 last_report，避免误清别的报告。
    #[test]
    fn ongoing_short_discard_keeps_unrelated_last_report() {
        let inner = test_inner();
        let dir = std::env::temp_dir().join(format!("diag-watchdog-test2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let other = dir.join("other.json");
        std::fs::write(&other, "{}").unwrap();
        *inner.last_report.lock().unwrap() = Some((other.clone(), Instant::now()));

        close_freeze(&inner, freeze_now(None), FreezeOutcome::Ongoing);

        let kept = inner.last_report.lock().unwrap();
        assert_eq!(
            kept.as_ref().map(|(p, _)| p),
            Some(&other),
            "无关 last_report 保留"
        );
        assert!(other.exists(), "无关文件不受影响");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Windows：问操作系统这个窗口是否已被判定「未响应」（≥5s 不处理消息）。
/// 与我们自己的心跳判定互相印证。
#[cfg(windows)]
pub(super) fn is_hung_window(hwnd: isize) -> Option<bool> {
    if hwnd == 0 {
        return None;
    }
    #[link(name = "user32")]
    extern "system" {
        fn IsHungAppWindow(hwnd: *mut std::ffi::c_void) -> i32;
    }
    Some(unsafe { IsHungAppWindow(hwnd as *mut std::ffi::c_void) } != 0)
}

#[cfg(not(windows))]
pub(super) fn is_hung_window(_hwnd: isize) -> Option<bool> {
    None
}
