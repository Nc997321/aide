//! 仓库 HEAD 提交域：变更基线的"改前"引用。
use super::runtime::{git_run, git_run_blocking};

use std::path::PathBuf;

/// 读当前 HEAD 的提交 sha。**非 git 仓库 / unborn HEAD（还没提交过）→ `Ok(None)`**：
/// 这两种都是合法状态（调用方据此"不记基线"，而不是报错）。
pub(super) fn read_head_rev(root: &std::path::Path) -> Result<Option<String>, String> {
    let out = git_run(&["rev-parse", "HEAD"], root)?;
    if !out.status.success() {
        return Ok(None);
    }
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(if sha.is_empty() { None } else { Some(sha) })
}

/// 会话所属工作区的 HEAD sha（变更面板开轮时取一次；实测 ~101ms，放后台链上）。
pub async fn git_head_rev(
    root: PathBuf,
) -> Result<Option<String>, String> {
    if !root.join(".git").exists() {
        return Ok(None);
    }
    git_run_blocking(move || read_head_rev(&root)).await
}

#[cfg(test)]
mod head_tests {
    use super::*;
    use std::process::Command;
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;

    fn git(root: &std::path::Path, args: &[&str]) {
        let mut cmd = Command::new("git");
        cmd.args(args).current_dir(root);
        #[cfg(windows)]
        {
            cmd.creation_flags(0x08000000);
        }
        let out = cmd.output().unwrap();
        assert!(out.status.success(), "git {:?} failed", args);
    }

    fn setup_repo(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("aide_head_test_{}", name));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init"]);
        git(&root, &["config", "user.email", "test@example.com"]);
        git(&root, &["config", "user.name", "Test"]);
        root
    }

    /// 未提交的空仓库（unborn HEAD）：**不是错误**，返回 None。
    #[test]
    fn unborn_head_is_none() {
        let root = setup_repo("unborn");
        assert_eq!(read_head_rev(&root).unwrap(), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn returns_sha_after_commit() {
        let root = setup_repo("after_commit");
        std::fs::write(root.join("a.txt"), "v1\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "v1"]);
        let sha = read_head_rev(&root).unwrap().unwrap();
        assert_eq!(sha.len(), 40);
        assert!(sha.chars().all(|c| c.is_ascii_hexdigit()));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 非 git 目录：同样返回 None（调用方据此不记基线，而不是报错）。
    #[test]
    fn non_repo_is_none() {
        let root = std::env::temp_dir().join("aide_head_test_nonrepo");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(read_head_rev(&root).unwrap(), None);
        let _ = std::fs::remove_dir_all(&root);
    }
}
