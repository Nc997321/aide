//! 真实输入：`SendInput`。所有事件都带系统的「注入」标记，守护线程据此区分用户真实输入。

use std::time::Duration;

use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

use crate::keys::{Combo, Key, Modifier, Named};
use crate::model::{Direction, MouseButton};
use crate::port::Res;

/// 打字每批多少个 UTF-16 单元；批间留一点时间，防目标应用来不及处理而丢字。
const TYPE_BATCH: usize = 32;
const TYPE_GAP: Duration = Duration::from_millis(8);

fn send(inputs: &[INPUT]) -> Res<()> {
    if inputs.is_empty() {
        return Ok(());
    }
    let n = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if n as usize != inputs.len() {
        return Err("Windows blocked the input (the target may run with higher privileges, or the screen is locked).".into());
    }
    Ok(())
}

fn mouse(dx: i32, dy: i32, data: i32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    }
}

/// 绝对移动到屏幕物理像素 (x, y)（覆盖所有显示器的虚拟桌面）。
fn move_to(x: i32, y: i32) -> INPUT {
    let (vx, vy, vw, vh) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN).max(2),
            GetSystemMetrics(SM_CYVIRTUALSCREEN).max(2),
        )
    };
    let nx = ((x - vx) as i64 * 65535 / (vw - 1) as i64) as i32;
    let ny = ((y - vy) as i64 * 65535 / (vh - 1) as i64) as i32;
    mouse(nx, ny, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)
}

pub fn click(x: i32, y: i32, button: MouseButton, clicks: u32) -> Res<()> {
    let (down, up) = match button {
        MouseButton::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        MouseButton::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    };
    send(&[move_to(x, y)])?;
    std::thread::sleep(Duration::from_millis(30));
    for i in 0..clicks.max(1) {
        if i > 0 {
            std::thread::sleep(Duration::from_millis(60));
        }
        send(&[mouse(0, 0, 0, down), mouse(0, 0, 0, up)])?;
    }
    Ok(())
}

pub fn scroll(x: i32, y: i32, direction: Direction, notches: u32) -> Res<()> {
    send(&[move_to(x, y)])?;
    std::thread::sleep(Duration::from_millis(30));
    let delta = (notches as i32) * 120;
    let ev = match direction {
        Direction::Up => mouse(0, 0, delta, MOUSEEVENTF_WHEEL),
        Direction::Down => mouse(0, 0, -delta, MOUSEEVENTF_WHEEL),
        Direction::Right => mouse(0, 0, delta, MOUSEEVENTF_HWHEEL),
        Direction::Left => mouse(0, 0, -delta, MOUSEEVENTF_HWHEEL),
    };
    send(&[ev])
}

fn key_event(vk: VIRTUAL_KEY, up: bool) -> INPUT {
    let scan = unsafe { MapVirtualKeyW(vk.0 as u32, MAPVK_VK_TO_VSC) } as u16;
    let mut flags = if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) };
    if is_extended(vk) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

fn unicode_event(unit: u16, up: bool) -> INPUT {
    let flags = if up { KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } else { KEYEVENTF_UNICODE };
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0), wScan: unit, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

fn is_extended(vk: VIRTUAL_KEY) -> bool {
    matches!(
        vk,
        VK_UP | VK_DOWN | VK_LEFT | VK_RIGHT | VK_HOME | VK_END | VK_PRIOR | VK_NEXT | VK_INSERT | VK_DELETE
            | VK_LWIN | VK_RWIN | VK_APPS | VK_RCONTROL | VK_RMENU | VK_SNAPSHOT
    )
}

/// 文本 → 输入事件：换行按回车、制表按 Tab，其余一律 Unicode 注入（不经输入法，中文结果确定）。
fn text_events(text: &str) -> Vec<Vec<INPUT>> {
    let mut chunks = Vec::new();
    let mut cur = Vec::new();
    let mut units = 0usize;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                // \r\n 只按一次回车
                if chars.peek() != Some(&'\n') {
                    cur.push(key_event(VK_RETURN, false));
                    cur.push(key_event(VK_RETURN, true));
                }
            }
            '\n' => {
                cur.push(key_event(VK_RETURN, false));
                cur.push(key_event(VK_RETURN, true));
            }
            '\t' => {
                cur.push(key_event(VK_TAB, false));
                cur.push(key_event(VK_TAB, true));
            }
            _ => {
                let mut buf = [0u16; 2];
                for u in c.encode_utf16(&mut buf) {
                    cur.push(unicode_event(*u, false));
                    cur.push(unicode_event(*u, true));
                }
            }
        }
        units += 1;
        if units >= TYPE_BATCH {
            chunks.push(std::mem::take(&mut cur));
            units = 0;
        }
    }
    if !cur.is_empty() {
        chunks.push(cur);
    }
    chunks
}

/// 分批打字。每批之前调用 `before_batch`（确认前台、检查打断），它报错就停。返回已打出的字符数。
pub fn type_text(text: &str, mut before_batch: impl FnMut() -> Res<()>) -> Res<usize> {
    let total = text.chars().count();
    let mut typed = 0usize;
    for chunk in text_events(text) {
        if let Err(e) = before_batch() {
            return Err(format!("{e} ({typed} of {total} characters were typed)"));
        }
        send(&chunk)?;
        typed = (typed + TYPE_BATCH).min(total);
        std::thread::sleep(TYPE_GAP);
    }
    Ok(total)
}

pub fn press(combo: &Combo) -> Res<()> {
    let mut mods: Vec<VIRTUAL_KEY> = combo
        .modifiers
        .iter()
        .map(|m| match m {
            Modifier::Ctrl => VK_CONTROL,
            Modifier::Alt => VK_MENU,
            Modifier::Shift => VK_SHIFT,
            Modifier::Win => VK_LWIN,
        })
        .collect();
    let main = match combo.key {
        None => None,
        Some(k) => {
            let (vk, needs_shift) = vk_of(k)?;
            if needs_shift && !mods.contains(&VK_SHIFT) {
                mods.push(VK_SHIFT);
            }
            Some(vk)
        }
    };
    let mut seq = Vec::new();
    for m in &mods {
        seq.push(key_event(*m, false));
    }
    if let Some(vk) = main {
        seq.push(key_event(vk, false));
        seq.push(key_event(vk, true));
    }
    for m in mods.iter().rev() {
        seq.push(key_event(*m, true));
    }
    send(&seq)
}

fn vk_of(key: Key) -> Res<(VIRTUAL_KEY, bool)> {
    Ok(match key {
        Key::Named(n) => (
            match n {
                Named::Enter => VK_RETURN,
                Named::Escape => VK_ESCAPE,
                Named::Tab => VK_TAB,
                Named::Space => VK_SPACE,
                Named::Backspace => VK_BACK,
                Named::Delete => VK_DELETE,
                Named::Insert => VK_INSERT,
                Named::Home => VK_HOME,
                Named::End => VK_END,
                Named::PageUp => VK_PRIOR,
                Named::PageDown => VK_NEXT,
                Named::Up => VK_UP,
                Named::Down => VK_DOWN,
                Named::Left => VK_LEFT,
                Named::Right => VK_RIGHT,
                Named::CapsLock => VK_CAPITAL,
                Named::PrintScreen => VK_SNAPSHOT,
                Named::Apps => VK_APPS,
            },
            false,
        ),
        Key::Function(n) => (VIRTUAL_KEY(VK_F1.0 + (n as u16 - 1)), false),
        Key::Char(c) if c.is_ascii_lowercase() => (VIRTUAL_KEY(c.to_ascii_uppercase() as u16), false),
        Key::Char(c) if c.is_ascii_digit() => (VIRTUAL_KEY(c as u16), false),
        Key::Char(c) => {
            let mut buf = [0u16; 2];
            let units = c.encode_utf16(&mut buf);
            if units.len() != 1 {
                return Err(format!("`{c}` cannot be pressed as a key; use type instead."));
            }
            let r = unsafe { VkKeyScanW(units[0]) };
            if r == -1 {
                return Err(format!("`{c}` is not on the current keyboard layout; use type instead."));
            }
            let vk = (r as u16) & 0xff;
            let shift = (r as u16 >> 8) & 1 == 1;
            (VIRTUAL_KEY(vk), shift)
        }
    })
}
