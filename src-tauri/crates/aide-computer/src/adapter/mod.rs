//! 平台适配器。**平台技术只准出现在这里**（端口隔离红线）。

#[cfg(windows)]
pub mod windows;

#[cfg(not(windows))]
pub mod unsupported;
