//! 按能力分的命令模块。每个模块导出 `COMMANDS` 分表，由 [`crate::registry`] 汇总。

pub mod fs;
pub mod git;
pub mod watch;

use serde::Deserialize;

/// 无参数命令的参数形状（忽略多余字段）。
#[derive(Deserialize)]
pub struct NoArgs {}
