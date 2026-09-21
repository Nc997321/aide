//! 非 Windows 平台占位引擎：所有方法返回 `PlatformUnsupported`（v1 Windows-only，macOS/Linux v2 补）。
//! 存在意义：让 `PlatformEngine` 别名在所有平台都可解析，命令层零 `#[cfg]`（L3 平台隔离）。

use url::Url;

use crate::browser::port::engine::{BrowserEngine, CreateCfg, EngineError};
use crate::browser::port::types::{Bounds, BrowserViewId};

#[derive(Debug, Default)]
pub struct UnsupportedEngine;

impl UnsupportedEngine {
    pub fn new() -> Self {
        Self
    }
}

impl BrowserEngine for UnsupportedEngine {
    fn create(
        &self,
        _window: &tauri::Window<tauri::Wry>,
        _id: BrowserViewId,
        _cfg: CreateCfg,
    ) -> Result<(), EngineError> {
        Err(EngineError::PlatformUnsupported)
    }
    fn navigate(&self, _id: &BrowserViewId, _url: &Url) -> Result<(), EngineError> {
        Err(EngineError::PlatformUnsupported)
    }
    fn reload(&self, _id: &BrowserViewId) -> Result<(), EngineError> {
        Err(EngineError::PlatformUnsupported)
    }
    fn stop(&self, _id: &BrowserViewId) -> Result<(), EngineError> {
        Err(EngineError::PlatformUnsupported)
    }
    fn set_bounds(&self, _id: &BrowserViewId, _bounds: Bounds) -> Result<(), EngineError> {
        Err(EngineError::PlatformUnsupported)
    }
    fn set_displayed(&self, _id: &BrowserViewId, _displayed: bool) -> Result<(), EngineError> {
        Err(EngineError::PlatformUnsupported)
    }
    fn eval(&self, _id: &BrowserViewId, _script: &str) -> Result<serde_json::Value, EngineError> {
        Err(EngineError::PlatformUnsupported)
    }
    fn call_cdp(
        &self,
        _id: &BrowserViewId,
        _method: &str,
        _params: &serde_json::Value,
    ) -> Result<serde_json::Value, EngineError> {
        Err(EngineError::PlatformUnsupported)
    }
    fn capture(&self, _id: &BrowserViewId) -> Result<Vec<u8>, EngineError> {
        Err(EngineError::PlatformUnsupported)
    }
    fn cookies_clear(&self, _id: &BrowserViewId) -> Result<(), EngineError> {
        Err(EngineError::PlatformUnsupported)
    }
    fn close(&self, _id: &BrowserViewId) -> Result<(), EngineError> {
        Err(EngineError::PlatformUnsupported)
    }
}
