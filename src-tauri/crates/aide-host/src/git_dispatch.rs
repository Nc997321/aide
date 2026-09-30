//! git 命令分派表（**由脚本从 aide-workspace 的函数签名生成**，与桌面的 Tauri 包装
//! `src-tauri/src/commands/git.rs` 同源——两边都是同一批函数的薄壳）。
//! 参数名沿用前端 invoke 的 camelCase 形状（Tauri 默认把 camelCase 映射到 snake_case）。

use aide_workspace::git;
use aide_workspace::git::diffpair::DiffMode;
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;

use crate::dispatch::{parse_args, to_value};

pub async fn dispatch(cmd: &str, args: Value, root: PathBuf) -> Option<Result<Value, String>> {
    let r = match cmd {
        "git_create_branch" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A { name: String, }
            let a: A = match parse_args(args) { Ok(a) => a, Err(e) => return Some(Err(e)) };
            to_value(git::branches::git_create_branch(root, a.name).await)
        }
        "git_delete_branch" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A { name: String, force: Option<bool>, }
            let a: A = match parse_args(args) { Ok(a) => a, Err(e) => return Some(Err(e)) };
            to_value(git::branches::git_delete_branch(root, a.name, a.force).await)
        }
        "git_branches" => {
            let _ = args;
            to_value(git::branches::git_branches(root).await)
        }
        "git_checkout" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A { branch: String, }
            let a: A = match parse_args(args) { Ok(a) => a, Err(e) => return Some(Err(e)) };
            to_value(git::branches::git_checkout(root, a.branch).await)
        }
        "git_log" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A { limit: Option<u32>, branch: Option<String>, skip: Option<u32>, }
            let a: A = match parse_args(args) { Ok(a) => a, Err(e) => return Some(Err(e)) };
            to_value(git::commits::git_log(root, a.limit, a.branch, a.skip).await)
        }
        "git_show" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A { hash: String, }
            let a: A = match parse_args(args) { Ok(a) => a, Err(e) => return Some(Err(e)) };
            to_value(git::commits::git_show(root, a.hash).await)
        }
        "git_compare_branches" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A { head: String, base: Option<String>, }
            let a: A = match parse_args(args) { Ok(a) => a, Err(e) => return Some(Err(e)) };
            to_value(git::compare::git_compare_branches(root, a.head, a.base).await)
        }
        "git_diff_pair_refs" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A { path: String, base: String, head: String, old_path: Option<String>, }
            let a: A = match parse_args(args) { Ok(a) => a, Err(e) => return Some(Err(e)) };
            to_value(git::compare::git_diff_pair_refs(root, a.path, a.base, a.head, a.old_path).await)
        }
        "git_diff_pair" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A { path: String, mode: DiffMode, }
            let a: A = match parse_args(args) { Ok(a) => a, Err(e) => return Some(Err(e)) };
            to_value(git::diffpair::git_diff_pair(root, a.path, a.mode).await)
        }
        "git_fingerprint" => {
            let _ = args;
            to_value(git::fingerprint::git_fingerprint(root))
        }
        "git_head_rev" => {
            let _ = args;
            to_value(git::head::git_head_rev(root).await)
        }
        "git_stage_all" => {
            let _ = args;
            to_value(git::operations::git_stage_all(root).await)
        }
        "git_stage_file" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A { path: String, }
            let a: A = match parse_args(args) { Ok(a) => a, Err(e) => return Some(Err(e)) };
            to_value(git::operations::git_stage_file(root, a.path).await)
        }
        "git_unstage_file" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A { path: String, }
            let a: A = match parse_args(args) { Ok(a) => a, Err(e) => return Some(Err(e)) };
            to_value(git::operations::git_unstage_file(root, a.path).await)
        }
        "git_revert_file" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A { path: String, }
            let a: A = match parse_args(args) { Ok(a) => a, Err(e) => return Some(Err(e)) };
            to_value(git::operations::git_revert_file(root, a.path).await)
        }
        "git_discard_all" => {
            let _ = args;
            to_value(git::operations::git_discard_all(root).await)
        }
        "git_unstage_all" => {
            let _ = args;
            to_value(git::operations::git_unstage_all(root).await)
        }
        "git_commit" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A { message: String, amend: Option<bool>, }
            let a: A = match parse_args(args) { Ok(a) => a, Err(e) => return Some(Err(e)) };
            to_value(git::operations::git_commit(root, a.message, a.amend).await)
        }
        "git_remote_url" => {
            let _ = args;
            to_value(git::remote_op::git_remote_url(root).await)
        }
        "git_pull" => {
            let _ = args;
            to_value(git::remote_op::git_pull(root).await)
        }
        "git_fetch" => {
            let _ = args;
            to_value(git::remote_op::git_fetch(root).await)
        }
        "git_ahead_behind" => {
            let _ = args;
            to_value(git::remote_op::git_ahead_behind(root).await)
        }
        "git_unpushed_commits" => {
            let _ = args;
            to_value(git::remote_op::git_unpushed_commits(root).await)
        }
        "git_push" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A { force: Option<bool>, }
            let a: A = match parse_args(args) { Ok(a) => a, Err(e) => return Some(Err(e)) };
            to_value(git::remote_op::git_push(root, a.force).await)
        }
        "git_stash" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A { message: Option<String>, }
            let a: A = match parse_args(args) { Ok(a) => a, Err(e) => return Some(Err(e)) };
            to_value(git::stash::git_stash(root, a.message).await)
        }
        "git_stash_pop" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A { index: Option<u32>, }
            let a: A = match parse_args(args) { Ok(a) => a, Err(e) => return Some(Err(e)) };
            to_value(git::stash::git_stash_pop(root, a.index).await)
        }
        "git_stash_list" => {
            let _ = args;
            to_value(git::stash::git_stash_list(root).await)
        }
        "git_stash_apply" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A { index: u32, }
            let a: A = match parse_args(args) { Ok(a) => a, Err(e) => return Some(Err(e)) };
            to_value(git::stash::git_stash_apply(root, a.index).await)
        }
        "git_stash_drop" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A { index: u32, }
            let a: A = match parse_args(args) { Ok(a) => a, Err(e) => return Some(Err(e)) };
            to_value(git::stash::git_stash_drop(root, a.index).await)
        }
        "git_diff_files" => {
            let _ = args;
            to_value(git::status::git_diff_files(root).await)
        }
        "git_status" => {
            let _ = args;
            to_value(git::status::git_status(root).await)
        }
        "git_tags" => {
            let _ = args;
            to_value(git::tags::git_tags(root).await)
        }
        _ => return None,
    };
    Some(r)
}
