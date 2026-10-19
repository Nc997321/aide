//! 控件树裁剪：把适配器读出的原始树压成 agent 读得动的精简列表。
//!
//! 规则（与应用无关）：
//! - 留下**能操作的**（可点 / 可切换 / 可选 / 可展开 / 可写值 / 交互类控件）与**有内容的**（有名字、有文字）；
//! - 无名字也不能操作的布局容器去掉，子元素提上来（深度按留下的祖先重算）；
//! - 滚动条、滑块拇指、分隔线这类纯装饰去掉；
//! - 与最近一个留下的祖先同名的 Text 去掉（按钮里那行同名文字）；
//! - 密码框不回值。

use crate::model::{RawElement, ViewElement};

/// 一次读取最多回多少个元素；超出截断并告诉 agent 还剩多少。
pub const MAX_ELEMENTS: usize = 400;
const MAX_NAME: usize = 200;
const MAX_VALUE: usize = 2000;
const MAX_TEXT: usize = 8000;

const INTERACTIVE: &[&str] = &[
    "Button", "CheckBox", "ComboBox", "Edit", "Hyperlink", "ListItem", "MenuItem", "RadioButton",
    "Slider", "Spinner", "TabItem", "TreeItem", "SplitButton", "DataItem", "HeaderItem", "Document",
];
const DECORATION: &[&str] = &["ScrollBar", "Thumb", "Separator"];

pub struct Pruned {
    pub elements: Vec<ViewElement>,
    /// 因上限没列出的元素数。
    pub omitted: usize,
}

/// `assign_ref` 按元素身份给出稳定编号（同一元素多次读取编号不变）。
pub fn prune(raw: &[RawElement], mut assign_ref: impl FnMut(&[i32]) -> String) -> Pruned {
    let mut out = Vec::new();
    let mut omitted = 0;
    // 留下的祖先：(原始深度, 名字)
    let mut stack: Vec<(u16, String)> = Vec::new();
    for e in raw {
        while stack.last().is_some_and(|(d, _)| *d >= e.depth) {
            stack.pop();
        }
        let parent_name = stack.last().map(|(_, n)| n.as_str()).unwrap_or("");
        if !keep(e, parent_name) {
            continue;
        }
        if out.len() >= MAX_ELEMENTS {
            omitted += 1;
            continue;
        }
        let depth = stack.len() as u16;
        stack.push((e.depth, e.name.trim().to_string()));
        out.push(ViewElement {
            ref_id: assign_ref(&e.runtime_id),
            role: e.role.clone(),
            name: clip(e.name.trim(), MAX_NAME),
            value: if e.password { None } else { e.value.as_deref().map(|v| clip(&newlines(v), MAX_VALUE)) },
            states: states(e),
            depth,
            text: e
                .text
                .as_deref()
                .map(newlines)
                .filter(|t| squash(t) != squash(&e.name))
                .map(|t| clip_tail(&t, MAX_TEXT)),
            runtime_id: e.runtime_id.clone(),
            clickable_by_pattern: e.patterns.invoke
                || e.patterns.toggle
                || e.patterns.select
                || e.patterns.expand,
        });
    }
    Pruned { elements: out, omitted }
}

/// `flags[i]` 为真、且先序子树里没有别的为真的元素 → 真。
pub fn innermost(depths: &[u16], flags: &[bool]) -> Vec<bool> {
    let mut out = vec![false; depths.len()];
    // 自右向左：栈里是已处理的右侧元素 (深度, 子树里有没有为真的)
    let mut stack: Vec<(u16, bool)> = Vec::new();
    for i in (0..depths.len()).rev() {
        let mut below = false;
        while let Some(&(d, any)) = stack.last() {
            if d > depths[i] {
                below |= any;
                stack.pop();
            } else {
                break;
            }
        }
        out[i] = flags[i] && !below;
        stack.push((depths[i], below || flags[i]));
    }
    out
}

fn keep(e: &RawElement, parent_name: &str) -> bool {
    if DECORATION.contains(&e.role.as_str()) {
        return false;
    }
    if e.bounds.is_empty() && !e.focused {
        return false;
    }
    let p = &e.patterns;
    if INTERACTIVE.contains(&e.role.as_str())
        || p.invoke
        || p.toggle
        || p.select
        || p.expand
        || p.value_editable
        || e.text.is_some()
    {
        return true;
    }
    let name = e.name.trim();
    if name.is_empty() {
        return false;
    }
    !(e.role == "Text" && name == parent_name)
}

fn states(e: &RawElement) -> Vec<&'static str> {
    let mut s = Vec::new();
    if e.focused {
        s.push("focused");
    }
    if !e.enabled {
        s.push("disabled");
    }
    match e.patterns.toggled {
        Some(true) => s.push("checked"),
        Some(false) => s.push("unchecked"),
        None => {}
    }
    if e.patterns.selected {
        s.push("selected");
    }
    match e.patterns.expanded {
        Some(true) => s.push("expanded"),
        Some(false) => s.push("collapsed"),
        None => {}
    }
    if e.password {
        s.push("password");
    }
    s
}

/// 统一换行：有的控件用 `\r`（RichEdit），有的用 `\r\n`。
fn newlines(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n")
}

/// 去掉所有空白后比较（状态栏常见「名字带换行、文字带空格」的同一段话）。
fn squash(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut t: String = s.chars().take(max).collect();
    t.push('…');
    t
}

/// 文字控件保留**末尾**（终端、聊天记录最新的在下面）。
fn clip_tail(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        return s.to_string();
    }
    let mut t = String::from("…");
    t.extend(s.chars().skip(n - max));
    t
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Patterns, Rect};

    fn el(depth: u16, role: &str, name: &str) -> RawElement {
        RawElement {
            runtime_id: vec![depth as i32, name.len() as i32],
            role: role.into(),
            name: name.into(),
            depth,
            bounds: Rect { x: 0, y: 0, w: 10, h: 10 },
            enabled: true,
            ..Default::default()
        }
    }

    fn refs() -> impl FnMut(&[i32]) -> String {
        let mut n = 0;
        move |_| {
            n += 1;
            format!("e{n}")
        }
    }

    #[test]
    fn drops_unnamed_containers_and_promotes_children() {
        let raw = vec![
            el(0, "Window", "无标题 - 记事本"),
            el(1, "Pane", ""),
            el(2, "Pane", ""),
            el(3, "Button", "保存"),
            el(4, "Text", "保存"),
            el(1, "ScrollBar", "垂直"),
        ];
        let p = prune(&raw, refs());
        let names: Vec<(u16, &str)> = p.elements.iter().map(|e| (e.depth, e.name.as_str())).collect();
        assert_eq!(names, vec![(0, "无标题 - 记事本"), (1, "保存")]);
    }

    #[test]
    fn keeps_interactive_even_without_name() {
        let mut edit = el(1, "Edit", "");
        edit.value = Some("hello".into());
        let p = prune(&[el(0, "Window", "w"), edit], refs());
        assert_eq!(p.elements.len(), 2);
        assert_eq!(p.elements[1].value.as_deref(), Some("hello"));
    }

    #[test]
    fn hides_password_values_and_reports_states() {
        let mut pw = el(0, "Edit", "密码");
        pw.password = true;
        pw.value = Some("secret".into());
        pw.focused = true;
        let mut cb = el(0, "CheckBox", "记住我");
        cb.patterns = Patterns { toggle: true, toggled: Some(true), ..Default::default() };
        let p = prune(&[pw, cb], refs());
        assert_eq!(p.elements[0].value, None);
        assert_eq!(p.elements[0].states, vec!["focused", "password"]);
        assert_eq!(p.elements[1].states, vec!["checked"]);
        assert!(p.elements[1].clickable_by_pattern);
    }

    #[test]
    fn caps_element_count() {
        let raw: Vec<RawElement> = (0..MAX_ELEMENTS + 5).map(|i| el(0, "Button", &format!("b{i}"))).collect();
        let p = prune(&raw, refs());
        assert_eq!(p.elements.len(), MAX_ELEMENTS);
        assert_eq!(p.omitted, 5);
    }

    #[test]
    fn innermost_skips_ancestors_of_text_controls() {
        // 0 Document(text) > 1 Group(text) > 2 Text(text) ; 1 Terminal(text) > 2 Button
        let depths = [0, 1, 2, 1, 2];
        let flags = [true, true, true, true, false];
        assert_eq!(innermost(&depths, &flags), vec![false, false, true, true, false]);
    }

    #[test]
    fn normalizes_newlines_and_drops_text_that_repeats_the_name() {
        let mut doc = el(0, "Document", "");
        doc.value = Some("a\rb\r\nc".into());
        doc.text = Some("a\rb".into());
        let mut status = el(0, "Text", "行 1，\n列 1");
        status.text = Some("  行 1，列 1".into());
        let p = prune(&[doc, status], refs());
        assert_eq!(p.elements[0].value.as_deref(), Some("a\nb\nc"));
        assert_eq!(p.elements[0].text.as_deref(), Some("a\nb"));
        assert_eq!(p.elements[1].text, None);
    }

    #[test]
    fn text_keeps_the_tail() {
        let mut doc = el(0, "Document", "");
        doc.text = Some("x".repeat(MAX_TEXT + 10) + "END");
        let p = prune(&[doc], refs());
        assert!(p.elements[0].text.as_ref().unwrap().ends_with("END"));
    }
}
