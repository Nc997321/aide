//! 按能力分的命令模块。每个模块导出 `COMMANDS` 分表，由 [`crate::registry`] 汇总。

pub mod agent_status;
pub mod automation;
pub mod chat;
pub mod codegraph;
pub mod fs;
pub mod customizations;
pub mod git;
pub mod jdk;
pub mod knowledge;
pub mod marketplace;
pub mod memory_observatory;
pub mod migration;
pub mod notifications;
pub mod onboarding;
pub mod permissions;
pub mod provider;
pub mod workspace;
pub mod recent;
pub mod run_configs;
pub mod session;
pub mod session_changes;
pub mod terminal;
pub mod watch;
pub mod workspace_trust;

use serde::Deserialize;

/// 无参数命令的参数形状（忽略多余字段）。
#[derive(Deserialize)]
pub struct NoArgs {}
