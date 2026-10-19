//! 与平台无关的数据形状：适配器产出原始数据，策略层裁剪、编号、比对后回给 agent。

use serde::Serialize;

/// 矩形（物理像素，屏幕坐标）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn center(&self) -> (i32, i32) {
        (self.x + self.w / 2, self.y + self.h / 2)
    }
    pub fn is_empty(&self) -> bool {
        self.w <= 0 || self.h <= 0
    }
}

/// 一个顶层窗口。`id` 是平台句柄的字符串形式，agent 原样传回。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WindowInfo {
    pub id: String,
    pub title: String,
    pub process: String,
    pub pid: u32,
    pub foreground: bool,
    pub minimized: bool,
    /// `false` = 系统不允许 Aide 往里面输入（Windows：目标以更高权限运行，UIPI 拦截）。
    pub accessible: bool,
    pub bounds: Rect,
}

/// 元素支持的交互模式（UIA 的 Pattern；其他平台的辅助功能 API 有对应物）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Patterns {
    pub invoke: bool,
    pub toggle: bool,
    /// `Some(true)` = 选中/打开；`None` = 不可切换或状态未知。
    pub toggled: Option<bool>,
    pub select: bool,
    pub selected: bool,
    pub expand: bool,
    /// `Some(true)` = 已展开。
    pub expanded: Option<bool>,
    /// 有 ValuePattern 且可写。
    pub value_editable: bool,
    pub text: bool,
}

/// 适配器读出的一个元素（先序遍历，`depth` 是原始树深度）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RawElement {
    /// 平台的元素身份（UIA RuntimeId）。空 = 拿不到，策略层每次给新编号。
    pub runtime_id: Vec<i32>,
    /// 控件类型名，如 `Button` / `Edit` / `Document`。
    pub role: String,
    pub name: String,
    pub value: Option<String>,
    /// 文字控件（文档 / 终端）里的文字，已按读取参数截好。
    pub text: Option<String>,
    pub depth: u16,
    pub bounds: Rect,
    pub enabled: bool,
    pub focused: bool,
    pub focusable: bool,
    pub password: bool,
    pub patterns: Patterns,
}

/// 一次读取的原始结果。
#[derive(Debug, Clone)]
pub struct RawTree {
    pub window: WindowInfo,
    pub elements: Vec<RawElement>,
    /// 原始树太大被适配器截断。
    pub truncated: bool,
}

/// 窗口截图。
#[derive(Debug, Clone)]
pub struct Shot {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// 图像像素 / 屏幕物理像素。
    pub scale: f64,
    /// 图像左上角对应的屏幕坐标。
    pub origin: (i32, i32),
}

/// 回给 agent 的元素（已裁剪、已编号）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ViewElement {
    #[serde(rename = "ref")]
    pub ref_id: String,
    pub role: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub states: Vec<&'static str>,
    pub depth: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// 内部用：元素身份与可交互方式，不序列化给 agent。
    #[serde(skip)]
    pub runtime_id: Vec<i32>,
    /// 单击能不动鼠标地完成时用哪种方式（见 [`click_via`]）；`None` = 用真实鼠标。
    #[serde(skip)]
    pub click_via: Option<ClickVia>,
    /// 能接收打字（输入框、文档、终端这类）。见 [`takes_text`]。
    #[serde(skip)]
    pub takes_text: bool,
}

/// 鼠标按键。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Right,
}

/// 滚动方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Up,
    Down,
    Left,
    Right,
}

/// 窗口级动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowAction {
    Launch,
    Focus,
    Minimize,
    Maximize,
    Restore,
    Close,
}

/// 不动鼠标完成「单击」的方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClickVia {
    Select,
    Invoke,
    Toggle,
    ExpandCollapse,
}

impl ClickVia {
    pub fn verb(self) -> &'static str {
        match self {
            Self::Select => "selected",
            Self::Invoke => "invoked",
            Self::Toggle => "toggled",
            Self::ExpandCollapse => "expanded/collapsed",
        }
    }
}

const TEXT_ROLES: &[&str] = &["Edit", "Document", "ComboBox"];

/// 这个控件能不能接收打字：可写值、文字控件（文档 / 终端），或输入类控件。
/// 按钮、列表项这类「点的」控件不收字——对它们 `type` 是用错了工具。
pub fn takes_text(role: &str, p: &Patterns) -> bool {
    p.value_editable || p.text || TEXT_ROLES.contains(&role)
}

const INVOKE_ROLES: &[&str] = &["Button", "Hyperlink", "MenuItem", "SplitButton"];
const EXPAND_ROLES: &[&str] = &["ComboBox", "MenuItem"];

/// 真人「单击一下」对这个控件意味着什么，就用对应的模式；对不上就返回 `None` 走真实鼠标。
///
/// **可选中的项一律「选中」，绝不「执行」**：列表项、树节点上的 Invoke 是默认动作（= 双击打开），
/// 实测对文件列表项 Invoke 把文件打开了。Invoke 只用于按钮、链接、菜单项。
pub fn click_via(role: &str, p: &Patterns) -> Option<ClickVia> {
    if p.select {
        return Some(ClickVia::Select);
    }
    if p.toggle {
        return Some(ClickVia::Toggle);
    }
    if p.invoke && INVOKE_ROLES.contains(&role) {
        return Some(ClickVia::Invoke);
    }
    if p.expand && EXPAND_ROLES.contains(&role) {
        return Some(ClickVia::ExpandCollapse);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pats(f: impl FnOnce(&mut Patterns)) -> Patterns {
        let mut p = Patterns::default();
        f(&mut p);
        p
    }

    #[test]
    fn list_items_are_selected_never_invoked() {
        let both = pats(|p| {
            p.invoke = true;
            p.select = true;
        });
        assert_eq!(click_via("ListItem", &both), Some(ClickVia::Select));
        // 只有 Invoke 的列表项：Invoke 是「打开」，改用真实鼠标
        assert_eq!(click_via("ListItem", &pats(|p| p.invoke = true)), None);
        assert_eq!(click_via("TreeItem", &pats(|p| { p.select = true; p.expand = true; })), Some(ClickVia::Select));
    }

    #[test]
    fn what_takes_typed_text() {
        assert!(takes_text("Edit", &Patterns::default()));
        assert!(takes_text("Text", &pats(|p| p.text = true))); // 终端
        assert!(takes_text("Group", &pats(|p| p.value_editable = true)));
        assert!(!takes_text("Button", &pats(|p| p.invoke = true)));
        assert!(!takes_text("ListItem", &pats(|p| p.select = true)));
    }

    #[test]
    fn buttons_links_and_toggles() {
        assert_eq!(click_via("Button", &pats(|p| p.invoke = true)), Some(ClickVia::Invoke));
        assert_eq!(click_via("Hyperlink", &pats(|p| p.invoke = true)), Some(ClickVia::Invoke));
        assert_eq!(click_via("CheckBox", &pats(|p| p.toggle = true)), Some(ClickVia::Toggle));
        assert_eq!(click_via("ComboBox", &pats(|p| p.expand = true)), Some(ClickVia::ExpandCollapse));
        assert_eq!(click_via("Edit", &pats(|p| p.value_editable = true)), None);
        assert_eq!(click_via("Group", &pats(|p| p.invoke = true)), None);
    }
}
