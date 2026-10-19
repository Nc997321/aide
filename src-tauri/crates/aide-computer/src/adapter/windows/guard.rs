//! 守护线程：用户接管检测（底层输入钩子）、急停热键、屏幕顶部提示条。
//!
//! 钩子与热键**只在持锁期间**装（平时零开销、也不占用户的组合键）。
//! 钩子回调用系统给的「注入」标记区分：我们自己 SendInput 的事件带标记，用户真实操作不带。
//! 什么算接管见 `crate::takeover`（在 Aide 自己窗口里的操作、单纯移动鼠标都不算）。
//! 提示条：置顶、鼠标穿透、不抢焦点、排除在截屏之外；颜色是原生绘制的固定值（不在前端主题系统里）。

use std::cell::RefCell;
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateFontW, CreateRoundRectRgn, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint, FillRect,
    GetDC, GetMonitorInfoW, GetTextExtentPoint32W, InvalidateRect, MonitorFromPoint, ReleaseDC, SelectObject,
    SetBkMode, SetTextColor, SetWindowRgn, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DT_CENTER,
    DT_SINGLELINE, DT_VCENTER, HFONT, MONITORINFO, MONITOR_DEFAULTTOPRIMARY, OUT_DEFAULT_PRECIS, PAINTSTRUCT,
    TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::HiDpi::{GetDpiForWindow, SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT};
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::port::{Guard, SharedSignals};
use crate::takeover::{is_takeover, UserInput};

pub const OVERLAY_CLASS: &str = "AideComputerOverlay";
const HOTKEY_ID: i32 = 0xA1DE;
const TIMER_HIDE: usize = 1;

static SIGNALS: OnceLock<SharedSignals> = OnceLock::new();

thread_local! {
    static TEXT: RefCell<Vec<u16>> = const { RefCell::new(Vec::new()) };
}

enum Cmd {
    Watch(bool),
    Show(Option<String>, Option<Duration>),
}

pub struct WinGuard {
    tx: Mutex<mpsc::Sender<Cmd>>,
    thread_id: u32,
}

impl WinGuard {
    fn send(&self, cmd: Cmd) {
        if self.tx.lock().unwrap_or_else(|e| e.into_inner()).send(cmd).is_ok() {
            unsafe {
                let _ = PostThreadMessageW(self.thread_id, WM_APP, WPARAM(0), LPARAM(0));
            }
        }
    }
}

impl Guard for WinGuard {
    fn watch_input(&self, on: bool) {
        self.send(Cmd::Watch(on));
    }
    fn show(&self, text: Option<String>, linger: Option<Duration>) {
        self.send(Cmd::Show(text, linger));
    }
}

pub fn start(signals: SharedSignals) -> Arc<dyn Guard> {
    let _ = SIGNALS.set(signals);
    let (tx, rx) = mpsc::channel::<Cmd>();
    let (id_tx, id_rx) = mpsc::channel::<u32>();
    let spawned = std::thread::Builder::new().name("aide-computer-guard".into()).spawn(move || unsafe {
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        // 先建消息队列，PostThreadMessage 才投得进来。
        let mut msg = MSG::default();
        let _ = PeekMessageW(&mut msg, None, WM_USER, WM_USER, PM_NOREMOVE);
        let _ = id_tx.send(GetCurrentThreadId());
        let overlay = Overlay::create();
        if overlay.is_none() {
            tracing::warn!("aide-computer: could not create the on-screen hint window");
        }
        let mut hooks: Option<(HHOOK, HHOOK)> = None;
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.hwnd.0.is_null() {
                match msg.message {
                    WM_APP => {
                        while let Ok(cmd) = rx.try_recv() {
                            match cmd {
                                Cmd::Watch(true) if hooks.is_none() => {
                                    hooks = install();
                                    tracing::info!(installed = hooks.is_some(), "aide-computer: watching for user input");
                                }
                                Cmd::Watch(false) => {
                                    if let Some((m, k)) = hooks.take() {
                                        let _ = UnhookWindowsHookEx(m);
                                        let _ = UnhookWindowsHookEx(k);
                                        let _ = UnregisterHotKey(None, HOTKEY_ID);
                                    }
                                }
                                Cmd::Watch(true) => {}
                                Cmd::Show(text, linger) => {
                                    if let Some(o) = &overlay {
                                        o.show(text, linger);
                                    }
                                }
                            }
                        }
                        continue;
                    }
                    WM_HOTKEY if msg.wParam.0 as i32 == HOTKEY_ID => {
                        if let Some(s) = SIGNALS.get() {
                            s.stop.store(true, Ordering::SeqCst);
                        }
                        tracing::info!("aide-computer: emergency stop hotkey pressed");
                        continue;
                    }
                    _ => {}
                }
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
    let thread_id = match spawned {
        Ok(_) => id_rx.recv_timeout(Duration::from_secs(2)).unwrap_or(0),
        Err(e) => {
            tracing::error!("aide-computer: cannot start guard thread: {e}");
            0
        }
    };
    Arc::new(WinGuard { tx: Mutex::new(tx), thread_id })
}

unsafe fn install() -> Option<(HHOOK, HHOOK)> {
    let module = GetModuleHandleW(None).ok().map(|m| m.into());
    let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), module, 0);
    let keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), module, 0);
    if let Err(e) = RegisterHotKey(None, HOTKEY_ID, MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT, 'S' as u32) {
        tracing::warn!("aide-computer: emergency-stop hotkey unavailable (taken by another app?): {e}");
    }
    match (mouse, keyboard) {
        (Ok(m), Ok(k)) => Some((m, k)),
        (m, k) => {
            tracing::warn!("aide-computer: input hooks unavailable; user takeover cannot be detected");
            if let Ok(m) = m {
                let _ = UnhookWindowsHookEx(m);
            }
            if let Ok(k) = k {
                let _ = UnhookWindowsHookEx(k);
            }
            None
        }
    }
}

fn takeover(kind: &str) {
    if let Some(s) = SIGNALS.get() {
        if !s.takeover.swap(true, Ordering::SeqCst) {
            tracing::info!(kind, "aide-computer: user input detected — taking hands off");
        }
    }
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        let input = match wparam.0 as u32 {
            WM_MOUSEMOVE => UserInput::MouseMove,
            WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN => UserInput::MouseButtonDown,
            WM_MOUSEWHEEL | WM_MOUSEHWHEEL => UserInput::Wheel,
            _ => UserInput::MouseButtonUp,
        };
        let injected = info.flags & LLMHF_INJECTED != 0;
        // 先用便宜的判断排除（移动 / 抬起 / 注入），可能算接管时才去查落点窗口。
        if is_takeover(input, injected, false) && is_takeover(input, injected, on_aide(WindowFromPoint(info.pt))) {
            takeover("mouse");
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let input = match wparam.0 as u32 {
            WM_KEYDOWN | WM_SYSKEYDOWN => UserInput::KeyDown,
            _ => UserInput::KeyUp,
        };
        let injected = info.flags.0 & LLKHF_INJECTED.0 != 0;
        if is_takeover(input, injected, on_aide(GetForegroundWindow())) {
            takeover("keyboard");
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// 窗口属于 Aide 自己（执行器跑在 Aide 的 GUI 进程里）。
unsafe fn on_aide(hwnd: HWND) -> bool {
    if hwnd.0.is_null() {
        return false;
    }
    let root = GetAncestor(hwnd, GA_ROOT);
    let mut pid = 0u32;
    GetWindowThreadProcessId(if root.0.is_null() { hwnd } else { root }, Some(&mut pid));
    pid == std::process::id()
}

// ------------------------------------------------------------ 提示条

struct Overlay {
    hwnd: HWND,
}

const BG: COLORREF = COLORREF(0x00_30_20_1E); // BGR：深色底
const FG: COLORREF = COLORREF(0x00_FF_FF_FF);

impl Overlay {
    unsafe fn create() -> Option<Self> {
        let instance = GetModuleHandleW(None).ok()?;
        let class = WNDCLASSW {
            lpfnWndProc: Some(overlay_proc),
            hInstance: instance.into(),
            lpszClassName: w!("AideComputerOverlay"),
            ..Default::default()
        };
        RegisterClassW(&class);
        let hwnd = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            w!("AideComputerOverlay"),
            PCWSTR::null(),
            WS_POPUP,
            0,
            0,
            10,
            10,
            None,
            None,
            Some(instance.into()),
            None,
        )
        .ok()?;
        let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 235, LWA_ALPHA);
        // 排除在截屏之外（Win10 2004+；旧系统失败无妨）。
        let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
        Some(Self { hwnd })
    }

    unsafe fn show(&self, text: Option<String>, linger: Option<Duration>) {
        let _ = KillTimer(Some(self.hwnd), TIMER_HIDE);
        let Some(text) = text else {
            let _ = ShowWindow(self.hwnd, SW_HIDE);
            return;
        };
        tracing::debug!(%text, "aide-computer: overlay");
        let wide: Vec<u16> = text.encode_utf16().collect();
        let dpi = GetDpiForWindow(self.hwnd).max(96) as i32;
        let font = font(dpi);
        let hdc = GetDC(Some(self.hwnd));
        let old = SelectObject(hdc, font.into());
        let mut size = SIZE::default();
        let _ = GetTextExtentPoint32W(hdc, &wide, &mut size);
        SelectObject(hdc, old);
        ReleaseDC(Some(self.hwnd), hdc);
        let _ = DeleteObject(font.into());
        TEXT.with(|t| *t.borrow_mut() = wide);

        let (pad_x, pad_y) = (16 * dpi / 96, 7 * dpi / 96);
        let (w, h) = (size.cx + 2 * pad_x, size.cy + 2 * pad_y);
        let monitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        let _ = GetMonitorInfoW(monitor, &mut mi);
        let work = mi.rcWork;
        let x = work.left + ((work.right - work.left) - w) / 2;
        let y = work.top + 10 * dpi / 96;
        let _ = SetWindowPos(self.hwnd, Some(HWND_TOPMOST), x, y, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
        let radius = h;
        let rgn = CreateRoundRectRgn(0, 0, w + 1, h + 1, radius, radius);
        SetWindowRgn(self.hwnd, Some(rgn), true);
        let _ = InvalidateRect(Some(self.hwnd), None, true);
        if let Some(d) = linger {
            SetTimer(Some(self.hwnd), TIMER_HIDE, d.as_millis() as u32, None);
        }
    }
}

unsafe fn font(dpi: i32) -> HFONT {
    CreateFontW(
        -(14 * dpi / 96),
        0,
        0,
        0,
        500,
        0,
        0,
        0,
        DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS,
        CLIP_DEFAULT_PRECIS,
        CLEARTYPE_QUALITY,
        0,
        w!("Microsoft YaHei UI"),
    )
}

unsafe extern "system" fn overlay_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_NCHITTEST => LRESULT(HTTRANSPARENT as isize),
        WM_TIMER if wparam.0 == TIMER_HIDE => {
            let _ = KillTimer(Some(hwnd), TIMER_HIDE);
            let _ = ShowWindow(hwnd, SW_HIDE);
            LRESULT(0)
        }
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let hdc = BeginPaint(hwnd, &mut ps);
            let mut rc = RECT::default();
            let _ = GetClientRect(hwnd, &mut rc);
            let brush = CreateSolidBrush(BG);
            FillRect(hdc, &rc, brush);
            let _ = DeleteObject(brush.into());
            let font = font(GetDpiForWindow(hwnd).max(96) as i32);
            let old = SelectObject(hdc, font.into());
            SetBkMode(hdc, TRANSPARENT);
            SetTextColor(hdc, FG);
            // 还没设过文字时窗口也可能收到 WM_PAINT（隐藏状态下由 DWM 触发）：空切片交给
            // DrawTextW 会访问越界、整个进程崩溃（实测 0xC000041D），所以空就不画。
            TEXT.with(|t| {
                let mut text = t.borrow().clone();
                if !text.is_empty() {
                    DrawTextW(hdc, &mut text, &mut rc, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
                }
            });
            SelectObject(hdc, old);
            let _ = DeleteObject(font.into());
            let _ = EndPaint(hwnd, &ps);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}
