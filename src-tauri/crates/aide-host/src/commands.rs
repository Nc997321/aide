//! aide-host 能执行的命令清单（**可审计暴露面**）。桌面的 IPC 拦截层据此判定
//! 「转发 / 大声拒绝」；aide-host 的单测断言清单里每一项都真的被分派（防登记漂移）。
//! 命令名 = 桌面的 Tauri 命令名，参数形状 = 前端 invoke 的原样参数。

/// fs / 搜索命令名（不需要工作区根，参数自带路径）。
pub const FS_COMMANDS: &[&str] = &[
    "list_directory",
    "list_fs_roots",
    "read_file_content",
    "read_file_base64",
    "read_file_binary",
    "write_file_content",
    "delete_file",
    "create_file",
    "create_dir",
    "copy_file",
    "move_file",
    "grep_symbol",
    "file_exists",
    "path_types",
    "find_files_by_name",
    "search_in_files",
    "replace_in_files_preview",
    "apply_replacements",
];

/// 需要工作区根、但不是 git 的命令。
pub const ROOT_COMMANDS: &[&str] = &["get_project_info"];

/// git 命令（需要工作区根：桌面按 `cwd` 参数 → 活动工作区解析后随 `root` 下发）。
pub const GIT_COMMANDS: &[&str] = &[
    "git_create_branch",
    "git_delete_branch",
    "git_branches",
    "git_checkout",
    "git_log",
    "git_show",
    "git_compare_branches",
    "git_diff_pair_refs",
    "git_diff_pair",
    "git_fingerprint",
    "git_head_rev",
    "git_stage_all",
    "git_stage_file",
    "git_unstage_file",
    "git_revert_file",
    "git_discard_all",
    "git_unstage_all",
    "git_commit",
    "git_remote_url",
    "git_pull",
    "git_fetch",
    "git_ahead_behind",
    "git_unpushed_commits",
    "git_push",
    "git_stash",
    "git_stash_pop",
    "git_stash_list",
    "git_stash_apply",
    "git_stash_drop",
    "git_diff_files",
    "git_status",
    "git_tags",
];

/// 会话转录（目标机 claude home 下的 `.jsonl`）。**不是** Tauri 命令名——桌面的会话
/// 命令判定会话属于远程工作区后，用这些名字向 host 取转录原料，再叠加桌面元数据。
pub const TRANSCRIPT_COMMANDS: &[&str] = &[
    "transcript_list",
    "transcript_load",
    "transcript_last_event",
    "transcript_size",
    "transcript_truncate",
];

/// 是否是 aide-host 认识的命令。
pub fn is_supported(cmd: &str) -> bool {
    FS_COMMANDS.contains(&cmd)
        || ROOT_COMMANDS.contains(&cmd)
        || GIT_COMMANDS.contains(&cmd)
        || TRANSCRIPT_COMMANDS.contains(&cmd)
}

/// 需要桌面解析并下发工作区根的命令。
pub fn needs_root(cmd: &str) -> bool {
    ROOT_COMMANDS.contains(&cmd) || GIT_COMMANDS.contains(&cmd)
}
