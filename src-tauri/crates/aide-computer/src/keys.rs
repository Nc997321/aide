//! 按键组合解析：`"ctrl+shift+s"` → 修饰键 + 主键。纯函数，适配器负责把 [`Key`] 翻成平台键码。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Modifier {
    Ctrl,
    Alt,
    Shift,
    Win,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Named {
    Enter,
    Escape,
    Tab,
    Space,
    Backspace,
    Delete,
    Insert,
    Home,
    End,
    PageUp,
    PageDown,
    Up,
    Down,
    Left,
    Right,
    CapsLock,
    PrintScreen,
    /// 上下文菜单键。
    Apps,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Named(Named),
    /// F1..F24
    Function(u8),
    /// 可打印字符（字母统一小写）。
    Char(char),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Combo {
    pub modifiers: Vec<Modifier>,
    /// `None` = 只按修饰键（如单按 `win`）。
    pub key: Option<Key>,
}

/// 解析一个组合。错误文本面向 agent。
pub fn parse_combo(input: &str) -> Result<Combo, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("`keys` is empty — pass something like \"enter\" or \"ctrl+s\"".into());
    }
    // 单独一个 "+" 就是加号键；"ctrl++" 也是 ctrl + 加号。
    let parts: Vec<String> = split_plus(trimmed);
    let mut modifiers = Vec::new();
    let mut key = None;
    for (i, part) in parts.iter().enumerate() {
        let last = i + 1 == parts.len();
        if let Some(m) = modifier(part) {
            if !modifiers.contains(&m) {
                modifiers.push(m);
            }
            continue;
        }
        if !last {
            return Err(format!(
                "`{part}` in \"{input}\" is not a modifier — only the last part may be a regular key (modifiers: ctrl, alt, shift, win)"
            ));
        }
        key = Some(main_key(part).ok_or_else(|| {
            format!(
                "unknown key `{part}` in \"{input}\". Use a single character, f1–f24, or one of: enter, esc, tab, space, backspace, delete, insert, home, end, pageup, pagedown, up, down, left, right, capslock, printscreen, apps, plus"
            )
        })?);
    }
    Ok(Combo { modifiers, key })
}

fn split_plus(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '+' && !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        } else if c == '+' {
            // 段首的 '+'：它本身就是键（"+" 或 "ctrl++" 的末段）。
            cur.push('+');
            out.push(std::mem::take(&mut cur));
            // 跳过紧随的分隔 '+'
            if i + 1 < chars.len() && chars[i + 1] == '+' {
                i += 1;
            }
        } else {
            cur.push(c);
        }
        i += 1;
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out.into_iter().map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect()
}

fn modifier(part: &str) -> Option<Modifier> {
    match part.to_ascii_lowercase().as_str() {
        "ctrl" | "control" | "ctl" => Some(Modifier::Ctrl),
        "alt" | "option" => Some(Modifier::Alt),
        "shift" => Some(Modifier::Shift),
        "win" | "windows" | "meta" | "super" | "cmd" | "command" => Some(Modifier::Win),
        _ => None,
    }
}

fn main_key(part: &str) -> Option<Key> {
    let lower = part.to_lowercase();
    let named = match lower.as_str() {
        "enter" | "return" => Some(Named::Enter),
        "esc" | "escape" => Some(Named::Escape),
        "tab" => Some(Named::Tab),
        "space" | "spacebar" => Some(Named::Space),
        "backspace" | "bksp" => Some(Named::Backspace),
        "delete" | "del" => Some(Named::Delete),
        "insert" | "ins" => Some(Named::Insert),
        "home" => Some(Named::Home),
        "end" => Some(Named::End),
        "pageup" | "pgup" => Some(Named::PageUp),
        "pagedown" | "pgdn" => Some(Named::PageDown),
        "up" | "arrowup" => Some(Named::Up),
        "down" | "arrowdown" => Some(Named::Down),
        "left" | "arrowleft" => Some(Named::Left),
        "right" | "arrowright" => Some(Named::Right),
        "capslock" => Some(Named::CapsLock),
        "printscreen" | "prtsc" => Some(Named::PrintScreen),
        "apps" | "menu" | "contextmenu" => Some(Named::Apps),
        _ => None,
    };
    if let Some(n) = named {
        return Some(Key::Named(n));
    }
    if lower == "plus" {
        return Some(Key::Char('+'));
    }
    if let Some(num) = lower.strip_prefix('f') {
        if let Ok(n) = num.parse::<u8>() {
            if (1..=24).contains(&n) {
                return Some(Key::Function(n));
            }
        }
    }
    let mut chars = lower.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) if !c.is_control() => Some(Key::Char(c)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modifier_combos() {
        let c = parse_combo("Ctrl+Shift+S").unwrap();
        assert_eq!(c.modifiers, vec![Modifier::Ctrl, Modifier::Shift]);
        assert_eq!(c.key, Some(Key::Char('s')));
    }

    #[test]
    fn parses_named_and_function_keys() {
        assert_eq!(parse_combo("enter").unwrap().key, Some(Key::Named(Named::Enter)));
        assert_eq!(parse_combo("alt+f4").unwrap().key, Some(Key::Function(4)));
        assert_eq!(parse_combo("shift+enter").unwrap().modifiers, vec![Modifier::Shift]);
    }

    #[test]
    fn plus_key_forms() {
        assert_eq!(parse_combo("+").unwrap().key, Some(Key::Char('+')));
        let c = parse_combo("ctrl++").unwrap();
        assert_eq!(c.modifiers, vec![Modifier::Ctrl]);
        assert_eq!(c.key, Some(Key::Char('+')));
        assert_eq!(parse_combo("ctrl+plus").unwrap().key, Some(Key::Char('+')));
    }

    #[test]
    fn lone_modifier_is_allowed() {
        let c = parse_combo("win").unwrap();
        assert_eq!(c.modifiers, vec![Modifier::Win]);
        assert_eq!(c.key, None);
    }

    #[test]
    fn rejects_unknown_and_misplaced() {
        assert!(parse_combo("ctrl+banana").is_err());
        assert!(parse_combo("s+ctrl").is_err());
        assert!(parse_combo("  ").is_err());
        assert!(parse_combo("f25").is_err());
    }
}
