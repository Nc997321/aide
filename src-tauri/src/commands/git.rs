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
    /// true = 远程跟踪分支（`origin/xxx`），本地分支为 false
    pub is_remote: bool,
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

/// git 默认对含非 ASCII/特殊字符的路径做 C 风格引号转义（core.quotepath），
/// 形如 `"C\357\200\272foo.md"`（八进制字节转义 + 首尾双引号）。还原为真实
/// UTF-8 路径；无引号包裹的输入原样返回。
/// status/numstat/ls-files/ls-tree 的输出都受此规则影响，不还原会导致下游
/// 文件操作（删除/diff/撤回）拿到不存在的转义名而静默失败。
fn unquote_git_path(s: &str) -> String {
    let bytes = s.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'"' || bytes[bytes.len() - 1] != b'"' {
        return s.to_string();
    }
    let inner = &bytes[1..bytes.len() - 1];
    let mut out: Vec<u8> = Vec::with_capacity(inner.len());
    let mut i = 0;
    while i < inner.len() {
        if inner[i] == b'\\' && i + 1 < inner.len() {
            match inner[i + 1] {
                b'0'..=b'7' => {
                    // 最多 3 位八进制 → 单字节
                    let mut val: u32 = 0;
                    let mut j = 0;
                    while j < 3 && i + 1 + j < inner.len() && inner[i + 1 + j].is_ascii_digit() && inner[i + 1 + j] < b'8' {
                        val = val * 8 + (inner[i + 1 + j] - b'0') as u32;
                        j += 1;
                    }
                    out.push(val as u8);
                    i += 1 + j;
                }
                b'n' => { out.push(b'\n'); i += 2; }
                b't' => { out.push(b'\t'); i += 2; }
                b'b' => { out.push(0x08); i += 2; }
                b'f' => { out.push(0x0C); i += 2; }
                b'v' => { out.push(0x0B); i += 2; }
                b'\\' => { out.push(b'\\'); i += 2; }
                b'"' => { out.push(b'"'); i += 2; }
                other => { out.push(other); i += 2; }
            }
        } else {
            out.push(inner[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ── Timeout + Mutex ──

const GIT_TIMEOUT: Duration = Duration::from_secs(15);
/// fetch/pull/push 等网络操作走更长的超时——大仓库或慢网络下 15s 会误杀。
const GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(120);

/// Serialises all git invocations so concurrent calls never fight over
/// `.git/index.lock`.  A poisoned lock is treated as a fatal error and
/// immediately returned to the caller.
static GIT_LOCK: Mutex<()> = Mutex::new(());

/// Spawn `git` with the given arguments inside `root`, blocking until it
/// finishes or `timeout` expires — on timeout the child is **killed** so no
/// zombie git process is left behind.  stdout/stderr are drained on helper
/// threads so a chatty child can't deadlock on a full pipe.
fn git_run_with_timeout(
    args: &[&str],
    root: &std::path::Path,
    timeout: Duration,
) -> Result<std::process::Output, String> {
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

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn git: {}", e))?;

    let mut child_stdout = child.stdout.take().expect("stdout piped");
    let mut child_stderr = child.stderr.take().expect("stderr piped");
    let out_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut child_stdout, &mut buf).map(|_| buf)
    });
    let err_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut child_stderr, &mut buf).map(|_| buf)
    });

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = out_handle.join();
                    let _ = err_handle.join();
                    return Err(format!(
                        "Git command 'git {}' timed out after {}s",
                        args.join(" "),
                        timeout.as_secs(),
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("Failed to wait on git: {}", e)),
        }
    };

    let stdout = out_handle.join().unwrap_or(Ok(Vec::new())).unwrap_or_default();
    let stderr = err_handle.join().unwrap_or(Ok(Vec::new())).unwrap_or_default();
    Ok(std::process::Output { status, stdout, stderr })
}

/// Default-timeout variant used by all local (non-network) git invocations.
fn git_run(args: &[&str], root: &std::path::Path) -> Result<std::process::Output, String> {
    git_run_with_timeout(args, root, GIT_TIMEOUT)
}

/// Run git inside `tokio::spawn_blocking` so the async handler never blocks
/// the tokio worker thread.
async fn git_run_async_timeout(
    args: Vec<String>,
    root: std::path::PathBuf,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    tokio::task::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        git_run_with_timeout(&refs, &root, timeout)
    })
    .await
    .map_err(|e| format!("Git task panicked: {}", e))?
}

async fn git_run_async(
    args: Vec<String>,
    root: std::path::PathBuf,
) -> Result<std::process::Output, String> {
    git_run_async_timeout(args, root, GIT_TIMEOUT).await
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
                committed_paths.insert(unquote_git_path(p));
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
        if let Ok(untracked_out) = git_run(
            &["ls-files", "--others", "--exclude-standard"],
            &root,
        ) {
            let ut_stdout = String::from_utf8_lossy(&untracked_out.stdout);
            for path in ut_stdout.lines() {
                let rel = unquote_git_path(path);
                let file_path = root.join(&rel);
                if !file_path.is_file() { continue; }
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
pub async fn git_stash(
    workspace_state: State<'_, WorkspaceState>,
    message: Option<String>,
) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    let mut args = vec!["stash".to_string(), "push".to_string()];
    if let Some(m) = message {
        let m = m.trim().to_string();
        if !m.is_empty() {
            args.push("-m".to_string());
            args.push(m);
        }
    }
    let output = git_run_async(args, root).await
        .map_err(|e| format!("STASH_FAILED: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("STASH_FAILED: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
pub async fn git_stash_pop(
    workspace_state: State<'_, WorkspaceState>,
    index: Option<u32>,
) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    let mut args = vec!["stash".to_string(), "pop".to_string()];
    if let Some(i) = index {
        args.push(format!("stash@{{{}}}", i));
    }
    let output = git_run_async(args, root).await
        .map_err(|e| format!("STASH_POP_FAILED: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("STASH_POP_FAILED: {}", stderr.trim()));
    }
    Ok(())
}

#[derive(Debug, serde::Serialize, Clone)]
pub struct StashEntry {
    pub index: u32,
    pub name: String,
    pub message: String,
    pub date: String,
}

#[tauri::command]
pub async fn git_stash_list(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<Vec<StashEntry>, String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Ok(Vec::new());
    }
    let output = git_run_async(
        vec!["stash".into(), "list".into(), "--format=%gd|%gs|%cr".into()],
        root,
    ).await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();
    for line in stdout.lines() {
        let parts: Vec<&str> = line.splitn(3, '|').collect();
        if parts.len() < 3 { continue; }
        let name = parts[0].to_string();
        // stash@{N} → N；解析不出的行跳过（防御性格式变化）
        let index = name
            .trim_start_matches("stash@{")
            .trim_end_matches('}')
            .parse::<u32>();
        let Ok(index) = index else { continue; };
        entries.push(StashEntry {
            index,
            name,
            message: parts[1].to_string(),
            date: parts[2].to_string(),
        });
    }
    Ok(entries)
}

#[tauri::command]
pub async fn git_stash_apply(
    workspace_state: State<'_, WorkspaceState>,
    index: u32,
) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    let output = git_run_async(
        vec!["stash".into(), "apply".into(), format!("stash@{{{}}}", index)],
        root,
    ).await
        .map_err(|e| format!("STASH_APPLY_FAILED: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("STASH_APPLY_FAILED: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
pub async fn git_stash_drop(
    workspace_state: State<'_, WorkspaceState>,
    index: u32,
) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    let output = git_run_async(
        vec!["stash".into(), "drop".into(), format!("stash@{{{}}}", index)],
        root,
    ).await
        .map_err(|e| format!("STASH_DROP_FAILED: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("STASH_DROP_FAILED: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
pub async fn git_discard_all(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    let output = git_run_async(vec!["checkout".into(), "--".into(), ".".into()], root).await
        .map_err(|e| format!("DISCARD_FAILED: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("DISCARD_FAILED: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
pub async fn git_unstage_all(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    let output = git_run_async(vec!["reset".into(), "HEAD".into()], root).await
        .map_err(|e| format!("Failed to run git reset: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("UNSTAGE_FAILED: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
pub async fn git_create_branch(
    workspace_state: State<'_, WorkspaceState>,
    name: String,
) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Err("BRANCH_FAILED: Not a git repository".into());
    }
    let output = git_run_async(vec!["checkout".into(), "-b".into(), name.clone()], root).await
        .map_err(|e| format!("BRANCH_FAILED: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr_trimmed = stderr.trim();
        let code = if stderr_trimmed.contains("already exists") {
            "BRANCH_EXISTS"
        } else {
            "BRANCH_FAILED"
        };
        return Err(format!("{}: {}", code, stderr_trimmed));
    }
    Ok(())
}

/// git pull/fetch 成功后带回前端的结果摘要：是否已是最新 + 人话摘要。
/// already_up_to_date 决定前端 toast 用 info（中性）还是 success（有更新）。
#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FetchPullOutcome {
    pub already_up_to_date: bool,
    pub summary: String,
}

/// 抓 `N files changed` / `N file changed` 里的 N（git pull 合并/快进统计行）。
fn parse_files_changed(s: &str) -> Option<u32> {
    for line in s.lines() {
        let l = line.trim();
        let marker = if l.contains("files changed") {
            "files changed"
        } else if l.contains("file changed") {
            "file changed"
        } else {
            continue;
        };
        let prefix = l.split(marker).next().unwrap_or("").trim();
        if let Some(n) = prefix.split_whitespace().last() {
            if let Ok(n) = n.parse::<u32>() {
                return Some(n);
            }
        }
    }
    None
}

/// 解析 `git pull` 成功时的 stdout，产出前端 toast 用的人话摘要。
/// - `Already up to date.` → 已是最新
/// - `Fast-forward`/`Merge made` + `N files changed` → 快进更新/合并完成：N 个文件变化
/// - 其它有更新：取首行非空作摘要
fn parse_pull_output(stdout: &str) -> FetchPullOutcome {
    let t = stdout.trim();
    if t.is_empty() {
        return FetchPullOutcome { already_up_to_date: true, summary: "已是最新代码".into() };
    }
    let lower = t.to_lowercase();
    if lower.contains("already up to date") {
        return FetchPullOutcome { already_up_to_date: true, summary: "已是最新代码".into() };
    }
    let kind_prefix = if lower.contains("fast-forward") {
        "快进更新"
    } else if lower.contains("merge made") {
        "合并完成"
    } else {
        "拉取完成"
    };
    let summary = match parse_files_changed(t) {
        Some(n) => format!("{}：{} 个文件变化", kind_prefix, n),
        None => t.lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("拉取完成")
            .trim()
            .to_string(),
    };
    FetchPullOutcome { already_up_to_date: false, summary }
}

/// 解析 `git fetch` 成功时的 stdout。fetch 不改工作区，stdout 通常只有
/// `From <url>` 和 `abc..def  branch -> origin/branch` / `* [new branch] ...` 行
/// （进度信息走 stderr）。空 stdout = 无更新。
fn parse_fetch_output(stdout: &str) -> FetchPullOutcome {
    let t = stdout.trim();
    if t.is_empty() {
        return FetchPullOutcome { already_up_to_date: true, summary: "远端无新提交".into() };
    }
    let refs = t.lines().filter(|l| l.contains(" -> ")).count();
    if refs > 0 {
        return FetchPullOutcome {
            already_up_to_date: false,
            summary: format!("已获取远端更新（{} 个引用）", refs),
        };
    }
    let first = t.lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("已获取远端更新")
        .trim();
    FetchPullOutcome { already_up_to_date: false, summary: first.to_string() }
}

#[tauri::command]
pub async fn git_pull(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<FetchPullOutcome, String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Err("PULL_FAILED: Not a git repository".into());
    }

    let branch = detect_git_branch(&root);
    if branch.is_empty() {
        return Err("DETACHED_HEAD: 当前处于分离 HEAD 状态，请先切换到一个分支再拉取".into());
    }

    let output = git_run_async_timeout(
        vec!["pull".into(), "origin".into(), branch.clone()],
        root,
        GIT_NETWORK_TIMEOUT,
    ).await.map_err(|e| format!("PULL_FAILED: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let combined = format!("{}{}", stdout, stderr);
        let code = if combined.contains("CONFLICT") || combined.contains("Automatic merge failed") {
            "MERGE_CONFLICT"
        } else if combined.contains("Your local changes") || combined.contains("would be overwritten") {
            "LOCAL_CHANGES"
        } else if combined.contains("Could not resolve hostname") || combined.contains("unable to access") {
            "NETWORK_FAILURE"
        } else {
            "PULL_FAILED"
        };
        return Err(format!("{}: {}", code, combined.trim()));
    }
    Ok(parse_pull_output(&String::from_utf8_lossy(&output.stdout)))
}

#[tauri::command]
pub async fn git_fetch(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<FetchPullOutcome, String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Err("FETCH_FAILED: Not a git repository".into());
    }

    // Prefer `origin`; fall back to the first configured remote; none → error.
    let remote = match git_run_async(vec!["remote".into()], root.clone()).await {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let remotes: Vec<&str> = stdout.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
            if remotes.iter().any(|r| *r == "origin") {
                "origin".to_string()
            } else if let Some(first) = remotes.first() {
                first.to_string()
            } else {
                return Err("NO_REMOTE: 没有配置任何远程仓库".into());
            }
        }
        _ => return Err("NO_REMOTE: 没有配置任何远程仓库".into()),
    };

    let output = git_run_async_timeout(
        vec!["fetch".into(), remote, "--prune".into()],
        root,
        GIT_NETWORK_TIMEOUT,
    ).await.map_err(|e| format!("FETCH_FAILED: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = stderr.trim();
        let code = if msg.contains("Could not resolve hostname") || msg.contains("unable to access") {
            "NETWORK_FAILURE"
        } else {
            "FETCH_FAILED"
        };
        return Err(format!("{}: {}", code, msg));
    }
    Ok(parse_fetch_output(&String::from_utf8_lossy(&output.stdout)))
}

#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AheadBehind {
    pub ahead: u32,
    pub behind: u32,
    pub has_upstream: bool,
}

/// `git rev-list --left-right --count @{upstream}...HEAD` →
/// left = 仅远端（behind），right = 仅本地（ahead）。无 upstream 时全 0。
#[tauri::command]
pub async fn git_ahead_behind(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<AheadBehind, String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Ok(AheadBehind { ahead: 0, behind: 0, has_upstream: false });
    }
    let output = git_run_async(
        vec!["rev-list".into(), "--left-right".into(), "--count".into(), "@{upstream}...HEAD".into()],
        root,
    ).await?;
    if !output.status.success() {
        // 无 upstream 或 detached HEAD
        return Ok(AheadBehind { ahead: 0, behind: 0, has_upstream: false });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut parts = stdout.split_whitespace();
    let behind = parts.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    let ahead = parts.next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    Ok(AheadBehind { ahead, behind, has_upstream: true })
}

#[tauri::command]
pub async fn git_delete_branch(
    workspace_state: State<'_, WorkspaceState>,
    name: String,
    force: Option<bool>,
) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Err("DELETE_FAILED: Not a git repository".into());
    }
    let flag = if force.unwrap_or(false) { "-D" } else { "-d" };
    let output = git_run_async(vec!["branch".into(), flag.into(), name.clone()], root).await
        .map_err(|e| format!("DELETE_FAILED: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr_trimmed = stderr.trim();
        let code = if stderr_trimmed.contains("not fully merged") || stderr_trimmed.contains("is not fully merged") {
            "BRANCH_NOT_MERGED"
        } else {
            "DELETE_FAILED"
        };
        return Err(format!("{}: {}", code, stderr_trimmed));
    }
    Ok(())
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
                path: unquote_git_path(parts[2]),
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

// ── Diff pair：编辑器级 diff 查看器的数据层 ──

#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiffPair {
    pub old_text: String,
    pub new_text: String,
    pub old_label: String,
    pub new_label: String,
    pub status: String, // "added" | "modified" | "deleted"
    pub is_binary: bool,
    pub eol_only: bool,
    pub too_big: bool,
}

/// 统一行尾为 LF：CRLF/LF 翻转不该让 merge 视图每行都标变更。
fn normalize_eol(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n")
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|b| *b == 0)
}

/// `git show <rev>:<path>`；blob 不存在（未跟踪 / 该 rev 无此文件）→ None。
fn show_blob(rev_path: &str, root: &std::path::Path) -> Result<Option<Vec<u8>>, String> {
    let out = git_run(&["show", rev_path], root)?;
    if out.status.success() {
        Ok(Some(out.stdout))
    } else {
        Ok(None)
    }
}

/// 三种场景取数：未暂存 = HEAD vs 磁盘；已暂存 = HEAD vs 索引；提交 = h^ vs h。
/// 返回前两侧都做行尾归一化；归一化后相等但原文不等 → eol_only。
/// 单侧超过 1MB 时标记 too_big 并返回空文本，避免巨大 payload 跨 IPC。
fn build_diff_pair(
    root: &std::path::Path,
    path: &str,
    staged: bool,
    commit_hash: Option<&str>,
) -> Result<DiffPair, String> {
    const MAX_DIFF_BYTES: u64 = 1_000_000;

    let (
        old_label,
        new_label,
        old_exists,
        new_exists,
        old_bytes,
        new_bytes,
        old_too_big,
        new_too_big,
    ) = if let Some(h) = commit_hash {
        let short = &h[..7.min(h.len())];
        let old = show_blob(&format!("{}^:{}", h, path), root)?;
        let new = show_blob(&format!("{}:{}", h, path), root)?;
        let old_exists = old.is_some();
        let new_exists = new.is_some();
        let old_too_big = old.as_ref().map(|b| b.len() as u64 > MAX_DIFF_BYTES).unwrap_or(false);
        let new_too_big = new.as_ref().map(|b| b.len() as u64 > MAX_DIFF_BYTES).unwrap_or(false);
        (
            format!("{}^", short),
            short.to_string(),
            old_exists,
            new_exists,
            old,
            new,
            old_too_big,
            new_too_big,
        )
    } else if staged {
        let old = show_blob(&format!("HEAD:{}", path), root)?;
        let new = show_blob(&format!(":{}", path), root)?;
        let old_exists = old.is_some();
        let new_exists = new.is_some();
        let old_too_big = old.as_ref().map(|b| b.len() as u64 > MAX_DIFF_BYTES).unwrap_or(false);
        let new_too_big = new.as_ref().map(|b| b.len() as u64 > MAX_DIFF_BYTES).unwrap_or(false);
        (
            "HEAD".to_string(),
            "已暂存".to_string(),
            old_exists,
            new_exists,
            old,
            new,
            old_too_big,
            new_too_big,
        )
    } else {
        let old = show_blob(&format!("HEAD:{}", path), root)?;
        let new_path = root.join(path);
        let new_exists = new_path.exists();
        let (new, new_too_big) = if new_exists {
            let meta = std::fs::metadata(&new_path)
                .map_err(|e| format!("Failed to read metadata for {}: {}", path, e))?;
            if meta.len() > MAX_DIFF_BYTES {
                (None, true)
            } else {
                (std::fs::read(&new_path).ok(), false)
            }
        } else {
            (None, false)
        };
        let old_exists = old.is_some();
        let old_too_big = old.as_ref().map(|b| b.len() as u64 > MAX_DIFF_BYTES).unwrap_or(false);
        (
            "HEAD".to_string(),
            "工作区".to_string(),
            old_exists,
            new_exists,
            old,
            new,
            old_too_big,
            new_too_big,
        )
    };

    let too_big = old_too_big || new_too_big;
    let is_binary = !too_big
        && (old_bytes.as_deref().map(looks_binary).unwrap_or(false)
            || new_bytes.as_deref().map(looks_binary).unwrap_or(false));

    let status = match (old_exists, new_exists) {
        (false, true) => "added",
        (true, false) => "deleted",
        // 两侧皆空（如未跟踪的空文件）：按磁盘存在性兜底
        (false, false) => {
            if root.join(path).exists() { "added" } else { "deleted" }
        }
        (true, true) => "modified",
    };

    if too_big {
        return Ok(DiffPair {
            old_text: String::new(),
            new_text: String::new(),
            old_label,
            new_label,
            status: status.to_string(),
            is_binary,
            eol_only: false,
            too_big,
        });
    }

    let old_str = old_bytes.map(|b| String::from_utf8_lossy(&b).into_owned());
    let new_str = new_bytes.map(|b| String::from_utf8_lossy(&b).into_owned());

    let old_raw_str = old_str.unwrap_or_default();
    let new_raw_str = new_str.unwrap_or_default();
    let old_text = normalize_eol(&old_raw_str);
    let new_text = normalize_eol(&new_raw_str);
    let eol_only = old_text == new_text && old_raw_str != new_raw_str;

    Ok(DiffPair {
        old_text,
        new_text,
        old_label,
        new_label,
        status: status.to_string(),
        is_binary,
        eol_only,
        too_big,
    })
}

#[tauri::command]
pub async fn git_diff_pair(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
    staged: Option<bool>,
    commit_hash: Option<String>,
) -> Result<DiffPair, String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Err("Not a git repository".into());
    }
    git_run_blocking(move || {
        build_diff_pair(&root, &path, staged.unwrap_or(false), commit_hash.as_deref())
    })
    .await
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

    let output = match git_run_async(vec!["branch".into(), "-a".into()], root).await {
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
        // 跳过符号引用别名行（`origin/HEAD -> origin/main`），不是真实分支
        if trimmed.contains(" -> ") {
            continue;
        }
        let (is_current, raw) = match trimmed.strip_prefix("* ") {
            Some(rest) => (true, rest),
            None => (false, trimmed),
        };
        // `git branch -a` 里远程分支带 `remotes/` 前缀，剥掉后展示为 origin/xxx
        let (is_remote, name) = match raw.strip_prefix("remotes/") {
            Some(rest) => (true, rest.to_string()),
            None => (false, raw.to_string()),
        };
        branches.push(BranchInfo { name, is_current, is_remote });
    }

    branches.sort_by(|a, b| {
        b.is_current
            .cmp(&a.is_current)
            .then(a.is_remote.cmp(&b.is_remote))
            .then(a.name.cmp(&b.name))
    });
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

    let mut args: Vec<String> = vec!["checkout".into()];
    if let Some((_, local)) = branch.split_once('/') {
        // 远程分支 ref（origin/xxx，git remote 名不含 `/`）：
        // 本地无同名分支 → `git checkout -b <短名> --track <ref>` 创建跟踪分支；
        // 已有同名本地分支 → 检出本地分支（即该远程分支的本地跟踪分支），避免检出远程 ref 变 detached HEAD。
        let local_exists = git_run_async(
            vec![
                "show-ref".into(),
                "--verify".into(),
                "--quiet".into(),
                format!("refs/heads/{}", local),
            ],
            root.clone(),
        )
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);
        if !local_exists {
            args.push("-b".into());
            args.push(local.to_string());
            args.push("--track".into());
            args.push(branch.clone());
        } else {
            args.push(local.to_string());
        }
    } else {
        args.push(branch.clone());
    }

    let output = git_run_async(args, root).await
        .map_err(|e| format!("Failed to run git checkout: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr_trimmed = stderr.trim();
        let code = if stderr_trimmed.contains("would be overwritten by checkout") {
            "CHECKOUT_CONFLICT"
        } else {
            "CHECKOUT_FAILED"
        };
        return Err(format!("{}: {}", code, stderr_trimmed));
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

    let output = match git_run_async(vec!["status".into(), "--porcelain".into(), "-u".into()], root).await {
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
            ('U', 'U') | ('A', 'A') | ('D', 'D') | ('A', 'U') | ('U', 'A') | ('D', 'U') | ('U', 'D') => (false, "C"),
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
    amend: Option<bool>,
) -> Result<String, String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Err("Not a git repository".into());
    }

    // status + commit + rev-parse in one blocking task
    git_run_blocking(move || {
        let amend = amend.unwrap_or(false);
        if !amend {
            let status_out = git_run(&["status", "--porcelain"], &root)
                .map_err(|e| format!("Failed to run git status: {}", e))?;
            let stdout = String::from_utf8_lossy(&status_out.stdout);
            if stdout.trim().is_empty() {
                return Err("Nothing to commit (working tree clean)".into());
            }
        }

        // amend 无 message 时保留原提交信息（--no-edit）；
        // amend 对工作区干净（纯改 message）也合法，故跳过上面的 precheck。
        let mut args: Vec<&str> = vec!["commit"];
        if amend {
            args.push("--amend");
            if message.trim().is_empty() {
                args.push("--no-edit");
            }
        }
        if !message.trim().is_empty() {
            args.push("-m");
            args.push(&message);
        }
        let output = git_run(&args, &root)
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

#[tauri::command]
pub async fn git_push(
    workspace_state: State<'_, WorkspaceState>,
    force: Option<bool>,
) -> Result<(), String> {
    let root = project_root_for_commands(&workspace_state);
    info!(root = %root.display(), "git_push");
    if !root.join(".git").exists() {
        return Err("Not a git repository".into());
    }

    let branch = detect_git_branch(&root);
    if branch.is_empty() {
        return Err("DETACHED_HEAD: 当前处于分离 HEAD 状态，请先切换到一个分支再推送".into());
    }

    // Prefer `origin`; fall back to the first configured remote.
    let remote = match git_run_async(vec!["remote".into()], root.clone()).await {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let remotes: Vec<&str> = stdout.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
            if remotes.iter().any(|r| *r == "origin") {
                "origin".to_string()
            } else {
                remotes.first().map(|s| s.to_string()).unwrap_or_else(|| "origin".into())
            }
        }
        _ => "origin".into(),
    };

    let mut args = vec!["push".into(), "-u".into(), remote.clone(), branch.clone()];
    if force.unwrap_or(false) {
        args.insert(1, "--force-with-lease".into());
    }

    info!(%remote, %branch, ?force, "git_push");
    let output = git_run_async_timeout(args, root, GIT_NETWORK_TIMEOUT)
    .await
    .map_err(|e| format!("Failed to run git push: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = stderr.trim();
        let code = if msg.contains("non-fast-forward") || msg.contains("rejected") {
            "REJECTED"
        } else if msg.contains("no upstream") {
            "NO_UPSTREAM"
        } else if msg.contains("Could not resolve host") || msg.contains("Could not connect") {
            "NETWORK_FAILURE"
        } else {
            "PUSH_FAILED"
        };
        return Err(format!("{}: {}", code, msg));
    }

    info!("git_push ok");
    Ok(())
}

/// 每 3s 轮询一次（useGitWatcher.ts），递归遍历 `.git/refs`——持续高频的同步
/// 命令，埋 trace_command 便于诊断报告点名（同批见 marketplace.rs 顶部注释）。
#[tauri::command]
pub fn git_fingerprint(
    workspace_state: State<'_, WorkspaceState>,
) -> Result<String, String> {
    let _trace = crate::diagnostics::trace_command("git_fingerprint");
    let root = project_root_for_commands(&workspace_state);
    let git_dir = root.join(".git");
    if !git_dir.exists() {
        return Ok(String::new());
    }

    fn mtime_ms(path: &std::path::Path) -> u64 {
        path.metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn dir_max_mtime(dir: &std::path::Path, depth: u8) -> u64 {
        let mut max = mtime_ms(dir);
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                let m = if p.is_dir() && depth < 3 {
                    dir_max_mtime(&p, depth + 1)
                } else {
                    mtime_ms(&p)
                };
                if m > max { max = m; }
            }
        }
        max
    }

    let head = mtime_ms(&git_dir.join("HEAD"));
    let index = mtime_ms(&git_dir.join("index"));
    let fetch_head = mtime_ms(&git_dir.join("FETCH_HEAD"));
    let refs_heads = dir_max_mtime(&git_dir.join("refs").join("heads"), 0);
    let refs_remotes = dir_max_mtime(&git_dir.join("refs").join("remotes"), 0);
    let stash = mtime_ms(&git_dir.join("refs").join("stash"));

    Ok(format!("{}-{}-{}-{}-{}-{}", head, index, fetch_head, refs_heads, refs_remotes, stash))
}

#[cfg(test)]
mod unquote_tests {
    use super::unquote_git_path;

    #[test]
    fn plain_path_passthrough() {
        assert_eq!(unquote_git_path("src/api.ts"), "src/api.ts");
        assert_eq!(unquote_git_path("docs/设计.md"), "docs/设计.md");
    }

    #[test]
    fn octal_escaped_utf8_decoded() {
        // \357\200\272 = U+F03A（私用区，某些工具把文件名里的 ':' 映射到这里）
        assert_eq!(
            unquote_git_path("\"C\\357\\200\\272UsersheavenIdeaProjectsaidetest.md\""),
            "C\u{f03a}UsersheavenIdeaProjectsaidetest.md"
        );
        // 中文路径：设 = \350\256\276 计 = \350\256\241
        assert_eq!(
            unquote_git_path("\"docs/\\350\\256\\276\\350\\256\\241.md\""),
            "docs/设计.md"
        );
    }

    #[test]
    fn c_escapes_decoded() {
        assert_eq!(unquote_git_path("\"a\\nb.md\""), "a\nb.md");
        assert_eq!(unquote_git_path("\"a\\tb.md\""), "a\tb.md");
        assert_eq!(unquote_git_path("\"a\\\\b.md\""), "a\\b.md");
        assert_eq!(unquote_git_path("\"a\\\"b.md\""), "a\"b.md");
    }

    #[test]
    fn unmatched_or_short_quotes_passthrough() {
        assert_eq!(unquote_git_path("\"abc"), "\"abc");
        assert_eq!(unquote_git_path("abc\""), "abc\"");
        assert_eq!(unquote_git_path("\""), "\"");
    }
}

#[cfg(test)]
mod diff_pair_tests {
    use super::*;
    use std::process::Command;

    fn git(root: &std::path::Path, args: &[&str]) {
        let out = Command::new("git").args(args).current_dir(root).output().unwrap();
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// 每个测试独立目录（可并行）；关 autocrlf 保证行尾可控。
    fn setup_repo(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("aide_diffpair_test_{}", name));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init"]);
        git(&root, &["config", "user.email", "test@example.com"]);
        git(&root, &["config", "user.name", "Test"]);
        git(&root, &["config", "core.autocrlf", "false"]);
        root
    }

    #[test]
    fn modified_unstaged_returns_head_vs_worktree() {
        let root = setup_repo("modified");
        std::fs::write(root.join("a.txt"), "line1\nline2\nline3\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "v1"]);
        std::fs::write(root.join("a.txt"), "line1\nCHANGED\nline3\n").unwrap();

        let pair = build_diff_pair(&root, "a.txt", false, None).unwrap();
        assert_eq!(pair.status, "modified");
        assert!(pair.old_text.contains("line2"));
        assert!(pair.new_text.contains("CHANGED"));
        assert_eq!(pair.old_label, "HEAD");
        assert_eq!(pair.new_label, "工作区");
        assert!(!pair.eol_only);
        assert!(!pair.is_binary);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn staged_returns_head_vs_index() {
        let root = setup_repo("staged");
        std::fs::write(root.join("a.txt"), "v1\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "v1"]);
        std::fs::write(root.join("a.txt"), "v2\n").unwrap();
        git(&root, &["add", "a.txt"]);

        let pair = build_diff_pair(&root, "a.txt", true, None).unwrap();
        assert_eq!(pair.status, "modified");
        assert_eq!(pair.old_text, "v1\n");
        assert_eq!(pair.new_text, "v2\n");
        assert_eq!(pair.new_label, "已暂存");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn commit_returns_parent_vs_commit() {
        let root = setup_repo("commit");
        std::fs::write(root.join("a.txt"), "v1\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "v1"]);
        std::fs::write(root.join("a.txt"), "v2\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "v2"]);
        let head = String::from_utf8_lossy(
            &Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(&root)
                .output()
                .unwrap()
                .stdout,
        )
        .trim()
        .to_string();

        let pair = build_diff_pair(&root, "a.txt", false, Some(&head)).unwrap();
        assert_eq!(pair.old_text, "v1\n");
        assert_eq!(pair.new_text, "v2\n");
        assert_eq!(pair.status, "modified");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn untracked_file_is_added_with_empty_old() {
        let root = setup_repo("untracked");
        std::fs::write(root.join("a.txt"), "seed\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "init"]);
        std::fs::write(root.join("new.txt"), "brand new\n").unwrap();

        let pair = build_diff_pair(&root, "new.txt", false, None).unwrap();
        assert_eq!(pair.status, "added");
        assert_eq!(pair.old_text, "");
        assert_eq!(pair.new_text, "brand new\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn deleted_file_is_deleted_with_empty_new() {
        let root = setup_repo("deleted");
        std::fs::write(root.join("a.txt"), "gone\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "v1"]);
        std::fs::remove_file(root.join("a.txt")).unwrap();

        let pair = build_diff_pair(&root, "a.txt", false, None).unwrap();
        assert_eq!(pair.status, "deleted");
        assert_eq!(pair.old_text, "gone\n");
        assert_eq!(pair.new_text, "");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn crlf_only_difference_sets_eol_only() {
        let root = setup_repo("eol");
        std::fs::write(root.join("a.txt"), "line1\nline2\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "v1"]);
        // 同一内容换成 CRLF——正是"假新文件"bug 的真实场景
        std::fs::write(root.join("a.txt"), "line1\r\nline2\r\n").unwrap();

        let pair = build_diff_pair(&root, "a.txt", false, None).unwrap();
        assert!(pair.eol_only);
        assert_eq!(pair.old_text, pair.new_text); // 归一化后相等
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn oversized_worktree_file_sets_too_big_and_empty_texts() {
        let root = setup_repo("oversized");
        std::fs::write(root.join("a.txt"), "small\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "v1"]);
        std::fs::write(root.join("a.txt"), "x".repeat(1_100_000)).unwrap();

        let pair = build_diff_pair(&root, "a.txt", false, None).unwrap();
        assert!(pair.too_big);
        assert_eq!(pair.old_text, "");
        assert_eq!(pair.new_text, "");
        assert_eq!(pair.status, "modified");
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod fetch_pull_tests {
    use super::*;

    #[test]
    fn pull_already_up_to_date() {
        let o = parse_pull_output("Already up to date.\n");
        assert!(o.already_up_to_date);
        assert_eq!(o.summary, "已是最新代码");
    }

    #[test]
    fn pull_already_up_to_date_with_branch() {
        let o = parse_pull_output("Already up to date with 'origin/main'.\n");
        assert!(o.already_up_to_date);
        assert_eq!(o.summary, "已是最新代码");
    }

    #[test]
    fn pull_empty_stdout_treated_as_up_to_date() {
        let o = parse_pull_output("");
        assert!(o.already_up_to_date);
        assert_eq!(o.summary, "已是最新代码");
    }

    #[test]
    fn pull_fast_forward_with_files_changed() {
        let stdout = "Updating 6e8d0a3..a4c5d12\nFast-forward\n README.md | 2 +-\n src/a.ts | 10 +++++-----\n 2 files changed, 6 insertions(+), 6 deletions(-)\n";
        let o = parse_pull_output(stdout);
        assert!(!o.already_up_to_date);
        assert_eq!(o.summary, "快进更新：2 个文件变化");
    }

    #[test]
    fn pull_merge_with_files_changed() {
        let stdout = "Merge made by the 'ort' strategy.\n README.md | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n";
        let o = parse_pull_output(stdout);
        assert!(!o.already_up_to_date);
        assert_eq!(o.summary, "合并完成：1 个文件变化");
    }

    #[test]
    fn pull_single_file_fast_forward() {
        let stdout = "Updating a..b\nFast-forward\n only.txt | 3 +++\n 1 file changed, 3 insertions(+)\n";
        let o = parse_pull_output(stdout);
        assert!(!o.already_up_to_date);
        assert_eq!(o.summary, "快进更新：1 个文件变化");
    }

    #[test]
    fn fetch_empty_means_no_update() {
        let o = parse_fetch_output("");
        assert!(o.already_up_to_date);
        assert_eq!(o.summary, "远端无新提交");
    }

    #[test]
    fn fetch_with_ref_updates_counts_refs() {
        let stdout = "From github.com:user/repo\n   6e8d0a3..a4c5d12  main    -> origin/main\n * [new branch]      feature -> origin/feature\n";
        let o = parse_fetch_output(stdout);
        assert!(!o.already_up_to_date);
        assert_eq!(o.summary, "已获取远端更新（2 个引用）");
    }

    #[test]
    fn fetch_deleted_ref_counts() {
        let stdout = " - [deleted]         (none)   -> origin/old-branch\n";
        let o = parse_fetch_output(stdout);
        assert!(!o.already_up_to_date);
        assert_eq!(o.summary, "已获取远端更新（1 个引用）");
    }

    #[test]
    fn fetch_no_ref_marker_falls_back_to_first_line() {
        let stdout = "From github.com:user/repo\n";
        let o = parse_fetch_output(stdout);
        assert!(!o.already_up_to_date);
        assert_eq!(o.summary, "From github.com:user/repo");
    }
}
