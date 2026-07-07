//! 看门狗线程：站在被监控者外面的检测者。
//!
//! 独立 `std::thread`（不占 Tauri 主线程、不进 tokio runtime），谁卡它都活着：
//! - 空闲态：每 tick 只做一次心跳缺口比较 + 投一枚主线程 no-op 探针（微秒级）；
//! - 心跳断流 ≥ `FREEZE_GAP_MS` → 冻结采样模式：每 tick 采一帧
//!   进程 CPU/内存（aide 全家族）+ 主线程探针积压 + IsHungAppWindow（Windows）；
//! - 心跳恢复 → 组装报告落盘（环形缓冲 + 冻结期采样帧）。
//!
//! 防误报：
//! - 首心跳前不判定（前端还没起）；
//! - `hidden` 心跳期间不判定（浏览器节流后台定时器，可退化到分钟级）；
//! - watchdog 自己的 tick 缺口 > `SUSPEND_GAP_MS` 说明整机休眠/挂起，
//!   进行中的冻结标记 `suspected_sleep` 收尾，不新开冻结。

use std::collections::HashMap;
use std::sync::atomic::{AtomicIsize, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use sysinfo::{ProcessesToUpdate, System};
use tauri::{AppHandle, Manager};

use super::report::{
    self, FreezeInfo, FreezeReport, FreezeSample, MainThreadProbe, ProcessSample, ReportMeta,
    RingSnapshot,
};
use super::{DiagnosticsState, DiagInner};

/// watchdog 检查周期 = 冻结期采样周期
const TICK_MS: u64 = 500;
/// 心跳断流判定阈值
pub const FREEZE_GAP_MS: u64 = 2000;
/// watchdog 自身 tick 缺口超过此值 = 系统休眠/挂起
const SUSPEND_GAP_MS: u64 = 5000;
/// 冻结采样帧上限（500ms × 600 = 5 分钟，再长只计时不再采样）
const MAX_SAMPLES: usize = 600;

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
                finalize(&inner, fz, true);
            }
            continue;
        }

        post_probe(&app, &probe);

        let heartbeat_at = *inner.last_heartbeat.lock().unwrap();
        let Some(heartbeat_at) = heartbeat_at else {
            continue; // 前端尚未发出首心跳
        };

        if inner.hidden.load(Ordering::Relaxed) {
            // 窗口隐藏：定时器被浏览器节流，缺口不可信。
            // 隐藏标志本身来自心跳 → 前端活着，进行中的冻结正常收尾。
            if let Some(fz) = freeze.take() {
                finalize(&inner, fz, false);
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
                };
                // 立即预热一次进程表：sysinfo 的 cpu_usage 是两次刷新间的差值，
                // 预热让下一帧就有有效 CPU 数据
                let _ = sample_processes(&mut sys);
                fz.samples.push(make_sample(&mut sys, &probe, &hwnd));
                freeze = Some(fz);
            }
            Some(fz) if gap_ms >= FREEZE_GAP_MS => {
                if fz.samples.len() < MAX_SAMPLES {
                    fz.samples.push(make_sample(&mut sys, &probe, &hwnd));
                }
            }
            Some(_) => {
                // 心跳恢复 → 落盘
                let fz = freeze.take().expect("freeze checked Some");
                finalize(&inner, fz, false);
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

fn make_sample(sys: &mut System, probe: &ProbeState, hwnd: &AtomicIsize) -> FreezeSample {
    FreezeSample {
        t: report::epoch_ms(),
        processes: sample_processes(sys),
        main_thread: MainThreadProbe {
            pending: probe.pending.load(Ordering::Relaxed),
            last_latency_ms: probe.last_latency_us.load(Ordering::Relaxed) as f64 / 1000.0,
        },
        is_hung_window: is_hung_window(hwnd.load(Ordering::Relaxed)),
    }
}

/// aide 主进程 + 全部后代进程（WebView2 渲染进程、node sidecar、git…）的 CPU/内存。
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
    let mut out: Vec<ProcessSample> = sys
        .processes()
        .iter()
        .filter(|(pid, _)| family.contains(&pid.as_u32()))
        .map(|(pid, p)| ProcessSample {
            pid: pid.as_u32(),
            name: p.name().to_string_lossy().into_owned(),
            cpu: p.cpu_usage(),
            mem: p.memory(),
        })
        .collect();
    out.sort_by(|a, b| b.cpu.total_cmp(&a.cpu));
    out
}

fn finalize(inner: &DiagInner, fz: ActiveFreeze, suspected_sleep: bool) {
    let ended = report::epoch_ms();
    let report = FreezeReport {
        meta: ReportMeta::current(),
        freeze: FreezeInfo {
            started: fz.started_epoch,
            ended,
            duration_ms: ended.saturating_sub(fz.started_epoch),
            detected_gap_ms: fz.detected_gap_ms,
            suspected_sleep,
        },
        samples: fz.samples,
        ring: RingSnapshot {
            heartbeats: inner.heartbeats.lock().unwrap().to_vec(),
            event_rates: inner.event_rates.lock().unwrap().snapshot(),
        },
        frontend: None,
    };
    let dir = crate::commands::our_config_dir().join("diagnostics");
    match report::write_report(&dir, &report) {
        Ok(path) => {
            tracing::warn!(
                "diag: freeze report written ({}ms): {}",
                report.freeze.duration_ms,
                path.display()
            );
            *inner.last_report.lock().unwrap() = Some((path, Instant::now()));
        }
        Err(e) => tracing::error!("diag: failed to write freeze report: {e}"),
    }
}

/// 主窗口 HWND（Windows 判「未响应」用）。在主线程解析一次，存成整数共享。
fn resolve_hwnd(app: &AppHandle) -> Arc<AtomicIsize> {
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

/// Windows：问操作系统这个窗口是否已被判定「未响应」（≥5s 不处理消息）。
/// 与我们自己的心跳判定互相印证。
#[cfg(windows)]
fn is_hung_window(hwnd: isize) -> Option<bool> {
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
fn is_hung_window(_hwnd: isize) -> Option<bool> {
    None
}
