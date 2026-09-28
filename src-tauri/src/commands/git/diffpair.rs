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

/// 单侧超过此字节数 → 标 `too_big` 并给空文本，避免巨大 payload 跨 IPC。
const MAX_DIFF_BYTES: u64 = 1_000_000;

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
    /// `Since(rev)` 的 rev 已不在仓库中（rebase / GC 之后不可达）→ 已退回 HEAD 视图：
    /// 内容仍是 HEAD 的（不是空、不是整片新增），由上层如实标注降级。
    pub base_missing: bool,
}

/// 取哪两方来比。**单值标签**：原先是 `staged: Option<bool>` + `commit_hash: Option<String>`
/// 两个相邻可选参数（靠"不同时给"的约定维持），再加一个基线 rev 就是三个——按参数铁律收成一个。
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DiffMode {
    /// HEAD → 工作区（默认；变更面板的累计兜底）
    Unstaged,
    /// HEAD → 索引
    Staged,
    /// h^ → h（历史提交）
    Commit { hash: String },
    /// rev → 工作区（变更基线的"改前"）
    Since { rev: String },
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

/// `assemble_diff_pair` 的输入：两侧的标签/存在性/内容/超限标记。
pub(super) struct DiffSides {
    pub old_label: String,
    pub new_label: String,
    pub old_exists: bool,
    pub new_exists: bool,
    pub old_bytes: Option<Vec<u8>>,
    pub new_bytes: Option<Vec<u8>>,
    pub old_too_big: bool,
    pub new_too_big: bool,
}

/// 一条 `cat-file --batch` 取回的两侧标签。命名成对传，避免两个 `String` 挨着写反而调换。
struct SideLabels {
    old: String,
    new: String,
}

/// 工作区模式的旧侧：`rev` 是**取数键**（必须能解析到那个对象），`label` 是给人看的标签。
///
/// 两者必须分开：`Since` 的标签是 7 位短号，而**短号在 git 层可能歧义**（撞前缀时
/// `git show <短号>:<path>` 非零退出 → `show_blob` 给 `None` → 静默判成"整片新增"，
/// 正是本笔承诺绝不出现的那类错内容）。取数一律用调用方给的完整 rev。
struct OldSide {
    rev: String,
    label: String,
}

impl OldSide {
    /// HEAD 视图（未暂存模式与基线失效的降级路径）：取数与标签都是 `HEAD`。
    fn head() -> Self {
        Self {
            rev: "HEAD".to_string(),
            label: "HEAD".to_string(),
        }
    }
}

/// 把已取到的两侧 blob/标签组装成 [`DiffPair`]：too-big 短路、binary 检测、
/// 行尾归一化、eol_only 判定、status 推导。`build_diff_pair` 与
/// `compare::git_diff_pair_refs` 共用此尾段。
pub(super) fn assemble_diff_pair(
    sides: DiffSides,
    root: &std::path::Path,
    path: &str,
    base_missing: bool,
) -> DiffPair {
    let too_big = sides.old_too_big || sides.new_too_big;
    let (old_text, new_text, eol_only) = normalized_texts(&sides, too_big);
    let is_binary = detect_binary(&sides, too_big);
    let status = derive_status(sides.old_exists, sides.new_exists, root, path).to_string();
    let DiffSides {
        old_label,
        new_label,
        ..
    } = sides;
    DiffPair {
        old_text,
        new_text,
        old_label,
        new_label,
        status,
        is_binary,
        eol_only,
        too_big,
        base_missing,
    }
}

/// too-big 时两侧文本一律空（不给巨大 payload 跨 IPC）；否则按 LF 归一化——
/// 归一化后相等但原文不等 → `eol_only`。
fn normalized_texts(sides: &DiffSides, too_big: bool) -> (String, String, bool) {
    if too_big {
        return (String::new(), String::new(), false);
    }
    let old_raw = sides
        .old_bytes
        .as_deref()
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .unwrap_or_default();
    let new_raw = sides
        .new_bytes
        .as_deref()
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .unwrap_or_default();
    let old_text = normalize_eol(&old_raw);
    let new_text = normalize_eol(&new_raw);
    let eol_only = old_text == new_text && old_raw != new_raw;
    (old_text, new_text, eol_only)
}

/// 两侧字节里是否有 NUL（`too_big` 已短路，不再探测）。
fn detect_binary(sides: &DiffSides, too_big: bool) -> bool {
    !too_big
        && (sides.old_bytes.as_deref().map(looks_binary).unwrap_or(false)
            || sides.new_bytes.as_deref().map(looks_binary).unwrap_or(false))
}

/// status 推导；两边都取不到（如未跟踪的空文件）时按 `root` 下 `path` 的磁盘存在性兜底。
fn derive_status(
    old_exists: bool,
    new_exists: bool,
    root: &std::path::Path,
    path: &str,
) -> &'static str {
    match (old_exists, new_exists) {
        (false, true) => "added",
        (true, false) => "deleted",
        (false, false) => {
            if root.join(path).exists() {
                "added"
            } else {
                "deleted"
            }
        }
        (true, true) => "modified",
    }
}

/// 取数 → 组装。按 [`DiffMode`] 分派：未暂存 = HEAD vs 磁盘；已暂存 = HEAD vs 索引；
/// 提交 = h^ vs h；基线 = rev vs 工作区。单侧超过 1MB 时标记 `too_big` 并返回空文本。
pub(super) fn build_diff_pair(
    root: &std::path::Path,
    path: &str,
    mode: &DiffMode,
) -> Result<DiffPair, String> {
    match mode {
        DiffMode::Commit { hash } => commit_sides(root, path, hash),
        DiffMode::Staged => staged_sides(root, path),
        DiffMode::Unstaged => worktree_sides(root, path, OldSide::head(), false),
        DiffMode::Since { rev } => since_sides(root, path, rev),
    }
}

/// h^ → h：一条 `cat-file --batch` 取两侧 blob（原 2 个 show_blob 串行 spawn）。
fn commit_sides(root: &std::path::Path, path: &str, hash: &str) -> Result<DiffPair, String> {
    let short = &hash[..7.min(hash.len())];
    let blobs = show_blobs(
        &[&format!("{}^:{}", hash, path), &format!("{}:{}", hash, path)],
        root,
    )?;
    let labels = SideLabels {
        old: format!("{}^", short),
        new: short.to_string(),
    };
    Ok(assemble_diff_pair(batch_sides(blobs, labels), root, path, false))
}

/// HEAD → 索引：一条 `cat-file --batch` 取 `HEAD:path` 与 `:path`（索引 blob）。
fn staged_sides(root: &std::path::Path, path: &str) -> Result<DiffPair, String> {
    let blobs = show_blobs(&[&format!("HEAD:{}", path), &format!(":{}", path)], root)?;
    let labels = SideLabels {
        old: "HEAD".to_string(),
        new: "已暂存".to_string(),
    };
    Ok(assemble_diff_pair(batch_sides(blobs, labels), root, path, false))
}

/// rev → 工作区。**先校验 rev**：`git show <坏 rev>:<path>` 与"该 rev 下没有这个文件"
/// 在 git 层都只是非零退出（见 [`show_blob`]），不校验就会把整份文件误判成**新增**。
fn since_sides(root: &std::path::Path, path: &str, rev: &str) -> Result<DiffPair, String> {
    let verify = git_run(
        &["rev-parse", "--verify", &format!("{}^{{commit}}", rev)],
        root,
    )?;
    if !verify.status.success() {
        // 基线不可达（rebase / GC）→ 不比，给 HEAD 视图 + 标记，由上层如实标注
        return worktree_sides(root, path, OldSide::head(), true);
    }
    worktree_sides(
        root,
        path,
        OldSide {
            rev: rev.to_string(), // 取数用完整 rev（短号可能歧义，见 `OldSide`）
            label: rev[..7.min(rev.len())].to_string(),
        },
        false,
    )
}

/// 某个提交（`old`）→ 工作区：旧侧走 blob，新侧读盘。
fn worktree_sides(
    root: &std::path::Path,
    path: &str,
    old: OldSide,
    base_missing: bool,
) -> Result<DiffPair, String> {
    let old_bytes = show_blob(&format!("{}:{}", old.rev, path), root)?;
    let old_too_big = old_bytes
        .as_ref()
        .map(|b| b.len() as u64 > MAX_DIFF_BYTES)
        .unwrap_or(false);
    let new_path = root.join(path);
    let new_exists = new_path.exists();
    let (new, new_too_big) = read_worktree_side(&new_path, new_exists)?;
    let sides = DiffSides {
        old_label: old.label,
        old_exists: old_bytes.is_some(),
        old_bytes,
        new_label: "工作区".to_string(),
        new_exists,
        new_bytes: new,
        old_too_big,
        new_too_big,
    };
    Ok(assemble_diff_pair(sides, root, path, base_missing))
}

/// 工作区一侧：不存在 → `(None, false)`；超限 → `(None, true)`；否则读盘。
fn read_worktree_side(
    new_path: &std::path::Path,
    new_exists: bool,
) -> Result<(Option<Vec<u8>>, bool), String> {
    if !new_exists {
        return Ok((None, false));
    }
    let meta = std::fs::metadata(new_path)
        .map_err(|e| format!("Failed to read metadata for {}: {}", new_path.display(), e))?;
    if meta.len() > MAX_DIFF_BYTES {
        return Ok((None, true));
    }
    Ok((std::fs::read(new_path).ok(), false))
}

/// 一条 `cat-file --batch` 的两侧结果 → [`DiffSides`]（标签由调用方给，超限按字节数标）。
fn batch_sides(blobs: Vec<Option<Vec<u8>>>, labels: SideLabels) -> DiffSides {
    let mut it = blobs.into_iter();
    let old = it.next().unwrap_or(None);
    let new = it.next().unwrap_or(None);
    DiffSides {
        old_label: labels.old,
        new_label: labels.new,
        old_exists: old.is_some(),
        new_exists: new.is_some(),
        old_too_big: old
            .as_ref()
            .map(|b| b.len() as u64 > MAX_DIFF_BYTES)
            .unwrap_or(false),
        new_too_big: new
            .as_ref()
            .map(|b| b.len() as u64 > MAX_DIFF_BYTES)
            .unwrap_or(false),
        old_bytes: old,
        new_bytes: new,
    }
}

/// 编辑器级 diff 的两侧内容：`mode` 决定"跟谁比"（见 [`DiffMode`]）。
#[tauri::command]
pub async fn git_diff_pair(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
    mode: DiffMode,
    // 会话所属工作区；省略 = 当前活动工作区（见 `project_root_for` 的存在理由）
    cwd: Option<String>,
) -> Result<DiffPair, String> {
    let root = project_root_for(&workspace_state, cwd.as_deref());
    if !root.join(".git").exists() {
        return Err("Not a git repository".into());
    }
    git_run_blocking(move || build_diff_pair(&root, &path, &mode)).await
}

#[cfg(test)]
mod diff_pair_tests {
    use super::*;
    use std::process::Command;
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;

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

    /// 测试用：当前 HEAD 的 sha。
    fn head_sha(root: &std::path::Path) -> String {
        let mut cmd = Command::new("git");
        cmd.args(["rev-parse", "HEAD"]).current_dir(root);
        #[cfg(windows)]
        {
            cmd.creation_flags(0x08000000);
        }
        let out = cmd.output().unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn modified_unstaged_returns_head_vs_worktree() {
        let root = setup_repo("modified");
        std::fs::write(root.join("a.txt"), "line1\nline2\nline3\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "v1"]);
        std::fs::write(root.join("a.txt"), "line1\nCHANGED\nline3\n").unwrap();

        let pair = build_diff_pair(&root, "a.txt", &DiffMode::Unstaged).unwrap();
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

        let pair = build_diff_pair(&root, "a.txt", &DiffMode::Staged).unwrap();
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

        let pair = build_diff_pair(&root, "a.txt", &DiffMode::Commit { hash: head }).unwrap();
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

        let pair = build_diff_pair(&root, "new.txt", &DiffMode::Unstaged).unwrap();
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

        let pair = build_diff_pair(&root, "a.txt", &DiffMode::Unstaged).unwrap();
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

        let pair = build_diff_pair(&root, "a.txt", &DiffMode::Unstaged).unwrap();
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

        let pair = build_diff_pair(&root, "a.txt", &DiffMode::Unstaged).unwrap();
        assert!(pair.too_big);
        assert_eq!(pair.old_text, "");
        assert_eq!(pair.new_text, "");
        assert_eq!(pair.status, "modified");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 报告场景：改文件 → 提交 → 用**开轮时**的提交当基线，改动仍看得见。
    #[test]
    fn since_rev_shows_change_after_commit() {
        let root = setup_repo("since_after_commit");
        std::fs::write(root.join("a.txt"), "v1\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "v1"]);
        let base = head_sha(&root);

        // agent 改文件并提交（一轮的典型收尾）
        std::fs::write(root.join("a.txt"), "v2\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "v2"]);

        let pair = build_diff_pair(
            &root,
            "a.txt",
            &DiffMode::Since { rev: base.clone() },
        )
        .unwrap();
        assert_eq!(pair.status, "modified");
        assert_eq!(pair.old_text, "v1\n", "旧侧必须是开轮提交的内容，不是 HEAD");
        assert_eq!(pair.new_text, "v2\n");
        assert_eq!(pair.old_label, &base[..7]);
        assert_eq!(pair.new_label, "工作区");
        assert!(!pair.base_missing);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 基线之后才新建的文件：rev 有效但该 rev 下没有它 → 正常显示为 added（不是"基线失效"）。
    #[test]
    fn since_rev_with_file_absent_at_rev_is_added() {
        let root = setup_repo("since_added");
        std::fs::write(root.join("old.txt"), "keep\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "v1"]);
        let base = head_sha(&root);

        std::fs::write(root.join("new.txt"), "brand new\n").unwrap();

        let pair = build_diff_pair(&root, "new.txt", &DiffMode::Since { rev: base }).unwrap();
        assert_eq!(pair.status, "added");
        assert!(!pair.base_missing, "rev 有效，不该标成基线失效");
        assert!(pair.new_text.contains("brand new"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 基线失效（rebase / GC 之后不可达）：**不比**，给 HEAD 视图 + 标记，绝不把整份文件当新增。
    #[test]
    fn since_rev_missing_falls_back_to_head_view() {
        let root = setup_repo("since_missing");
        std::fs::write(root.join("a.txt"), "v1\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "v1"]);
        std::fs::write(root.join("a.txt"), "v2\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "v2"]);

        let pair = build_diff_pair(
            &root,
            "a.txt",
            &DiffMode::Since {
                rev: "0000000000000000000000000000000000000000".into(),
            },
        )
        .unwrap();
        assert!(pair.base_missing);
        assert_eq!(pair.old_label, "HEAD", "降级后标签如实写 HEAD");
        assert_eq!(pair.old_text, "v2\n");
        assert_eq!(pair.new_text, "v2\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 基线用**引用名**（不是 sha）：取数必须用调用方给的 rev 本身，
    /// **不能**拿显示标签（`&rev[..7]`）去取——短号可能歧义，取数失败会被静默判成"整片新增"。
    #[test]
    fn since_rev_fetches_with_the_given_rev_not_the_label() {
        let root = setup_repo("since_refname");
        std::fs::write(root.join("a.txt"), "v1\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "v1"]);
        git(&root, &["branch", "baseline-branch"]);

        std::fs::write(root.join("a.txt"), "v2\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "v2"]);

        let pair = build_diff_pair(
            &root,
            "a.txt",
            &DiffMode::Since {
                rev: "refs/heads/baseline-branch".into(),
            },
        )
        .unwrap();
        assert_eq!(pair.status, "modified", "旧侧取数失败会被误判成整片新增");
        assert_eq!(pair.old_text, "v1\n");
        assert!(!pair.base_missing);
        let _ = std::fs::remove_dir_all(&root);
    }

    // 未提交的空仓库（unborn HEAD）与 HEAD 取 sha 的两条用例见 `head.rs` 自己的测试模块。
}
