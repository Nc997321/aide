//! 渲染进程线程采样：冻结期回答「渲染进程里**哪个线程**在烧 CPU、它停在哪个模块」。
//!
//! 为什么需要（2026-09-17 复盘 freeze-1789629633117）：JS 侧探针（LoAF / longtask）
//! 都靠渲染主线程**自己的回调**把数据取出来，而冻结最严重时它恰恰跑不动——实测
//! 8.2 秒窗口里 50 个长任务只喂到 2 条帧（另外 47 条在补交发出之后才落进 ring），
//! 用户强杀不恢复的冻结更是一条都拿不到。本模块从**宿主进程**侧采样，不需要渲染
//! 进程配合：
//!   CreateToolhelp32Snapshot 枚举目标进程线程
//!   → GetThreadTimes 取每线程累计 CPU（跨帧差分得「谁在烧」）
//!   → SuspendThread/GetThreadContext 抓最烧那几条的顶帧（模块名 + 偏移）。
//!
//! 判读（模块名就够分类）：主线程烧满且停在 `msedge.dll`/`v8.dll` = 我们自己的
//! JS/样式布局；停在合成/光栅相关模块 = 绘制路径；全线程 park 在 `ntdll` = 它在等
//! 别人（那这次冻结不在渲染进程里）。
//!
//! 边界：只读系统状态；一切失败返回 None/空，绝不 panic、绝不抛——诊断永不影响业务。

use std::collections::HashMap;
use std::time::Instant;

use super::report::{ParkFrameRecord, ProcessSample, RendererProbe, ThreadSample};
use super::stackwalk::ForeignProc;

/// WebView2 的进程名：渲染 / GPU / 浏览器进程都叫它，靠 CPU 挑最忙那个。
const WEBVIEW_NAME: &str = "msedgewebview2.exe";
/// 进报告的线程数上限（按 CPU 降序）——报告体积要有界。
const MAX_THREADS: usize = 8;
/// 抓顶帧的线程数上限（比 MAX_THREADS 更严）：挂起线程有代价，只点最烧的几条。
const MAX_FRAMES: usize = 4;

/// 一场冻结期间复用的采样器：持有跨样本状态（线程 CPU 基线 + 目标进程符号会话）。
/// watchdog 起冻结时新建、收尾即 Drop（ForeignProc 的 Drop 关句柄、清符号会话）。
pub struct RendererSampler {
    /// tid → 上次累计 CPU（user+kernel，100ns）——差分用
    prev_cpu: HashMap<u32, u64>,
    /// 上次采样的墙钟时刻：CPU 增量换算成百分比的分母
    prev_wall: Option<Instant>,
    /// 目标进程（最忙的 webview）+ 其符号会话；pid 变了（渲染进程重启）就重开
    foreign: Option<ForeignProc>,
}

impl Default for RendererSampler {
    fn default() -> Self {
        Self::new()
    }
}

impl RendererSampler {
    pub fn new() -> Self {
        Self {
            prev_cpu: HashMap::new(),
            prev_wall: None,
            foreign: None,
        }
    }

    /// 采一帧：挑最忙的 webview → 枚举线程 → 每线程 CPU → 最烧的几条抓顶帧。
    /// `candidates` 是 watchdog 本帧已按 CPU 降序排过的进程列表；没有 webview
    /// 进程（已退出）返回 None。
    pub fn sample(&mut self, candidates: &[ProcessSample]) -> Option<RendererProbe> {
        let target = candidates
            .iter()
            .filter(|p| p.name.eq_ignore_ascii_case(WEBVIEW_NAME))
            .max_by(|a, b| a.cpu.total_cmp(&b.cpu))?;
        if self.foreign.as_ref().map(|f| f.pid()) != Some(target.pid) {
            // 换进程（渲染进程崩溃重启）：旧会话作废，CPU 基线重来
            self.foreign = ForeignProc::open(target.pid);
            self.prev_cpu.clear();
            self.prev_wall = None;
        }
        let tids = enum_threads(target.pid);
        if tids.is_empty() {
            return None;
        }
        let now = Instant::now();
        let mut threads: Vec<ThreadSample> = tids
            .iter()
            .filter_map(|tid| self.measure(*tid, now))
            .collect();
        // 降序：正在烧的在前。首帧无基线（cpu_pct 全 0）时按累计 CPU 排，别把真正
        // 忙的线程挤出名单；次键 tid 保证同值时顺序稳定（报告可比）。
        threads.sort_by(|a, b| {
            b.cpu_pct
                .total_cmp(&a.cpu_pct)
                .then((b.user_ms + b.kernel_ms).cmp(&(a.user_ms + a.kernel_ms)))
                .then(a.tid.cmp(&b.tid))
        });
        threads.truncate(MAX_THREADS);
        if let Some(f) = self.foreign.as_ref() {
            for t in threads.iter_mut().take(MAX_FRAMES) {
                t.park = f.top_frame(t.tid).map(ParkFrameRecord::from);
            }
        }
        // 已消失线程的基线清掉，防 map 随冻结时长无界增长
        self.prev_cpu.retain(|tid, _| tids.contains(tid));
        self.prev_wall = Some(now);
        Some(RendererProbe {
            pid: target.pid,
            name: target.name.clone(),
            threads,
        })
    }

    /// 单线程 CPU：累计值换算成本帧增量速率。首次见到该线程无基线 → cpu_pct = 0，
    /// user/kernel 给出**累计值**（读的人跨帧加减即得冻结期消耗，语义见 DTO 注释）。
    fn measure(&mut self, tid: u32, now: Instant) -> Option<ThreadSample> {
        let (user_100ns, kernel_100ns) = thread_cpu_100ns(tid)?;
        let prev_total = self.prev_cpu.insert(tid, user_100ns + kernel_100ns);
        let cpu_pct = match (prev_total, self.prev_wall) {
            (Some(prev), Some(prev_wall)) => {
                let wall_ms = now.duration_since(prev_wall).as_secs_f64() * 1000.0;
                if wall_ms > 0.0 {
                    let busy_ms = (user_100ns + kernel_100ns).saturating_sub(prev) as f64 / 10_000.0;
                    (busy_ms / wall_ms * 100.0) as f32
                } else {
                    0.0
                }
            }
            _ => 0.0,
        };
        Some(ThreadSample {
            tid,
            user_ms: user_100ns / 10_000,
            kernel_ms: kernel_100ns / 10_000,
            cpu_pct,
            park: None,
        })
    }
}

/// 目标进程的全部线程 id。快照失败/进程已退 → 空表。
#[cfg(all(windows, target_arch = "x86_64"))]
fn enum_threads(pid: u32) -> Vec<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    let mut out = Vec::new();
    unsafe {
        // SNAPTHREAD 快照是全系统的（pid 参数无意义，传 0），下面按 owner 过滤。
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) else {
            return out;
        };
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut ok = Thread32First(snap, &mut entry).is_ok();
        while ok {
            if entry.th32OwnerProcessID == pid {
                out.push(entry.th32ThreadID);
            }
            ok = Thread32Next(snap, &mut entry).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    out
}

#[cfg(not(all(windows, target_arch = "x86_64")))]
fn enum_threads(_pid: u32) -> Vec<u32> {
    Vec::new()
}

/// 某线程的累计 user/kernel CPU 时间（100ns 单位）。取不到 → None。
#[cfg(all(windows, target_arch = "x86_64"))]
fn thread_cpu_100ns(tid: u32) -> Option<(u64, u64)> {
    use windows::Win32::Foundation::{CloseHandle, FILETIME};
    use windows::Win32::System::Threading::{
        GetThreadTimes, OpenThread, THREAD_QUERY_INFORMATION, THREAD_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        // GetThreadTimes 要 QUERY_INFORMATION；个别受保护线程只给 LIMITED，退一步再试。
        let h = OpenThread(THREAD_QUERY_INFORMATION, false, tid)
            .or_else(|_| OpenThread(THREAD_QUERY_LIMITED_INFORMATION, false, tid))
            .ok()?;
        let (mut creation, mut exit, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        let ok = GetThreadTimes(h, &mut creation, &mut exit, &mut kernel, &mut user).is_ok();
        let _ = CloseHandle(h);
        if !ok {
            return None;
        }
        let to_u64 = |ft: FILETIME| ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64;
        Some((to_u64(user), to_u64(kernel)))
    }
}

#[cfg(not(all(windows, target_arch = "x86_64")))]
fn thread_cpu_100ns(_tid: u32) -> Option<(u64, u64)> {
    None
}

#[cfg(all(test, windows, target_arch = "x86_64"))]
mod tests {
    use super::*;

    /// Toolhelp 枚举 + 每线程 CPU 的管路验证：拿本进程实测（不需要 WebView2）。
    /// 这两步是渲染采样的地基——它们错了，报告里的线程表就是空的或全 0。
    #[test]
    fn enum_and_cpu_of_own_threads() {
        let me = std::process::id();
        let tids = enum_threads(me);
        assert!(!tids.is_empty(), "本进程至少应枚举出一个线程");
        let my_tid = unsafe { windows::Win32::System::Threading::GetCurrentThreadId() };
        assert!(
            tids.contains(&my_tid),
            "枚举结果必须含当前线程 tid={my_tid}（拿到的是 {tids:?}）"
        );

        let before = thread_cpu_100ns(my_tid).expect("当前线程的 CPU 时间必须可读");
        let t0 = Instant::now();
        let mut spin = 0u64;
        while t0.elapsed().as_millis() < 30 {
            spin = spin.wrapping_add(1);
        }
        assert!(spin > 0, "忙等应至少跑一轮");
        let after = thread_cpu_100ns(my_tid).expect("当前线程的 CPU 时间必须可读");
        assert!(
            after.0 + after.1 >= before.0 + before.1,
            "累计 CPU 时间不得回退：{before:?} → {after:?}"
        );
    }

    /// 跨进程抓渲染进程顶帧（真机集成用例）：本机有 msedgewebview2 进程就跑真活，
    /// 没有就**响亮地**跳过——不让它悄悄变绿。渲染进程线程枚举不需要特殊权限（一定
    /// 断言）；打开句柄/抓栈需要同完整性级别，跨用户场景会失败 → 打警告后跳过。
    #[test]
    fn foreign_top_frame_on_live_webview() {
        let mut sys = sysinfo::System::new_all();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let busiest = sys
            .processes()
            .iter()
            .filter(|(_, p)| p.name().to_string_lossy().eq_ignore_ascii_case(WEBVIEW_NAME))
            .max_by(|a, b| a.1.cpu_usage().total_cmp(&b.1.cpu_usage()))
            .map(|(pid, p)| (pid.as_u32(), p.cpu_usage()));
        let Some((pid, cpu)) = busiest else {
            eprintln!("⚠ 跳过：本机没有 msedgewebview2.exe（需要运行中的 WebView2 应用）");
            return;
        };

        let tids = enum_threads(pid);
        assert!(!tids.is_empty(), "webview 进程 {pid} 必须能枚举出线程");

        let Some(proc) = ForeignProc::open(pid) else {
            eprintln!("⚠ 跳过：打不开 webview 进程 {pid}（不同完整性级别？）");
            return;
        };
        let frames: Vec<_> = tids.iter().filter_map(|t| proc.top_frame(*t)).collect();
        assert!(
            !frames.is_empty(),
            "至少应抓到一个线程的顶帧（pid={pid} cpu={cpu:.1}% 线程数={}）",
            tids.len()
        );
        assert!(
            frames.iter().any(|f| f.module.is_some()),
            "顶帧至少要有一个能解析出模块名：{frames:?}"
        );
    }
}
