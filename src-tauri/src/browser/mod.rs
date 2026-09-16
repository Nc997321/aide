//! 内嵌浏览器子系统。设计见 docs/superpowers/plans/2026-09-10-embedded-browser.md。
//!
//! **当前阶段（2026-09-15）**：主区面板形态已通（面板自带标签页），加载事件通道接通
//! （`on_page_load` → 注册表状态机 → `browser-nav` 广播）。**门面 `facade` 是能力入口**：
//! 命令层（UI）与未来的 agent 工具桥接都从那里进——门面不认识「用途」，只提供机制
//! （见 facade.rs 头注释与设计文档 §11）。
//!
//! **下一步（agent 路径地基）**：webview2-com 下钻——`eval` 带返回值 / `CapturePreview` 截图 /
//! `DocumentTitleChanged` 标题 / `NavigationCompleted.IsSuccess` 失败判定（当前 `Finished` 一律
//! 当成功，是已知的诚实降级）。
//!
//! **端口隔离红线**（CLAUDE.md「可替换技术必须藏在端口后面」）：`webview2-com` / `wry` 的 `use`
//! 只允许出现在 `adapter/`。验收尺：grep 这两个库名，`adapter/` 之外 0 命中。
//!
//! 依赖方向单向：`adapter → port + core`，`port → core`，`dto/state → port`，`core` 不依赖任何层；
//! `commands/` 与 `facade` 是外壳（命令薄壳 → 门面 → 端口）。

pub mod adapter;
pub mod bookmarks;
pub mod core;
pub mod dto;
pub mod facade;
pub mod port;
pub mod state;

// 对外再导出（BrowserEngine/Bounds/BrowserView/BrowserState 等）留到命令层接线时加，避免骨架期 unused。

#[cfg(test)]
mod dto_test;
