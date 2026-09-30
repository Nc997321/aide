//! Git 命令模块。
//!
//! 按域拆分：spawn 基建在 [`runtime`]，输出归一化在 [`types`]，工作树/暂存/提交
//! 操作在 [`operations`]，stash 在 [`stash`]，分支在 [`branches`]，工作树状态在
//! [`status`]，远端同步在 [`remote_op`]，提交历史在 [`commits`]，编辑器 diff
//! 数据层在 [`diffpair`]，仓库 HEAD 在 [`head`]，目录指纹轮询在 [`fingerprint`]；分支对比在 [`compare`]，
//! 标签在 [`tags`]。每个命令都是 `fn(root, 参数…)`：工作区根由调用方解析——
//! 桌面由 Tauri 包装层从 `WorkspaceState` 取，远程由 aide-host 从请求取。
//!
//! 子模块间的共享底层（spawn helper、`CommitEntry`/`DiffPair` 等结构、
//! `parse_commit_lines`/`assemble_diff_pair`）以 `pub(super)` 暴露给同模块树，
//! 不被 `pub use` 重导出到外部。

pub mod branches;
pub mod commits;
pub mod diffpair;
pub mod fingerprint;
pub mod head;
pub use head::*;
pub mod operations;
pub mod remote_op;
pub mod runtime;
pub mod stash;
pub mod status;
pub mod types;

pub mod compare;
pub use compare::*;

pub mod tags;
pub use tags::*;

pub use branches::*;
pub use commits::*;
pub use diffpair::*;
pub use fingerprint::*;
pub use operations::*;
pub use remote_op::*;
pub use stash::*;
pub use status::*;
