//! Git 命令模块。
//!
//! 按域拆分：spawn 基建在 [`runtime`]，输出归一化在 [`types`]，工作树/暂存/提交
//! 操作在 [`operations`]，stash 在 [`stash`]，分支在 [`branches`]，工作树状态在
//! [`status`]，远端同步在 [`remote_op`]，提交历史在 [`commits`]，编辑器 diff
//! 数据层在 [`diffpair`]，目录指纹轮询在 [`fingerprint`]；分支对比在 [`compare`]，
//! 标签在 [`tags`]。`pub use` 把各子模块的公开项重新导出到
//! `crate::commands::git` 命名空间，使 `lib.rs` 里
//! `commands::git::git_log` 等注册路径在拆分后仍解析。
//!
//! 子模块间的共享底层（spawn helper、`CommitEntry`/`DiffPair` 等结构、
//! `parse_commit_lines`/`assemble_diff_pair`）以 `pub(super)` 暴露给同模块树，
//! 不被 `pub use` 重导出到外部。

pub mod branches;
pub mod commits;
pub mod diffpair;
pub mod fingerprint;
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

// tauri 的 __cmd__<name> / __tauri_command_name_<name> 本身是 pub item，
// 随下方 glob `pub use X::*` 一起转发，lib.rs 的 `commands::git::X` 注册路径
// 因此与拆分前一致，无需逐个转发。（session/ 用的是私有子模块 + 显式
// pub use，宏必须逐个转发——两种结构各自成立，勿混用。）

pub use branches::*;
pub use commits::*;
pub use diffpair::*;
pub use fingerprint::*;
pub use operations::*;
pub use remote_op::*;
pub use stash::*;
pub use status::*;
