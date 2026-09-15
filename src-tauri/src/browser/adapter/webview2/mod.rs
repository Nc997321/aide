//! WebView2 适配器（Windows）。
//!
//! 实现 `BrowserEngine` 的可视子集 + 页面加载信号：create（含 `on_page_load` 观察者接线）/
//! navigate / reload / stop / set_bounds / set_visible / close。这些只用 tauri `Webview` 自带方法
//! （`add_child` / `eval` / `set_position` / `set_size` / `show` / `hide` / `close`），
//! **不引 webview2-com**。
//!
//! 截图（capture）、带返回值的脚本注入（eval→Value）、cookie 清除需下钻裸 WebView2
//! （`with_webview(|pw| pw.controller())` → `ICoreWebView2` 的 CapturePreview/ExecuteScript/
//! CookieManager）——**这是 agent 路径的地基（下一批）**，现在如实返回带说明的 `EngineError`，
//! 不静默假装成功。
//!
//! 线程（两条，都已在源码核实）：
//! - `add_child` / `eval` / `set_position` 内部 `run_on_main_thread` + 阻塞 `rx.recv()` →
//!   **必须从非主线程调用**（命令层用 `async fn` 跑在 tokio worker），否则主线程死锁；
//! - `on_page_load` 回调**本身就在主线程**（wry 用 `Rc` 持有 handler）→ 回调里只准做纯状态变更，
//!   调上面那批方法或 `AppHandle::emit` 都会自锁（emit 的投递终点也是 `Webview::eval`）。

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::webview::{PageLoadEvent, Webview, WebviewBuilder};
use tauri::window::Window;
use tauri::{LogicalPosition, LogicalSize, WebviewUrl, Wry};
use url::Url;

use crate::browser::port::engine::{BrowserEngine, CreateCfg, EngineError};
use crate::browser::port::types::{Bounds, BrowserViewId, PageLoadSignal};

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

        let pos = LogicalPosition::new(cfg.bounds.position().x(), cfg.bounds.position().y());
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

    fn set_visible(&self, id: &BrowserViewId, visible: bool) -> Result<(), EngineError> {
        let wv = self.handle(id)?;
        if visible {
            wv.show()
                .map_err(|e| EngineError::Internal(format!("show: {e}")))
        } else {
            wv.hide()
                .map_err(|e| EngineError::Internal(format!("hide: {e}")))
        }
    }

    fn eval(&self, id: &BrowserViewId, script: &str) -> Result<serde_json::Value, EngineError> {
        // 原型：fire-and-forget 注入（无返回值）。带返回值的 eval 需 WebView2 ExecuteScript
        // 的异步 completed-handler，属完整 adapter 阶段（需 webview2-com）。
        let wv = self.handle(id)?;
        wv.eval(script)
            .map_err(|e| EngineError::EvalFailed(e.to_string()))?;
        Ok(serde_json::Value::Null)
    }

    fn capture(&self, _id: &BrowserViewId) -> Result<Vec<u8>, EngineError> {
        Err(EngineError::CaptureFailed(
            "截图需 WebView2 CapturePreview（完整 adapter 阶段，需 webview2-com）".into(),
        ))
    }

    fn cookies_clear(&self, _id: &BrowserViewId) -> Result<(), EngineError> {
        Err(EngineError::CookieFailed(
            "cookie 清除需 WebView2 CookieManager（完整 adapter 阶段，需 webview2-com）".into(),
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
