// 提交历史域：git_log 分页列表（%H|%s|%an|%ar 逐行解析，parse_commit_lines
// 与 compare::git_compare_branches 共用）+ git_show 单提交详情（元数据 + numstat）。
use super::runtime::{git_run, git_run_async, git_run_blocking};
use super::types::unquote_git_path;
use crate::commands::{project_root_for_commands, DiffEntry, WorkspaceState};
use tauri::State;
use tracing::{error, info};
#[derive(Debug, serde::Serialize, Clone)]
pub struct CommitEntry {
    pub hash: String,
    pub message: String,
    pub author: String,
    pub date: String,
}

#[derive(Debug, serde::Serialize, Clone)]
pub struct CommitDetail {
    pub hash: String,
    pub message: String,
    pub author: String,
    pub date: String,
    pub body: String,
    pub files: Vec<DiffEntry>,
}

/// 解析 `git log --format=%H|%s|%an|%ar` 的逐行输出为 [`CommitEntry`] 列表。
/// `git_log` 与 `compare::git_compare_branches` 共用。
pub(super) fn parse_commit_lines(stdout: &str) -> Vec<CommitEntry> {
    let mut commits = Vec::new();
    for line in stdout.lines() {
        let parts: Vec<&str> = line.splitn(4, '|').collect();
        if parts.len() < 4 {
            continue;
        }
        commits.push(CommitEntry {
            hash: parts[0].to_string(),
            message: parts[1].to_string(),
            author: parts[2].to_string(),
            date: parts[3].to_string(),
        });
    }
    commits
}

#[tauri::command]
pub async fn git_log(
    workspace_state: State<'_, WorkspaceState>,
    limit: Option<u32>,
    branch: Option<String>,
    skip: Option<u32>,
) -> Result<Vec<CommitEntry>, String> {
    let root = project_root_for_commands(&workspace_state);
    info!(root = %root.display(), ?limit, ?skip, "git_log");
    if !root.join(".git").exists() {
        return Ok(Vec::new());
    }

    let limit = limit.unwrap_or(50);
    let mut args = vec![
        "log".to_string(),
        "--format=%H|%s|%an|%ar".to_string(),
        format!("-n{}", limit),
    ];
    if let Some(s) = skip {
        if s > 0 {
            args.push(format!("--skip={}", s));
        }
    }
    if let Some(b) = branch {
        args.push(b);
    }

    let output = git_run_async(args, root).await.map_err(|e| {
        error!("git_log failed: {}", e);
        e
    })?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let commits = parse_commit_lines(&stdout);

    info!(count = commits.len(), "git_log ok");
    Ok(commits)
}

#[tauri::command]
pub async fn git_show(
    workspace_state: State<'_, WorkspaceState>,
    hash: String,
) -> Result<CommitDetail, String> {
    let root = project_root_for_commands(&workspace_state);
    info!(%hash, "git_show");
    if !root.join(".git").exists() {
        return Err("Not a git repository".into());
    }

    // Both git log + git show in one blocking task
    git_run_blocking(move || {
        let meta_out = git_run(&["log", "--format=%H|%s|%an|%ar|%b", "-1", &hash], &root)
            .map_err(|e| format!("Failed to run git log: {}", e))?;

        let meta_str = String::from_utf8_lossy(&meta_out.stdout);
        let mut meta_parts = meta_str.splitn(5, '|');
        let commit_hash = meta_parts.next().unwrap_or(&hash).to_string();
        let message = meta_parts.next().unwrap_or("").to_string();
        let author = meta_parts.next().unwrap_or("").to_string();
        let date = meta_parts.next().unwrap_or("").to_string();
        let body = meta_parts.next().unwrap_or("").trim().to_string();

        let stat_out = git_run(&["show", "--numstat", "--format=", &hash], &root)
            .map_err(|e| format!("Failed to run git show: {}", e))?;

        let stat_str = String::from_utf8_lossy(&stat_out.stdout);
        let mut files = Vec::new();
        for line in stat_str.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 3 {
                continue;
            }
            let additions = if parts[0] == "-" {
                0
            } else {
                parts[0].parse().unwrap_or(0)
            };
            let deletions = if parts[1] == "-" {
                0
            } else {
                parts[1].parse().unwrap_or(0)
            };
            files.push(DiffEntry {
                path: unquote_git_path(parts[2]),
                status: status_from_numstat(parts[0], parts[1]),
                additions,
                deletions,
            });
        }

        Ok(CommitDetail {
            hash: commit_hash,
            message,
            author,
            date,
            body,
            files,
        })
    })
    .await
}

fn status_from_numstat(additions: &str, deletions: &str) -> String {
    if additions == "0" && deletions == "0" {
        "R".to_string()
    } else if additions == "-" && deletions == "-" {
        "B".to_string()
    } else {
        "M".to_string()
    }
}
