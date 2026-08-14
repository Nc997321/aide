//! Git 命令模块。
//!
//! 历史命令（29 个）集中在 [`legacy`]；新增的分支对比命令在 [`compare`]，
//! 标签命令在 [`tags`]。`pub use` 把各子模块的公开项重新导出到
//! `crate::commands::git` 命名空间，使 `lib.rs` 里
//! `commands::git::git_log` 等注册路径在拆分后仍解析。
//!
//! 子模块间的共享底层（spawn helper、`CommitEntry`/`DiffPair` 等结构、
//! `parse_commit_lines`/`assemble_diff_pair`）以 `pub(super)` 暴露给同模块树，
//! 不被 `pub use` 重导出到外部。

pub mod legacy;
pub use legacy::*;

pub mod compare;
pub use compare::*;

pub mod tags;
pub use tags::*;