//! aide-host：远程工作区的目标机端（WSL 发行版 / SSH 服务器，无需图形界面）。
//!
//! 库部分只导出 [`protocol`]（帧类型）与 [`commands`]（可转发命令清单）——桌面
//! 依赖它们，保证两端编译期同形；
//! 其余模块只属于二进制。

pub mod commands;
pub mod protocol;
