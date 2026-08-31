//! codegraph-runner 库面：迁移自 `src-tauri/src/codegraph/`（优化项二）。
//!
//! 模块树刻意保持 `crate::codegraph::*` 原路径，迁移 diff 最小化——模块间
//! 引用零改动，只有跨进程边界（settings / trust / proxy）的少数切口改签名。
//! `#[cfg(test)]` 内联测试（107 个）随之整体随迁，`cargo test -p codegraph-runner`
//! 全量运行。
//!
//! 进程隔离语义（相对迁移前的行为对账）：
//! - 命令级门控（trust / 工作区索引开关）移回主进程：政策归 aide.exe，
//!   本进程是机制，盲执行；
//! - embedder 配置与代理由请求参数传入（settings 不进本进程）；
//! - 前端轮询合同（codegraph_build_progress 五键形状）由 progress 通知 +
//!   主进程 atomics 维持，本进程不感知前端。

pub mod codegraph;
