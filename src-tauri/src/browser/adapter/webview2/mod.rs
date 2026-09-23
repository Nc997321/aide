//! WebView2 适配器（Windows）。
//!
//! 实现 `BrowserEngine`：可视子集 + 页面加载信号（create / navigate / reload / stop /
//! set_bounds / set_displayed / close）走 tauri `Webview` 自带方法；**agent 路径**（`eval` 带返回值、
//! `call_cdp`）下沉到同目录 `native.rs` —— 那是全仓库唯一 `use webview2_com` 的地方。
//!
//! 仍未实现、**如实报错**（不假装成功）：截图 `capture`（需 `CapturePreview`）、
//! cookie 清除 `cookies_clear`（需 `CookieManager`）。
//!
//! 线程（两条，都已在源码核实）：
//! - `add_child` / `eval` / `set_position` 内部 `run_on_main_thread` + 阻塞 `rx.recv()` →
//!   **必须从非主线程调用**（命令层用 `async fn` 跑在 tokio worker），否则主线程死锁；
//!   下钻层（`native.rs`）同理——它会在调用线程上等 COM 回调；
//! - `on_page_load` 回调**本身就在主线程**（wry 用 `Rc` 持有 handler）→ 回调里只准做纯状态变更，
//!   调上面那批方法或 `AppHandle::emit` 都会自锁（emit 的投递终点也是 `Webview::eval`）。

mod native;

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::webview::{PageLoadEvent, Webview, WebviewBuilder};
use tauri::window::Window;
use tauri::{LogicalPosition, LogicalSize, WebviewUrl, Wry};
use url::Url;

use crate::browser::port::engine::{BrowserEngine, CreateCfg, EngineError};
use crate::browser::port::types::{Bounds, BrowserViewId, PageLoadSignal};

/// 停靠点：远超任何真实客户区的固定逻辑坐标。子窗口被父窗口裁剪 ⇒ 用户看不见；
/// 而 HWND 保持 WS_VISIBLE、`SetIsVisible` **不动** ⇒ 引擎照常合成。
///
/// 依据（2026-09-21 一次性 wry 探针实测，`%TEMP%\wry-park-probe`）：parked 视图的 rAF 帧率、
/// `Page.captureScreenshot`、CDP 真实点击与前台视图**逐项等价**；对照组 `set_visible(false)`
/// 三项全灭（rAF 0 帧、截图永远不回包）。规格见
/// `docs/superpowers/specs/2026-09-21-agent-tabs-and-parking-design.md`。
const PARK_X: f64 = 20000.0;
const PARK_Y: f64 = 20000.0;

/// WebView2 引擎。`handles` 持有各视图的原生 `Webview` 句柄（id → handle），是句柄的唯一主人。
#[derive(Debug, Default)]
pub struct Webview2Engine {
    handles: Mutex<HashMap<BrowserViewId, Webview<Wry>>>,
}

impl Webview2Engine {
    pub fn new() -> Self {
        Self::default()
    }

    /// 子 webview 的 label：`browser-<id>`（窗口内唯一）。
    fn label(id: &BrowserViewId) -> String {
        format!("browser-{}", id.as_str())
    }

    /// 取出句柄副本（`Webview` 是 Arc 背书的 handle，可 Clone）——克隆后即释放锁，
    /// 后续 eval/set_position 等可能阻塞主线程的操作不在持锁期发生。
    fn handle(&self, id: &BrowserViewId) -> Result<Webview<Wry>, EngineError> {
        let map = self.lock()?;
        map.get(id)
            .cloned()
            .ok_or_else(|| EngineError::ViewNotFound(id.as_str().to_string()))
    }

    fn lock(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<BrowserViewId, Webview<Wry>>>, EngineError> {
        self.handles
            .lock()
            .map_err(|e| EngineError::Internal(format!("engine lock poisoned: {e}")))
    }
}

impl BrowserEngine for Webview2Engine {
    fn create(
        &self,
        window: &Window<Wry>,
        id: BrowserViewId,
        cfg: CreateCfg,
    ) -> Result<(), EngineError> {
        if self.lock()?.contains_key(&id) {
            return Err(EngineError::ViewAlreadyExists(id.as_str().to_string()));
        }

        // 观察者在 `cfg.initial_url` 被移进 builder 之前取出（partial move 顺序敏感）。
        let observer = cfg.on_page_load.clone();

        let mut builder =
            WebviewBuilder::new(Self::label(&id), WebviewUrl::External(cfg.initial_url))
                // 页面加载信号 → 端口观察者。WebView2 侧是 `ContentLoading` / `NavigationCompleted`
                // 两个事件（wry 映射，见 wry `webview2/mod.rs`）。
                //
                // ⚠️ 回调跑在**主线程**（wry 用 `Rc` 持有 handler，非 `Send`——已核实）：回调里只准
                // 调观察者做纯状态变更。任何 `eval` / `set_position` / `add_child` / `AppHandle::emit`
                // 都会 `run_on_main_thread` + 阻塞 `recv()` 等主线程自己 → **自锁**。
                .on_page_load(move |_webview, payload| {
                    if let Some(obs) = &observer {
                        let signal = match payload.event() {
                            PageLoadEvent::Started => PageLoadSignal::Started,
                            PageLoadEvent::Finished => PageLoadSignal::Finished,
                        };
                        obs.call(payload.url(), signal);
                    }
                });
        // 自定义 UA（OAuth/反爬场景会传；`None` 用内核默认）。
        if let Some(ua) = &cfg.user_agent {
            builder = builder.user_agent(ua);
        }
        // devtools 语义 = **不主动开**，而不是强制关：`false` 时不动内核默认值（debug 构建仍可
        // 开，保留排查内嵌页的能力），`true` 才显式打开。release 构建本就没有 devtools，安全不受影响。
        if cfg.devtools {
            builder = builder.devtools(true);
        }

        // 落点：displayed 的建在占位洞的矩形上；parked 的直接建在停靠点——
        // **不要"先建在洞上再挪走"**，那会闪一帧。
        let pos = if cfg.displayed {
            LogicalPosition::new(cfg.bounds.position().x(), cfg.bounds.position().y())
        } else {
            LogicalPosition::new(PARK_X, PARK_Y)
        };
        let size = LogicalSize::new(cfg.bounds.size().w(), cfg.bounds.size().h());

        // add_child 内部 run_on_main_thread + 阻塞 recv——调用方须在非主线程（async 命令）。
        let webview = window
            .add_child(builder, pos, size)
            .map_err(|e| EngineError::CreateFailed(e.to_string()))?;

        self.lock()?.insert(id, webview);
        Ok(())
    }

    fn navigate(&self, id: &BrowserViewId, url: &Url) -> Result<(), EngineError> {
        let wv = self.handle(id)?;
        // serde_json 给出带引号、已转义的 JS 字符串字面量，杜绝注入/引号截断。
        let literal = serde_json::to_string(url.as_str())
            .map_err(|e| EngineError::NavigationFailed(e.to_string()))?;
        wv.eval(format!("window.location.href = {literal};"))
            .map_err(|e| EngineError::NavigationFailed(e.to_string()))
    }

    fn reload(&self, id: &BrowserViewId) -> Result<(), EngineError> {
        let wv = self.handle(id)?;
        wv.eval("window.location.reload();")
            .map_err(|e| EngineError::NavigationFailed(e.to_string()))
    }

    fn stop(&self, id: &BrowserViewId) -> Result<(), EngineError> {
        let wv = self.handle(id)?;
        wv.eval("window.stop();")
            .map_err(|e| EngineError::NavigationFailed(e.to_string()))
    }

    fn set_bounds(&self, id: &BrowserViewId, bounds: Bounds) -> Result<(), EngineError> {
        let wv = self.handle(id)?;
        wv.set_position(LogicalPosition::new(
            bounds.position().x(),
            bounds.position().y(),
        ))
        .map_err(|e| EngineError::Internal(format!("set_position: {e}")))?;
        wv.set_size(LogicalSize::new(bounds.size().w(), bounds.size().h()))
            .map_err(|e| EngineError::Internal(format!("set_size: {e}")))
    }

    fn set_displayed(&self, id: &BrowserViewId, displayed: bool) -> Result<(), EngineError> {
        let wv = self.handle(id)?;
        if displayed {
            // 位置由随后的 `set_bounds` 给（面板的 showActive 就是这个顺序）；
            // 期间视图停在停靠点，没人看得见 ⇒ 不存在"闪在错位置"的问题。
            return wv
                .show()
                .map_err(|e| EngineError::Internal(format!("show: {e}")));
        }
        // **绝不调 `hide()`/`SetIsVisible(false)`**：那是内核级制动（不合成、rAF 停摆、
        // 截图取不到帧、输入丢弃）。parking 的全部理由就是绕开它——探针实测见 PARK 常量注释。
        wv.set_position(LogicalPosition::new(PARK_X, PARK_Y))
            .map_err(|e| EngineError::Internal(format!("park: {e}")))
    }

    fn eval(&self, id: &BrowserViewId, script: &str) -> Result<serde_json::Value, EngineError> {
        // 下钻裸 WebView2 取返回值（`native.rs`）。⚠️ 调用方须在**非主线程**——本函数会在调用
        // 线程上等 COM 回调；从主线程调 = 闭包内联 + 主线程阻塞等消息循环 = 自锁。
        let wv = self.handle(id)?;
        native::execute_script(&wv, script)
    }

    fn call_cdp(
        &self,
        id: &BrowserViewId,
        method: &str,
        params: &serde_json::Value,
    ) -> Result<serde_json::Value, EngineError> {
        // 同上：非主线程调用。CDP 域名可用性是**运行期行为**，失败原样上报，不假装成功。
        let wv = self.handle(id)?;
        native::call_cdp(&wv, method, params)
    }

    fn add_init_script(
        &self,
        id: &BrowserViewId,
        script: &str,
    ) -> Result<serde_json::Value, EngineError> {
        // 同 eval：下钻裸 WebView2 宿主 API（`native.rs`），**非主线程**调用。
        let wv = self.handle(id)?;
        native::add_init_script(&wv, script)
    }

    fn capture(&self, _id: &BrowserViewId) -> Result<Vec<u8>, EngineError> {
        Err(EngineError::CaptureFailed(
            "截图未实现（需 WebView2 CapturePreview）".into(),
        ))
    }

    fn cookies_clear(&self, _id: &BrowserViewId) -> Result<(), EngineError> {
        Err(EngineError::CookieFailed(
            "cookie 清除未实现（需 WebView2 CookieManager）".into(),
        ))
    }

    fn close(&self, id: &BrowserViewId) -> Result<(), EngineError> {
        let wv = self.handle(id)?;
        wv.close()
            .map_err(|e| EngineError::Internal(format!("close: {e}")))?;
        self.lock()?.remove(id);
        Ok(())
    }
}
