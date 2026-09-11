//! 端口：浏览器内核能力契约。trait 表达能力，不表达分类（rust 技能 §五）。
//!
//! v1 仅 `Webview2Engine`（adapter/webview2）；macOS/Linux 经 `UnsupportedEngine` 占位，v2 补。
//! **可替换的是「引擎」**（WebView2 / WKWebView / WebKitGTK），tauri 是宿主框架（常量）——
//! 故 trait 引用 `tauri::Window` 合理；引擎实现藏 adapter 后，命令层零 `cfg`（L3 平台隔离）。
//!
//! `create` 取 `&Window<Wry>`：`add_child` 是 `Window` 的方法（已核实），命令层用
//! `app.get_window("main")` 取得（`Manager::get_window`，unstable-gated）。
//!
//! 线程契约：实现方负责把对原生视图的调用编组到 webview 所属线程（经 `Webview::with_webview`）。
//! 调用方（命令层）**不可**对这些调用 `spawn_blocking`（会跑到错误线程，plan §10#3）。

use url::Url;

use crate::browser::port::types::{Bounds, BrowserViewId};

/// 创建配置。对象化避免相邻同类型裸传（S2）；可选字段在后（S5）。
#[derive(Debug, Clone)]
pub struct CreateCfg {
    /// 初始加载的 URL（已过 `url_guard`）。
    pub initial_url: Url,
    /// 初始矩形（占位 div 的屏幕坐标）。
    pub bounds: Bounds,
    /// 自定义 UA（OAuth/反爬可能需要）；`None` 用内核默认。
    pub user_agent: Option<String>,
    /// 是否开 devtools。release 默认 `false`（安全要求，plan §8）。
    pub devtools: bool,
}

/// 引擎调用失败原因。具体错误类型（rust 技能 §四：库代码定义具体错误，应用层汇总传播）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineError {
    ViewNotFound(String),
    ViewAlreadyExists(String),
    CreateFailed(String),
    NavigationFailed(String),
    EvalFailed(String),
    CaptureFailed(String),
    CookieFailed(String),
    /// 引擎内部错误（锁中毒、几何设置失败等），带上下文。
    Internal(String),
    /// 当前平台无适配器（macOS/Linux v1 未实现）。
    PlatformUnsupported,
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::ViewNotFound(id) => write!(f, "browser view not found: {id}"),
            EngineError::ViewAlreadyExists(id) => write!(f, "browser view already exists: {id}"),
            EngineError::CreateFailed(detail) => write!(f, "create browser view failed: {detail}"),
            EngineError::NavigationFailed(detail) => write!(f, "navigation failed: {detail}"),
            EngineError::EvalFailed(detail) => write!(f, "script eval failed: {detail}"),
            EngineError::CaptureFailed(detail) => write!(f, "capture failed: {detail}"),
            EngineError::CookieFailed(detail) => write!(f, "cookie operation failed: {detail}"),
            EngineError::Internal(detail) => write!(f, "browser engine internal error: {detail}"),
            EngineError::PlatformUnsupported => {
                write!(f, "no embedded-browser adapter on this platform")
            }
        }
    }
}

impl std::error::Error for EngineError {}

/// 浏览器内核能力端口。每个方法 ≤4 输入（S1）；只读借用取最弱类型（S5：`&BrowserViewId`/`&Url`/`&str`）。
///
/// 注：**前进后退不在端口上**——历史/游标的唯一主人是 `BrowserView`（领域层），外壳取
/// `view.go_back() -> Option<Url>` 后调 `navigate`。引擎不另记一份历史（避免双主人）。
pub trait BrowserEngine: Send + Sync {
    /// 在 `window` 内创建一个加载 `cfg.initial_url` 的子视图。
    fn create(
        &self,
        window: &tauri::Window<tauri::Wry>,
        id: BrowserViewId,
        cfg: CreateCfg,
    ) -> Result<(), EngineError>;

    fn navigate(&self, id: &BrowserViewId, url: &Url) -> Result<(), EngineError>;
    fn reload(&self, id: &BrowserViewId) -> Result<(), EngineError>;
    fn stop(&self, id: &BrowserViewId) -> Result<(), EngineError>;

    /// 布局同步：把占位 div 的矩形拍到原生视图。
    fn set_bounds(&self, id: &BrowserViewId, bounds: Bounds) -> Result<(), EngineError>;
    fn set_visible(&self, id: &BrowserViewId, visible: bool) -> Result<(), EngineError>;

    /// agent 网页任务：注入脚本并取回 JSON 结果（WebView2 `ExecuteScript`）。
    fn eval(&self, id: &BrowserViewId, script: &str) -> Result<serde_json::Value, EngineError>;
    /// agent 网页任务：截图为 PNG 字节（WebView2 `CapturePreview`）。
    fn capture(&self, id: &BrowserViewId) -> Result<Vec<u8>, EngineError>;

    /// OAuth：清空 cookie/存储（WebView2 `CoreWebView2Profile` / CookieManager）。
    fn cookies_clear(&self, id: &BrowserViewId) -> Result<(), EngineError>;

    fn close(&self, id: &BrowserViewId) -> Result<(), EngineError>;
}
