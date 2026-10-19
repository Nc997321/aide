//! Windows 适配器：UI Automation 读、SendInput 写、PrintWindow 截图、开始菜单启动。
//! **整个 crate 只有这个目录允许出现 Win32 / UIA 调用。**

mod capture;
pub mod guard;
mod input;
mod launch;
mod uia;
mod win;

use std::sync::Arc;

use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::UI::HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};

use crate::keys::Combo;
use crate::model::{Direction, MouseButton, PatternClick, RawTree, Shot, WindowAction, WindowInfo};
use crate::port::{Backend, Guard, Res, SharedSignals};

/// 在**执行器线程**上调用：初始化 COM（MTA）与 DPI 感知，建适配器；另起守护线程。
pub fn create(signals: SharedSignals) -> (WinBackend, Arc<dyn Guard>) {
    unsafe {
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let uia = uia::Uia::new();
    if let Err(e) = &uia {
        tracing::error!("aide-computer: {e}");
    }
    (
        WinBackend { uia: uia.ok(), procs: win::Procs::new(), launcher: launch::Launcher::default() },
        guard::start(signals),
    )
}

pub struct WinBackend {
    uia: Option<uia::Uia>,
    procs: win::Procs,
    launcher: launch::Launcher,
}

impl WinBackend {
    fn uia(&mut self) -> Res<&mut uia::Uia> {
        self.uia.as_mut().ok_or_else(|| "UI Automation is not available on this system.".into())
    }
}

impl Backend for WinBackend {
    fn list_windows(&mut self) -> Res<Vec<WindowInfo>> {
        Ok(win::list(&mut self.procs))
    }

    fn window(&mut self, id: &str) -> Res<WindowInfo> {
        let h = win::hwnd_of(id)?;
        Ok(win::info(&mut self.procs, h))
    }

    fn foreground(&mut self) -> Option<String> {
        win::foreground().map(win::id_of)
    }

    fn focused_element(&mut self) -> Option<(Vec<i32>, String)> {
        self.uia.as_ref()?.focused()
    }

    fn window_action(&mut self, id: &str, action: WindowAction) -> Res<()> {
        win::act(win::hwnd_of(id)?, action)
    }

    fn launch(&mut self, app: &str) -> Res<String> {
        self.launcher.launch(app)
    }

    fn snapshot(&mut self, id: &str, text_tail: Option<u32>) -> Res<RawTree> {
        let h = win::hwnd_of(id)?;
        let window = win::info(&mut self.procs, h);
        let (elements, truncated) = self.uia()?.snapshot(id, h, text_tail)?;
        Ok(RawTree { window, elements, truncated })
    }

    fn screenshot(&mut self, id: &str, max_side: u32) -> Res<Shot> {
        capture::window(win::hwnd_of(id)?, max_side)
    }

    fn element_alive(&mut self, window: &str, runtime_id: &[i32], role: &str) -> Res<bool> {
        self.uia()?.alive(window, runtime_id, role)
    }

    fn pattern_click(&mut self, window: &str, runtime_id: &[i32]) -> Res<PatternClick> {
        self.uia()?.pattern_click(window, runtime_id)
    }

    fn element_center(&mut self, window: &str, runtime_id: &[i32]) -> Res<(i32, i32)> {
        self.uia()?.center(window, runtime_id)
    }

    fn focus_element(&mut self, window: &str, runtime_id: &[i32]) -> Res<()> {
        self.uia()?.focus(window, runtime_id)
    }

    fn set_value(&mut self, window: &str, runtime_id: &[i32], value: &str) -> Res<()> {
        self.uia()?.set_value(window, runtime_id, value)
    }

    fn bring_to_front(&mut self, id: &str) -> Res<()> {
        win::bring_to_front(win::hwnd_of(id)?)
    }

    fn check_point(&mut self, id: &str, x: i32, y: i32) -> Res<()> {
        win::check_point(win::hwnd_of(id)?, x, y)
    }

    fn mouse_click(&mut self, x: i32, y: i32, button: MouseButton, clicks: u32) -> Res<()> {
        input::click(x, y, button, clicks)
    }

    fn scroll(&mut self, x: i32, y: i32, direction: Direction, notches: u32) -> Res<()> {
        input::scroll(x, y, direction, notches)
    }

    fn type_text(&mut self, id: &str, text: &str, interrupted: &dyn Fn() -> Option<String>) -> Res<usize> {
        let target = win::hwnd_of(id)?;
        input::type_text(text, || {
            if let Some(why) = interrupted() {
                return Err(why);
            }
            match win::foreground() {
                Some(fg) if win::same_family(fg, target) => Ok(()),
                Some(fg) => Err(format!(
                    "The keyboard focus moved to another window (\"{}\"), so typing stopped.",
                    win::title(fg)
                )),
                None => Err("No window has the keyboard focus, so typing stopped.".into()),
            }
        })
    }

    fn press(&mut self, id: &str, combo: &Combo) -> Res<()> {
        let target = win::hwnd_of(id)?;
        if !win::foreground().is_some_and(|fg| win::same_family(fg, target)) {
            return Err("The window is not in the foreground, so the keys were not sent.".into());
        }
        input::press(combo)
    }
}
