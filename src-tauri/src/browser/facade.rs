//! 浏览器子系统门面 / 门控收口（STUB）。
//!
//! 照「Facade pattern for subsystem switches」记忆：子系统总开关/门控统一收口于此，
//! 禁止在调用点散落 `if browser_enabled` 补丁。命令层接线时在此提供：
//! - 子系统启用判定（设置项 + 平台支持），收口成单一入口；
//! - 对命令层暴露的最小门面（创建/导航/截图… 转发到 `BrowserEngine` + `BrowserRegistry`）。
//!
//! 本轮不实现——待 A/B 决策与命令层落地。
