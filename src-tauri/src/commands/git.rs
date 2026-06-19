use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::State;
use tracing::{info, error};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use super::{DiffEntry, WorkspaceState, project_root_for_commands, detect_git_branch};

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
    pub xy: String,
    pub status: String,
    pub staged: bool,
}

#[derive(Debug, serde::Serialize, Clone)]
pub struct GitStatus {
    pub entries: Vec<GitStatusEntry>,
}

// ── Timeout + Mutex ──

const GIT_TIMEOUT: Duration = Duration::from_secs(15);

/// Serialises all git invocations so concurrent calls never fight over
/// `.git/index.lock`.  A poisoned lock is treated as a fatal error and
/// immediately returned to the caller.
static GIT_LOCK: Mutex<()> = Mutex::new(());

/// Spawn `git` with the given arguments inside `root`, blocking until it
/// finishes or `GIT_TIMEOUT` expires.  Uses `.output()` (no manual polling)
/// and a helper thread for the timeout.
fn git_run(args: &[&str], root: &std::path::Path) -> Result<std::process::Output, String> {
    let _guard = GIT_LOCK
        .lock()
        .map_err(|e| format!("Git lock poisoned: {}", e))?;

    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    { cmd.creation_flags(0x08000000); }

    let child = cmd.spawn().map_err(|e| format!("Failed to spawn git: {}", e))?;

    // Spawn a helper thread for wait_with_output; join with a timeout.
    let handle = std::thread::spawn(move || child.wait_with_output());
    let start = Instant::now();
    loop {
        if handle.is_finished() {
            return handle
                .join()
                .unwrap_or_else(|_| Err(std::io::Error::new(std::io::ErrorKind::Other, "Git thread panicked")))
                .map_err(|e| format!("Failed to read git output: {}", e));
        }
        if start.elapsed() > GIT_TIMEOUT {
            return Err(format!(
                "Git command 'git {}' timed out after {}s",
                args.join(" "),
                GIT_TIMEOUT.as_secs(),
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Run git inside `tokio::spawn_blocking` so the async handler never blocks
/// the tokio worker thread.
async fn git_run_async(
    args: Vec<String>,
    root: std::path::PathBuf,
) -> Result<std::process::Output, String> {
    tokio::task::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        git_run(&refs, &root)
    })
    .await
    .map_err(|e| format!("Git task panicked: {}", e))?
}

/// Like `git_run_async` but accepts an arbitrary closure that receives `root`
/// and can execute **multiple** git steps inside a single blocking task —
/// avoids repeated thread hops for compound operations (commit, show, …).
async fn git_run_blocking<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("Git task panicked: {}", e))?
}

// ── Commands (all async to avoid blocking IPC) ──

/// Capture frontend errors into the Rust tracing log.
#[tauri::command]
pub fn log_frontend_error(message: String) {
    error!(%message, "FRONTEND_ERROR");
}

#[tauri::command]
pub async fn git_remote_url(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<Option<String>, String> {
    let root = project_root_for_commands(&workspace_state);
    info!(root = %root.display(), "git_remote_url");
    if !root.join(".git").exists() {
        info!("git_remote_url: no .git, skip");
        return Ok(None);
    }
    let output = git_run_async(
        vec!["remote".into(), "get-url".into(), "origin".into()],
        root,
    )
    .await?;
    if output.status.success() {
        let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !url.is_empty() {
            info!(%url, "git_remote_url ok");
            return Ok(Some(url));
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn git_diff_files(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<Vec<DiffEntry>, String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Ok(Vec::new());
    }

    // All git + filesystem work in one blocking task
    git_run_blocking(move || {
        // 1. Collect all committed paths from HEAD (used to distinguish real tracked
        //    deletions from ephemeral files that were never committed).
        let mut committed_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
        if let Ok(tree_out) = git_run(&["ls-tree", "-r", "HEAD", "--name-only"], &root) {
            let tree_stdout = String::from_utf8_lossy(&tree_out.stdout);
            for p in tree_stdout.lines() {
                committed_paths.insert(p.to_string());
            }
        }

        // 2. Modified / deleted files (vs HEAD so staged-then-deleted files are also caught)
        let diff_out = git_run(&["diff", "HEAD", "--numstat"], &root)?;
        let stdout = String::from_utf8_lossy(&diff_out.stdout);
        let mut files: Vec<DiffEntry> = Vec::new();
        for line in stdout.lines() {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 3 { continue; }
            let additions = if parts[0] == "-" { 0 } else { parts[0].parse().unwrap_or(0) };
            let deletions = if parts[1] == "-" { 0 } else { parts[1].parse().unwrap_or(0) };
            let file_path = root.join(parts[2]);
            let status = if !file_path.exists() { "D" } else { "M" };
            files.push(DiffEntry {
                path: parts[2].to_string(),
                status: status.to_string(),
                additions,
                deletions,
            });
        }

        // 3. Untracked files — skip any that no longer exist on disk (ephemeral mid-round files)
        if let Ok(untracked_out) = git_run(
            &["ls-files", "--others", "--exclude-standard"],
            &root,
        ) {
            let ut_stdout = String::from_utf8_lossy(&untracked_out.stdout);
            for path in ut_stdout.lines() {
                let file_path = root.join(path);
                if !file_path.is_file() { continue; }
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

        // 4. Filter ephemeral files: not on disk AND never committed to HEAD.
        //    These are files created after the snapshot and deleted before capture —
        //    they should not appear in the changes panel.
        files.retain(|f| {
            let full_path = root.join(&f.path);
            if full_path.exists() { return true; }
            // File gone — keep only if it was committed at some point (real tracked deletion)
            committed_paths.contains(&f.path)
        });

        Ok(files)
    }).await
}

#[tauri::command]
pub async fn git_stage_all(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Ok(());
    }
    git_run_async(vec!["add".into(), "-A".into()], root).await?;
    Ok(())
}

#[tauri::command]
pub async fn git_stage_file(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    git_run_async(vec!["add".into(), "--".into(), path], root).await?;
    Ok(())
}

#[tauri::command]
pub async fn git_unstage_file(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    git_run_async(vec!["restore".into(), "--staged".into(), "--".into(), path], root).await?;
    Ok(())
}

/// Returns true if the file exists on disk OR is committed in HEAD.
/// Used by the frontend to decide whether a previous-round change entry is still valid.
/// Checking HEAD (not the index) avoids false positives from ephemeral files
/// that were staged by `git add -A` but never committed.
#[tauri::command]
pub fn git_has_file(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
) -> Result<bool, String> {
    let root = project_root_for_commands(&workspace_state);
    // 1. Check disk
    if root.join(&path).exists() {
        return Ok(true);
    }
    // 2. Check HEAD commit (was the file ever committed?)
    if git_run(&["cat-file", "-e", &format!("HEAD:{}", path)], &root).is_ok() {
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
pub async fn git_revert_file(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    git_run_async(vec!["checkout".into(), "--".into(), path], root).await?;
    Ok(())
}

#[tauri::command]
pub async fn git_log(
    workspace_state: State<'_, WorkspaceState>,
    limit: Option<u32>,
    branch: Option<String>,
) -> Result<Vec<CommitEntry>, String> {
    let root = project_root_for_commands(&workspace_state);
    info!(root = %root.display(), ?limit, "git_log");
    if !root.join(".git").exists() {
        return Ok(Vec::new());
    }

    let limit = limit.unwrap_or(50);
    let mut args = vec![
        "log".to_string(),
        "--format=%H|%s|%an|%ar".to_string(),
        format!("-n{}", limit),
    ];
    if let Some(b) = branch {
        args.push(b);
    }

    let output = git_run_async(args, root).await
        .map_err(|e| {
            error!("git_log failed: {}", e);
            e
        })?;

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
        let meta_out = git_run(
            &["log", "--format=%H|%s|%an|%ar|%b", "-1", &hash],
            &root,
        ).map_err(|e| format!("Failed to run git log: {}", e))?;

        let meta_str = String::from_utf8_lossy(&meta_out.stdout);
        let mut meta_parts = meta_str.splitn(5, '|');
        let commit_hash = meta_parts.next().unwrap_or(&hash).to_string();
        let message = meta_parts.next().unwrap_or("").to_string();
        let author = meta_parts.next().unwrap_or("").to_string();
        let date = meta_parts.next().unwrap_or("").to_string();
        let body = meta_parts.next().unwrap_or("").trim().to_string();

        let stat_out = git_run(
            &["show", "--numstat", "--format=", &hash],
            &root,
        ).map_err(|e| format!("Failed to run git show: {}", e))?;

        let stat_str = String::from_utf8_lossy(&stat_out.stdout);
        let mut files = Vec::new();
        for line in stat_str.lines() {
            let line = line.trim();
            if line.is_empty() { continue; }
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 3 { continue; }
            let additions = if parts[0] == "-" { 0 } else { parts[0].parse().unwrap_or(0) };
            let deletions = if parts[1] == "-" { 0 } else { parts[1].parse().unwrap_or(0) };
            files.push(DiffEntry {
                path: parts[2].to_string(),
                status: status_from_numstat(parts[0], parts[1]),
                additions,
                deletions,
            });
        }

        Ok(CommitDetail { hash: commit_hash, message, author, date, body, files })
    }).await
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

#[tauri::command]
pub async fn git_diff_content(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
    staged: Option<bool>,
    commit_hash: Option<String>,
) -> Result<String, String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Err("Not a git repository".into());
    }

    // git diff + fallback file read in one blocking task
    git_run_blocking(move || {
        let mut args: Vec<&str> = vec!["diff"];
        if staged.unwrap_or(false) {
            args.push("--cached");
        }
        let hash_flag;
        if let Some(ref h) = commit_hash {
            hash_flag = format!("{}^!", h);
            args.push(&hash_flag);
        }
        args.push("--");
        args.push(&path);

        let output = git_run(&args, &root)
            .map_err(|e| format!("Failed to run git diff: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        if !stdout.is_empty() {
            return Ok(stdout);
        }

        // Fallback: new file — synthesise a diff from its content
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
        Ok("No changes".to_string())
    }).await
}

#[tauri::command]
pub async fn git_branches(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<Vec<BranchInfo>, String> {
    let root = project_root_for_commands(&workspace_state);
    info!(root = %root.display(), "git_branches");
    if !root.join(".git").exists() {
        return Ok(Vec::new());
    }

    let output = match git_run_async(vec!["branch".into()], root).await {
        Ok(o) => o,
        Err(e) => {
            error!("git_branches failed: {}", e);
            return Err(format!("Failed to run git branch: {}", e));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        error!("git_branches stderr: {}", stderr);
    }

    let mut branches = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(name) = trimmed.strip_prefix("* ") {
            branches.push(BranchInfo { name: name.to_string(), is_current: true });
        } else {
            branches.push(BranchInfo { name: trimmed.to_string(), is_current: false });
        }
    }

    branches.sort_by(|a, b| b.is_current.cmp(&a.is_current).then(a.name.cmp(&b.name)));
    info!(count = branches.len(), "git_branches ok");
    Ok(branches)
}

#[tauri::command]
pub async fn git_checkout(
    workspace_state: State<'_, WorkspaceState>,
    branch: String,
) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Err("Not a git repository".into());
    }

    let output = git_run_async(vec!["checkout".into(), branch], root).await
        .map_err(|e| format!("Failed to run git checkout: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Checkout failed: {}", stderr.trim()));
    }

    Ok(())
}

#[tauri::command]
pub async fn git_status(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<GitStatus, String> {
    let root = project_root_for_commands(&workspace_state);
    info!(root = %root.display(), "git_status");
    if !root.join(".git").exists() {
        return Ok(GitStatus { entries: vec![] });
    }

    let output = match git_run_async(vec!["status".into(), "--porcelain".into()], root).await {
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
        let path = line[3..].trim().to_string();
        if path.is_empty() {
            continue;
        }
        let x = line.chars().next().unwrap_or(' ');
        let y = line.chars().nth(1).unwrap_or(' ');
        let (staged, status) = match (x, y) {
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

#[tauri::command]
pub async fn git_commit(
    workspace_state: State<'_, WorkspaceState>,
    message: String,
) -> Result<String, String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Err("Not a git repository".into());
    }

    // status + commit + rev-parse in one blocking task
    git_run_blocking(move || {
        let status_out = git_run(&["status", "--porcelain"], &root)
            .map_err(|e| format!("Failed to run git status: {}", e))?;
        let stdout = String::from_utf8_lossy(&status_out.stdout);
        if stdout.trim().is_empty() {
            return Err("Nothing to commit (working tree clean)".into());
        }

        let output = git_run(&["commit", "-m", &message], &root)
            .map_err(|e| format!("Failed to run git commit: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Commit failed: {}", stderr.trim()));
        }

        let hash_out = git_run(&["rev-parse", "HEAD"], &root)
            .map_err(|e| format!("Failed to get commit hash: {}", e))?;
        Ok(String::from_utf8_lossy(&hash_out.stdout).trim().to_string())
    }).await
}

#[tauri::command]
pub async fn git_unpushed_commits(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<Vec<String>, String> {
    let root = project_root_for_commands(&workspace_state);
    info!(root = %root.display(), "git_unpushed_commits");
    if !root.join(".git").exists() {
        return Ok(Vec::new());
    }

    // Determine current branch
    let branch = detect_git_branch(&root);
    if branch.is_empty() {
        return Ok(Vec::new());
    }

    // git log origin/<branch>..HEAD — commits in local but not on remote
    let range = format!("origin/{}..HEAD", branch);
    let output = match git_run_async(
        vec!["log".into(), "--format=%H".into(), range],
        root.clone(),
    )
    .await
    {
        Ok(o) => o,
        Err(e) => {
            // No upstream configured — all commits are unpushed
            info!("git_unpushed_commits (no upstream): {}", e);
            return Ok(Vec::new());
        }
    };

    if !output.status.success() {
        // origin/<branch> doesn't exist yet → all commits are unpushed
        // `git log` with a non-existent ref exits non-zero; fall back to just HEAD
        let fallback = git_run_async(
            vec!["log".into(), "--format=%H".into()],
            root.clone(),
        )
        .await
        .map_err(|e| format!("Failed to run git log: {}", e))?;
        let stdout = String::from_utf8_lossy(&fallback.stdout);
        let hashes: Vec<String> = stdout.lines().map(|s| s.to_string()).filter(|s| !s.is_empty()).collect();
        info!(count = hashes.len(), "git_unpushed_commits (all unpushed)");
        return Ok(hashes);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let hashes: Vec<String> = stdout.lines().map(|s| s.to_string()).filter(|s| !s.is_empty()).collect();
    info!(count = hashes.len(), "git_unpushed_commits ok");
    Ok(hashes)
}
