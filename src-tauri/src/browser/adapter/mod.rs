//! 适配层：唯一允许碰 `webview2-com` / `wry` 的地方（端口隔离红线，见 browser/mod.rs）。
//! v1 仅 Windows 实现；macOS（WKWebView）/ Linux（WebKitGTK）v2 在此并列补 `pub mod`。
//!
//! `PlatformEngine` 别名把平台选择收口于此——命令层只认 `PlatformEngine`，零 `#[cfg]`（L3）。

#[cfg(windows)]
pub mod webview2;

#[cfg(not(windows))]
pub mod unsupported;

/// 平台引擎统一别名。Windows = `Webview2Engine`；其它平台 = `UnsupportedEngine`（方法返回
/// `PlatformUnsupported`，v1 Windows-only）。命令层与 state 注册据此零 `cfg`。
#[cfg(windows)]
pub type PlatformEngine = webview2::Webview2Engine;

#[cfg(not(windows))]
pub type PlatformEngine = unsupported::UnsupportedEngine;
