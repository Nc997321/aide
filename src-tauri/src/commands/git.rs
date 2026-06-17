use std::process::Command;
use tauri::State;

use super::{DiffEntry, WorkspaceState, project_root_for_commands};

// ── Git-specific types ──

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

#[derive(Debug, serde::Serialize, Clone)]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
}

#[derive(Debug, serde::Serialize, Clone)]
pub struct GitStatusEntry {
    pub path: String,
    /// XY from git status --porcelain v1 (index + worktree)
    pub xy: String,
    pub status: String, // "M", "A", "D", "R", "?"
    pub staged: bool,
}

#[derive(Debug, serde::Serialize, Clone)]
pub struct GitStatus {
    pub entries: Vec<GitStatusEntry>,
}

// ── Existing commands ──

#[tauri::command]
pub fn git_diff_files(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<Vec<DiffEntry>, String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Ok(Vec::new());
    }

    // Modified / deleted files (working tree vs index)
    let output = Command::new("git")
        .args(["diff", "--numstat"])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("Failed to run git diff: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut files: Vec<DiffEntry> = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let additions = if parts[0] == "-" { 0 } else { parts[0].parse().unwrap_or(0) };
        let deletions = if parts[1] == "-" { 0 } else { parts[1].parse().unwrap_or(0) };
        files.push(DiffEntry {
            path: parts[2].to_string(),
            status: "M".to_string(),
            additions,
            deletions,
        });
    }

    // Untracked (new) files — git diff doesn't see them, so we scan separately
    if let Ok(untracked) = Command::new("git")
        .args(["ls-files", "--others", "--exclude-standard"])
        .current_dir(&root)
        .output()
    {
        let untracked_stdout = String::from_utf8_lossy(&untracked.stdout);
        for path in untracked_stdout.lines() {
            let file_path = root.join(path);
            if !file_path.is_file() {
                continue;
            }
            let additions = std::fs::read_to_string(&file_path)
                .map(|c| c.lines().count() as u32)
                .unwrap_or(0);
            files.push(DiffEntry {
                path: path.to_string(),
                status: "A".to_string(),
                additions,
                deletions: 0,
            });
        }
    }

    Ok(files)
}

#[tauri::command]
pub fn git_stage_all(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Ok(());
    }
    Command::new("git")
        .args(["add", "-A"])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("Failed to git add: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn git_stage_file(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    Command::new("git")
        .args(["add", "--", &path])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("Failed to stage: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn git_unstage_file(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    Command::new("git")
        .args(["restore", "--staged", "--", &path])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("Failed to unstage: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn git_revert_file(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    Command::new("git")
        .args(["checkout", "--", &path])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("Failed to revert: {}", e))?;
    Ok(())
}

// ── New commands ──

/// Get commit history for the current branch.
#[tauri::command]
pub fn git_log(
    workspace_state: State<'_, WorkspaceState>,
    limit: Option<u32>,
    branch: Option<String>,
) -> Result<Vec<CommitEntry>, String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Ok(Vec::new());
    }

    let limit = limit.unwrap_or(50);
    let limit_str = format!("-n{}", limit);
    let mut args = vec![
        "log",
        "--format=%H|%s|%an|%ar",
        &limit_str,
    ];

    // If branch is specified, use it; otherwise default to HEAD
    let branch_str;
    if let Some(ref b) = branch {
        branch_str = b.clone();
        args.push(&branch_str);
    }

    let output = Command::new("git")
        .args(&args)
        .current_dir(&root)
        .output()
        .map_err(|e| format!("Failed to run git log: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
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

    Ok(commits)
}

/// Get details of a single commit: metadata + file list with stats.
#[tauri::command]
pub fn git_show(
    workspace_state: State<'_, WorkspaceState>,
    hash: String,
) -> Result<CommitDetail, String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Err("Not a git repository".into());
    }

    // 1. Metadata: %H|%s|%an|%ar|%b
    let meta_out = Command::new("git")
        .args(["log", "--format=%H|%s|%an|%ar|%b", "-1", &hash])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("Failed to run git log: {}", e))?;

    let meta_str = String::from_utf8_lossy(&meta_out.stdout);
    let mut meta_parts = meta_str.splitn(5, '|');
    let commit_hash = meta_parts.next().unwrap_or(&hash).to_string();
    let message = meta_parts.next().unwrap_or("").to_string();
    let author = meta_parts.next().unwrap_or("").to_string();
    let date = meta_parts.next().unwrap_or("").to_string();
    let body = meta_parts.next().unwrap_or("").trim().to_string();

    // 2. File list with stats: git show --numstat --format="" <hash>
    let stat_out = Command::new("git")
        .args(["show", "--numstat", "--format=", &hash])
        .current_dir(&root)
        .output()
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
        let additions = if parts[0] == "-" { 0 } else { parts[0].parse().unwrap_or(0) };
        let deletions = if parts[1] == "-" { 0 } else { parts[1].parse().unwrap_or(0) };
        files.push(DiffEntry {
            path: parts[2].to_string(),
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
}

fn status_from_numstat(additions: &str, deletions: &str) -> String {
    if additions == "0" && deletions == "0" {
        "R".to_string() // rename (no line changes)
    } else if additions == "-" && deletions == "-" {
        "B".to_string() // binary
    } else if deletions == "-" || additions == "0" {
        "D".to_string() // deleted or all deletions
    } else if additions == "0" {
        "M".to_string()
    } else {
        "M".to_string()
    }
}

/// Get the raw diff content for a file.
#[tauri::command]
pub fn git_diff_content(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
    staged: Option<bool>,
    commit_hash: Option<String>,
) -> Result<String, String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Err("Not a git repository".into());
    }

    let mut args: Vec<String> = vec!["diff".to_string()];
    if staged.unwrap_or(false) {
        args.push("--cached".to_string());
    }
    if let Some(ref h) = commit_hash {
        // Show diff for this commit's changes to the file
        // git diff <hash>^! -- <path> shows changes introduced by that commit
        args.push(format!("{}^!", h));
    }
    args.push("--".to_string());
    args.push(path.clone());

    let output = Command::new("git")
        .args(&args)
        .current_dir(&root)
        .output()
        .map_err(|e| format!("Failed to run git diff: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if stdout.is_empty() {
        // File might be new (untracked) — show full file content as "diff"
        let file_path = root.join(&path);
        if file_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&file_path) {
                let mut result = String::new();
                result.push_str(&format!("diff --git a/{} b/{}\n", path, path));
                result.push_str("new file mode 100644\n");
                result.push_str(&format!("--- /dev/null\n+++ b/{}\n", path));
                for line in content.lines() {
                    result.push_str(&format!("+{}\n", line));
                }
                return Ok(result);
            }
        }
        return Ok("No changes".to_string());
    }

    Ok(stdout)
}

/// List all local branches and mark the current one.
#[tauri::command]
pub fn git_branches(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<Vec<BranchInfo>, String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Ok(Vec::new());
    }

    let output = Command::new("git")
        .args(["branch"])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("Failed to run git branch: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut branches = Vec::new();

    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(name) = trimmed.strip_prefix("* ") {
            branches.push(BranchInfo {
                name: name.to_string(),
                is_current: true,
            });
        } else {
            branches.push(BranchInfo {
                name: trimmed.to_string(),
                is_current: false,
            });
        }
    }

    // Sort: current branch first, then alphabetically
    branches.sort_by(|a, b| {
        b.is_current
            .cmp(&a.is_current)
            .then(a.name.cmp(&b.name))
    });

    Ok(branches)
}

/// Switch to a different branch.
#[tauri::command]
pub fn git_checkout(
    workspace_state: State<'_, WorkspaceState>,
    branch: String,
) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Err("Not a git repository".into());
    }

    let output = Command::new("git")
        .args(["checkout", &branch])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("Failed to run git checkout: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Checkout failed: {}", stderr.trim()));
    }

    Ok(())
}

/// Get working tree status (porcelain format, parsed).
#[tauri::command]
pub fn git_status(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<GitStatus, String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Ok(GitStatus { entries: vec![] });
    }

    let output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("Failed to run git status: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();

    for line in stdout.lines() {
        if line.len() < 4 {
            continue;
        }
        let xy = line[..2].to_string();
        let path = line[3..].trim().to_string();
        if path.is_empty() {
            continue;
        }

        let x = line.chars().next().unwrap_or(' ');
        let y = line.chars().nth(1).unwrap_or(' ');

        // Determine overall status and whether staged
        let (staged, status) = match (x, y) {
            ('M', ' ') => (true, "M"),
            ('A', ' ') => (true, "A"),
            ('D', ' ') => (true, "D"),
            ('R', ' ') => (true, "R"),
            (' ', 'M') => (false, "M"),
            (' ', 'D') => (false, "D"),
            ('?', '?') => (false, "?"),
            ('M', 'M') => (true, "M"),  // staged + unstaged mods: show as staged modified
            _ => (false, "M"),
        };

        entries.push(GitStatusEntry {
            path,
            xy,
            status: status.to_string(),
            staged,
        });
    }

    Ok(GitStatus { entries })
}

/// Create a commit with the given message.
#[tauri::command]
pub fn git_commit(
    workspace_state: State<'_, WorkspaceState>,
    message: String,
) -> Result<String, String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Err("Not a git repository".into());
    }

    // First check there's something to commit
    let status_out = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("Failed to run git status: {}", e))?;

    let stdout = String::from_utf8_lossy(&status_out.stdout);
    if stdout.trim().is_empty() {
        return Err("Nothing to commit (working tree clean)".into());
    }

    let output = Command::new("git")
        .args(["commit", "-m", &message])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("Failed to run git commit: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Commit failed: {}", stderr.trim()));
    }

    // Return the new commit hash
    let hash_out = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("Failed to get commit hash: {}", e))?;

    Ok(String::from_utf8_lossy(&hash_out.stdout).trim().to_string())
}
