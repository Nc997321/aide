//! Windows Job Object：让 Agent Runtime 的**整棵进程树**随宿主一起死。
//!
//! 动机（2026-09-17 实锤）：`aide.exe → aide-agent.exe → claude.exe →
//! rust-analyzer / typescript-language-server` 是一条四层链，而 Windows **不会**连带
//! 杀子进程：
//!   - `kill_runtime` 的 `start_kill()` 只终结 sidecar 自己——TerminateProcess 连
//!     sidecar 内部 JS 的收尾钩子都不执行，claude.exe 与它名下的语言服务器整片活下来；
//!   - 主进程被强杀（任务管理器结束任务 / 崩溃）时同理，且下次启动又叠一套新的。
//! 当天实测：三个会话各挂一个 rust-analyzer，合计 ~7.9GB 常驻，其中两个会话根本没人在用。
//!
//! 机制：sidecar 一 spawn 就塞进一个 `KILL_ON_JOB_CLOSE` 的 job，句柄由 aide.exe 持有：
//!   - aide.exe 被杀 → 内核关掉它的全部句柄 → job 关闭 → **整棵树由内核终结**
//!     （没有任何 JS / Drop 代码参与，这正是"强杀也收得干净"的唯一来源）；
//!   - `kill_runtime` → 显式 drop 句柄 → 同上，Runtime 重启不再留旧树；
//!   - 正常退出 → 进程终止时句柄关闭，行为一致。
//!
//! 这层管"父进程没了也得死"；"某条会话被停掉时杀它一个"由 sidecar 侧
//! `subprocessReaper.ts` 负责，两者是不同层次的兜底，都要在。
//!
//! 边界：
//!   - **嵌套 job** 需要 Win8+（本应用基线远高于此）。若宿主自己已在某个 job 里且
//!     不允许嵌套，`AssignProcessToJobObject` 会失败——按降级处理：返回 Err 由调用方
//!     记警告并继续（退回 sidecar 侧收尾兜底），**绝不阻断 Runtime 启动**。
//!   - 只 Windows。unix 侧等价物是 process group + PDEATHSIG，当前未实现（那边的收尾
//!     只覆盖正常退出与信号两路）。

use std::io;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

/// `KILL_ON_JOB_CLOSE` 的 job 句柄。**Drop 即杀**——持有者一放手，job 内所有进程
/// （sidecar 及其全部后代）被内核终结。
pub struct KillOnCloseJob(HANDLE);

// SAFETY: Windows 句柄表属于进程、不属于线程，句柄本身跨线程使用是内核保证的；
// 本类型的唯一操作是 Drop 里的 CloseHandle，调用方用 Mutex 串行化取放。
unsafe impl Send for KillOnCloseJob {}
unsafe impl Sync for KillOnCloseJob {}

impl KillOnCloseJob {
    /// 新建 job 并把 `process`（sidecar 进程句柄）塞进去。
    /// 任何一步失败都返回 Err（调用方降级：记警告、照常跑）。
    pub fn assign(process: HANDLE) -> io::Result<Self> {
        // SAFETY: 三个调用都是 kernel32 的稳定 API，参数按签名给出；job 句柄在任一步
        // 失败时立即关闭（不留半成品），成功时移交给 Self 独占持有。
        unsafe {
            let job = CreateJobObjectW(None, None).map_err(to_io)?;
            if let Err(e) = set_kill_on_close(job) {
                let _ = CloseHandle(job);
                return Err(e);
            }
            if let Err(e) = AssignProcessToJobObject(job, process) {
                let _ = CloseHandle(job);
                return Err(to_io(e));
            }
            Ok(Self(job))
        }
    }
}

/// 给 job 打上 "最后一个句柄关闭时杀光 job 内进程" 的限制。
unsafe fn set_kill_on_close(job: HANDLE) -> io::Result<()> {
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            std::ptr::addr_of!(info).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .map_err(to_io)
    }
}

impl Drop for KillOnCloseJob {
    fn drop(&mut self) {
        // SAFETY: 句柄由 Self 独占持有，且只在这里关闭一次。
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn to_io(e: windows::core::Error) -> io::Error {
    io::Error::new(io::ErrorKind::Other, e.to_string())
}
