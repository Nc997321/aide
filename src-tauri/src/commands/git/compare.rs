//! 分支对比命令：基准分支与另一分支的提交差异 + 文件级 diff 摘要。
//!
//! 与 [`super::legacy`] 共享底层 spawn helper、`CommitEntry`/`DiffPair` 结构
//! 与 `parse_commit_lines`/`assemble_diff_pair` 尾段（均 `pub(super)` 暴露）。
//! 本模块只做「对比」这一新逻辑，不改动既有 29 个命令。

use std::path::Path;
use tauri::State;
use tracing::{info, error};

use crate::commands::{WorkspaceState, project_root_for_commands, detect_git_branch};
use super::legacy::{
    git_run, git_run_blocking, unquote_git_path, show_blobs, assemble_diff_pair,
    parse_commit_lines, CommitEntry, DiffPair,
};

/// 对比中的一个文件差异项（文件级 diff 摘要，不含行内容）。
#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompareFile {
    /// 新侧路径（head 侧）。重命名时为新名。
    pub path: String,
    /// 重命名源路径（base 侧旧名）；仅 `status == 'R'` 时有值。
    pub old_path: Option<String>,
    /// `A`/`M`/`D`/`R`/`C`/`T` 单字母状态（取自 `--name-status`，含相似度数字时只留首字母）。
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
}

/// 分支对比结果。
#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompareResult {
    /// 基准分支名（对比基准，默认当前分支）。
    pub base: String,
    /// 被对比分支名。
    pub head: String,
    /// base 领先 head 的提交数（base 独有）。
    pub ahead: u32,
    /// head 领先 base 的提交数（head 独有，即 base 落后 head 的量）。
    pub behind: u32,
    /// base 独有的提交（最多 50，最新在前）。
    pub ahead_commits: Vec<CommitEntry>,
    /// head 独有的提交（最多 50，最新在前）。
    pub behind_commits: Vec<CommitEntry>,
    /// 两分支差异文件（`base head` 双点直比）。
    pub files: Vec<CompareFile>,
    pub files_total: u32,
}

/// `git diff --numstat` 对重命名可能输出花括号紧凑路径 `docs/{a => b}/file.html`，
/// 还原为新路径 `docs/b/file.html`。非紧凑形式（无 `{` 或无 `=>`）原样返回。
/// 多个花括号段逐个还原；嵌套花括号极罕见，不处理。
fn rename_dest(path: &str) -> String {
    if !path.contains('{') || !path.contains("=>") {
        return path.to_string();
    }
    let mut out = String::with_capacity(path.len());
    let mut rest = path;
    loop {
        match rest.find('{') {
            None => {
                out.push_str(rest);
                break;
            }
            Some(open) => {
                out.push_str(&rest[..open]);
                let after_open = &rest[open + 1..];
                match after_open.find('}') {
                    None => {
                        // 不闭合：剩余原样追加
                        out.push_str(&rest[open..]);
                        break;
                    }
                    Some(close) => {
                        let inside = &after_open[..close];
                        if let Some(arrow) = inside.find("=>") {
                            // `old => new` → 取 new（去首尾空白）
                            out.push_str(inside[arrow + 2..].trim());
                        } else {
                            // 花括号内无箭头：保持原样
                            out.push('{');
                            out.push_str(inside);
                            out.push('}');
                        }
                        rest = &after_open[close + 1..];
                    }
                }
            }
        }
    }
    out
}

/// 用 `--name-status`（状态 + 路径，R 行有 old\tnew 两路径）配 `--numstat`
///（+/- 计数，R 行路径可能为花括号紧凑形式）按 new_path 拼装文件差异。
/// name-status 是路径/状态的权威来源；numstat 仅提供 +/- 计数，按归一化后的
/// new_path 查表，缺失按 0/0 兜底。
fn compare_files(root: &Path, base: &str, head: &str) -> Result<Vec<CompareFile>, String> {
    let ns_out = git_run(&["diff", "-M", "--name-status", base, head], root)?;
    let nm_out = git_run(&["diff", "-M", "--numstat", base, head], root)?;

    // 计数表：new_path(unquoted, 已还原花括号) → (add, del)
    let mut counts: std::collections::HashMap<String, (u32, u32)> =
        std::collections::HashMap::new();
    if nm_out.status.success() {
        let nm = String::from_utf8_lossy(&nm_out.stdout);
        for line in nm.lines() {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 3 {
                continue;
            }
            let add = if parts[0] == "-" {
                0
            } else {
                parts[0].parse::<u32>().unwrap_or(0)
            };
            let del = if parts[1] == "-" {
                0
            } else {
                parts[1].parse::<u32>().unwrap_or(0)
            };
            let path = unquote_git_path(&rename_dest(parts[2]));
            counts.insert(path, (add, del));
        }
    }

    let mut files: Vec<CompareFile> = Vec::new();
    if !ns_out.status.success() {
        return Ok(files);
    }
    let ns = String::from_utf8_lossy(&ns_out.stdout);
    for line in ns.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.is_empty() {
            continue;
        }
        // 状态字母可能带相似度数字（R100/C90）；取首字母
        let letter = parts[0].chars().next().unwrap_or('M');
        match parts.len() {
            2 => {
                // A/M/D/T：单路径
                let path = unquote_git_path(parts[1]);
                let (add, del) = counts.get(&path).copied().unwrap_or((0, 0));
                files.push(CompareFile {
                    path,
                    old_path: None,
                    status: letter.to_string(),
                    additions: add,
                    deletions: del,
                });
            }
            3 => {
                // R/C：old\tnew
                let old_path = unquote_git_path(parts[1]);
                let new_path = unquote_git_path(parts[2]);
                let (add, del) = counts.get(&new_path).copied().unwrap_or((0, 0));
                files.push(CompareFile {
                    path: new_path,
                    old_path: Some(old_path),
                    status: letter.to_string(),
                    additions: add,
                    deletions: del,
                });
            }
            _ => continue,
        }
    }
    Ok(files)
}

/// 对比 `base`（默认当前分支）与 `head` 的提交差异与文件差异。
///
/// `ahead` = base 独有提交数（base 领先 head），`behind` = head 独有提交数。
/// 提交列表各取最新 50 条；文件差异为两分支尖端的直比（`git diff base head`）。
/// `head` 引用不存在时返回 `COMPARE_REF_MISSING`。
#[tauri::command]
pub async fn git_compare_branches(
    workspace_state: State<'_, WorkspaceState>,
    head: String,
    base: Option<String>,
) -> Result<CompareResult, String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Err("Not a git repository".into());
    }
    let base_opt = base;
    let head_c = head.clone();
    info!(?base_opt, head = %head_c, "git_compare_branches");

    git_run_blocking(move || {
        // base 缺省 = 当前分支（读 .git/HEAD，游离 HEAD → 空 → 报错）
        let base = base_opt.unwrap_or_else(|| detect_git_branch(&root));
        if base.is_empty() {
            return Err(
                "COMPARE_NO_BASE: 无法确定基准分支（当前处于游离 HEAD），请显式指定 base".into(),
            );
        }

        // 校验 head 引用存在
        let rev_check = git_run(&["rev-parse", "--verify", &head_c], &root)?;
        if !rev_check.status.success() {
            let stderr = String::from_utf8_lossy(&rev_check.stderr).trim().to_string();
            return Err(format!(
                "COMPARE_REF_MISSING: 分支/引用 '{}' 不存在: {}",
                head_c, stderr
            ));
        }
        // 校验 base 引用存在
        let base_check = git_run(&["rev-parse", "--verify", &base], &root)?;
        if !base_check.status.success() {
            let stderr = String::from_utf8_lossy(&base_check.stderr).trim().to_string();
            return Err(format!(
                "COMPARE_REF_MISSING: 分支/引用 '{}' 不存在: {}",
                base, stderr
            ));
        }

        // ahead/behind 计数：`rev-list --left-right --count base...head`
        // 输出 "L\tR"：L = base 独有（base 领先），R = head 独有（head 领先）
        let count_out = git_run(
            &["rev-list", "--left-right", "--count", &format!("{}...{}", base, head_c)],
            &root,
        )?;
        let (ahead, behind) = if count_out.status.success() {
            let line = String::from_utf8_lossy(&count_out.stdout);
            let parts: Vec<&str> = line.trim().split_whitespace().collect();
            let l = parts.get(0).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
            let r = parts.get(1).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
            (l, r)
        } else {
            (0, 0)
        };

        // base 独有提交 = `head..base`（在 base 不在 head）
        let ahead_out = git_run(
            &["log", "--format=%H|%s|%an|%ar", "-n50", &format!("{}..{}", head_c, base)],
            &root,
        )?;
        let ahead_commits = if ahead_out.status.success() {
            parse_commit_lines(&String::from_utf8_lossy(&ahead_out.stdout))
        } else {
            Vec::new()
        };

        // head 独有提交 = `base..head`（在 head 不在 base）
        let behind_out = git_run(
            &["log", "--format=%H|%s|%an|%ar", "-n50", &format!("{}..{}", base, head_c)],
            &root,
        )?;
        let behind_commits = if behind_out.status.success() {
            parse_commit_lines(&String::from_utf8_lossy(&behind_out.stdout))
        } else {
            Vec::new()
        };

        let files = compare_files(&root, &base, &head_c)?;
        let files_total = files.len() as u32;

        Ok(CompareResult {
            base,
            head: head_c,
            ahead,
            behind,
            ahead_commits,
            behind_commits,
            files,
            files_total,
        })
    })
    .await
    .map_err(|e| {
        error!("git_compare_branches failed: {}", e);
        e
    })
}

/// 取 `base:path` 与 `head:path` 两侧 blob 组装成 [`DiffPair`]，供对比视图
/// 点击文件行时在 DiffViewer 查看行级差异。`old_path` 用于重命名场景：
/// 当 `base:path` 不存在（文件在 head 新增或被改名）时回退取 `base:old_path`
///（重命名源）作为旧侧。标签为分支名（旧侧=base，新侧=head）。
#[tauri::command]
pub async fn git_diff_pair_refs(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
    base: String,
    head: String,
    old_path: Option<String>,
) -> Result<DiffPair, String> {
    let root = project_root_for_commands(&workspace_state);
    if !root.join(".git").exists() {
        return Err("Not a git repository".into());
    }
    info!(%path, %base, %head, ?old_path, "git_diff_pair_refs");

    let path_c = path.clone();
    let base_c = base.clone();
    let head_c = head.clone();
    let old_path_c = old_path;

    git_run_blocking(move || {
        const MAX_DIFF_BYTES: u64 = 1_000_000;

        // 一条 cat-file --batch 取两侧 blob：新侧 = head:path；旧侧重命名时 = base:old_path，
        // 否则 = base:path。原为 2~3 个 show_blob 串行 spawn（本机 ~1s/spawn），
        // 合并后 1 个进程。重命名/复制场景下 base:path 不存在（git 标 R/C 即意味着
        // base 无新名），直接取 base:old_path 与原回退逻辑等价。
        let new_rev = format!("{}:{}", head_c, path_c);
        let old_rev = match old_path_c.as_deref() {
            Some(op) => format!("{}:{}", base_c, op),
            None => format!("{}:{}", base_c, path_c),
        };
        let blobs = show_blobs(&[&new_rev, &old_rev], &root)?;
        let mut it = blobs.into_iter();
        let new = it.next().unwrap_or(None);
        let old = it.next().unwrap_or(None);
        let new_exists = new.is_some();
        let old_exists = old.is_some();
        let new_too_big = new
            .as_ref()
            .map(|b| b.len() as u64 > MAX_DIFF_BYTES)
            .unwrap_or(false);
        let old_too_big = old
            .as_ref()
            .map(|b| b.len() as u64 > MAX_DIFF_BYTES)
            .unwrap_or(false);

        Ok(assemble_diff_pair(
            base_c,
            head_c,
            old_exists,
            new_exists,
            old,
            new,
            old_too_big,
            new_too_big,
            &root,
            &path_c,
        ))
    })
    .await
    .map_err(|e| {
        error!("git_diff_pair_refs failed: {}", e);
        e
    })
}

#[cfg(test)]
mod tests {
    use super::rename_dest;

    #[test]
    fn rename_dest_compact_braces_resolved() {
        assert_eq!(rename_dest("docs/{a => b}/file.html"), "docs/b/file.html");
    }

    #[test]
    fn rename_dest_bare_brace_pair() {
        assert_eq!(rename_dest("{a => b}"), "b");
    }

    #[test]
    fn rename_dest_multiple_brace_segments() {
        assert_eq!(rename_dest("a/{b => c}/d/{e => f}"), "a/c/d/f");
    }

    #[test]
    fn rename_dest_empty_old_part() {
        assert_eq!(rename_dest("{ => foo}"), "foo");
    }

    #[test]
    fn rename_dest_no_braces_passthrough() {
        assert_eq!(rename_dest("a/b/c"), "a/b/c");
        assert_eq!(rename_dest("plain"), "plain");
    }

    #[test]
    fn rename_dest_brace_without_arrow_kept_as_is() {
        assert_eq!(rename_dest("a/{literal}/b"), "a/{literal}/b");
    }

    #[test]
    fn rename_dest_unclosed_brace_passthrough() {
        assert_eq!(rename_dest("a/{unterminated"), "a/{unterminated");
    }
}