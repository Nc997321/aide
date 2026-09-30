// 工作树状态域：`status --porcelain` 逐行解析（xy → staged/status，冲突态
// 归一为 C）→ 变更面板文件列表；`git_diff_files`（HEAD vs 工作树，含
// 临时文件过滤与未跟踪行数统计）。
use super::runtime::{git_run, git_run_async, git_run_blocking};
use super::types::unquote_git_path;
use crate::{DiffEntry};
use std::path::PathBuf;
use tracing::{error, info};
#[derive(Debug, serde::Serialize, Clone)]
pub struct GitStatusEntry {
    pub path: String,
    pub xy: String,
    pub status: String,
    pub staged: bool,
}

#[derive(Debug, serde::Serialize, Clone)]
pub struct GitStatus {
    pub entries: Vec<GitStatusEntry>,
}

pub async fn git_diff_files(
    root: PathBuf,
) -> Result<Vec<DiffEntry>, String> {
    if !root.join(".git").exists() {
        return Ok(Vec::new());
    }

    // All git + filesystem work in one blocking task
    git_run_blocking(move || {
        // 1. Collect all committed paths from HEAD (used to distinguish real tracked
        //    deletions from ephemeral files that were never committed).
        let mut committed_paths: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        if let Ok(tree_out) = git_run(&["ls-tree", "-r", "HEAD", "--name-only"], &root) {
            let tree_stdout = String::from_utf8_lossy(&tree_out.stdout);
            for p in tree_stdout.lines() {
                committed_paths.insert(unquote_git_path(p));
            }
        }

        // 2. Modified / deleted files (vs HEAD so staged-then-deleted files are also caught)
        let diff_out = git_run(&["diff", "HEAD", "--numstat"], &root)?;
        let stdout = String::from_utf8_lossy(&diff_out.stdout);
        let mut files: Vec<DiffEntry> = Vec::new();
        for line in stdout.lines() {
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
            let rel = unquote_git_path(parts[2]);
            let file_path = root.join(&rel);
            let status = if !file_path.exists() { "D" } else { "M" };
            files.push(DiffEntry {
                path: rel,
                status: status.to_string(),
                additions,
                deletions,
            });
        }

        // 3. Untracked files — skip any that no longer exist on disk (ephemeral mid-round files)
        if let Ok(untracked_out) = git_run(&["ls-files", "--others", "--exclude-standard"], &root) {
            let ut_stdout = String::from_utf8_lossy(&untracked_out.stdout);
            for path in ut_stdout.lines() {
                let rel = unquote_git_path(path);
                let file_path = root.join(&rel);
                if !file_path.is_file() {
                    continue;
                }
                let additions = std::fs::read_to_string(&file_path)
                    .map(|c| c.lines().count() as u32)
                    .unwrap_or(0);
                files.push(DiffEntry {
                    path: rel,
                    status: "A".to_string(),
                    additions,
                    deletions: 0,
                });
            }
        }

        // 4. Filter ephemeral files: not on disk AND never committed to HEAD.
        //    These are files created after the snapshot and deleted before capture —
        //    they should not appear in the changes panel.
        files.retain(|f| {
            let full_path = root.join(&f.path);
            if full_path.exists() {
                return true;
            }
            // File gone — keep only if it was committed at some point (real tracked deletion)
            committed_paths.contains(&f.path)
        });

        Ok(files)
    })
    .await
}

pub async fn git_status(root: PathBuf) -> Result<GitStatus, String> {
    info!(root = %root.display(), "git_status");
    if !root.join(".git").exists() {
        return Ok(GitStatus { entries: vec![] });
    }

    let output = match git_run_async(
        vec!["status".into(), "--porcelain".into(), "-u".into()],
        root,
    )
    .await
    {
        Ok(o) => o,
        Err(e) => {
            error!("git_status failed: {}", e);
            return Err(format!("Failed to run git status: {}", e));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();
    for line in stdout.lines() {
        if line.len() < 4 {
            continue;
        }
        let xy = line[..2].to_string();
        let path = unquote_git_path(line[3..].trim());
        if path.is_empty() {
            continue;
        }
        let x = line.chars().next().unwrap_or(' ');
        let y = line.chars().nth(1).unwrap_or(' ');
        let (staged, status) = match (x, y) {
            // 未合并（冲突）状态：UU AA DD AU UA DU UD → C(onflict)
            ('U', 'U')
            | ('A', 'A')
            | ('D', 'D')
            | ('A', 'U')
            | ('U', 'A')
            | ('D', 'U')
            | ('U', 'D') => (false, "C"),
            ('M', ' ') => (true, "M"),
            ('A', ' ') => (true, "A"),
            ('D', ' ') => (true, "D"),
            ('R', ' ') => (true, "R"),
            (' ', 'M') => (false, "M"),
            (' ', 'D') => (false, "D"),
            ('?', '?') => (false, "?"),
            ('M', 'M') => (true, "M"),
            _ => (false, "M"),
        };
        entries.push(GitStatusEntry {
            path,
            xy,
            status: status.to_string(),
            staged,
        });
    }

    info!(count = entries.len(), "git_status ok");
    Ok(GitStatus { entries })
}
