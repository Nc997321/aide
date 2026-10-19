//! 顶层窗口：枚举、信息、前台切换、遮挡判断、权限级别。

use std::collections::HashMap;
use std::ffi::c_void;

use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel, TOKEN_MANDATORY_LABEL,
    TOKEN_QUERY,
};
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentProcess, GetCurrentThreadId, OpenProcess, OpenProcessToken,
    QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_MENU,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumWindows, GetAncestor, GetClassNameW, GetForegroundWindow, GetWindowLongPtrW,
    GetWindowRect, GetWindowThreadProcessId, InternalGetWindowText, IsIconic, IsWindow,
    IsWindowVisible, PostMessageW, SetForegroundWindow, ShowWindow, WindowFromPoint, GA_ROOT, GWL_EXSTYLE,
    SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE, WM_CLOSE, WS_EX_TOOLWINDOW,
};

use super::guard::OVERLAY_CLASS;
use crate::model::{Rect, WindowAction, WindowInfo};
use crate::port::Res;

pub fn hwnd_of(id: &str) -> Res<HWND> {
    let hex = id.trim().trim_start_matches("0x").trim_start_matches("0X");
    let raw = usize::from_str_radix(hex, 16).map_err(|_| format!("`{id}` is not a window id from computer_windows"))?;
    let hwnd = HWND(raw as *mut c_void);
    if unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        Ok(hwnd)
    } else {
        Err(format!("Window {id} no longer exists. Call computer_windows to see what is open."))
    }
}

pub fn id_of(hwnd: HWND) -> String {
    format!("0x{:X}", hwnd.0 as usize)
}

/// 窗口标题。用 `InternalGetWindowText`：它直接读系统里存的标题、不给目标窗口发消息——
/// `GetWindowText` 对**本进程**的窗口会发 WM_GETTEXT，Aide 读自己的窗口时界面线程一忙就卡住。
pub fn title(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let n = unsafe { InternalGetWindowText(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

pub fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

pub fn pid_of(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

/// 窗口可见区域（去掉 Win10/11 的隐形边框）。
pub fn frame(hwnd: HWND) -> Rect {
    let mut r = RECT::default();
    let ok = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut RECT as *mut c_void,
            std::mem::size_of::<RECT>() as u32,
        )
    }
    .is_ok();
    if !ok {
        let _ = unsafe { GetWindowRect(hwnd, &mut r) };
    }
    Rect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top }
}

fn cloaked(hwnd: HWND) -> bool {
    let mut v: u32 = 0;
    unsafe {
        DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut v as *mut u32 as *mut c_void, 4).is_ok() && v != 0
    }
}

/// 进程信息缓存：进程名 + 能否往里输入（按 pid）。
#[derive(Default)]
pub struct Procs {
    cache: HashMap<u32, (String, bool)>,
    own_integrity: Option<u32>,
}

impl Procs {
    pub fn new() -> Self {
        let own = unsafe { integrity_of(GetCurrentProcess()) };
        Self { cache: HashMap::new(), own_integrity: own }
    }

    pub fn info(&mut self, pid: u32) -> (String, bool) {
        if let Some(v) = self.cache.get(&pid) {
            return v.clone();
        }
        let v = unsafe {
            match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                Ok(h) => {
                    let name = image_name(h);
                    let theirs = integrity_of(h);
                    let _ = CloseHandle(h);
                    // 拿不到对方的权限级别（系统 / 受保护进程）一律当作碰不到。
                    let accessible = match (self.own_integrity, theirs) {
                        (Some(o), Some(t)) => t <= o,
                        _ => false,
                    };
                    (name, accessible)
                }
                Err(_) => (String::new(), false),
            }
        };
        if self.cache.len() > 512 {
            self.cache.clear();
        }
        self.cache.insert(pid, v.clone());
        v
    }
}

unsafe fn image_name(h: HANDLE) -> String {
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_err() {
        return String::new();
    }
    let full = String::from_utf16_lossy(&buf[..len as usize]);
    full.rsplit(['\\', '/']).next().unwrap_or_default().to_string()
}

/// 进程的强制完整性级别（UIPI 依据它拦截输入）。
unsafe fn integrity_of(process: HANDLE) -> Option<u32> {
    let mut token = HANDLE::default();
    OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
    let mut needed = 0u32;
    let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut needed);
    let mut buf = vec![0u8; needed.max(64) as usize];
    let ok = GetTokenInformation(
        token,
        TokenIntegrityLevel,
        Some(buf.as_mut_ptr() as *mut c_void),
        buf.len() as u32,
        &mut needed,
    )
    .is_ok();
    let _ = CloseHandle(token);
    if !ok {
        return None;
    }
    let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
    let sid = label.Label.Sid;
    let count = *GetSidSubAuthorityCount(sid);
    if count == 0 {
        return None;
    }
    Some(*GetSidSubAuthority(sid, (count - 1) as u32))
}

pub fn info(procs: &mut Procs, hwnd: HWND) -> WindowInfo {
    let pid = pid_of(hwnd);
    let (process, accessible) = procs.info(pid);
    WindowInfo {
        id: id_of(hwnd),
        title: title(hwnd),
        process,
        pid,
        foreground: unsafe { GetForegroundWindow() } == hwnd,
        minimized: unsafe { IsIconic(hwnd) }.as_bool(),
        accessible,
        bounds: frame(hwnd),
    }
}

unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let out = &mut *(lparam.0 as *mut Vec<HWND>);
    out.push(hwnd);
    BOOL(1)
}

/// 用户看得见的顶层窗口（含对话框）：可见、未被隐藏（cloaked）、有标题、不是工具窗、不是我们自己的提示条。
pub fn list(procs: &mut Procs) -> Vec<WindowInfo> {
    let mut all: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut all as *mut Vec<HWND> as isize));
    }
    all.into_iter()
        .filter(|&h| unsafe { IsWindowVisible(h) }.as_bool())
        .filter(|&h| !cloaked(h))
        .filter(|&h| {
            let ex = unsafe { GetWindowLongPtrW(h, GWL_EXSTYLE) } as u32;
            ex & WS_EX_TOOLWINDOW.0 == 0
        })
        .filter(|&h| class_name(h) != OVERLAY_CLASS)
        .filter(|&h| !title(h).trim().is_empty())
        .filter(|&h| unsafe { IsIconic(h) }.as_bool() || !frame(h).is_empty())
        .map(|h| info(procs, h))
        .collect()
}

pub fn foreground() -> Option<HWND> {
    let h = unsafe { GetForegroundWindow() };
    (!h.0.is_null()).then_some(h)
}

/// 前台是不是这个窗口「一家」的（它自己、它的对话框 / 菜单，或同一进程的别的顶层窗）。
pub fn same_family(a: HWND, b: HWND) -> bool {
    if a == b {
        return true;
    }
    let ra = unsafe { GetAncestor(a, GA_ROOT) };
    let rb = unsafe { GetAncestor(b, GA_ROOT) };
    ra == rb || pid_of(a) == pid_of(b)
}

pub fn bring_to_front(hwnd: HWND) -> Res<()> {
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        if foreground() == Some(hwnd) {
            return Ok(());
        }
        // Windows 限制后台进程抢前台：先挂到当前前台线程的输入队列上再切。
        let fg = GetForegroundWindow();
        let fg_thread = GetWindowThreadProcessId(fg, None);
        let me = GetCurrentThreadId();
        let attached = fg_thread != 0 && fg_thread != me && AttachThreadInput(me, fg_thread, true).as_bool();
        let _ = SetForegroundWindow(hwnd);
        let _ = BringWindowToTop(hwnd);
        if attached {
            let _ = AttachThreadInput(me, fg_thread, false);
        }
        if wait_foreground(hwnd) {
            return Ok(());
        }
        // 兜底：轻点一下 Alt 让本进程成为「最近有输入」的一方，再切一次。
        tap_alt();
        let _ = SetForegroundWindow(hwnd);
        if wait_foreground(hwnd) {
            return Ok(());
        }
    }
    Err(format!(
        "Windows refused to bring \"{}\" to the front. Ask the user to click on it once, then try again.",
        title(hwnd)
    ))
}

fn wait_foreground(hwnd: HWND) -> bool {
    for _ in 0..10 {
        if foreground().is_some_and(|f| f == hwnd || same_family(f, hwnd)) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
    false
}

fn tap_alt() {
    let key = |up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VK_MENU,
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { Default::default() },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let inputs = [key(false), key(true)];
    unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
}

/// 屏幕上这一点是否落在目标窗口（或同一家的弹出层）上。
pub fn check_point(hwnd: HWND, x: i32, y: i32) -> Res<()> {
    let at = unsafe { WindowFromPoint(POINT { x, y }) };
    if at.0.is_null() {
        return Err(format!("({x}, {y}) is outside the screen."));
    }
    let root = unsafe { GetAncestor(at, GA_ROOT) };
    if root == hwnd || same_family(root, hwnd) {
        return Ok(());
    }
    Err(format!(
        "That spot is covered by another window (\"{}\"). Deal with that window first, or bring this one to the front.",
        title(root)
    ))
}

pub fn act(hwnd: HWND, action: WindowAction) -> Res<()> {
    unsafe {
        match action {
            WindowAction::Focus => return bring_to_front(hwnd),
            WindowAction::Minimize => {
                let _ = ShowWindow(hwnd, SW_MINIMIZE);
            }
            WindowAction::Maximize => {
                let _ = ShowWindow(hwnd, SW_MAXIMIZE);
            }
            WindowAction::Restore => {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            WindowAction::Close => {
                PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0))
                    .map_err(|e| format!("Could not ask the window to close: {e}"))?;
            }
            WindowAction::Launch => unreachable!("launch is handled by the engine"),
        }
    }
    Ok(())
}
