// 远端同步域：remote_url / fetch / pull / push / ahead_behind / unpushed。
// 网络命令走 GIT_NETWORK_TIMEOUT（120s）；错误归类（MERGE_CONFLICT /
// NETWORK_FAILURE / REJECTED 等）给前端 toast 人话提示。pull/fetch 的
// stdout 解析为纯函数，配单测。
use super::runtime::{git_run_async, git_run_async_timeout, GIT_NETWORK_TIMEOUT};
use crate::{detect_git_branch};
use std::path::PathBuf;
use tracing::info;
pub async fn git_remote_url(
    root: PathBuf,
) -> Result<Option<String>, String> {
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
        return FetchPullOutcome {
            already_up_to_date: true,
            summary: "已是最新代码".into(),
        };
    }
    let lower = t.to_lowercase();
    if lower.contains("already up to date") {
        return FetchPullOutcome {
            already_up_to_date: true,
            summary: "已是最新代码".into(),
        };
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
        None => t
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("拉取完成")
            .trim()
            .to_string(),
    };
    FetchPullOutcome {
        already_up_to_date: false,
        summary,
    }
}

/// 解析 `git fetch` 成功时的 stdout。fetch 不改工作区，stdout 通常只有
/// `From <url>` 和 `abc..def  branch -> origin/branch` / `* [new branch] ...` 行
/// （进度信息走 stderr）。空 stdout = 无更新。
fn parse_fetch_output(stdout: &str) -> FetchPullOutcome {
    let t = stdout.trim();
    if t.is_empty() {
        return FetchPullOutcome {
            already_up_to_date: true,
            summary: "远端无新提交".into(),
        };
    }
    let refs = t.lines().filter(|l| l.contains(" -> ")).count();
    if refs > 0 {
        return FetchPullOutcome {
            already_up_to_date: false,
            summary: format!("已获取远端更新（{} 个引用）", refs),
        };
    }
    let first = t
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("已获取远端更新")
        .trim();
    FetchPullOutcome {
        already_up_to_date: false,
        summary: first.to_string(),
    }
}

pub async fn git_pull(
    root: PathBuf,
) -> Result<FetchPullOutcome, String> {
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
    )
    .await
    .map_err(|e| format!("PULL_FAILED: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let combined = format!("{}{}", stdout, stderr);
        let code = if combined.contains("CONFLICT") || combined.contains("Automatic merge failed") {
            "MERGE_CONFLICT"
        } else if combined.contains("Your local changes")
            || combined.contains("would be overwritten")
        {
            "LOCAL_CHANGES"
        } else if combined.contains("Could not resolve hostname")
            || combined.contains("unable to access")
        {
            "NETWORK_FAILURE"
        } else {
            "PULL_FAILED"
        };
        return Err(format!("{}: {}", code, combined.trim()));
    }
    Ok(parse_pull_output(&String::from_utf8_lossy(&output.stdout)))
}

pub async fn git_fetch(
    root: PathBuf,
) -> Result<FetchPullOutcome, String> {
    if !root.join(".git").exists() {
        return Err("FETCH_FAILED: Not a git repository".into());
    }

    // Prefer `origin`; fall back to the first configured remote; none → error.
    let remote = match git_run_async(vec!["remote".into()], root.clone()).await {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let remotes: Vec<&str> = stdout
                .lines()
                .map(|l| l.trim())
                .filter(|l| !l.is_empty())
                .collect();
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
    )
    .await
    .map_err(|e| format!("FETCH_FAILED: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = stderr.trim();
        let code = if msg.contains("Could not resolve hostname") || msg.contains("unable to access")
        {
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
pub async fn git_ahead_behind(
    root: PathBuf,
) -> Result<AheadBehind, String> {
    if !root.join(".git").exists() {
        return Ok(AheadBehind {
            ahead: 0,
            behind: 0,
            has_upstream: false,
        });
    }
    let output = git_run_async(
        vec![
            "rev-list".into(),
            "--left-right".into(),
            "--count".into(),
            "@{upstream}...HEAD".into(),
        ],
        root,
    )
    .await?;
    if !output.status.success() {
        // 无 upstream 或 detached HEAD
        return Ok(AheadBehind {
            ahead: 0,
            behind: 0,
            has_upstream: false,
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut parts = stdout.split_whitespace();
    let behind = parts
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    let ahead = parts
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    Ok(AheadBehind {
        ahead,
        behind,
        has_upstream: true,
    })
}

pub async fn git_unpushed_commits(
    root: PathBuf,
) -> Result<Vec<String>, String> {
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
        let fallback = git_run_async(vec!["log".into(), "--format=%H".into()], root.clone())
            .await
            .map_err(|e| format!("Failed to run git log: {}", e))?;
        let stdout = String::from_utf8_lossy(&fallback.stdout);
        let hashes: Vec<String> = stdout
            .lines()
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
            .collect();
        info!(count = hashes.len(), "git_unpushed_commits (all unpushed)");
        return Ok(hashes);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let hashes: Vec<String> = stdout
        .lines()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .collect();
    info!(count = hashes.len(), "git_unpushed_commits ok");
    Ok(hashes)
}

pub async fn git_push(
    root: PathBuf,
    force: Option<bool>,
) -> Result<(), String> {
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
            let remotes: Vec<&str> = stdout
                .lines()
                .map(|l| l.trim())
                .filter(|l| !l.is_empty())
                .collect();
            if remotes.iter().any(|r| *r == "origin") {
                "origin".to_string()
            } else {
                remotes
                    .first()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "origin".into())
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
        let stdout =
            "Updating a..b\nFast-forward\n only.txt | 3 +++\n 1 file changed, 3 insertions(+)\n";
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
