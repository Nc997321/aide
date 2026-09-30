//! git 命令。实现都在 [`aide_workspace::git`]；这里只做参数形状与根解析。
//!
//! 根解析统一：每条命令都接受可选 `cwd`（会话所属工作区），缺省回落活动工作区 → 家目录
//! （见 [`crate::WorkspaceState::root_for`]）。

use std::sync::Arc;

use aide_workspace::git::{self, *};
use aide_workspace::git::diffpair::DiffMode;
use aide_workspace::DiffEntry;
use serde::Deserialize;

use crate::registry::{blocking, Command};
use crate::{command, Core};

pub static COMMANDS: &[Command] = &[
    command!("git_branches", git_branches),
    command!("git_checkout", git_checkout),
    command!("git_create_branch", git_create_branch),
    command!("git_delete_branch", git_delete_branch),
    command!("git_log", git_log),
    command!("git_show", git_show),
    command!("git_compare_branches", git_compare_branches),
    command!("git_diff_pair_refs", git_diff_pair_refs),
    command!("git_diff_pair", git_diff_pair),
    command!("git_fingerprint", git_fingerprint),
    command!("git_head_rev", git_head_rev),
    command!("git_commit", git_commit),
    command!("git_discard_all", git_discard_all),
    command!("git_revert_file", git_revert_file),
    command!("git_stage_all", git_stage_all),
    command!("git_stage_file", git_stage_file),
    command!("git_unstage_all", git_unstage_all),
    command!("git_unstage_file", git_unstage_file),
    command!("git_ahead_behind", git_ahead_behind),
    command!("git_fetch", git_fetch),
    command!("git_pull", git_pull),
    command!("git_push", git_push),
    command!("git_remote_url", git_remote_url),
    command!("git_unpushed_commits", git_unpushed_commits),
    command!("git_stash", git_stash),
    command!("git_stash_apply", git_stash_apply),
    command!("git_stash_drop", git_stash_drop),
    command!("git_stash_list", git_stash_list),
    command!("git_stash_pop", git_stash_pop),
    command!("git_diff_files", git_diff_files),
    command!("git_status", git_status),
    command!("git_tags", git_tags),
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchesArgs {
    #[serde(default)]
    cwd: Option<String>,
}

async fn git_branches(core: Arc<Core>, a: GitBranchesArgs) -> Result<Vec<BranchInfo>, String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::branches::git_branches(root).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckoutArgs {
    #[serde(default)]
    cwd: Option<String>,
    branch: String,
}

async fn git_checkout(core: Arc<Core>, a: GitCheckoutArgs) -> Result<(), String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::branches::git_checkout(root, a.branch).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCreateBranchArgs {
    #[serde(default)]
    cwd: Option<String>,
    name: String,
}

async fn git_create_branch(core: Arc<Core>, a: GitCreateBranchArgs) -> Result<(), String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::branches::git_create_branch(root, a.name).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDeleteBranchArgs {
    #[serde(default)]
    cwd: Option<String>,
    name: String,
    #[serde(default)]
    force: Option<bool>,
}

async fn git_delete_branch(core: Arc<Core>, a: GitDeleteBranchArgs) -> Result<(), String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::branches::git_delete_branch(root, a.name, a.force).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogArgs {
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    skip: Option<u32>,
}

async fn git_log(core: Arc<Core>, a: GitLogArgs) -> Result<Vec<CommitEntry>, String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::commits::git_log(root, a.limit, a.branch, a.skip).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitShowArgs {
    #[serde(default)]
    cwd: Option<String>,
    hash: String,
}

async fn git_show(core: Arc<Core>, a: GitShowArgs) -> Result<CommitDetail, String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::commits::git_show(root, a.hash).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCompareBranchesArgs {
    #[serde(default)]
    cwd: Option<String>,
    head: String,
    #[serde(default)]
    base: Option<String>,
}

async fn git_compare_branches(core: Arc<Core>, a: GitCompareBranchesArgs) -> Result<CompareResult, String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::compare::git_compare_branches(root, a.head, a.base).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffPairRefsArgs {
    #[serde(default)]
    cwd: Option<String>,
    path: String,
    base: String,
    head: String,
    #[serde(default)]
    old_path: Option<String>,
}

async fn git_diff_pair_refs(core: Arc<Core>, a: GitDiffPairRefsArgs) -> Result<DiffPair, String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::compare::git_diff_pair_refs(root, a.path, a.base, a.head, a.old_path).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffPairArgs {
    #[serde(default)]
    cwd: Option<String>,
    path: String,
    mode: DiffMode,
}

async fn git_diff_pair(core: Arc<Core>, a: GitDiffPairArgs) -> Result<DiffPair, String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::diffpair::git_diff_pair(root, a.path, a.mode).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFingerprintArgs {
    #[serde(default)]
    cwd: Option<String>,
}

async fn git_fingerprint(core: Arc<Core>, a: GitFingerprintArgs) -> Result<String, String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    blocking(move || git::fingerprint::git_fingerprint(root)).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHeadRevArgs {
    #[serde(default)]
    cwd: Option<String>,
}

async fn git_head_rev(core: Arc<Core>, a: GitHeadRevArgs) -> Result<Option<String>, String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::head::git_head_rev(root).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitArgs {
    #[serde(default)]
    cwd: Option<String>,
    message: String,
    #[serde(default)]
    amend: Option<bool>,
}

async fn git_commit(core: Arc<Core>, a: GitCommitArgs) -> Result<String, String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::operations::git_commit(root, a.message, a.amend).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiscardAllArgs {
    #[serde(default)]
    cwd: Option<String>,
}

async fn git_discard_all(core: Arc<Core>, a: GitDiscardAllArgs) -> Result<(), String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::operations::git_discard_all(root).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRevertFileArgs {
    #[serde(default)]
    cwd: Option<String>,
    path: String,
}

async fn git_revert_file(core: Arc<Core>, a: GitRevertFileArgs) -> Result<(), String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::operations::git_revert_file(root, a.path).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStageAllArgs {
    #[serde(default)]
    cwd: Option<String>,
}

async fn git_stage_all(core: Arc<Core>, a: GitStageAllArgs) -> Result<(), String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::operations::git_stage_all(root).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStageFileArgs {
    #[serde(default)]
    cwd: Option<String>,
    path: String,
}

async fn git_stage_file(core: Arc<Core>, a: GitStageFileArgs) -> Result<(), String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::operations::git_stage_file(root, a.path).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitUnstageAllArgs {
    #[serde(default)]
    cwd: Option<String>,
}

async fn git_unstage_all(core: Arc<Core>, a: GitUnstageAllArgs) -> Result<(), String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::operations::git_unstage_all(root).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitUnstageFileArgs {
    #[serde(default)]
    cwd: Option<String>,
    path: String,
}

async fn git_unstage_file(core: Arc<Core>, a: GitUnstageFileArgs) -> Result<(), String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::operations::git_unstage_file(root, a.path).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitAheadBehindArgs {
    #[serde(default)]
    cwd: Option<String>,
}

async fn git_ahead_behind(core: Arc<Core>, a: GitAheadBehindArgs) -> Result<AheadBehind, String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::remote_op::git_ahead_behind(root).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFetchArgs {
    #[serde(default)]
    cwd: Option<String>,
}

async fn git_fetch(core: Arc<Core>, a: GitFetchArgs) -> Result<FetchPullOutcome, String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::remote_op::git_fetch(root).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPullArgs {
    #[serde(default)]
    cwd: Option<String>,
}

async fn git_pull(core: Arc<Core>, a: GitPullArgs) -> Result<FetchPullOutcome, String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::remote_op::git_pull(root).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPushArgs {
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    force: Option<bool>,
}

async fn git_push(core: Arc<Core>, a: GitPushArgs) -> Result<(), String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::remote_op::git_push(root, a.force).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteUrlArgs {
    #[serde(default)]
    cwd: Option<String>,
}

async fn git_remote_url(core: Arc<Core>, a: GitRemoteUrlArgs) -> Result<Option<String>, String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::remote_op::git_remote_url(root).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitUnpushedCommitsArgs {
    #[serde(default)]
    cwd: Option<String>,
}

async fn git_unpushed_commits(core: Arc<Core>, a: GitUnpushedCommitsArgs) -> Result<Vec<String>, String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::remote_op::git_unpushed_commits(root).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStashArgs {
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

async fn git_stash(core: Arc<Core>, a: GitStashArgs) -> Result<(), String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::stash::git_stash(root, a.message).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStashApplyArgs {
    #[serde(default)]
    cwd: Option<String>,
    index: u32,
}

async fn git_stash_apply(core: Arc<Core>, a: GitStashApplyArgs) -> Result<(), String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::stash::git_stash_apply(root, a.index).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStashDropArgs {
    #[serde(default)]
    cwd: Option<String>,
    index: u32,
}

async fn git_stash_drop(core: Arc<Core>, a: GitStashDropArgs) -> Result<(), String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::stash::git_stash_drop(root, a.index).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStashListArgs {
    #[serde(default)]
    cwd: Option<String>,
}

async fn git_stash_list(core: Arc<Core>, a: GitStashListArgs) -> Result<Vec<StashEntry>, String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::stash::git_stash_list(root).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStashPopArgs {
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    index: Option<u32>,
}

async fn git_stash_pop(core: Arc<Core>, a: GitStashPopArgs) -> Result<(), String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::stash::git_stash_pop(root, a.index).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffFilesArgs {
    #[serde(default)]
    cwd: Option<String>,
}

async fn git_diff_files(core: Arc<Core>, a: GitDiffFilesArgs) -> Result<Vec<DiffEntry>, String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::status::git_diff_files(root).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusArgs {
    #[serde(default)]
    cwd: Option<String>,
}

async fn git_status(core: Arc<Core>, a: GitStatusArgs) -> Result<GitStatus, String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::status::git_status(root).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTagsArgs {
    #[serde(default)]
    cwd: Option<String>,
}

async fn git_tags(core: Arc<Core>, a: GitTagsArgs) -> Result<Vec<TagEntry>, String> {
    let root = core.workspace.root_for(a.cwd.as_deref());
    git::tags::git_tags(root).await
}

#[cfg(test)]
mod tests {
    use crate::registry::lookup;
    use crate::NullSink;
    use serde_json::json;
    use std::sync::Arc;

    #[tokio::test]
    async fn git_runs_against_explicit_cwd() {
        // 非 git 目录：命令真的跑到了实现（报错 / 空结果都行），而不是参数层就被拒。
        let core = crate::test_core(Arc::new(NullSink));
        let dir = std::env::temp_dir();
        let r = lookup("git_head_rev").unwrap()(core, json!({ "cwd": dir })).await;
        if let Err(e) = r {
            assert!(!e.contains("invalid args"), "{e}");
        }
    }
}
