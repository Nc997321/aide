// 分支域：列出（本地+远程合并排序）、新建（重名区分 BRANCH_EXISTS）、
// 删除（未合并时 BRANCH_NOT_MERGED）、检出（origin/xxx 自动建跟踪分支）。
use super::runtime::git_run_async;

use std::path::PathBuf;
use tracing::{error, info};
#[derive(Debug, serde::Serialize, Clone)]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    /// true = 远程跟踪分支（`origin/xxx`），本地分支为 false
    pub is_remote: bool,
}

pub async fn git_create_branch(
    root: PathBuf,
    name: String,
) -> Result<(), String> {
    if !root.join(".git").exists() {
        return Err("BRANCH_FAILED: Not a git repository".into());
    }
    let output = git_run_async(vec!["checkout".into(), "-b".into(), name.clone()], root)
        .await
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

pub async fn git_delete_branch(
    root: PathBuf,
    name: String,
    force: Option<bool>,
) -> Result<(), String> {
    if !root.join(".git").exists() {
        return Err("DELETE_FAILED: Not a git repository".into());
    }
    let flag = if force.unwrap_or(false) { "-D" } else { "-d" };
    let output = git_run_async(vec!["branch".into(), flag.into(), name.clone()], root)
        .await
        .map_err(|e| format!("DELETE_FAILED: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr_trimmed = stderr.trim();
        let code = if stderr_trimmed.contains("not fully merged")
            || stderr_trimmed.contains("is not fully merged")
        {
            "BRANCH_NOT_MERGED"
        } else {
            "DELETE_FAILED"
        };
        return Err(format!("{}: {}", code, stderr_trimmed));
    }
    Ok(())
}

pub async fn git_branches(
    root: PathBuf,
) -> Result<Vec<BranchInfo>, String> {
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
        branches.push(BranchInfo {
            name,
            is_current,
            is_remote,
        });
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

pub async fn git_checkout(
    root: PathBuf,
    branch: String,
) -> Result<(), String> {
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

    let output = git_run_async(args, root)
        .await
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
