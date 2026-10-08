//! `.aide/` 自动 git 忽略（`.git/info/exclude`）。
//!
//! 信任工作区 / 已信任工作区激活索引时，把 `.aide/` 追加进该仓库的
//! `.git/info/exclude`。选 exclude 而非共享 `.gitignore`：exclude 是 git 官方
//! 「本仓库私有、不共享」的忽略机制，效果等同但不修改用户可提交的文件——团队
//! 仓库的 git status 不会冒出 `.aide/` 一行未提交改动。`.aide/` 是 Aide 本地
//! 状态（LSP 数据 / 项目设置），本就不该进版本库。重新 clone
//! 后上述流程会再次走到这里，幂等补齐，用户无感。
//!
//! 对外的唯一入口是 [`ensure_aide_excluded`]（由 `workspace/mod.rs` re-export），
//! 幂等、任何失败只记日志不报错。

use std::fs;
use std::path::{Path, PathBuf};

/// `.aide/` 在 exclude 内容中的既有状态。
#[derive(Debug, PartialEq, Eq)]
enum AideExcludeState {
    /// 已有等价条目（`.aide` `.aide/` `/.aide` `/.aide/`）。
    Present,
    /// 用户显式否定（`!.aide/` 等）——有意不忽略。尊重：追加 `.aide/` 会
    /// 盖掉否定，违背用户意图。
    Negated,
    Absent,
}

/// 判定 exclude 内容里 `.aide/` 的状态。用户以任何形式显式提到过 .aide
/// （忽略或否定）就不再动这个文件；行尾 CR / 前后空白容忍。
fn aide_exclude_state(content: &str) -> AideExcludeState {
    let mut negated = false;
    for line in content.lines() {
        let t = line.trim_end_matches('\r').trim();
        match t {
            ".aide" | ".aide/" | "/.aide" | "/.aide/" => return AideExcludeState::Present,
            "!.aide" | "!.aide/" | "!/.aide" | "!/.aide/" => negated = true,
            _ => {}
        }
    }
    if negated {
        AideExcludeState::Negated
    } else {
        AideExcludeState::Absent
    }
}

/// 带超时跑 `git rev-parse --git-common-dir`，解析为绝对路径。
///
/// 用 `--git-common-dir` 而非探测 `.git`：linked worktree 只有公共目录里的
/// exclude 生效（per-worktree gitdir 的 info/exclude git 不读），submodule
/// 的 `.git` 文件形式也由 rev-parse 一并解掉。输出为相对路径时相对的是进程
/// cwd（已设为 root），join 解析即可。非 git 仓库 / git 不在 PATH → Ok(None)。
///
/// 不借 commands::git 的 GIT_LOCK：rev-parse 不碰 index.lock，无需与写操作
/// 串行（否则一次 fetch 最长能把它挡 120s）。输出极小（一行路径），管道
/// 不会撑满，子进程退出后再读不会阻塞。
fn git_common_dir(root: &Path) -> Result<Option<PathBuf>, String> {
    use std::io::Read as _;
    let mut cmd = std::process::Command::new("git");
    cmd.args(["rev-parse", "--git-common-dir"])
        .current_dir(root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW，防 release 弹控制台窗
    }
    let mut child = cmd.spawn().map_err(|e| format!("spawn git: {}", e))?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("git rev-parse --git-common-dir timed out".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(e) => return Err(format!("wait git: {}", e)),
        }
    };
    if !status.success() {
        return Ok(None); // 非 git 仓库（git 以非零退出回答）
    }
    let mut buf = Vec::new();
    child
        .stdout
        .take()
        .expect("stdout piped")
        .read_to_end(&mut buf)
        .map_err(|e| format!("read git stdout: {}", e))?;
    let out = String::from_utf8_lossy(&buf).trim().to_string();
    if out.is_empty() {
        return Ok(None);
    }
    let p = PathBuf::from(&out);
    Ok(Some(if p.is_absolute() { p } else { root.join(p) }))
}

/// 追加 `.aide/` 条目（带来源注释）。`existing` 缺尾部换行时先补，防粘连。
fn append_aide_exclude(exclude: &Path, existing: &str) -> std::io::Result<()> {
    use std::io::Write as _;
    if let Some(dir) = exclude.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut block = String::new();
    if !existing.is_empty() && !existing.ends_with('\n') {
        block.push('\n');
    }
    block.push_str("# Aide 本地状态（索引/LSP/项目设置）\n.aide/\n");
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(exclude)?
        .write_all(block.as_bytes())
}

/// [`ensure_aide_excluded`] 的实质部分，返回处理结果供日志/测试断言。
fn ensure_aide_excluded_inner(root: &Path) -> Result<&'static str, String> {
    let common = match git_common_dir(root)? {
        Some(p) => p,
        None => return Ok("not-a-repo"),
    };
    let exclude = common.join("info").join("exclude");
    let content = fs::read_to_string(&exclude).unwrap_or_default();
    match aide_exclude_state(&content) {
        AideExcludeState::Present => Ok("already-present"),
        AideExcludeState::Negated => Ok("negated"),
        AideExcludeState::Absent => {
            append_aide_exclude(&exclude, &content)
                .map_err(|e| format!("write {}: {}", exclude.display(), e))?;
            Ok("written")
        }
    }
}

/// 确保工作区所在 git 仓库的 exclude 忽略 `.aide/`（幂等）。
///
/// 任何失败（非 git 仓库、git 不可用、IO 错误）只记日志不报错——信任
/// 流程绝不因此失败。**调用方须在非主线程上下文**（spawn git 子进程 +
/// 文件 IO），现有调用点（trust_workspace）
/// 在 spawn_blocking 里。
pub fn ensure_aide_excluded(workspace_root: &Path) {
    match ensure_aide_excluded_inner(workspace_root) {
        Ok("written") => {
            tracing::info!(
                "workspace: .aide/ 已写入 git exclude ({})",
                workspace_root.display()
            )
        }
        Ok("negated") => tracing::debug!(
            "workspace: 用户在 git exclude 显式否定 .aide/，尊重不写 ({})",
            workspace_root.display()
        ),
        Ok(_) => {}
        Err(e) => tracing::warn!(
            "workspace: 写 git exclude 失败（不影响信任/索引）{}: {}",
            workspace_root.display(),
            e
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── aide_exclude_state 状态机（纯函数）──

    #[test]
    fn state_recognizes_exact_variants() {
        for c in [".aide", ".aide/", "/.aide", "/.aide/"] {
            assert_eq!(aide_exclude_state(c), AideExcludeState::Present, "{}", c);
        }
    }

    #[test]
    fn state_ignores_comments_and_similar_names() {
        let content = "# .aide/\n.aide-bak/\nfoo.aide/\n*.aide\n";
        assert_eq!(aide_exclude_state(content), AideExcludeState::Absent);
    }

    #[test]
    fn state_handles_crlf_and_surrounding_whitespace() {
        assert_eq!(
            aide_exclude_state("node_modules/\r\n.aide/\r\n"),
            AideExcludeState::Present
        );
        assert_eq!(
            aide_exclude_state("  .aide/  \n"),
            AideExcludeState::Present
        );
    }

    #[test]
    fn state_user_negation_is_respected() {
        assert_eq!(aide_exclude_state("!.aide/\n"), AideExcludeState::Negated);
        // 否定与条目同时存在：用户显式安排过，不再动文件（Present 优先）。
        assert_eq!(
            aide_exclude_state("!.aide/\n.aide/\n"),
            AideExcludeState::Present
        );
    }

    // ── 真 git 仓库集成（与 commands::git 测试同风格：temp 目录 + 真 spawn）──

    /// 每个用例独立目录（可并行）；git init + 一次提交（worktree 用例需要 HEAD）。
    fn exclude_test_repo(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("aide_exclude_test_{}", name));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&root)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {:?}: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&["init"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        git(&["config", "core.autocrlf", "false"]);
        fs::write(root.join("a.txt"), "x\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-m", "init"]);
        root
    }

    #[test]
    fn writes_exclude_entry_in_plain_repo() {
        let root = exclude_test_repo("plain");
        assert_eq!(ensure_aide_excluded_inner(&root).unwrap(), "written");
        let content = fs::read_to_string(root.join(".git").join("info").join("exclude")).unwrap();
        assert!(content.contains(".aide/\n"), "{}", content);
    }

    #[test]
    fn idempotent_second_run_is_noop() {
        let root = exclude_test_repo("idem");
        assert_eq!(ensure_aide_excluded_inner(&root).unwrap(), "written");
        assert_eq!(
            ensure_aide_excluded_inner(&root).unwrap(),
            "already-present"
        );
        let content = fs::read_to_string(root.join(".git").join("info").join("exclude")).unwrap();
        assert_eq!(content.matches(".aide/").count(), 1, "{}", content);
    }

    #[test]
    fn appends_newline_when_file_lacks_trailing_newline() {
        let root = exclude_test_repo("nonl");
        let exclude = root.join(".git").join("info").join("exclude");
        fs::write(&exclude, "custom/").unwrap(); // 无尾换行
        assert_eq!(ensure_aide_excluded_inner(&root).unwrap(), "written");
        let content = fs::read_to_string(&exclude).unwrap();
        assert!(content.starts_with("custom/\n"), "{}", content);
        assert!(content.ends_with(".aide/\n"), "{}", content);
    }

    #[test]
    fn respects_existing_entry_and_user_negation() {
        let root = exclude_test_repo("respect");
        let exclude = root.join(".git").join("info").join("exclude");
        fs::write(&exclude, "/.aide/\n").unwrap();
        assert_eq!(
            ensure_aide_excluded_inner(&root).unwrap(),
            "already-present"
        );
        fs::write(&exclude, "!.aide/\n").unwrap();
        assert_eq!(ensure_aide_excluded_inner(&root).unwrap(), "negated");
        // 否定场景文件原样保留，一个字节都不动。
        assert_eq!(fs::read_to_string(&exclude).unwrap(), "!.aide/\n");
    }

    #[test]
    fn non_repo_is_noop() {
        let root = std::env::temp_dir().join("aide_exclude_test_norepo");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        assert_eq!(ensure_aide_excluded_inner(&root).unwrap(), "not-a-repo");
        assert!(!root.join(".git").exists());
    }

    #[test]
    fn linked_worktree_writes_to_common_dir() {
        let root = exclude_test_repo("worktree");
        let wt = std::env::temp_dir().join("aide_exclude_test_worktree_wt");
        let _ = fs::remove_dir_all(&wt);
        let out = std::process::Command::new("git")
            .args(["worktree", "add", "--detach"])
            .arg(&wt)
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(ensure_aide_excluded_inner(&wt).unwrap(), "written");
        // exclude 落在主仓库公共 .git/info/exclude（per-worktree gitdir 的
        // info/exclude git 不读，写了也没用）。
        let content = fs::read_to_string(root.join(".git").join("info").join("exclude")).unwrap();
        assert!(content.contains(".aide/\n"), "{}", content);
        let _ = fs::remove_dir_all(&wt);
    }
}
