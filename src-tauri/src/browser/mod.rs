//! 内嵌浏览器子系统。设计见 docs/superpowers/plans/2026-09-10-embedded-browser.md。
//!
//! **骨架阶段（本轮）**：纯核心（`core`：url_guard/nav_decision）+ 领域类型（`port::types`：
//! BrowserView/NavState/Bounds）+ DTO + `BrowserEngine` 端口签名已落地并由独立单测覆盖；
//! adapter（WebView2 实现）、命令、门面待**可视原型定 A/B**（multiwebview `unstable` vs owned
//! `WebviewWindow`）后填充。
//!
//! **端口隔离红线**（CLAUDE.md「可替换技术必须藏在端口后面」）：`webview2-com` / `wry` 的 `use`
//! 只允许出现在 `adapter/`。验收尺：grep 这两个库名，`adapter/` 之外 0 命中。
//!
//! 依赖方向单向：`adapter → port + core`，`port → core`，`dto/state → port`，`core` 不依赖任何层。

// 骨架期：命令尚未接线，trait/State/EngineError 等在非测试构建里未被消费。纯核心/领域类型/DTO
// 已由独立单测覆盖。adapter + 命令接通后**移除**此 allow（rust 技能：死代码直接删，不靠 allow 留尸）。
#![allow(dead_code)]

pub mod adapter;
pub mod core;
pub mod dto;
pub mod facade;
pub mod port;
pub mod state;

// 对外再导出（BrowserEngine/Bounds/BrowserView/BrowserState 等）留到命令层接线时加，避免骨架期 unused。

#[cfg(test)]
mod dto_test;
