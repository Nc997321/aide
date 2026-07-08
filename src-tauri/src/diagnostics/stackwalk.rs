//! 冻结期跨线程抓主线程 native 顶帧。
//!
//! watchdog 在冻结采样帧调用 `capture_main_thread_park(main_tid)`：SuspendThread
//! → GetThreadContext → 读 Rip → SymGetModuleBase64 + GetModuleFileNameExW 解析
//! 模块名 → ResumeThread。返回主线程当前停在「哪个模块 + 偏移」——这是「主线程
//! park 在哪一帧」的关键判据，专治 `stuck_command` 看不到的框架路径（emit 投递、
//! 事件循环、锁、系统调用）：
//! - `msedgewebview2.dll` / WebView2 运行时 → 卡在 `ExecuteScript`/COM 等 WebView2 内部；
//! - `aide.exe` → 卡在 tao/wry/tauri（编译进宿主）的代码里；
//! - `ntdll.dll` / `kernelbase.dll` → 系统调用等待（锁/IO/事件）。
//!
//! 仅 Windows x64。整段 unsafe 隔离，每步 fallible（返回值校验 / `.ok()?`），
//! **绝不 panic**，挂起仅 µs 级且保证 ResumeThread。当前为最小版（仅顶帧）；
//! 如顶帧不足以定位，再迭代加 StackWalk64 走调用链。
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
    CONTEXT, CONTEXT_FULL_AMD64, SYMOPT_DEFERRED_LOADS, SYMOPT_UNDNAME, GetThreadContext,
    SymGetModuleBase64, SymInitializeW, SymSetOptions,
};
#[cfg(all(windows, target_arch = "x86_64"))]
use windows::Win32::System::ProcessStatus::GetModuleFileNameExW;
#[cfg(all(windows, target_arch = "x86_64"))]
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenThread, ResumeThread, SuspendThread, THREAD_ACCESS_RIGHTS,
    THREAD_GET_CONTEXT, THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
};

/// 抓到的主线程顶帧。模块/偏移用于报告 `mainThread.park`。
pub struct ParkFrame {
    pub module: Option<String>,
    pub address: u64,
    pub module_base: u64,
    pub offset: u64,
}

#[cfg(all(windows, target_arch = "x86_64"))]
static SYM_INIT: OnceLock<()> = OnceLock::new();

/// 抓主线程当前停在哪一帧。失败返回 None——绝不抛、绝不 panic。
/// watchdog 传入启动时在主线程记下的 TID。
#[cfg(not(all(windows, target_arch = "x86_64")))]
pub fn capture_main_thread_park(_main_tid: u32) -> Option<ParkFrame> {
    None
}

#[cfg(all(windows, target_arch = "x86_64"))]
pub fn capture_main_thread_park(main_tid: u32) -> Option<ParkFrame> {
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
            park_frame_inner(h, &mut ctx)
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
unsafe fn park_frame_inner(h: HANDLE, ctx: &mut CONTEXT) -> Option<ParkFrame> {
    GetThreadContext(h, ctx as *mut CONTEXT).ok()?;
    let rip = ctx.Rip;
    if rip == 0 {
        return None;
    }
    let proc = GetCurrentProcess();
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
    Some(ParkFrame {
        module,
        address: rip,
        module_base: base,
        offset: if base != 0 { rip - base } else { 0 },
    })
}