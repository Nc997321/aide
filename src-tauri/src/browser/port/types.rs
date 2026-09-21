//! 浏览器视图领域类型：纯逻辑、无 IO、状态机封闭（make illegal states unrepresentable）。
//! 设计见 docs/superpowers/plans/2026-09-10-embedded-browser.md §5。
//!
//! 红线对齐：M1 禁贫血（状态+行为同处，字段私有走方法）/ M5 枚举封闭状态（不堆 bool 旗帜）/
//! M6 变更守门（非法值入口拒绝）/ M2 组合层级（Bounds 持 Position+Size）/ 二 newtype 封闭合法值。

use url::Url;

use crate::browser::core::nav_decision;

// ── BrowserViewId：newtype 封闭「非空」不变量 ──────────────────────────────

/// 浏览器视图标识。newtype 封闭合法值：非空才造得出来（rust 技能 §二）。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct BrowserViewId(String);

impl BrowserViewId {
    /// 守门创建：拒绝空串与全空白（M6——非法值入口拒绝，决策权交调用方）。
    pub fn try_new(raw: impl Into<String>) -> Result<Self, BrowserViewIdError> {
        let s = raw.into();
        if s.trim().is_empty() {
            return Err(BrowserViewIdError::Empty);
        }
        Ok(Self(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowserViewIdError {
    Empty,
}

impl std::fmt::Display for BrowserViewIdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BrowserViewIdError::Empty => write!(f, "browser view id must not be empty"),
        }
    }
}

impl std::error::Error for BrowserViewIdError {}

// ── Position / Size / Bounds：逻辑像素几何（M2 组合） ───────────────────────

/// 逻辑像素坐标（已除 devicePixelRatio）。x/y 可为负——视图可被刻意移到屏外隐藏。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Position {
    x: f64,
    y: f64,
}

impl Position {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
    pub fn x(&self) -> f64 {
        self.x
    }
    pub fn y(&self) -> f64 {
        self.y
    }
}

/// 逻辑像素尺寸。不变量：宽/高非负、非 NaN——`try_new` 守门，非法值造不出来（M5/M6）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Size {
    w: f64,
    h: f64,
}

impl Size {
    /// 守门：拒绝负或 NaN 宽高（M6）。
    pub fn try_new(w: f64, h: f64) -> Result<Self, SizeError> {
        if w.is_nan() || h.is_nan() {
            return Err(SizeError::NotFinite { w, h });
        }
        if w < 0.0 || h < 0.0 {
            return Err(SizeError::Negative { w, h });
        }
        Ok(Self { w, h })
    }

    /// 零尺寸（隐藏态用）。
    pub const ZERO: Self = Self { w: 0.0, h: 0.0 };

    pub fn w(&self) -> f64 {
        self.w
    }
    pub fn h(&self) -> f64 {
        self.h
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum SizeError {
    Negative { w: f64, h: f64 },
    NotFinite { w: f64, h: f64 },
}

impl std::fmt::Display for SizeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SizeError::Negative { w, h } => write!(f, "size must be non-negative (w={w}, h={h})"),
            SizeError::NotFinite { w, h } => write!(f, "size must be finite (w={w}, h={h})"),
        }
    }
}

impl std::error::Error for SizeError {}

/// 视图矩形 = 位置 + 尺寸（M2 组合）。`new` 取两个**不同类型**参数，规避 4 个相邻 f64 的 S2 风险；
/// 真正的调用点是 DTO（命名字段）经 `TryFrom` 构造，不存在裸位置传参。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bounds {
    pos: Position,
    size: Size,
}

impl Bounds {
    pub fn new(pos: Position, size: Size) -> Self {
        Self { pos, size }
    }

    pub fn position(&self) -> Position {
        self.pos
    }
    pub fn size(&self) -> Size {
        self.size
    }

    /// 隐藏态：移到屏外远端 + 零尺寸（plan §6：切 tab 时把原生视图挪走，否则它浮在全部内容之上）。
    pub fn hidden() -> Self {
        Self {
            pos: Position::new(-100_000.0, -100_000.0),
            size: Size::ZERO,
        }
    }
}

// ── NavState：导航状态机（M5 枚举封闭，不堆 bool 旗帜） ─────────────────────

/// 导航状态。四种互斥状态合成一个枚举——「既 loading 又 failed」这类非法组合无法表示。
#[derive(Debug, Clone, PartialEq)]
pub enum NavState {
    /// 已创建但尚未发起任何导航。
    Idle,
    /// 正在加载 `url`。
    Loading { url: Url },
    /// 加载完成。
    Ready { url: Url, title: String },
    /// 加载失败。
    Failed { url: Url, reason: String },
}

/// 引擎观测到的页面加载信号（端口词汇：引擎只报「开始/完成」，不认识用途）。
///
/// 存在理由：**页面内点击/重定向/脚本跳转由 WebView2 自己发起**，我们的 `begin_nav` 看不见
/// 它们。不吸收这些信号，地址栏就永远停在最后一次命令发出的 URL 上。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageLoadSignal {
    /// 内容开始加载（WebView2 `ContentLoading`）。
    Started,
    /// 导航完成（WebView2 `NavigationCompleted`）。
    ///
    /// ⚠️ 该事件**成功与失败都会发**（`NavigationCompleted.IsSuccess` 被 wry 丢弃，事件里带不出来），
    /// 所以 v1 的 `Finished` 一律当成功、`fail_nav` 暂时无人调用；根治 = 下一批下钻 webview2-com
    /// 读 `IsSuccess`（见 docs 续作路线）。
    Finished,
}

/// `BrowserView` 状态机的非法变更（M6：拒绝并交调用方决策，不静默接受）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ViewError {
    /// `finish_nav`/`fail_nav` 只能在 `Loading` 态调用。
    NotLoading,
}

impl std::fmt::Display for ViewError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ViewError::NotLoading => {
                write!(f, "navigation completion only valid while loading")
            }
        }
    }
}

impl std::error::Error for ViewError {}

// ── BrowserView：状态 + 行为同处（M1），历史/游标唯一主人 ───────────────────

/// 一个浏览器视图的领域状态。字段私有，变更走守门方法（M1 禁贫血）。
///
/// **历史/游标的唯一主人**：前进后退是「移动 `cursor` 并返回目标 URL」，真正的加载 IO 由外壳
/// （命令层）调引擎 `navigate` 执行——领域对象不碰 IO（纯核心+薄外壳）。引擎不再各自记一份历史，
/// 避免双份记账违反「数据有且只有一个主人」。
/// 视图是谁开的。**用户在标签条上一眼要能分**（三个 agent 各一个 tab 时尤其）。
///
/// 领域类型**不带 serde**：跨 IPC 的形态是 `dto::OriginDto`，转换在边界做（M3）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BrowserOrigin {
    #[default]
    User,
    Agent,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BrowserView {
    id: BrowserViewId,
    nav: NavState,
    bounds: Bounds,
    displayed: bool,
    /// 创建时给的名字（页面没有 `<title>` 时标签条用它，agent 靠它给 tab 起名）。
    label: Option<String>,
    origin: BrowserOrigin,
    /// 已访问 URL 栈；`cursor` 指向当前项。`Idle` 时为空、`cursor == 0`（瞬态，can_go_* 均为 false）。
    history: Vec<Url>,
    cursor: usize,
}

impl BrowserView {
    /// 新建：`Idle` 态、空历史、可见。`bounds` 已是校验过的值（`Size::try_new` 在构造时守门）。
    pub fn new(id: BrowserViewId, bounds: Bounds) -> Self {
        Self {
            id,
            nav: NavState::Idle,
            bounds,
            displayed: true,
            label: None,
            origin: BrowserOrigin::User,
            history: Vec::new(),
            cursor: 0,
        }
    }

    pub fn id(&self) -> &BrowserViewId {
        &self.id
    }
    pub fn nav(&self) -> &NavState {
        &self.nav
    }
    pub fn bounds(&self) -> Bounds {
        self.bounds
    }
    /// 是否露在面板上。**不是**"引擎能不能用"——parked 的视图引擎照样活着（合成/输入/截图全在），
    /// 只是没人看得见（见 `adapter/webview2/mod.rs` 的 PARK 常量）。
    pub fn displayed(&self) -> bool {
        self.displayed
    }

    /// 当前 URL（`Loading`/`Ready`/`Failed` 携带；`Idle` 无）。
    pub fn current_url(&self) -> Option<&Url> {
        match &self.nav {
            NavState::Idle => None,
            NavState::Loading { url }
            | NavState::Ready { url, .. }
            | NavState::Failed { url, .. } => Some(url),
        }
    }

    /// 发起新导航：截断 `cursor` 之后的前进分支、压栈、置 `Loading`。
    /// `url` 已是 `url_guard` 校验过的 `Url`，类型即合法性，无需再守门（rust 技能 §二）。
    pub fn begin_nav(&mut self, url: Url) {
        // 丢弃前进分支：从 a→b→c 后退到 b 再去 d，历史变 a→b→d，c 被截断。
        self.history.truncate(self.cursor.saturating_add(1));
        self.history.push(url.clone());
        self.cursor = self.history.len() - 1;
        self.nav = NavState::Loading { url };
    }

    /// 加载完成：仅 `Loading` 合法，否则拒绝（M5/M6 状态机守门——非法跳转造不出来）。
    pub fn finish_nav(&mut self, title: String) -> Result<(), ViewError> {
        let url = self.loading_url()?;
        self.nav = NavState::Ready { url, title };
        Ok(())
    }

    /// 加载失败：仅 `Loading` 合法，否则拒绝。
    pub fn fail_nav(&mut self, reason: String) -> Result<(), ViewError> {
        let url = self.loading_url()?;
        self.nav = NavState::Failed { url, reason };
        Ok(())
    }

    /// 取当前 `Loading` 的 url，非 `Loading` 则 `NotLoading`。`finish_nav`/`fail_nav` 共用守门。
    fn loading_url(&self) -> Result<Url, ViewError> {
        match &self.nav {
            NavState::Loading { url } => Ok(url.clone()),
            _ => Err(ViewError::NotLoading),
        }
    }

    /// 同一个 URL 的重新加载：不压历史（历史只在真正的新导航上增长），仅把状态置回 `Loading`。
    /// 返回是否发生变化——`false` = 已经在加载同一个 URL（重复信号，调用方不广播）。
    ///
    /// 浏览器惯例：地址栏输入当前 URL 回车、⟳ 按钮，都算重载而不是新导航；否则「后退」会退到
    /// 同一个页面（看起来像坏了）。
    pub fn reload_current(&mut self) -> bool {
        match self.current_url().cloned() {
            Some(url) if !matches!(self.nav, NavState::Loading { .. }) => {
                self.nav = NavState::Loading { url };
                true
            }
            _ => false,
        }
    }

    /// 吸收一次引擎观测到的页面加载事件（含页面内点击/重定向/脚本跳转）。
    /// 返回是否发生状态迁移——`false` = 陈旧/重复信号，调用方**不广播**（事件通道只报真变化）。
    ///
    /// 已知代价（下一批根治）：重定向链会逐跳压历史，镜像与 WebView2 真历史会漂移；根治 = 把
    /// 前进后退整体委托给 WebView2（`CanGoBackChanged` 驱动按钮态），届时删掉本镜像。
    pub fn absorb_page_load(&mut self, url: Url, signal: PageLoadSignal) -> bool {
        match signal {
            PageLoadSignal::Started => {
                if self.current_url() == Some(&url) {
                    return self.reload_current();
                }
                self.begin_nav(url);
                true
            }
            PageLoadSignal::Finished => {
                if !matches!(self.nav, NavState::Loading { .. }) {
                    return false;
                }
                // title 待 webview2-com 的 DocumentTitleChanged（本批留空，前端展示 URL）。
                let _ = self.finish_nav(String::new());
                true
            }
        }
    }

    pub fn can_go_back(&self) -> bool {
        nav_decision::back_cursor(self.cursor).is_some()
    }
    pub fn can_go_forward(&self) -> bool {
        nav_decision::forward_cursor(self.cursor, self.history.len()).is_some()
    }

    /// 后退：移动游标并置 `Loading`，返回外壳应加载的 URL。无可退则 `None` 且**不改任何状态**。
    pub fn go_back(&mut self) -> Option<Url> {
        let cursor = nav_decision::back_cursor(self.cursor)?;
        Some(self.move_cursor_to(cursor))
    }

    /// 前进：对称于 [`go_back`](Self::go_back)。
    pub fn go_forward(&mut self) -> Option<Url> {
        let cursor = nav_decision::forward_cursor(self.cursor, self.history.len())?;
        Some(self.move_cursor_to(cursor))
    }

    /// 游标移到 `cursor`（调用方已保证在界内）、置 `Loading`、返回目标 URL。
    fn move_cursor_to(&mut self, cursor: usize) -> Url {
        self.cursor = cursor;
        let url = self.history[cursor].clone();
        self.nav = NavState::Loading { url: url.clone() };
        url
    }

    /// 布局同步：`bounds` 已是校验过的值，直接落（plan §6 坐标同步）。
    pub fn set_bounds(&mut self, bounds: Bounds) {
        self.bounds = bounds;
    }

    pub fn set_displayed(&mut self, displayed: bool) {
        self.displayed = displayed;
    }

    /// 创建时给的名字（页面标题为空时标签条用它）。
    pub fn label(&self) -> Option<&str> {
        self.label.as_deref()
    }
    pub fn set_label(&mut self, label: Option<String>) {
        self.label = label;
    }
    pub fn origin(&self) -> BrowserOrigin {
        self.origin
    }
    pub fn set_origin(&mut self, origin: BrowserOrigin) {
        self.origin = origin;
    }
}
