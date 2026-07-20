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

use std::ffi::c_void;
use std::sync::OnceLock;

#[cfg(all(windows, target_arch = "x86_64"))]
use windows::core::PCWSTR;
#[cfg(all(windows, target_arch = "x86_64"))]
use windows::Win32::Foundation::{CloseHandle, HANDLE, HMODULE};
#[cfg(all(windows, target_arch = "x86_64"))]
use windows::Win32::System::Diagnostics::Debug::{
    ADDRESS64, AddrModeFlat, CONTEXT, CONTEXT_FULL_AMD64, STACKFRAME64, SYMOPT_DEFERRED_LOADS,
    SYMOPT_UNDNAME, StackWalk64, GetThreadContext, SymInitializeW, SymSetOptions,
};
#[cfg(all(windows, target_arch = "x86_64"))]
use windows::Win32::System::ProcessStatus::GetModuleFileNameExW;
#[cfg(all(windows, target_arch = "x86_64"))]
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenThread, ResumeThread, SuspendThread, THREAD_ACCESS_RIGHTS,
    THREAD_GET_CONTEXT, THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
};

/// 调用链中的一帧：模块 basename + 绝对地址 + 相对模块基址偏移。
#[derive(Clone)]
pub struct StackFrame {
    pub module: Option<String>,
    pub address: u64,
    pub offset: u64,
}

/// 抓到的主线程顶帧。模块/偏移用于报告 `mainThread.park`。
/// `frames` 为完整调用链（顶帧在前），仅 `walk_full=true` 时填充；空表示该帧只抓了顶帧。
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
    let mut frames = if walk_full { vec![top.clone()] } else { Vec::new() };

    if walk_full {
        // StackWalk64 初态从 CONTEXT 构造：PC/Stack/Frame 分别对应 Rip/Rsp/Rbp。
        // AddrModeFlat = 64 位平坦地址空间。后续每调一次返回上一帧（调用者）。
        let mut sf = STACKFRAME64 {
            AddrPC: ADDRESS64 { Offset: ctx.Rip, Segment: 0, Mode: AddrModeFlat },
            AddrStack: ADDRESS64 { Offset: ctx.Rsp, Segment: 0, Mode: AddrModeFlat },
            AddrFrame: ADDRESS64 { Offset: ctx.Rbp, Segment: 0, Mode: AddrModeFlat },
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