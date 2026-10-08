//! agent runtime 住 aide-core（`aide_core::runtime`：sidecar 进程、会话表、事件泵）；这里保留
//! 旧路径的 re-export，外加只有桌面才有的 GUI 侧钩子（内嵌浏览器 / 冻结诊断 / 自动化观测）。

pub use aide_core::provider;
pub use aide_core::runtime::*;

pub mod browser_agent;
pub mod hooks;
