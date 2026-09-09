// 编辑器级 diff 查看器数据域：未暂存 = HEAD vs 磁盘、已暂存 = HEAD vs 索引、
// 提交 = h^ vs h 三场景取数；`git cat-file --batch` 一条进程批量取 blob
// （N 次串行 spawn 每次启动 ~1s 的开销）；组装成 [`DiffPair`]（too_big /
// binary / eol_only 短路）。build/assemble 尾段与 compare::git_diff_pair_refs 共用。
use super::runtime::{git_run, git_run_blocking, GIT_LOCK, GIT_TIMEOUT};
use crate::commands::{project_root_for, WorkspaceState};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::State;
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
pub(super) fn show_blob(rev_path: &str, root: &std::path::Path) -> Result<Option<Vec<u8>>, String> {
    let out = git_run(&["show", rev_path], root)?;
    if out.status.success() {
        Ok(Some(out.stdout))
    } else {
        Ok(None)
    }
}

/// 一条 `git cat-file --batch` 进程取多个 blob，避免 N 个 `git show` 串行 spawn 的
/// 固定启动开销（本机每 spawn ~1s，2~3 个串行 = 2~3s 纯启动）。`rev_paths` 用
/// `rev:path` 语法——`HEAD:path`、`:path`（索引）、`HEAD^:path`（父提交）均经实测可用。
/// 返回与输入对齐的 `Option<Vec<u8>>`：对象缺失（未跟踪 / 该 rev 无此文件）→ None。
pub(super) fn show_blobs(
    rev_paths: &[&str],
    root: &std::path::Path,
) -> Result<Vec<Option<Vec<u8>>>, String> {
    let _guard = GIT_LOCK
        .lock()
        .map_err(|e| format!("Git lock poisoned: {}", e))?;

    let mut cmd = Command::new("git");
    cmd.args(["cat-file", "--batch"])
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn git cat-file: {}", e))?;

    // 先起 stdout/stderr 排干线程，再写 stdin：否则 cat-file 写满 stdout 管道时
    // 会阻塞在写端，与主线程写 stdin 互锁。
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

    {
        let stdin = child.stdin.as_mut().expect("stdin piped");
        for rp in rev_paths {
            std::io::Write::write_all(stdin, rp.as_bytes())
                .map_err(|e| format!("write cat-file stdin: {}", e))?;
            std::io::Write::write_all(stdin, b"\n")
                .map_err(|e| format!("write cat-file stdin: {}", e))?;
        }
    }
    drop(child.stdin.take());

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {
                if start.elapsed() > GIT_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = out_handle.join();
                    let _ = err_handle.join();
                    return Err(format!(
                        "git cat-file --batch timed out after {}s",
                        GIT_TIMEOUT.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("Failed to wait on git cat-file: {}", e)),
        }
    };

    let bytes = out_handle
        .join()
        .unwrap_or(Ok(Vec::new()))
        .unwrap_or_default();
    let _stderr = err_handle
        .join()
        .unwrap_or(Ok(Vec::new()))
        .unwrap_or_default();
    if !status.success() {
        return Err(format!(
            "git cat-file --batch failed (exit {:?})",
            status.code()
        ));
    }

    parse_cat_file_batch(&bytes, rev_paths.len())
}

/// 解析 `git cat-file --batch` 输出：每对象 `<oid> <type> <size>\n<content>\n`，
/// 缺失 `<input> missing\n`。按输入数量对齐返回。纯字节解析，不需 git，配单测。
fn parse_cat_file_batch(bytes: &[u8], expected: usize) -> Result<Vec<Option<Vec<u8>>>, String> {
    let mut results = Vec::with_capacity(expected);
    let mut pos = 0;
    while results.len() < expected {
        if pos >= bytes.len() {
            // 提前收尾（不应发生）— 剩余按缺失填充，保持与输入对齐
            results.push(None);
            continue;
        }
        let nl = bytes[pos..]
            .iter()
            .position(|&b| b == b'\n')
            .ok_or("cat-file batch: truncated header")?;
        let header = std::str::from_utf8(&bytes[pos..pos + nl])
            .map_err(|e| format!("cat-file batch: bad header utf8: {}", e))?;
        pos += nl + 1;
        // 缺失行：<input> missing（input 可能含空格，只按后缀判定，不解析 input）
        if header.ends_with(" missing") {
            results.push(None);
            continue;
        }
        // 命中行：<oid> <type> <size>
        let parts: Vec<&str> = header.split_whitespace().collect();
        let size: usize = parts
            .get(2)
            .ok_or_else(|| format!("cat-file batch: bad header '{}'", header))?
            .parse::<usize>()
            .map_err(|e| format!("cat-file batch: bad size: {}", e))?;
        if pos + size > bytes.len() {
            return Err("cat-file batch: truncated content".into());
        }
        let content = bytes[pos..pos + size].to_vec();
        pos += size;
        // content 后的定界 \n
        if pos < bytes.len() && bytes[pos] == b'\n' {
            pos += 1;
        }
        results.push(Some(content));
    }
    Ok(results)
}

#[cfg(test)]
mod batch_tests {
    use super::parse_cat_file_batch;

    #[test]
    fn parses_two_blobs() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"abc123 blob 5\nhello\n");
        bytes.extend_from_slice(b"def456 blob 6\nworld!\n");
        let r = parse_cat_file_batch(&bytes, 2).unwrap();
        assert_eq!(r[0].as_deref(), Some(b"hello".as_ref()));
        assert_eq!(r[1].as_deref(), Some(b"world!".as_ref()));
    }

    #[test]
    fn parses_missing_object() {
        let bytes = b"HEAD:foo missing\nabc blob 3\nbar\n";
        let r = parse_cat_file_batch(bytes, 2).unwrap();
        assert_eq!(r[0], None);
        assert_eq!(r[1].as_deref(), Some(b"bar".as_ref()));
    }

    #[test]
    fn parses_binary_content() {
        let mut bytes = b"abc blob 3\n".to_vec();
        bytes.extend_from_slice(&[0u8, 1, 2]);
        bytes.push(b'\n');
        let r = parse_cat_file_batch(&bytes, 1).unwrap();
        assert_eq!(r[0].as_deref(), Some(&[0u8, 1, 2][..]));
    }

    #[test]
    fn missing_input_with_spaces() {
        let bytes = b"HEAD:src/foo bar.ts missing\n";
        let r = parse_cat_file_batch(bytes, 1).unwrap();
        assert_eq!(r[0], None);
    }

    #[test]
    fn empty_blob() {
        let bytes = b"abc blob 0\n\n";
        let r = parse_cat_file_batch(bytes, 1).unwrap();
        assert_eq!(r[0].as_deref(), Some(&[][..]));
    }
}

/// 把已取到的两侧 blob/标签组装成 [`DiffPair`]：too-big 短路、binary 检测、
/// 行尾归一化、eol_only 判定、status 推导。`build_diff_pair` 与
/// `compare::git_diff_pair_refs` 共用此尾段。`(old_exists,new_exists)==(false,false)`
/// 时按 `root` 下 `path` 的磁盘存在性兜底（与原内联逻辑一致）。
pub(super) fn assemble_diff_pair(
    old_label: String,
    new_label: String,
    old_exists: bool,
    new_exists: bool,
    old_bytes: Option<Vec<u8>>,
    new_bytes: Option<Vec<u8>>,
    old_too_big: bool,
    new_too_big: bool,
    root: &std::path::Path,
    path: &str,
) -> DiffPair {
    let too_big = old_too_big || new_too_big;
    let is_binary = !too_big
        && (old_bytes.as_deref().map(looks_binary).unwrap_or(false)
            || new_bytes.as_deref().map(looks_binary).unwrap_or(false));

    let status = match (old_exists, new_exists) {
        (false, true) => "added",
        (true, false) => "deleted",
        // 两侧皆空（如未跟踪的空文件）：按磁盘存在性兜底
        (false, false) => {
            if root.join(path).exists() {
                "added"
            } else {
                "deleted"
            }
        }
        (true, true) => "modified",
    };

    if too_big {
        return DiffPair {
            old_text: String::new(),
            new_text: String::new(),
            old_label,
            new_label,
            status: status.to_string(),
            is_binary,
            eol_only: false,
            too_big,
        };
    }

    let old_str = old_bytes.map(|b| String::from_utf8_lossy(&b).into_owned());
    let new_str = new_bytes.map(|b| String::from_utf8_lossy(&b).into_owned());

    let old_raw_str = old_str.unwrap_or_default();
    let new_raw_str = new_str.unwrap_or_default();
    let old_text = normalize_eol(&old_raw_str);
    let new_text = normalize_eol(&new_raw_str);
    let eol_only = old_text == new_text && old_raw_str != new_raw_str;

    DiffPair {
        old_text,
        new_text,
        old_label,
        new_label,
        status: status.to_string(),
        is_binary,
        eol_only,
        too_big,
    }
}

/// 三种场景取数：未暂存 = HEAD vs 磁盘；已暂存 = HEAD vs 索引；提交 = h^ vs h。
/// 返回前两侧都做行尾归一化；归一化后相等但原文不等 → eol_only。
/// 单侧超过 1MB 时标记 too_big 并返回空文本，避免巨大 payload 跨 IPC。
pub(super) fn build_diff_pair(
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
        // 一条 cat-file --batch 取 h^:path 与 h:path（原 2 个 show_blob 串行 spawn）
        let blobs = show_blobs(
            &[&format!("{}^:{}", h, path), &format!("{}:{}", h, path)],
            root,
        )?;
        let mut it = blobs.into_iter();
        let old = it.next().unwrap_or(None);
        let new = it.next().unwrap_or(None);
        let old_exists = old.is_some();
        let new_exists = new.is_some();
        let old_too_big = old
            .as_ref()
            .map(|b| b.len() as u64 > MAX_DIFF_BYTES)
            .unwrap_or(false);
        let new_too_big = new
            .as_ref()
            .map(|b| b.len() as u64 > MAX_DIFF_BYTES)
            .unwrap_or(false);
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
        // 一条 cat-file --batch 取 HEAD:path 与 :path（索引 blob）
        let blobs = show_blobs(&[&format!("HEAD:{}", path), &format!(":{}", path)], root)?;
        let mut it = blobs.into_iter();
        let old = it.next().unwrap_or(None);
        let new = it.next().unwrap_or(None);
        let old_exists = old.is_some();
        let new_exists = new.is_some();
        let old_too_big = old
            .as_ref()
            .map(|b| b.len() as u64 > MAX_DIFF_BYTES)
            .unwrap_or(false);
        let new_too_big = new
            .as_ref()
            .map(|b| b.len() as u64 > MAX_DIFF_BYTES)
            .unwrap_or(false);
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
        let old_too_big = old
            .as_ref()
            .map(|b| b.len() as u64 > MAX_DIFF_BYTES)
            .unwrap_or(false);
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

    Ok(assemble_diff_pair(
        old_label,
        new_label,
        old_exists,
        new_exists,
        old_bytes,
        new_bytes,
        old_too_big,
        new_too_big,
        root,
        path,
    ))
}

#[tauri::command]
pub async fn git_diff_pair(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
    staged: Option<bool>,
    commit_hash: Option<String>,
    // 会话所属工作区；省略 = 当前活动工作区（见 `project_root_for` 的存在理由）
    cwd: Option<String>,
) -> Result<DiffPair, String> {
    let root = project_root_for(&workspace_state, cwd.as_deref());
    if !root.join(".git").exists() {
        return Err("Not a git repository".into());
    }
    git_run_blocking(move || {
        build_diff_pair(
            &root,
            &path,
            staged.unwrap_or(false),
            commit_hash.as_deref(),
        )
    })
    .await
}

#[cfg(test)]
mod diff_pair_tests {
    use super::*;
    use std::process::Command;

    fn git(root: &std::path::Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .unwrap();
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
