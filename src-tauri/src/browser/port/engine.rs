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

use std::sync::Arc;

use url::Url;

use crate::browser::port::types::{Bounds, BrowserViewId, PageLoadSignal};

/// 页面加载观察者：引擎每观测到一次加载信号回调一次。
///
/// **线程契约（已核实，别踩）**：回调在 webview 所属线程执行（Windows = 主线程——wry 用 `Rc`
/// 持有该 handler，非 `Send`）。因此回调里**只准做纯状态变更**：
/// - 调 `eval` / `set_position` / `set_size` / `add_child` → 内部 `run_on_main_thread` + 阻塞
///   `rx.recv()`，主线程等自己 = **死锁**；
/// - 调 `AppHandle::emit` → 事件投递终点是 `Webview::eval`，同一把锁 = **同样死锁**（广播必须
///   交给 worker，见 `facade::apply_page_load`）。
#[derive(Clone)]
pub struct PageLoadObserver(Arc<dyn Fn(&Url, PageLoadSignal) + Send + Sync + 'static>);

impl PageLoadObserver {
    pub fn new(f: impl Fn(&Url, PageLoadSignal) + Send + Sync + 'static) -> Self {
        Self(Arc::new(f))
    }

    pub fn call(&self, url: &Url, signal: PageLoadSignal) {
        (self.0)(url, signal)
    }
}

impl std::fmt::Debug for PageLoadObserver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("<page-load observer>")
    }
}

/// 创建配置。对象化避免相邻同类型裸传（S2）；可选字段在后（S5）。
#[derive(Debug, Clone)]
pub struct CreateCfg {
    /// 初始加载的 URL（已过 `url_guard`）。
    pub initial_url: Url,
    /// 初始矩形（占位 div 的屏幕坐标）。
    pub bounds: Bounds,
    /// 自定义 UA（OAuth/反爬可能需要）；`None` 用内核默认。
    pub user_agent: Option<String>,
    /// 是否**主动**开 devtools（`false` = 不动内核默认：debug 构建仍可开，release 本就没有）。
    /// 不是"强制关"——那样会把 dev 下的排查能力也关掉（plan §8 的安全要求由 release 构建保证）。
    pub devtools: bool,
    /// 页面加载信号回传口。`None` = 不关心（无广播需求）。
    pub on_page_load: Option<PageLoadObserver>,
}

/// 引擎调用失败原因。具体错误类型（rust 技能 §四：库代码定义具体错误，应用层汇总传播）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineError {
    ViewNotFound(String),
    ViewAlreadyExists(String),
    CreateFailed(String),
    NavigationFailed(String),
    EvalFailed(String),
    /// 裸 CDP 调用失败（`CallDevToolsProtocolMethod`）。与 `EvalFailed` 分开：CDP 域名不可用、
    /// 参数形状错、内核版本不支持，排查路径与脚本注入完全不同。
    CdpFailed(String),
    CaptureFailed(String),
    CookieFailed(String),
    /// 引擎内部错误（锁中毒、几何设置失败等），带上下文。
    Internal(String),
    /// 当前平台无适配器（macOS/Linux v1 未实现）。Windows 构建里无人构造（那个分支的
    /// `UnsupportedEngine` 被 cfg 掉），故按平台门控 allow——非 Windows 构建下它是活路径。
    #[cfg_attr(windows, allow(dead_code))]
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
            EngineError::CdpFailed(detail) => write!(f, "devtools protocol call failed: {detail}"),
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
// 未接线的方法（stop / capture / cookies_clear）是**端口完整能力面**，不是空壳：
// - capture：用途③「本地预览」的地基（当前如实返回「未实现」的错误，不假装成功）；
// - stop：UI 停止加载按钮（下一批）；
// - cookies_clear：用途④ OAuth 的隔离清理。
// 它们是设计文档 §6 承诺的扩展面（agent 工具从 facade 进、调的就是这些方法），故保留接线前的
// allow；**新增方法前先问一句「谁调它」**——答不上来就别加（死代码直接删，不靠 allow 留尸）。
//
// 注：`eval` / `call_cdp` 已实现（裸 WebView2 下钻），消费方是 agent 桥（`browser/agent_bridge.rs`
// → facade）。等桥接线完成后，本 trait 的整块 `#[allow(dead_code)]` 应只覆盖上面三个未接线项，
// 而不是整个 trait——别让它继续当遮盖。
#[allow(dead_code)]
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
    ///
    /// **脚本契约**：经此方法执行的脚本必须返回信封 `{ok: true|false, ...}`——`ExecuteScript`
    /// 在页面脚本抛异常时回 `null`，与「脚本确实返回 null」不可区分（详见 adapter 的 `native.rs`）。
    fn eval(&self, id: &BrowserViewId, script: &str) -> Result<serde_json::Value, EngineError>;

    /// agent 操作任务：裸 CDP 调用（WebView2 `CallDevToolsProtocolMethod`）。
    /// 用途 = 真实输入事件（`Input.dispatchMouseEvent`）、文件上传（`DOM.setFileInputFiles`）。
    ///
    /// ⚠️ WebView2 对部分 CDP 域名有限制，可用性是运行期行为——调用方必须把失败**如实上报**，
    /// 不许静默降级假装成功。
    fn call_cdp(
        &self,
        id: &BrowserViewId,
        method: &str,
        params: &serde_json::Value,
    ) -> Result<serde_json::Value, EngineError>;

    /// agent 网页任务：截图为 PNG 字节（WebView2 `CapturePreview`）。
    fn capture(&self, id: &BrowserViewId) -> Result<Vec<u8>, EngineError>;

    /// OAuth：清空 cookie/存储（WebView2 `CoreWebView2Profile` / CookieManager）。
    fn cookies_clear(&self, id: &BrowserViewId) -> Result<(), EngineError>;

    fn close(&self, id: &BrowserViewId) -> Result<(), EngineError>;
}
