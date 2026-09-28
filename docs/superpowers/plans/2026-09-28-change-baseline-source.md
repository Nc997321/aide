# 变更「改前」的来源端口 + 基线源 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「全部文件」与「轮次」两侧的 diff 各自用**对的基线**（会话首 / 轮首）——agent 提交之后回看，改动仍然看得见；并把"内容从哪来"做成可替换的端口。

**Architecture:** 三级来源链（本轮内存片段 → git 某提交 → HEAD 兜底）藏在 `diffSource` 端口后面，**口径由消费者显式声明**（`scope: "round" | "session"`），选择只发生在装配处一处；轮记录落一个新字段 `baseRev`（开轮时刻的 HEAD），会话起点 = 第一轮带基线的那个值。Rust 侧把 `staged`/`commit_hash` 两个相邻可选参数收成一个 `DiffMode` 标签枚举，并新增取 HEAD 的 `git_head_rev`。

**Tech Stack:** Vue 3 + TS（vitest/@vue/test-utils）+ Rust（tauri commands，`git_run` 家族）+ 真 git 临时仓做 Rust 用例。

**Spec:** `docs/superpowers/specs/2026-09-28-change-baseline-source-design.md`

---

## 实施前发现的一处 spec 漏洞（Task 1 Step 1 先补上）

**spec §4.4/§4.5 的前提不成立**：在 git 层，「rev 不存在」与「该 rev 下没有这个文件」**都只是 `git show` 非零退出**——`diffpair.rs:37-44` 的 `show_blob` 一律返回 `None`。若照原设计直接 `Since(badRev)`，会把整个文件误判成**新增**（old 缺失、new 存在 → status `added`）——**内容错**，违背"失败一律退回今天"的承诺。

修法（本计划采用）：`Since` 分支**先用 `git rev-parse --verify <rev>^{commit}` 校验**（既有先例 `compare.rs:202`），不通过时不比、直接给 HEAD 视图，并在 `DiffPair` 上置 `base_missing` 标记（与既有 `eolOnly`/`tooBig`/`isBinary` 同形的机制标记）。TS 侧据此写降级 note。同时修正 §4.5 里"短号只在 Rust 截一次"的说法：**非降级 note 的短号取自 `pair.oldLabel`**（Rust 给的），**降级 note 的短号由适配器从 `req.baseRev` 截取**（那个 rev 已经不在仓库里，Rust 给不出来）。

## 顺带的定向改进（同一处代码，一并做掉）

`assemble_diff_pair` 今天有 **10 个位置参数**（`diffpair.rs:230-241`），本次要再加一个标记位 → 11 个。按参数铁律（单函数输入 >4 = 设计问题），把它收成一个输入结构体 `DiffSides`（8 字段）+ `root` + `path` + `base_missing` = **4 个输入**。行为零变化（`compare.rs` 的调用点同步改写法）。

---

## Global Constraints

- **口径必须显式声明**：`openDiff(row, opts)` 的 `opts.scope` 必填；**禁止**再从 `row.segments.length === 0` 之类的数据形状推断来源。
- **端口边界**：`api.gitDiffPair` / `api.gitHeadRev` 只允许出现在 `src/composables/diffSource/git.ts`；领域侧（`useDiffWindow` / 面板 / 卡片）只认端口。判据见 spec §4.6。
- **退化链**（任何一环失败都退回今天，绝不出现错的内容）：无 `baseRev` → `Unstaged`；rev 校验不过 → HEAD 视图 + `base_missing` + 降级 note；老会话无字段 → 同无基线。
- **文案逐字**（spec §4.5）：
  - round：`自开轮时的 <短号> 到工作区（本轮视图）`
  - session：`自会话起点的 <短号> 到工作区（会话视图）`
  - 降级：`基线 <短号> 已不在仓库中，退回 HEAD 累计`
  - 兜底（照抄今天这句，一字不改）：`累计视图：显示该文件相对 HEAD 的全部差异（非本轮片段）`
- **标签**：`Since(rev)` → `oldLabel = 短号`（`&rev[..7.min(len)]`）、`newLabel = 工作区`；`Unstaged` 照旧 `HEAD → 工作区`。
- **不动**：sidecar、协议、REGISTRY（已核 `remote/rpc.rs` 无 `git_diff_pair`）、`DiffViewer` 渲染、`ChangeRoundData` 既有字段语义、落盘格式的既有形状（只**新增**一个可选字段）。
- **Rust 规矩**：重 IO/子进程命令一律 `async` + `spawn_blocking`（复用 `git_run_blocking`）；`Command::new("git")` 必须带 `CREATE_NO_WINDOW`（复用 `git_run`，已带，见 `commands/git/runtime.rs`）；跨平台，不硬编码分隔符。
- **TS 规矩**：`any` 零容忍；函数 ≤40 行、嵌套 ≤3 层、单函数输入 ≤4；无死代码、无注释掉的逻辑；样式不涉本笔。
- **测试命令**：Rust `cargo test --manifest-path src-tauri/Cargo.toml --lib <过滤词>`；TS `npx vitest run <路径>`、全量 `pnpm test`、类型 `npx vue-tsc --noEmit`。
- **实测值**（写死在用例注释里）：`git rev-parse HEAD` ≈ **101 ms/次**（本机温启动）；`git_run` 已带无窗口标志。

---

## Review Focus

（spec 没写、但输入一到就会咬人的五类；每条都在对应任务里有测试钉住）

1. **rev 有效、但该文件在那个提交里不存在**（文件是基线之后新建的）→ 必须按 `added` 正常显示；**不能**被判成"基线失效"（两者在 git 层都只是非零退出）。
2. **未提交的空仓库**（unborn HEAD，项目刚 `git init`）→ `git_head_rev` 返回 `None` 而非报错；不记基线，整条链退化为今天。
3. **跨会话不串**：`sessionBaseRev` 只看**本会话**的 rounds——A 会话的老数据（无 `baseRev`）不能借到 B 会话的基线。
4. **`base_missing` 时内容仍是 HEAD 视图**（不是空、不是"整片新增"），且 note 如实说明降级。
5. **同一条文件被两种口径先后打开**（先轮次、后全部文件）→ 两次各用各的 mode 与 rev，不缓存、不串。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src-tauri/src/commands/git/diffpair.rs`（改） | `DiffMode` 标签枚举；`build_diff_pair` 按 mode 分派（新增 `Since`）；`DiffSides` 输入结构体；`DiffPair.base_missing` |
| `src-tauri/src/commands/git/head.rs`（新） | `git_head_rev`：仓库 HEAD 提交（非 git 仓库 → `Ok(None)`） |
| `src-tauri/src/commands/git/mod.rs`（改） | 登记 `head` 子模块 + `pub use head::*` + 文档补一行 |
| `src-tauri/src/lib.rs`（改） | 注册 `commands::git::git_head_rev` |
| `src-tauri/src/commands/mod.rs`（改） | `ChangeRoundData.base_rev: Option<String>`（`#[serde(default)]`） |
| `packages/aide-sdk/src/types.ts`（改） | `ChangeRound.baseRev?: string`；`DiffPair.baseMissing?: boolean` |
| `packages/aide-sdk/src/api.ts`（改） | `gitDiffPair(path, { mode, cwd })` 收口；新增 `gitHeadRev(cwd?)` |
| `src/composables/diffSource.ts`（新） | 端口类型 + 有序链 + 唯一选择处 + `sessionBaseRev` |
| `src/composables/diffSource/segments.ts`（新） | 适配器：本轮内存片段（从 `useDiffWindow` 原样搬来） |
| `src/composables/diffSource/git.ts`（新） | 适配器：git（有基线用 `Since`，无基线/降级用 `Unstaged`），写 note |
| `src/composables/useDiffWindow.ts`（改） | 只做"解析路径 → 交给端口 → 开窗"，选择逻辑全部移走 |
| `src/composables/useConversationChanges.ts`（改） | `startRound` 记 `baseRev`（+ 非 git 仓库负缓存） |
| `src/components/ChangeLogPanel.vue`（改） | 树行传 `session`、轮次行传 `round` |
| `src/components/ChatPanel/TurnChangeCard.vue`（改） | 展开行传 `round` |
| `src/components/git-panel/GitCompare.vue` / `src/components/GitPanel.vue`（改） | `DiffMode` 收口的调用写法（语义不变） |
| `docs/prototypes/_harness/diff-note-live.{html,ts}`（新） | `WindowDiffPane` 真组件截图（note 文案核对） |

---

### Task 1: Rust 机制层 —— `DiffMode` 收口 + `Since` + `base_missing` + `git_head_rev`

**Files:**
- Modify: `src-tauri/src/commands/git/diffpair.rs`（`DiffPair`、`assemble_diff_pair`、`build_diff_pair`、`git_diff_pair`、测试）
- Create: `src-tauri/src/commands/git/head.rs`
- Modify: `src-tauri/src/commands/git/mod.rs`、`src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands/git/compare.rs`（`assemble_diff_pair` 调用写法）
- **先改文档**：`docs/superpowers/specs/2026-09-28-change-baseline-source-design.md` §4.4/§4.5（见"实施前发现的漏洞"）

**Interfaces:**
- Consumes: 既有 `show_blob` / `show_blobs` / `assemble_diff_pair` / `git_run` / `git_run_blocking` / `project_root_for`
- Produces:
  - `pub enum DiffMode { Unstaged, Staged, Commit { hash: String }, Since { rev: String } }`（serde `tag = "kind"`）
  - `pub async fn git_diff_pair(ws, path: String, mode: DiffMode, cwd: Option<String>) -> Result<DiffPair, String>`
  - `DiffPair.base_missing: bool`
  - `pub async fn git_head_rev(ws, cwd: Option<String>) -> Result<Option<String>, String>`

- [ ] **Step 1: 修 spec（漏洞 + 短号说明），单独提交**

改 `docs/superpowers/specs/2026-09-28-change-baseline-source-design.md`：
1. §4.4 的 `DiffMode` 代码块后补一段：`Since` 分支先 `rev-parse --verify <rev>^{commit}`；不通过 → 不比、给 HEAD 视图并置 `base_missing=true`。
2. §4.5 的"短号只在 Rust 截一次"改成：非降级 note 的短号取自 `pair.oldLabel`；降级 note 的短号由适配器从 `req.baseRev` 截取（那个 rev 已不在仓库里）。
3. §4.5 表格上面补一句：`DiffPair` 新增 `baseMissing`（与 `eolOnly`/`tooBig`/`isBinary` 同形的机制标记）。

```bash
git add docs/superpowers/specs/2026-09-28-change-baseline-source-design.md
git commit -m "docs(diff): 修基线源 spec 的一处漏洞——rev 失效与该 rev 下无此文件在 git 层不可区分"
```

- [ ] **Step 2: 写失败的 Rust 用例（真 git 临时仓）**

在 `diffpair.rs` 的 `mod diff_pair_tests` 末尾追加（沿用该模块的 `setup_repo` / `git` 助手；下面用到的 `mode` 与 `head::` 此时还不存在，编译失败即 RED）：

```rust
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

        let pair = build_diff_pair(&root, "a.txt", &DiffMode::Since { rev: base.clone() }).unwrap();
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
            &DiffMode::Since { rev: "0000000000000000000000000000000000000000".into() },
        )
        .unwrap();
        assert!(pair.base_missing);
        assert_eq!(pair.old_label, "HEAD", "降级后标签如实写 HEAD");
        assert_eq!(pair.old_text, "v2\n");
        assert_eq!(pair.new_text, "v2\n");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 未提交的空仓库（unborn HEAD）与 HEAD 取 sha 的两条用例见 `head.rs` 自己的测试模块。
```

同模块顶部加一个助手（`head_sha` 用现成的 `git` 助手取 `rev-parse HEAD`）：

```rust
    /// 测试用：当前 HEAD 的 sha。
    fn head_sha(root: &std::path::Path) -> String {
        let out = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(root)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }
```

`head.rs` 的测试模块（自带最小 `git init` 脚手架 —— 与 `diffpair.rs` 那份同形，测试脚手架的小重复可接受）：

```rust
#[cfg(test)]
mod head_tests {
    use super::*;
    use std::process::Command;

    fn git(root: &std::path::Path, args: &[&str]) {
        let out = Command::new("git").args(args).current_dir(root).output().unwrap();
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
```

- [ ] **Step 3: 跑 Rust 用例确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib diff_pair_tests`
Expected: 编译失败（`DiffMode` / `head` 未定义 / `build_diff_pair` 参数不符）——这是 Rust 侧的 RED。

- [ ] **Step 4: 实现 `DiffMode` + `Since` + `DiffSides`**

`diffpair.rs`：

```rust
/// 取哪两方来比。**单值标签**：原先是 `staged: Option<bool>` + `commit_hash: Option<String>`
/// 两个相邻可选参数（靠"不同时给"的约定维持），再加一个基线 rev 就是三个 —— 按参数铁律收成一个。
#[derive(Deserialize)]
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
```

`assemble_diff_pair` 的输入收成一个结构体（10 → 4 个输入，行为不变）：

```rust
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

pub(super) fn assemble_diff_pair(
    sides: DiffSides,
    root: &std::path::Path,
    path: &str,
    base_missing: bool,
) -> DiffPair
```

（函数体逐字沿用现有逻辑 —— `too_big` 短路、binary 检测、行尾归一化、`eol_only`、status 推导 —— 只是把入参从散开的 10 个改成 `sides.*`；`DiffPair` 两个构造点都补 `base_missing`。）

`build_diff_pair` 按 mode 分派，主函数只做骨架：

```rust
pub(super) fn build_diff_pair(
    root: &std::path::Path,
    path: &str,
    mode: &DiffMode,
) -> Result<DiffPair, String> {
    match mode {
        DiffMode::Commit { hash } => commit_sides(root, path, hash),
        DiffMode::Staged => staged_sides(root, path),
        DiffMode::Unstaged => worktree_sides(root, path, "HEAD".to_string(), false),
        DiffMode::Since { rev } => since_sides(root, path, rev),
    }
}

/// rev → 工作区。**先校验 rev**：`git show <坏 rev>:<path>` 与"该 rev 下没这个文件"
/// 都只是非零退出（见 `show_blob`），不校验就会把整份文件误判成新增。
fn since_sides(root: &std::path::Path, path: &str, rev: &str) -> Result<DiffPair, String> {
    let verified = git_run(&["rev-parse", "--verify", &format!("{}^{{commit}}", rev)], root)?;
    if !verified.status.success() {
        // 基线不可达（rebase / GC）→ 不比，给 HEAD 视图 + 标记，由上层如实标注
        return worktree_sides(root, path, "HEAD".to_string(), true);
    }
    let short = &rev[..7.min(rev.len())];
    worktree_sides(root, path, short.to_string(), false)
}

/// HEAD/某提交 → 工作区（`old_label` 决定旧侧取哪个 rev）。旧侧也走 blob 取数，
/// 故超限判断与读盘那段（原 `:371-385`）一并搬成两个小函数，行为逐字不变。
fn worktree_sides(
    root: &std::path::Path,
    path: &str,
    old_label: String,
    base_missing: bool,
) -> Result<DiffPair, String> {
    const MAX_DIFF_BYTES: u64 = 1_000_000;
    let old = show_blob(&format!("{}:{}", old_label, path), root)?;
    let old_too_big = old
        .as_ref()
        .map(|b| b.len() as u64 > MAX_DIFF_BYTES)
        .unwrap_or(false);
    let new_path = root.join(path);
    let new_exists = new_path.exists();
    let (new, new_too_big) = read_worktree_side(&new_path, path, new_exists)?;
    Ok(assemble_diff_pair(
        DiffSides {
            old_label,
            new_label: "工作区".to_string(),
            old_exists: old.is_some(),
            new_exists,
            old_bytes: old,
            new_bytes: new,
            old_too_big,
            new_too_big,
        },
        root,
        path,
        base_missing,
    ))
}

/// 工作区一侧：不存在 → (None, false)；超 1MB → (None, true)；否则读盘。
fn read_worktree_side(
    new_path: &std::path::Path,
    path: &str,
    new_exists: bool,
) -> Result<(Option<Vec<u8>>, bool), String> {
    const MAX_DIFF_BYTES: u64 = 1_000_000;
    if !new_exists {
        return Ok((None, false));
    }
    let meta = std::fs::metadata(new_path)
        .map_err(|e| format!("Failed to read metadata for {}: {}", path, e))?;
    if meta.len() > MAX_DIFF_BYTES {
        return Ok((None, true));
    }
    Ok((std::fs::read(new_path).ok(), false))
}
```

`git_diff_pair` 命令改签名（`Commit { hash }` 里 `h^` 的取法照旧）：

```rust
#[tauri::command]
pub async fn git_diff_pair(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
    mode: DiffMode,
    cwd: Option<String>,
) -> Result<DiffPair, String> {
    let root = project_root_for(&workspace_state, cwd.as_deref());
    if !root.join(".git").exists() {
        return Err("Not a git repository".into());
    }
    git_run_blocking(move || build_diff_pair(&root, &path, &mode)).await
}
```

- [ ] **Step 5: 新增 `head.rs` + 注册**

Create `src-tauri/src/commands/git/head.rs`：

```rust
//! 仓库 HEAD 提交域：变更基线的"改前"引用。
use crate::commands::{project_root_for, WorkspaceState};
use super::runtime::{git_run, git_run_blocking};
use serde::Serialize;
use tauri::State;

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
#[tauri::command]
pub async fn git_head_rev(
    workspace_state: State<'_, WorkspaceState>,
    cwd: Option<String>,
) -> Result<Option<String>, String> {
    let root = project_root_for(&workspace_state, cwd.as_deref());
    if !root.join(".git").exists() {
        return Ok(None);
    }
    git_run_blocking(move || read_head_rev(&root)).await
}
```

`src-tauri/src/commands/git/mod.rs`：加 `pub mod head;` + `pub use head::*;`，并在模块文档的域列表里补一句「仓库 HEAD 在 [`head`]」。
`src-tauri/src/lib.rs`：在 git 命令注册段（`:475` 附近，`git_diff_pair` 旁）加 `commands::git::git_head_rev,`。

- [ ] **Step 6: 跑 Rust 用例确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib diff_pair_tests`
Expected: PASS（既有 12 例 + 新增 5 例；既有 `modified_unstaged_returns_head_vs_worktree` / `staged_returns_head_vs_index` / `commit_returns_parent_vs_commit` 三条语义不变）

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: 全绿（`compare` 的既有用例一起过 —— `assemble_diff_pair` 收口的行为不变由它们兜底）

- [ ] **Step 7: 提交**

```bash
git add src-tauri/src/commands/git/diffpair.rs src-tauri/src/commands/git/head.rs src-tauri/src/commands/git/mod.rs src-tauri/src/commands/git/compare.rs src-tauri/src/lib.rs
git commit -m "feat(diff): DiffMode 单值收口 + Since(基线) 模式 + git_head_rev；assemble_diff_pair 输入收成结构体"
```

---

### Task 2: 类型与落盘 —— `baseRev` / `base_rev`

**Files:**
- Modify: `src-tauri/src/commands/mod.rs:158-167`（`ChangeRoundData`）+ `src-tauri/src/commands/session/changes.rs`（测试构造点与兼容用例）
- Modify: `packages/aide-sdk/src/types.ts`（`ChangeRound`、`DiffPair`）

**Interfaces:**
- Consumes: Task 1 的 `DiffPair.base_missing`
- Produces: `ChangeRound.baseRev?: string`（TS）/ `ChangeRoundData.base_rev: Option<String>`（Rust）；`DiffPair.baseMissing?: boolean`（TS）

- [ ] **Step 1: 写失败的兼容用例**

在 `changes.rs` 的 `mod tests` 里追加（`change_round` 助手同步补 `base_rev`）：

```rust
    #[test]
    fn changes_round_trips_base_rev() {
        let id = format!("test-changes-baserev-{}", std::process::id());
        let path = changes_path(&id);
        let _ = std::fs::remove_file(&path);

        let mut r = change_round(1);
        r.base_rev = Some("a".repeat(40));
        append_session_change_blocking(id.clone(), r).unwrap();

        let rounds = load_session_changes_blocking(id.clone()).unwrap();
        assert_eq!(rounds[0].base_rev.as_deref(), Some("a".repeat(40).as_str()));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn changes_load_without_base_rev_is_none() {
        // 2026-09-28 之前写下的轮记录没有该字段 → 必须照读（老会话不追溯、退化为 HEAD 累计）
        let id = format!("test-changes-nobaserev-{}", std::process::id());
        let path = changes_path(&id);
        let _ = std::fs::remove_file(&path);
        fs::create_dir_all(our_sessions_dir()).unwrap();
        fs::write(
            &path,
            "{\"index\":1,\"time\":\"12:01\",\"files\":[],\"rewind_to\":101,\"prompt\":\"提问 1\"}\n",
        )
        .unwrap();

        let rounds = load_session_changes_blocking(id.clone()).unwrap();
        assert_eq!(rounds.len(), 1);
        assert_eq!(rounds[0].base_rev, None);
        let _ = std::fs::remove_file(&path);
    }
```

- [ ] **Step 2: 跑确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib changes_`
Expected: 编译失败（`ChangeRoundData` 无 `base_rev` 字段）

- [ ] **Step 3: 加字段**

`src-tauri/src/commands/mod.rs`（`ChangeRoundData` 内，`prompt` 之后）：

```rust
    /// 「改前」引用：**该轮开轮时刻**会话工作区仓库的 HEAD 提交。
    /// 旧数据 / 非 git 仓库 / 取失败都没有它 —— 消费端据此退回 HEAD 累计，不追溯。
    #[serde(default)]
    pub base_rev: Option<String>,
```

`packages/aide-sdk/src/types.ts`：`ChangeRound`（`:82-97`）加：

```ts
  /** 「改前」引用：该轮开轮时刻的 HEAD 提交（开轮时取；旧数据没有）。
   *  消费端按口径取用：轮视图取本轮、全部文件树取**首轮**的（会话起点）。 */
  baseRev?: string;
```

同文件 `DiffPair` 加：

```ts
  /** 机制标记：请求的基线提交已不在仓库中（rebase / GC），本次给的是 HEAD 视图。
   *  与 eolOnly / tooBig / isBinary 同形——由 Rust 侧置位，消费端据此如实标注。 */
  baseMissing?: boolean;
```

`changes.rs` 的 `change_round` 助手补 `base_rev: None,`。

- [ ] **Step 4: 跑确认通过 + 全量**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib changes_`
Expected: PASS（既有 7 例 + 新增 2 例）

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/commands/mod.rs src-tauri/src/commands/session/changes.rs packages/aide-sdk/src/types.ts
git commit -m "feat(diff): 轮记录加 baseRev/base_rev（基线引用）+ DiffPair.baseMissing 标记；老数据无字段照读"
```

---

### Task 3: TS 端口 —— `diffSource` + 两个适配器 + `useDiffWindow` 瘦身

**Files:**
- Create: `src/composables/diffSource.ts`、`src/composables/diffSource/segments.ts`、`src/composables/diffSource/git.ts`
- Modify: `src/composables/useDiffWindow.ts`（只留"解析路径 → 端口 → 开窗"）
- Test: `src/composables/diffSource.test.ts`（新）、`src/composables/useDiffWindow.test.ts`（改签名、保语义）

**Interfaces:**
- Consumes: Task 1/2 的 `api.gitDiffPair(path, { mode, cwd })`（Task 4 落地门面；本任务先按新形状写，门面在 Task 4 改，故 Task 3 的测试要 mock 门面形状）
- Produces:
  - `type DiffScope = "round" | "session"`
  - `interface DiffRequest { row: TouchedFile; scope: DiffScope; workspaceRoot?: string; baseRev?: string }`
  - `interface DiffContentSource { id: "segments" | "git"; available(req): boolean; build(req): Promise<WindowDiff> }`
  - `resolveDiff(req: DiffRequest): Promise<WindowDiff>`
  - `sessionBaseRev(rounds: ChangeRound[]): string | undefined`
  - `useDiffWindow().openDiff(row: TouchedFile, opts: { scope: DiffScope; workspaceRoot?: string; baseRev?: string })`

- [ ] **Step 1: 写失败测试**

Create `src/composables/diffSource.test.ts`：

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeRound, DiffPair, TouchedFile } from "../types";

const mocks = vi.hoisted(() => ({
  gitDiffPair: vi.fn(),
  readFileContent: vi.fn(async (_p: string) => ""),
}));
vi.mock("../api", () => ({ api: { gitDiffPair: mocks.gitDiffPair, readFileContent: mocks.readFileContent } }));

import { resolveDiff, sessionBaseRev } from "./diffSource";

function pair(over: Partial<DiffPair> = {}): DiffPair {
  return {
    oldText: "old", newText: "new", oldLabel: "a1b2c3d", newLabel: "工作区",
    status: "modified", isBinary: false, eolOnly: false, tooBig: false, ...over,
  };
}
function row(over: Partial<TouchedFile> = {}): TouchedFile {
  return { path: "src/a.ts", status: "M", additions: 1, deletions: 0, segments: [], ...over };
}
function round(index: number, baseRev?: string): ChangeRound {
  return { index, time: "10:00", files: [], baseRev };
}

beforeEach(() => vi.clearAllMocks());

describe("resolveDiff — 口径由声明决定，不看数据形状", () => {
  it("round + 有片段 → 走片段（不碰 git）", async () => {
    const diff = await resolveDiff({
      row: row({ segments: [{ oldText: "x", newText: "y", addCount: 1, delCount: 1 }] }),
      scope: "round",
      workspaceRoot: "C:/repo",
    });
    expect(mocks.gitDiffPair).not.toHaveBeenCalled();
    expect(diff.parts).toHaveLength(1);
  });

  it("session + **有片段** → 仍走 git：口径优先于数据形状", async () => {
    mocks.gitDiffPair.mockResolvedValue(pair());
    await resolveDiff({
      row: row({ segments: [{ oldText: "x", newText: "y", addCount: 1, delCount: 1 }] }),
      scope: "session",
      workspaceRoot: "C:/repo",
      baseRev: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(mocks.gitDiffPair).toHaveBeenCalledTimes(1);
  });

  it("有基线 → Since(rev)，note 写明口径与短号（取自 pair.oldLabel）", async () => {
    mocks.gitDiffPair.mockResolvedValue(pair({ oldLabel: "0123456" }));
    const rev = "0123456789abcdef0123456789abcdef01234567";

    const asRound = await resolveDiff({ row: row(), scope: "round", workspaceRoot: "C:/repo", baseRev: rev });
    expect(mocks.gitDiffPair).toHaveBeenCalledWith("src/a.ts", { mode: { kind: "since", rev }, cwd: "C:/repo" });
    expect(asRound.note).toBe("自开轮时的 0123456 到工作区（本轮视图）");

    const asSession = await resolveDiff({ row: row(), scope: "session", workspaceRoot: "C:/repo", baseRev: rev });
    expect(asSession.note).toBe("自会话起点的 0123456 到工作区（会话视图）");
  });

  it("无基线（老会话）→ Unstaged，note 照抄今天那句，一字不改", async () => {
    mocks.gitDiffPair.mockResolvedValue(pair({ oldLabel: "HEAD", newLabel: "工作区" }));
    const diff = await resolveDiff({ row: row(), scope: "round", workspaceRoot: "C:/repo" });

    expect(mocks.gitDiffPair).toHaveBeenCalledWith("src/a.ts", { mode: { kind: "unstaged" }, cwd: "C:/repo" });
    expect(diff.note).toBe("累计视图：显示该文件相对 HEAD 的全部差异（非本轮片段）");
  });

  it("基线失效 → 内容仍是 HEAD 视图（不是空壳），note 如实说降级、短号由适配器截取", async () => {
    mocks.gitDiffPair.mockResolvedValue(pair({ oldLabel: "HEAD", baseMissing: true }));
    const rev = "0123456789abcdef0123456789abcdef01234567";

    const diff = await resolveDiff({ row: row(), scope: "round", workspaceRoot: "C:/repo", baseRev: rev });

    expect(diff.note).toBe("基线 0123456 已不在仓库中，退回 HEAD 累计");
    expect(diff.parts[0].pair.newText).toBe("new"); // 内容照旧是 HEAD 视图，不空、不误判为新增
  });
});

describe("sessionBaseRev — 会话起点 = 本会话第一个带基线的轮", () => {
  it("跳过没有基线的轮（老数据 / 非 git 仓库的轮）", () => {
    expect(sessionBaseRev([round(1), round(2, "aaaaaaa"), round(3, "bbbbbbb")])).toBe("aaaaaaa");
  });
  it("全都没有 → undefined（退化为 HEAD 累计）", () => {
    expect(sessionBaseRev([round(1), round(2)])).toBeUndefined();
    expect(sessionBaseRev([])).toBeUndefined();
  });
  it("只看传进来的这一份 rounds —— 跨会话不串", () => {
    expect(sessionBaseRev([round(1)])).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `npx vitest run src/composables/diffSource.test.ts`
Expected: FAIL —— `Failed to resolve import "./diffSource"`

- [ ] **Step 3: 写端口与适配器**

Create `src/composables/diffSource.ts`（组织文件：类型 + 链 + 唯一选择处）：

```ts
/**
 * 「一条变更记录的改前/改后从哪里取」——端口（照 `api.ts + api/*` 的分层范式：
 * 组织文件在上层、子实现同名子目录）。
 *
 * 为什么是端口：来源**已经有三个**（本轮内存片段 / 某个提交 / HEAD），而选源原先写在两处
 * ——树行靠 `asTouchedFile()` 掏空片段来"伪造"累计口径，`useDiffWindow` 再按空数组嗅探一次。
 * 口径必须由**消费者显式声明**（`scope`），选择只发生在这里；加来源 = 加一个适配器 + 链上一行。
 */
import type { ChangeRound, TouchedFile } from "../types";
import type { WindowDiff } from "./useFileViewer";
import { segmentsSource } from "./diffSource/segments";
import { gitSource } from "./diffSource/git";

/** 看哪个口径的"改前"。 */
export type DiffScope = "round" | "session";

export interface DiffRequest {
  row: TouchedFile;
  scope: DiffScope;
  /** 会话所属工作区根（git cwd） */
  workspaceRoot?: string;
  /** 该口径的基线提交（轮首 / 会话首）；缺失 = 无基线，走兜底 */
  baseRev?: string;
}

export interface DiffContentSource {
  id: "segments" | "git";
  /** 能不能服务这个请求（纯判定，不取数） */
  available(req: DiffRequest): boolean;
  build(req: DiffRequest): Promise<WindowDiff>;
}

/** 有序链：加来源 = 加一个适配器 + 这里一行。链尾 `gitSource` 恒可服务（兜底）。 */
const CHAIN: DiffContentSource[] = [segmentsSource, gitSource];

export async function resolveDiff(req: DiffRequest): Promise<WindowDiff> {
  const source = CHAIN.find((s) => s.available(req));
  if (!source) throw new Error("no diff source available"); // 链尾恒真，防御
  return source.build(req);
}

/** 会话起点 = 本会话第一个带基线的轮的那个提交（轮首即开轮时刻，故首轮有基线时它就是会话起点）。
 *  只看传进来的这一份 rounds —— 跨会话不串。 */
export function sessionBaseRev(rounds: ChangeRound[]): string | undefined {
  return rounds.find((r) => !!r.baseRev)?.baseRev;
}
```

Create `src/composables/diffSource/segments.ts`（从 `useDiffWindow.ts` 原样搬 `segmentParts` / `pairStatusOf`）：

```ts
/** 适配器：本轮内存片段（精确到片，与 HEAD 无关）。 */
import type { DiffPair, TouchedFile } from "../../types";
import type { WindowDiff } from "../useFileViewer";
import type { DiffContentSource, DiffRequest } from "../diffSource";
import { locateEditStartLine, makePair } from "../../utils/changeCard";
import { resolveFileLinkPath } from "@aide/sdk/utils/fileLink";

export const segmentsSource: DiffContentSource = {
  id: "segments",
  // 口径优先：session 口径即便内存里有片段也不要（那是跨轮视图）
  available: (req) => req.scope === "round" && req.row.segments.length > 0,
  build: async (req) => ({ parts: await segmentParts(req) }),
};

async function segmentParts(req: DiffRequest): Promise<WindowDiff["parts"]> {
  const absPath = resolveFileLinkPath(req.row.path, req.workspaceRoot);
  const status = pairStatusOf(req.row.status);
  return Promise.all(
    req.row.segments.map(async (seg) => {
      const pair = makePair(seg.oldText, seg.newText, status);
      return { pair, firstLine: await locateEditStartLine(absPath, seg.newText, pair.status) };
    }),
  );
}

/** 变更状态字母（git 口径）→ DiffPair 状态：新增走「新增」配色，其余按修改。 */
function pairStatusOf(status: string): DiffPair["status"] {
  return status === "A" ? "added" : "modified";
}
```

Create `src/composables/diffSource/git.ts`（唯一允许 import `api.gitDiffPair` 的地方）：

```ts
/** 适配器：git。同一个机制、只差"跟哪个提交比"：有基线用 `Since`，无基线/降级用 `Unstaged`。 */
import { api } from "../../api";
import type { DiffContentSource, DiffRequest, DiffScope } from "../diffSource";

export const gitSource: DiffContentSource = {
  id: "git",
  available: () => true, // 链尾兜底：永远能服务
  build: async (req) => {
    const mode = req.baseRev ? { kind: "since" as const, rev: req.baseRev } : { kind: "unstaged" as const };
    const pair = await api.gitDiffPair(req.row.path, { mode, cwd: req.workspaceRoot });
    if (!req.baseRev) return { parts: [{ pair }], note: HEAD_NOTE };
    if (pair.baseMissing) {
      return { parts: [{ pair }], note: `基线 ${short(req.baseRev)} 已不在仓库中，退回 HEAD 累计` };
    }
    return { parts: [{ pair }], note: scopeNote(req.scope, pair.oldLabel) };
  },
};

/** 今天的句子，一字不改（兜底路径仍要说清"这不是本轮片段"）。 */
const HEAD_NOTE = "累计视图：显示该文件相对 HEAD 的全部差异（非本轮片段）";

function scopeNote(scope: DiffScope, shortRev: string): string {
  return scope === "round"
    ? `自开轮时的 ${shortRev} 到工作区（本轮视图）`
    : `自会话起点的 ${shortRev} 到工作区（会话视图）`;
}

/** 降级 note 用的短号：那个 rev 已不在仓库里，Rust 给不出标签，只能在这里截。 */
function short(rev: string): string {
  return rev.slice(0, 7);
}
```

`src/composables/useDiffWindow.ts` 改成一页纸：

```ts
import { useFileViewer } from "./useFileViewer";
import { resolveDiff, type DiffScope } from "./diffSource";
import { resolveFileLinkPath } from "@aide/sdk/utils/fileLink";
import type { TouchedFile } from "../types";

/** 「点变更条目 → 弹 diff 窗口」的唯一入口。**取哪份内容交给端口**（见 diffSource.ts）。 */
export interface DiffOpenOptions {
  scope: DiffScope;
  workspaceRoot?: string;
  baseRev?: string;
}

export function useDiffWindow() {
  const viewer = useFileViewer();

  async function openDiff(row: TouchedFile, opts: DiffOpenOptions): Promise<void> {
    const diff = await resolveDiff({ row, ...opts });
    await viewer.open(resolveFileLinkPath(row.path, opts.workspaceRoot), { diff });
  }

  return { openDiff };
}
```

- [ ] **Step 4: 改既有 `useDiffWindow.test.ts`（保语义、换签名）**

把 6 个用例的调用点从 `openDiff(row, "C:/repo")` 改成 `openDiff(row, { scope: "round", workspaceRoot: "C:/repo" })`；断言**逐条保留**（片段两段行号、git 拿仓库相对路径 + cwd、无片段走累计并含"累计视图"、`undefined` cwd、A 状态 added 且无 firstLine、git 抛错向上抛）。其中"git 拿 pair…"那条的载荷断言改成新形状：

```ts
    expect(mocks.gitDiffPair).toHaveBeenCalledWith("src/a.ts", { mode: { kind: "unstaged" }, cwd: "C:/repo" });
```

- [ ] **Step 5: 跑确认通过 + 全量**

Run: `npx vitest run src/composables/diffSource.test.ts src/composables/useDiffWindow.test.ts`
Expected: PASS（新 10 例 + 既有 6 例）

Run: `npx vue-tsc --noEmit`
Expected: 报错指向**尚未改的调用点**（面板/卡片/GitPanel 的 `openDiff` 与 `gitDiffPair` 旧形状）——这正是 Task 4 要改的清单，记录下来。

- [ ] **Step 6: 提交**

```bash
git add src/composables/diffSource.ts src/composables/diffSource/ src/composables/useDiffWindow.ts src/composables/useDiffWindow.test.ts src/composables/diffSource.test.ts
git commit -m "refactor(diff): 内容来源做成端口（片段 / git）+ 单点装配；口径由消费者显式声明"
```

---

### Task 4: api 门面收口 + 消费者接线 + 开轮记基线

**Files:**
- Modify: `packages/aide-sdk/src/api.ts`（`gitDiffPair` 收口 + `gitHeadRev`）
- Modify: `src/components/GitPanel.vue:196`、`src/components/git-panel/GitCompare.vue:113`（调用写法）
- Modify: `src/composables/useConversationChanges.ts`（`startRound` 记 `baseRev` + 非 git 仓库负缓存）
- Modify: `src/components/ChangeLogPanel.vue`（树行 `session`、轮次行 `round`）
- Modify: `src/components/ChatPanel/TurnChangeCard.vue`（`round`）
- Test: `src/components/ChangeLogPanel.test.ts`、`src/components/ChatPanel/TurnChangeCard.test.ts`、`src/composables/useConversationChanges.test.ts`（若无则新建）

**Interfaces:**
- Consumes: Task 3 的端口与 `DiffOpenOptions`；Task 1 的 `git_head_rev`；Task 2 的 `baseRev`
- Produces: `api.gitDiffPair(path, { mode: DiffMode; cwd? })`、`api.gitHeadRev(cwd?)`；开轮写 `baseRev`

- [ ] **Step 1: 写失败测试**

(a) `useConversationChanges.test.ts`（**沿用该文件既有的 harness**：`mountWithSid()` / `bindWs()` / `flushAsync()` / `apiMock` / `useSessionState().setSessionState()`）：

先在 mock 区与类型 cast 里补 `gitHeadRev`（默认给一个 sha，用例可覆写）：

```ts
    // vi.mock("../api", …) 的 api 对象里加一行
    gitHeadRev: vi.fn().mockResolvedValue("0123456789abcdef0123456789abcdef01234567"),
    // apiMock 的键联合类型里加 "gitHeadRev"
```

追加三条用例：

```ts
  it("开轮取一次基线（cwd = 会话工作区根），写进轮记录", async () => {
    const { setSessionState } = useSessionState();
    const rev = "0123456789abcdef0123456789abcdef01234567";
    apiMock.gitHeadRev.mockResolvedValue(rev);
    const { hook } = await mountWithSid();

    setSessionState(SID, "running");
    await flushAsync();

    expect(apiMock.gitHeadRev).toHaveBeenCalledTimes(1);
    expect(apiMock.gitHeadRev).toHaveBeenCalledWith(WS_ROOT);
    expect(hook.rounds.value[0]?.baseRev).toBe(rev);
  });

  it("非 git 仓库（Ok(None)）→ 不写字段，且负缓存生效（两轮只 spawn 一次）", async () => {
    const { setSessionState } = useSessionState();
    apiMock.gitHeadRev.mockResolvedValue(null);
    const { hook } = await mountWithSid();

    setSessionState(SID, "running");
    await flushAsync();
    setSessionState(SID, "waiting");
    await flushAsync();
    setSessionState(SID, "running");
    await flushAsync();

    expect(apiMock.gitHeadRev).toHaveBeenCalledTimes(1); // 缓存了"不是 git 仓库"
    expect(hook.rounds.value.every((r) => r.baseRev === undefined)).toBe(true);
  });

  it("取基线抛错 → 不写字段，但**不缓存**（下一轮还要试）", async () => {
    const { setSessionState } = useSessionState();
    apiMock.gitHeadRev.mockRejectedValue(new Error("boom"));
    const { hook } = await mountWithSid();

    setSessionState(SID, "running");
    await flushAsync();
    setSessionState(SID, "waiting");
    await flushAsync();
    setSessionState(SID, "running");
    await flushAsync();

    expect(apiMock.gitHeadRev).toHaveBeenCalledTimes(2); // 暂态失败不进负缓存
    expect(hook.rounds.value.every((r) => r.baseRev === undefined)).toBe(true);
  });
```

> 模块级负缓存会跨用例残留 → 把 `noGitRoots.clear()` 加进既有的 `__resetForTest()`（同模块既有范式），
> 且这些用例依赖文件顶部既有的 `__resetForTest()` 调用。

(b) `ChangeLogPanel.test.ts` 追加两条（断言"口径"而不是"形状"）：

```ts
  it("全部文件树：以**会话口径**取 diff（基线 = 首轮 baseRev）", async () => {
    mocks.rounds = [
      { index: 1, time: "10:00", files: [], baseRev: "aaaaaaa1111111111111111111111111111111111" },
      { index: 2, time: "10:10", files: [{ path: "src/App.vue", status: "M", additions: 1, deletions: 0 }], baseRev: "bbbbbbb2222222222222222222222222222222222" },
    ];
    await openAction(wrapper.get(".cft-file")).trigger("click");
    expect(mocks.gitDiffPair).toHaveBeenCalledWith("src/App.vue", {
      mode: { kind: "since", rev: "aaaaaaa1111111111111111111111111111111111" }, // 首轮 = 会话起点
      cwd: "C:/repo",
    });
  });

  it("轮次行：以**本轮口径**取 diff（基线 = 该轮 baseRev）", async () => {
    // 同上，展开轮 2 点文件行 → mode.rev === "bbbbbbb222…"
  });
```

(c) `TurnChangeCard.test.ts`：把 `useDiffWindow` 的 mock 换成收 opts 的形状，并把断言改成：

```ts
    expect(mocks.openDiff).toHaveBeenCalledWith(
      expect.objectContaining({ path: "src/a.ts" }),
      { scope: "round", workspaceRoot: "C:/repo", baseRev: "aaaaaaa1111111111111111111111111111111111" },
    );
```

（该用例的 round 需要带 `baseRev`；新增一条"轮记录没有 baseRev → baseRev 传 undefined"。）

- [ ] **Step 2: 跑确认失败**

Run: `npx vitest run src/composables/useConversationChanges.test.ts src/components/ChangeLogPanel.test.ts src/components/ChatPanel/TurnChangeCard.test.ts`
Expected: FAIL（新断言红：`gitHeadRev` 未调用 / mode 还是旧形状 / opts 形状不符）

- [ ] **Step 3: 收口 api 门面**

`packages/aide-sdk/src/api.ts`（`:525-539`）替换 `gitDiffPair`，并加 `gitHeadRev`：

```ts
  /** 行级 diff 双份原文。**取哪两方由 `mode` 单值标签决定**（原 staged/commitHash 两个
   *  相邻可选参数靠"不同时给"的约定维持，加第三维就会变成三选一的隐式约定）。 */
  gitDiffPair(
    path: string,
    opts: { mode: DiffMode; cwd?: string },
  ): Promise<DiffPair> {
    return getTransport().invoke("git_diff_pair", {
      path,
      mode: opts.mode,
      cwd: opts.cwd ?? null,
    });
  },
  /** 仓库 HEAD 提交（变更基线用）；非 git 仓库 / 还没提交过 → null。 */
  gitHeadRev(cwd?: string): Promise<string | null> {
    return getTransport().invoke("git_head_rev", { cwd: cwd ?? null });
  },
```

`DiffMode` 类型（放 `packages/aide-sdk/src/types.ts`，与 Rust 的 tag 形状对齐）：

```ts
/** `gitDiffPair` 的取数模式（与 Rust `DiffMode` 的 serde tag 对齐：kind 判别）。 */
export type DiffMode =
  | { kind: "unstaged" }
  | { kind: "staged" }
  | { kind: "commit"; hash: string }
  | { kind: "since"; rev: string };
```

两个既有调用点改写法（语义不变）：
- `GitPanel.vue:196`：`{ staged, commitHash }` → `mode: commitHash ? { kind: "commit", hash: commitHash } : staged ? { kind: "staged" } : { kind: "unstaged" }`
- `GitCompare.vue:113`：`{ commitHash: hash }` → `mode: { kind: "commit", hash }`

- [ ] **Step 4: 开轮记基线**

`src/composables/useConversationChanges.ts`：模块级加负缓存（放在 `attribution` 单例旁）：

```ts
/** 已确认「不是 git 仓库」的工作区根：不必每轮白掏一次 spawn（约 101ms）。
 *  只缓存 `Ok(None)`；命令**失败**不缓存 —— 那是暂态，下一轮还要试。 */
const noGitRoots = new Set<string>();
```

`startRound`（`:175-199`）在 `pendingOp` 链内、push 轮记录之前插入：

```ts
      // 基线（"改前"）：开轮时刻的 HEAD 提交。与 jsonl 字节锚点同批取，**不依赖 fs 事件时序**
      // （事件订阅失败时首次触碰会晚于提交，基线就取成提交后的 sha）。取不到就不记 —— 那条记录
      // 将来退回 HEAD 累计，绝不出现错的内容。
      let baseRev: string | undefined;
      const root = sessionWsRoot(sid);
      if (root && !noGitRoots.has(root)) {
        try {
          baseRev = (await api.gitHeadRev(root)) ?? undefined;
          if (!baseRev) noGitRoots.add(root);
        } catch (e) {
          console.warn("[changelog] read HEAD rev failed, this round has no baseline:", e);
        }
      }
```

轮记录里加 `baseRev,`（`t.rounds.push({ index, time, files: [], rewindTo, prompt, pending: true, baseRev })`）。

- [ ] **Step 5: 消费者接线**

`ChangeLogPanel.vue`：

```ts
/** 全部文件树 = 跨轮视图 → **会话口径**，基线取首轮（会话起点）。 */
async function openDiffFromTree(f: ChangeFile) {
  await openDiff(asTouchedFile(f), {
    scope: "session",
    workspaceRoot: wsRoot.value,
    baseRev: sessionBaseRev(props.rounds),
  });
}

/** 轮次行 = 本轮口径，基线取该轮。 */
async function openDiffForRound(round: ChangeRound, row: TouchedFile) {
  await openDiff(row, { scope: "round", workspaceRoot: wsRoot.value, baseRev: round.baseRev });
}
```

模板里 `ChangeRoundItem` 的 `@open-diff` 改成 `(row) => openDiffForRound(item.round, row)`（`item` 在作用域内）。
删掉 `openDiff(row)` 旧签名那条注释里"没有片段 → 以累计视图打开"的解释，换成口径的说法。

`ChatPanel/TurnChangeCard.vue`：

```ts
/** 展开清单 = 本轮的账单 → 本轮口径（基线 = 该轮开轮提交）。 */
async function openDiff(row: TouchedFile) {
  try {
    await openDiffWindow(row, {
      scope: "round",
      workspaceRoot: wsRoot.value,
      baseRev: round.value?.baseRev,
    });
  } catch (e) {
    showToast(`加载 diff 失败：${errorText(e)}`, "danger");
  }
}
```

- [ ] **Step 6: 跑确认通过 + 全量 + 类型**

Run: `npx vitest run src/composables/useConversationChanges.test.ts src/components/ChangeLogPanel.test.ts src/components/ChatPanel/TurnChangeCard.test.ts src/composables/diffSource.test.ts src/composables/useDiffWindow.test.ts`
Expected: PASS

Run: `npx vue-tsc --noEmit`
Expected: 0 报错（Task 3 Step 5 记下的那批调用点应已全部改完）

Run: `pnpm test`
Expected: 全绿（重点看 Git 面板相关用例：mode 收口只改写法）

- [ ] **Step 7: 提交**

```bash
git add packages/aide-sdk/src/api.ts packages/aide-sdk/src/types.ts src/composables/useConversationChanges.ts src/components/ChangeLogPanel.vue src/components/ChatPanel/TurnChangeCard.vue src/components/GitPanel.vue src/components/git-panel/GitCompare.vue src/components/ChangeLogPanel.test.ts src/components/ChatPanel/TurnChangeCard.test.ts src/composables/useConversationChanges.test.ts
git commit -m "feat(diff): 基线接线——开轮记 HEAD、树/轮/卡片各自声明口径、api 门面 DiffMode 收口"
```

---

### Task 5: 夹具截图 + spec 状态 + 台账

**Files:**
- Create: `docs/prototypes/_harness/diff-note-live.{html,ts}`
- Modify: `docs/superpowers/specs/2026-09-28-change-baseline-source-design.md`（状态行 + §8 实现状态）

**Interfaces:**
- Consumes: Task 3 的四条 note 文案
- Produces: 形态核对证据 + 状态回写

- [ ] **Step 1: 夹具（note 文案在真组件里长什么样）**

`docs/prototypes/_harness/diff-note-live.html`（照 `changelog-live.html` 的五行骨架）+ `diff-note-live.ts`：挂四个 `WindowDiffPane`（真实组件），各带一份 `WindowDiff`，`note` 分别是四条文案（round / session / 降级 / 兜底），`parts` 用一对造好的 `pair`（`makePair("a\nb\n", "a\nB\n", "modified")`）。

Run:
```bash
npx vite --port 5199
```
打开 `http://localhost:5199/docs/prototypes/_harness/diff-note-live.html`，用内嵌浏览器截图（`browser_tab` → `browser_screenshot`，用完 `action=close`），核对：四条 note 各自一行、不折行、不挤压 diff 区；短号是 7 位。

- [ ] **Step 2: 回写 spec 状态**

`docs/superpowers/specs/2026-09-28-change-baseline-source-design.md` 头两行改成：

```
日期：2026-09-28
状态：**已实现（2026-09-28）；真机未跑**（Rust 真仓用例是本笔的主证据，见 §6）
```

并在文末追加「实现状态」一节：逐条对 §6 的自测表（哪条由哪个测试文件覆盖）、§5 的边界是否守住、`grep` 验收（spec §4.6 的那条命令）的实际输出。

- [ ] **Step 3: 提交**

```bash
git add docs/prototypes/_harness/diff-note-live.html docs/prototypes/_harness/diff-note-live.ts docs/superpowers/specs/2026-09-28-change-baseline-source-design.md
git commit -m "docs(diff): 基线源 —— note 文案真组件夹具 + spec 状态回写"
```

---

## 收尾（全部任务完成后）

- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --lib` 全绿 + `pnpm test` 全绿 + `npx vue-tsc --noEmit` 0 报错（在最后一次改动之后）
- [ ] `grep -rn "gitDiffPair\|gitHeadRev" src packages --include=*.ts --include=*.vue | grep -v diffSource/git.ts | grep -v "\.test\.ts"` —— 只应命中 api 门面自身与 Git 面板两个调用点（spec §4.6 判据）
- [ ] `git diff --stat` 复核改动面：sidecar / 协议 / REGISTRY / `DiffViewer` 渲染 / `ChangeRoundData` 既有字段语义 **一字未动**
- [ ] 给用户一份"可点一下"的说明：在他那台机器的报告场景里点「全部文件」→ 看到 diff 有内容（30 秒，**非必须**——内容层已由 Rust 真仓用例证明）
