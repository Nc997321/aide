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
    #[serde(skip)]
    pub clickable_by_pattern: bool,
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

/// 适配器能直接做的「点一下」语义（不动鼠标）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PatternClick {
    /// 已用某个模式完成；字符串是用的哪种（回报里给 agent 看）。
    Done(&'static str),
    /// 元素不支持任何「点一下」模式，调用方改用真实鼠标。
    Unsupported,
}
