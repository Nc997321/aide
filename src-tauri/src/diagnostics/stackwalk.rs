//! 冻结期跨线程抓主线程 native 顶帧。
//!
//! watchdog 在冻结采样帧调用 `capture_main_thread_park(main_tid, walk_full)`：
//! SuspendThread → GetThreadContext → 读 Rip → SymGetModuleBase64 +
//! GetModuleFileNameExW 解析模块名 → ResumeThread。返回主线程当前停在「哪个模块 +
//! 偏移」——这是「主线程 park 在哪一帧」的关键判据，专治 `stuck_command` 看不到的
//! 框架路径（emit 投递、事件循环、锁、系统调用）：
//! - `msedgewebview2.dll` / WebView2 运行时 → 卡在 `ExecuteScript`/COM 等 WebView2 内部；
//! - `aide.exe` → 卡在 tao/wry/tauri（编译进宿主）的代码里；
//! - `ntdll.dll` / `kernelbase.dll` → 系统调用等待（锁/IO/事件）。
//!
//! `walk_full=true` 时进一步用 `StackWalk64` 走完整调用链（顶帧 + 最多 32 帧），
//! 每帧解析 module+offset。park 期间栈静态不变，所以只在冻结首帧走全栈，其余帧只
//! 抓顶帧——既拿到完整调用链点名（如 `ntdll → kernelbase → aide.exe(+offset) →
//! msedgewebview2.dll`），又不让报告随采样帧数线性膨胀。
//!
//! 仅 Windows x64。整段 unsafe 隔离，每步 fallible（返回值校验 / `.ok()?`），
//! **绝不 panic**，挂起仅 µs 级且保证 ResumeThread。
//!
//! 安全性：SuspendThread + GetThreadContext + ResumeThread 是跨线程抓栈的标准做法，
//! 对已 park 的线程短暂挂起不改变其状态；watchdog 是独立线程，挂起主线程不影响自己。
//! dbghelp 符号 API 非线程安全——只从 watchdog 单线程调用，不与主线程竞争。

// 非 Windows / 非 x64：watchdog 调用拿不到任何栈，返回 None 即可。
#![cfg_attr(all(windows, target_arch = "x86_64"), allow(unused))]

#[cfg(all(windows, target_arch = "x86_64"))]
use std::ffi::c_void;
#[cfg(all(windows, target_arch = "x86_64"))]
use std::sync::OnceLock;

#[cfg(all(windows, target_arch = "x86_64"))]
use windows::core::PCWSTR;
#[cfg(all(windows, target_arch = "x86_64"))]
use windows::Win32::Foundation::{CloseHandle, HANDLE, HMODULE};
#[cfg(all(windows, target_arch = "x86_64"))]
use windows::Win32::System::Diagnostics::Debug::{
    AddrModeFlat, GetThreadContext, StackWalk64, SymCleanup, SymInitializeW, SymSetOptions,
    ADDRESS64, CONTEXT, CONTEXT_FULL_AMD64, STACKFRAME64, SYMOPT_DEFERRED_LOADS, SYMOPT_UNDNAME,
};
#[cfg(all(windows, target_arch = "x86_64"))]
use windows::Win32::System::ProcessStatus::GetModuleFileNameExW;
#[cfg(all(windows, target_arch = "x86_64"))]
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenThread, ResumeThread, SuspendThread, PROCESS_ACCESS_RIGHTS,
    PROCESS_QUERY_INFORMATION, PROCESS_VM_READ, THREAD_ACCESS_RIGHTS, THREAD_GET_CONTEXT,
    THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
};

/// 调用链中的一帧：模块 basename + 绝对地址 + 相对模块基址偏移。
#[derive(Clone, Debug)]
pub struct StackFrame {
    pub module: Option<String>,
    pub address: u64,
    pub offset: u64,
}

/// 抓到的主线程顶帧。模块/偏移用于报告 `mainThread.park`。
/// `frames` 为完整调用链（顶帧在前），仅 `walk_full=true` 时填充；空表示该帧只抓了顶帧。
#[derive(Debug)]
pub struct ParkFrame {
    pub module: Option<String>,
    pub address: u64,
    pub module_base: u64,
    pub offset: u64,
    pub frames: Vec<StackFrame>,
}

#[cfg(all(windows, target_arch = "x86_64"))]
static SYM_INIT: OnceLock<()> = OnceLock::new();

/// x64 机器类型常量（StackWalk64 的 MachineType 参数）。
/// 值 = dbghelp 的 `IMAGE_FILE_MACHINE_AMD64`（0x8664）。
#[cfg(all(windows, target_arch = "x86_64"))]
const IMAGE_FILE_MACHINE_AMD64: u32 = 0x8664;

// dbghelp 的两个回调需以 `extern "system"` ABI 直接传给 StackWalk64（windows crate
// 把它们包成 Rust ABI 的 unsafe fn，不匹配回调类型 PFUNCTION_TABLE_ACCESS_ROUTINE64 /
// PGET_MODULE_BASE_ROUTINE64）。直接 extern 声明保证 ABI 一致；同时 resolve_frame
// 复用 SymGetModuleBase64（同一 dbghelp 导出）。
#[cfg(all(windows, target_arch = "x86_64"))]
#[link(name = "dbghelp")]
extern "system" {
    fn SymFunctionTableAccess64(hprocess: HANDLE, dwaddr: u64) -> *mut c_void;
    fn SymGetModuleBase64(hprocess: HANDLE, dwaddr: u64) -> u64;
}

/// 抓主线程当前停在哪一帧。失败返回 None——绝不抛、绝不 panic。
/// watchdog 传入启动时在主线程记下的 TID。`walk_full=true` 用 StackWalk64 走完整
/// 调用链（最多 32 帧）；false 只抓顶帧。
#[cfg(not(all(windows, target_arch = "x86_64")))]
pub fn capture_main_thread_park(_main_tid: u32, _walk_full: bool) -> Option<ParkFrame> {
    None
}

#[cfg(all(windows, target_arch = "x86_64"))]
pub fn capture_main_thread_park(main_tid: u32, walk_full: bool) -> Option<ParkFrame> {
    unsafe {
        ensure_sym_init();
        // SUSPEND_RESUME(2) | GET_CONTEXT(8) | QUERY_LIMITED_INFORMATION(2048) —— 不依赖
        // BitOr trait，直接 OR 内层 u32 再包回 THREAD_ACCESS_RIGHTS。
        let access = THREAD_ACCESS_RIGHTS(
            THREAD_SUSPEND_RESUME.0 | THREAD_GET_CONTEXT.0 | THREAD_QUERY_LIMITED_INFORMATION.0,
        );
        let h = OpenThread(access, false, main_tid).ok()?;
        // 挂起 → 读上下文 → 立刻恢复（即便后续解析失败也保证 ResumeThread 跑到）。
        let prev = SuspendThread(h);
        let result = if prev != u32::MAX {
            let mut ctx = CONTEXT::default();
            ctx.ContextFlags = CONTEXT_FULL_AMD64;
            park_frame_inner(h, &mut ctx, walk_full)
        } else {
            None
        };
        let _ = ResumeThread(h);
        let _ = CloseHandle(h);
        result
    }
}

#[cfg(all(windows, target_arch = "x86_64"))]
unsafe fn ensure_sym_init() {
    SYM_INIT.get_or_init(|| {
        // SymSetOptions 应在 SymInitialize 前调：延后加载 + 不修饰符号名。
        let _ = SymSetOptions(SYMOPT_DEFERRED_LOADS | SYMOPT_UNDNAME);
        // fInvadeProcess=true 预加载本进程模块表，SymGetModuleBase64 才能给基址。
        // 用宽版 SymInitializeW + PCWSTR（SymInitialize 是 ANSI 版，要 PCSTR）。
        // 失败不致命：模块名走 GetModuleFileNameExW 兜底，顶帧仍能解析。
        let _ = SymInitializeW(GetCurrentProcess(), PCWSTR::null(), true);
    });
}

#[cfg(all(windows, target_arch = "x86_64"))]
unsafe fn park_frame_inner(h: HANDLE, ctx: &mut CONTEXT, walk_full: bool) -> Option<ParkFrame> {
    GetThreadContext(h, ctx as *mut CONTEXT).ok()?;
    let rip = ctx.Rip;
    if rip == 0 {
        return None;
    }
    let proc = GetCurrentProcess();
    let (top, base) = resolve_frame(proc, rip);
    let mut frames = if walk_full {
        vec![top.clone()]
    } else {
        Vec::new()
    };

    if walk_full {
        // StackWalk64 初态从 CONTEXT 构造：PC/Stack/Frame 分别对应 Rip/Rsp/Rbp。
        // AddrModeFlat = 64 位平坦地址空间。后续每调一次返回上一帧（调用者）。
        let mut sf = STACKFRAME64 {
            AddrPC: ADDRESS64 {
                Offset: ctx.Rip,
                Segment: 0,
                Mode: AddrModeFlat,
            },
            AddrStack: ADDRESS64 {
                Offset: ctx.Rsp,
                Segment: 0,
                Mode: AddrModeFlat,
            },
            AddrFrame: ADDRESS64 {
                Offset: ctx.Rbp,
                Segment: 0,
                Mode: AddrModeFlat,
            },
            ..Default::default()
        };
        const MAX_FRAMES: usize = 32;
        while frames.len() < MAX_FRAMES {
            let ok = StackWalk64(
                IMAGE_FILE_MACHINE_AMD64,
                proc,
                h,
                &mut sf,
                ctx as *mut CONTEXT as *mut c_void,
                None, // 读内存回调：None → 默认处理读当前进程
                Some(SymFunctionTableAccess64),
                Some(SymGetModuleBase64),
                None, // 第 9 参数（枚举回调上下文）不使用
            );
            if !ok.as_bool() {
                break;
            }
            let ip = sf.AddrPC.Offset;
            // ip=0 或与上一帧相同 = 走到尽头 / 解不出新帧，停止避免死循环。
            if ip == 0 || frames.last().is_some_and(|f| f.address == ip) {
                break;
            }
            let (fr, _) = resolve_frame(proc, ip);
            frames.push(fr);
        }
    }

    Some(ParkFrame {
        module: top.module,
        address: rip,
        module_base: base,
        offset: if base != 0 { rip - base } else { 0 },
        frames,
    })
}

/// 目标进程的符号会话 + 进程句柄——跨进程抓顶帧用（渲染进程那个「谁在烧 CPU」）。
///
/// 为什么要有它：JS 侧探针（LoAF / longtask）都靠渲染主线程**自己的回调**把数据
/// 取出来，而冻结最严重时它恰恰跑不动——实测 8.2 秒窗口里 50 个长任务只喂到 2 条
/// 帧；用户强杀不恢复的冻结更是一条都拿不到。这条路径从宿主进程侧采样，不需要
/// 渲染进程配合。
///
/// `SymInitialize` 要求「每个进程句柄各自初始化一次」，所以会话与句柄同生命周期：
/// 一场冻结开一次（watchdog 持有），冻结收尾 Drop → SymCleanup + CloseHandle。
/// 只抓顶帧、不跑 StackWalk64 全栈：顶帧的模块名就足以把 V8 / Blink / 合成光栅 /
/// 系统调用等待分开，而跨进程走全栈要多一套内存读回调与函数表访问——收益不抵复杂度。
#[cfg(all(windows, target_arch = "x86_64"))]
pub struct ForeignProc {
    h: HANDLE,
    pid: u32,
}

/// 非 Windows / 非 x64：没有进程句柄这回事（`HANDLE` 是 Windows 类型，不能出现在这里），
/// `open` 恒返回 None，结构体永远不会被构造。
#[cfg(not(all(windows, target_arch = "x86_64")))]
pub struct ForeignProc {
    pid: u32,
}

#[cfg(not(all(windows, target_arch = "x86_64")))]
impl ForeignProc {
    pub fn open(_pid: u32) -> Option<Self> {
        None
    }
    pub fn pid(&self) -> u32 {
        self.pid
    }
    pub fn top_frame(&self, _tid: u32) -> Option<ParkFrame> {
        None
    }
}

#[cfg(all(windows, target_arch = "x86_64"))]
impl ForeignProc {
    /// 打开目标进程并为其建立 dbghelp 会话。失败（权限/进程已退）返回 None。
    pub fn open(pid: u32) -> Option<Self> {
        unsafe {
            // GetModuleFileNameExW 与 dbghelp 读目标进程内存都需要 VM_READ；
            // 同用户同完整性级别下必然成功，跨完整性（提权进程）会失败 → 降级 None。
            let access = PROCESS_ACCESS_RIGHTS(PROCESS_QUERY_INFORMATION.0 | PROCESS_VM_READ.0);
            let h = OpenProcess(access, false, pid).ok()?;
            // 初始化失败不致命：模块名走 GetModuleFileNameExW 兜底，顶帧仍可解析。
            let _ = SymInitializeW(h, PCWSTR::null(), true);
            Some(Self { h, pid })
        }
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// 抓某线程当前顶帧（模块 basename + 偏移）。挂起 µs 级、必 Resume。
    /// 失败（线程已退/权限不足）返回 None，绝不 panic。
    pub fn top_frame(&self, tid: u32) -> Option<ParkFrame> {
        unsafe {
            let access = THREAD_ACCESS_RIGHTS(
                THREAD_SUSPEND_RESUME.0 | THREAD_GET_CONTEXT.0 | THREAD_QUERY_LIMITED_INFORMATION.0,
            );
            let h = OpenThread(access, false, tid).ok()?;
            let prev = SuspendThread(h);
            let result = if prev != u32::MAX {
                let mut ctx = CONTEXT::default();
                ctx.ContextFlags = CONTEXT_FULL_AMD64;
                if GetThreadContext(h, &mut ctx as *mut CONTEXT).is_ok() && ctx.Rip != 0 {
                    let (top, base) = resolve_frame(self.h, ctx.Rip);
                    Some(ParkFrame {
                        module: top.module,
                        address: ctx.Rip,
                        module_base: base,
                        offset: if base != 0 { ctx.Rip - base } else { 0 },
                        // 跨进程不走全栈（见类型注释），顶帧就够分类
                        frames: Vec::new(),
                    })
                } else {
                    None
                }
            } else {
                None
            };
            let _ = ResumeThread(h);
            let _ = CloseHandle(h);
            result
        }
    }
}

#[cfg(all(windows, target_arch = "x86_64"))]
impl Drop for ForeignProc {
    fn drop(&mut self) {
        unsafe {
            let _ = SymCleanup(self.h);
            let _ = CloseHandle(self.h);
        }
    }
}

/// 解析一帧：模块 basename + 偏移。返回 (StackFrame, module_base)——base 供顶帧
/// 填 ParkFrame.module_base 用。模块名走 GetModuleFileNameExW（取 basename）。
#[cfg(all(windows, target_arch = "x86_64"))]
unsafe fn resolve_frame(proc: HANDLE, rip: u64) -> (StackFrame, u64) {
    let base = SymGetModuleBase64(proc, rip);
    let module = if base != 0 {
        let mut buf = [0u16; 260];
        let n = GetModuleFileNameExW(Some(proc), Some(HMODULE(base as *mut c_void)), &mut buf);
        if n > 0 {
            let path = String::from_utf16_lossy(&buf[..n as usize]);
            // 取 basename（去目录），如 `msedgewebview2.dll`
            path.rsplit(['\\', '/']).next().map(|s| s.to_string())
        } else {
            None
        }
    } else {
        None
    };
    (
        StackFrame {
            module,
            address: rip,
            offset: if base != 0 { rip - base } else { 0 },
        },
        base,
    )
}
