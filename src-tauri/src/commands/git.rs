//! Git 命令的 Tauri 薄包装：解析工作区根（`cwd` 参数 → 活动工作区），然后调
//! [`aide_workspace::git`] 的唯一实现。远程工作区的同名命令由 IPC 拦截层转发给
//! aide-host，在目标机上跑同一份实现（见 `crate::remote_workspace::routes`）。

use crate::commands::{project_root_for, project_root_for_commands, DiffEntry, WorkspaceState};
use aide_workspace::git;
use tauri::State;

pub use aide_workspace::git::{
    branches::*, commits::*, compare::*, diffpair::*, remote_op::*, stash::*, status::*, tags::*,
};

#[tauri::command]
pub async fn git_branches(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<Vec<BranchInfo>, String> {
    git::branches::git_branches(project_root_for_commands(&workspace_state)).await
}

#[tauri::command]
pub async fn git_checkout(
    workspace_state: State<'_, WorkspaceState>,
    branch: String,
) -> Result<(), String> {
    git::branches::git_checkout(project_root_for_commands(&workspace_state), branch).await
}

#[tauri::command]
pub async fn git_create_branch(
    workspace_state: State<'_, WorkspaceState>,
    name: String,
) -> Result<(), String> {
    git::branches::git_create_branch(project_root_for_commands(&workspace_state), name).await
}

#[tauri::command]
pub async fn git_delete_branch(
    workspace_state: State<'_, WorkspaceState>,
    name: String,
    force: Option<bool>,
) -> Result<(), String> {
    git::branches::git_delete_branch(project_root_for_commands(&workspace_state), name, force).await
}

#[tauri::command]
pub async fn git_log(
    workspace_state: State<'_, WorkspaceState>,
    limit: Option<u32>,
    branch: Option<String>,
    skip: Option<u32>,
) -> Result<Vec<CommitEntry>, String> {
    git::commits::git_log(project_root_for_commands(&workspace_state), limit, branch, skip).await
}

#[tauri::command]
pub async fn git_show(
    workspace_state: State<'_, WorkspaceState>,
    hash: String,
) -> Result<CommitDetail, String> {
    git::commits::git_show(project_root_for_commands(&workspace_state), hash).await
}

#[tauri::command]
pub async fn git_compare_branches(
    workspace_state: State<'_, WorkspaceState>,
    head: String,
    base: Option<String>,
) -> Result<CompareResult, String> {
    git::compare::git_compare_branches(project_root_for_commands(&workspace_state), head, base).await
}

#[tauri::command]
pub async fn git_diff_pair_refs(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
    base: String,
    head: String,
    old_path: Option<String>,
) -> Result<DiffPair, String> {
    git::compare::git_diff_pair_refs(project_root_for_commands(&workspace_state), path, base, head, old_path).await
}

#[tauri::command]
pub async fn git_diff_pair(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
    mode: DiffMode,
    cwd: Option<String>,
) -> Result<DiffPair, String> {
    git::diffpair::git_diff_pair(project_root_for(&workspace_state, cwd.as_deref()), path, mode).await
}

#[tauri::command]
pub fn git_fingerprint(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<String, String> {
    let _trace = crate::diagnostics::trace_command("git_fingerprint");
    git::fingerprint::git_fingerprint(project_root_for_commands(&workspace_state))
}

#[tauri::command]
pub async fn git_head_rev(
    workspace_state: State<'_, WorkspaceState>,
    cwd: Option<String>,
) -> Result<Option<String>, String> {
    git::head::git_head_rev(project_root_for(&workspace_state, cwd.as_deref())).await
}

#[tauri::command]
pub async fn git_commit(
    workspace_state: State<'_, WorkspaceState>,
    message: String,
    amend: Option<bool>,
) -> Result<String, String> {
    git::operations::git_commit(project_root_for_commands(&workspace_state), message, amend).await
}

#[tauri::command]
pub async fn git_discard_all(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    git::operations::git_discard_all(project_root_for_commands(&workspace_state)).await
}

#[tauri::command]
pub async fn git_revert_file(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
    cwd: Option<String>,
) -> Result<(), String> {
    git::operations::git_revert_file(project_root_for(&workspace_state, cwd.as_deref()), path).await
}

#[tauri::command]
pub async fn git_stage_all(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    git::operations::git_stage_all(project_root_for_commands(&workspace_state)).await
}

#[tauri::command]
pub async fn git_stage_file(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
) -> Result<(), String> {
    git::operations::git_stage_file(project_root_for_commands(&workspace_state), path).await
}

#[tauri::command]
pub async fn git_unstage_all(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    git::operations::git_unstage_all(project_root_for_commands(&workspace_state)).await
}

#[tauri::command]
pub async fn git_unstage_file(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
) -> Result<(), String> {
    git::operations::git_unstage_file(project_root_for_commands(&workspace_state), path).await
}

#[tauri::command]
pub async fn git_ahead_behind(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<AheadBehind, String> {
    git::remote_op::git_ahead_behind(project_root_for_commands(&workspace_state)).await
}

#[tauri::command]
pub async fn git_fetch(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<FetchPullOutcome, String> {
    git::remote_op::git_fetch(project_root_for_commands(&workspace_state)).await
}

#[tauri::command]
pub async fn git_pull(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<FetchPullOutcome, String> {
    git::remote_op::git_pull(project_root_for_commands(&workspace_state)).await
}

#[tauri::command]
pub async fn git_push(
    workspace_state: State<'_, WorkspaceState>,
    force: Option<bool>,
) -> Result<(), String> {
    git::remote_op::git_push(project_root_for_commands(&workspace_state), force).await
}

#[tauri::command]
pub async fn git_remote_url(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<Option<String>, String> {
    git::remote_op::git_remote_url(project_root_for_commands(&workspace_state)).await
}

#[tauri::command]
pub async fn git_unpushed_commits(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<Vec<String>, String> {
    git::remote_op::git_unpushed_commits(project_root_for_commands(&workspace_state)).await
}

#[tauri::command]
pub async fn git_stash(
    workspace_state: State<'_, WorkspaceState>,
    message: Option<String>,
) -> Result<(), String> {
    git::stash::git_stash(project_root_for_commands(&workspace_state), message).await
}

#[tauri::command]
pub async fn git_stash_apply(
    workspace_state: State<'_, WorkspaceState>,
    index: u32,
) -> Result<(), String> {
    git::stash::git_stash_apply(project_root_for_commands(&workspace_state), index).await
}

#[tauri::command]
pub async fn git_stash_drop(
    workspace_state: State<'_, WorkspaceState>,
    index: u32,
) -> Result<(), String> {
    git::stash::git_stash_drop(project_root_for_commands(&workspace_state), index).await
}

#[tauri::command]
pub async fn git_stash_list(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<Vec<StashEntry>, String> {
    git::stash::git_stash_list(project_root_for_commands(&workspace_state)).await
}

#[tauri::command]
pub async fn git_stash_pop(
    workspace_state: State<'_, WorkspaceState>,
    index: Option<u32>,
) -> Result<(), String> {
    git::stash::git_stash_pop(project_root_for_commands(&workspace_state), index).await
}

#[tauri::command]
pub async fn git_diff_files(
    workspace_state: State<'_, WorkspaceState>,
    cwd: Option<String>,
) -> Result<Vec<DiffEntry>, String> {
    git::status::git_diff_files(project_root_for(&workspace_state, cwd.as_deref())).await
}

#[tauri::command]
pub async fn git_status(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<GitStatus, String> {
    git::status::git_status(project_root_for_commands(&workspace_state)).await
}

#[tauri::command]
pub async fn git_tags(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<Vec<TagEntry>, String> {
    git::tags::git_tags(project_root_for_commands(&workspace_state)).await
}
