# Diff 查看器（编辑器级对比视图）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 diff 标签页从「裸 unified diff 文本 + 行首染色」重做编辑器级对比视图（@codemirror/merge），并从根上消除 `git_diff_content` 的假新文件 bug。

**Architecture:** Rust 新增 `git_diff_pair` 命令返回新旧双份原文（行尾归一化 + 状态判定）；前端新增 `DiffViewer.vue` 包装 `@codemirror/merge` 的 `MergeView`（并排，默认）/ `unifiedMergeView`（单栏），经 `useFileViewer` 虚拟窗口机制接入；CodeEditor 的语言加载与语法高亮样式抽取为共享 util 复用；旧 `git_diff_content`（含 synthesize fallback）与相关死代码、旧样式整体清除。

**Tech Stack:** Vue 3 + TS、CodeMirror 6 + `@codemirror/merge@6.12.2`（已安装）、Rust + Tauri v2、vitest、cargo test。

**Spec:** `docs/superpowers/specs/2026-07-17-diff-viewer-design.md`

## Global Constraints

- 颜色/背景/边框/间距一律 `var(--aide-*)`；**禁止硬编码 hex**；不新增 ThemeTokens 槽位。
- `EditorView.theme(spec, { dark: true })` 第二参数**必须传**（漏传则 CM 按 light 主题出白底）。
- CM 相关类名以 `node_modules/@codemirror/merge/dist/index.js` 源码为准，不猜。
- Rust 子进程只走 `git_run`（内含 `CREATE_NO_WINDOW` + GIT_LOCK + 15s 超时），禁止另起裸 `Command`；新命令为 async + `git_run_blocking`；async 命令不埋 `trace_command`。
- 禁止原生 UI（`alert`/`confirm`/`title`）；操作回执用 `useToast` + `<AToast>`；hover 提示用 `v-tooltip`。
- **提交纪律**：每个任务的 `git add` 只加本任务列出的文件。工作区里有一份**不属于本计划**的 `src-tauri/Cargo.toml` 修改（tracing 止血），严禁带入任何提交。
- 提交信息结尾统一加 `Co-Authored-By: Claude <noreply@anthropic.com>`。
- 验证命令：Rust = `cargo test --lib`（在 `src-tauri/` 下）；前端 = `pnpm vitest run`；类型 = `pnpm build`（含 `vue-tsc --noEmit`）。

---

### Task 1: Rust `git_diff_pair` 命令（TDD）

**Files:**
- Modify: `src-tauri/src/commands/git.rs`（新增 DiffPair 结构、helpers、命令、测试模块）
- Modify: `src-tauri/src/lib.rs:205`（注册新命令）

**Interfaces:**
- Consumes: `git_run(args: &[&str], root: &Path) -> Result<Output, String>`（git.rs:63）、`git_run_blocking<F, T>(f: F) -> Result<T, String>`（git.rs:117，闭包内捕获 root）、`project_root_for_commands(&WorkspaceState) -> PathBuf`。
- Produces（Task 4 的前端与 lib.rs 依赖）:
  - 命令：`git_diff_pair(path: String, staged: Option<bool>, commit_hash: Option<String>) -> Result<DiffPair, String>`
  - 线格式（serde camelCase）：`{ oldText, newText, oldLabel, newLabel, status: "added"|"modified"|"deleted", isBinary, eolOnly }`

- [ ] **Step 1: 写失败测试**

在 `src-tauri/src/commands/git.rs` 文件末尾追加：

```rust
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
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test --lib diff_pair`
Expected: FAIL（编译错误：`build_diff_pair` 未定义）

- [ ] **Step 3: 实现**

在 `src-tauri/src/commands/git.rs` 中、既有 `git_diff_content` 函数之前插入（`git_diff_content` 本任务**不删**，Task 4 才删）：

```rust
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
fn build_diff_pair(
    root: &std::path::Path,
    path: &str,
    staged: bool,
    commit_hash: Option<&str>,
) -> Result<DiffPair, String> {
    let (old_raw, new_raw, old_label, new_label) = if let Some(h) = commit_hash {
        let short = &h[..7.min(h.len())];
        (
            show_blob(&format!("{}^:{}", h, path), root)?,
            show_blob(&format!("{}:{}", h, path), root)?,
            format!("{}^", short),
            short.to_string(),
        )
    } else if staged {
        (
            show_blob(&format!("HEAD:{}", path), root)?,
            show_blob(&format!(":{}", path), root)?,
            "HEAD".to_string(),
            "已暂存".to_string(),
        )
    } else {
        (
            show_blob(&format!("HEAD:{}", path), root)?,
            std::fs::read(root.join(path)).ok(),
            "HEAD".to_string(),
            "工作区".to_string(),
        )
    };

    let is_binary = old_raw.as_deref().map(looks_binary).unwrap_or(false)
        || new_raw.as_deref().map(looks_binary).unwrap_or(false);

    let old_str = old_raw.map(|b| String::from_utf8_lossy(&b).into_owned());
    let new_str = new_raw.map(|b| String::from_utf8_lossy(&b).into_owned());

    let status = match (&old_str, &new_str) {
        (None, Some(_)) => "added",
        (Some(_), None) => "deleted",
        // 两侧皆空（如未跟踪的空文件）：按磁盘存在性兜底
        (None, None) => {
            if root.join(path).exists() { "added" } else { "deleted" }
        }
        (Some(_), Some(_)) => "modified",
    };

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
```

在 `src-tauri/src/lib.rs` 第 205 行 `commands::git::git_diff_content,` **之后**加一行：

```rust
            commands::git::git_diff_pair,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test --lib diff_pair`
Expected: 6 个测试全 PASS

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/commands/git.rs src-tauri/src/lib.rs
git commit -m "feat(git): git_diff_pair 命令——返回新旧双份原文（行尾归一化 + 状态判定）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 前端基础——DiffPair 类型 + CM 共享抽取 + 依赖入账

**Files:**
- Create: `src/utils/cmLanguage.ts`
- Create: `src/utils/cmHighlight.ts`
- Create: `src/utils/cmLanguage.test.ts`
- Modify: `src/components/CodeEditor.vue`（删本地函数改 import）
- Modify: `src/types.ts`（DiffEntry 附近加 DiffPair）
- Commit 波及: `package.json`、`pnpm-lock.yaml`（`@codemirror/merge@6.12.2` 已装好，此任务入账）

**Interfaces:**
- Consumes: `CodeEditor.vue:44-58`（`createHighlightStyle` 现状）、`CodeEditor.vue:62-117`（`loadLanguageExtension` 现状）、`CodeEditor.vue:39-42`（`ext` computed）。
- Produces（Task 3/4 依赖）:
  - `loadLanguageExtension(ext: string): Promise<Extension>`（`src/utils/cmLanguage.ts`；未知扩展名返回 `[]`）
  - `createHighlightStyle(t: ThemeTokens): HighlightStyle`（`src/utils/cmHighlight.ts`）
  - `DiffPair` TS 接口（`src/types.ts`）：`{ oldText: string; newText: string; oldLabel: string; newLabel: string; status: "added" | "modified" | "deleted"; isBinary: boolean; eolOnly: boolean }`

- [ ] **Step 1: 写失败测试**

Create `src/utils/cmLanguage.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { loadLanguageExtension } from "./cmLanguage";

describe("loadLanguageExtension", () => {
  it("已知扩展名返回语言扩展（非空数组）", async () => {
    expect(await loadLanguageExtension("rs")).not.toEqual([]);
    expect(await loadLanguageExtension("ts")).not.toEqual([]);
    expect(await loadLanguageExtension("vue")).not.toEqual([]);
  });

  it("未知扩展名返回空数组", async () => {
    expect(await loadLanguageExtension("zztop")).toEqual([]);
    expect(await loadLanguageExtension("")).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/utils/cmLanguage.test.ts`
Expected: FAIL（`./cmLanguage` 模块不存在）

- [ ] **Step 3: 创建两个共享 util**

Create `src/utils/cmLanguage.ts`（从 `CodeEditor.vue:62-117` 搬出，`ext` 改为参数）：

```ts
import type { Extension } from "@codemirror/state";

/**
 * 按文件扩展名动态加载 CodeMirror 语言包（CodeEditor 与 DiffViewer 共用）。
 * 未知扩展名 / 加载失败 → 空数组（无语法高亮，不报错）。
 */
export async function loadLanguageExtension(e: string): Promise<Extension> {
  try {
    switch (e) {
      case "ts":
      case "tsx":
      case "js":
      case "jsx": {
        const { javascript } = await import("@codemirror/lang-javascript");
        const isTs = e === "ts" || e === "tsx";
        const isJsx = e === "tsx" || e === "jsx";
        return javascript({ typescript: isTs, jsx: isJsx });
      }
      case "rs": {
        const { rust } = await import("@codemirror/lang-rust");
        return rust();
      }
      case "java": {
        const { java } = await import("@codemirror/lang-java");
        return java();
      }
      case "py": {
        const { python } = await import("@codemirror/lang-python");
        return python();
      }
      case "json": {
        const { json } = await import("@codemirror/lang-json");
        return json();
      }
      case "md":
      case "mdx": {
        const { markdown } = await import("@codemirror/lang-markdown");
        return markdown();
      }
      case "html":
      case "htm": {
        const { html } = await import("@codemirror/lang-html");
        return html();
      }
      case "css":
      case "scss":
      case "less": {
        const { css } = await import("@codemirror/lang-css");
        return css();
      }
      case "vue": {
        const { vue } = await import("@codemirror/lang-vue");
        return vue();
      }
      default:
        return [];
    }
  } catch {
    return [];
  }
}
```

Create `src/utils/cmHighlight.ts`（从 `CodeEditor.vue:44-58` 原样搬出）：

```ts
import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { ThemeTokens } from "../themes/tokens";

/** 语法高亮从主题 token 派生（CLAUDE.md 铁律：不用 oneDark）。 */
export function createHighlightStyle(t: ThemeTokens): HighlightStyle {
  return HighlightStyle.define([
    { tag: tags.keyword, color: t.syntaxKeyword },
    { tag: [tags.typeName, tags.definition(tags.typeName)], color: t.syntaxKeyword },
    { tag: tags.string, color: t.success },
    { tag: tags.number, color: t.syntaxNumber },
    { tag: [tags.variableName, tags.literal, tags.bool, tags.null], color: t.syntaxNumber },
    { tag: tags.comment, color: t.textMuted, fontStyle: "italic" },
    { tag: [tags.function(tags.variableName), tags.labelName], color: t.accent },
    { tag: [tags.propertyName, tags.attributeName], color: t.info },
    { tag: [tags.className, tags.definition(tags.className)], color: t.warning },
    { tag: tags.invalid, color: t.danger },
    { tag: [tags.bracket, tags.separator], color: t.textSecondary },
  ]);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/utils/cmLanguage.test.ts`
Expected: 2 个测试 PASS

- [ ] **Step 5: CodeEditor 改用共享 util + types.ts 加 DiffPair**

`src/components/CodeEditor.vue`：
1. 删除 `createHighlightStyle` 函数（44-58 行）与 `loadLanguageExtension` 函数（62-117 行）。
2. import 区（7-8 行附近）：`HighlightStyle` 和 `tags` 的 import 若不再有其他用途则删除；新增：

```ts
import { createHighlightStyle } from "../utils/cmHighlight";
import { loadLanguageExtension } from "../utils/cmLanguage";
```

3. `createEditor()` 里的调用 `await loadLanguageExtension()` 改为 `await loadLanguageExtension(ext.value)`（`ext` computed 保留在组件内）。
4. `syntaxHighlighting` 的 import 保留（组件内仍用）。

`src/types.ts`：在 `DiffEntry` 接口（39 行）之后插入：

```ts
/** git_diff_pair 返回的新旧双份原文（serde camelCase 镜像） */
export interface DiffPair {
  oldText: string;
  newText: string;
  oldLabel: string;
  newLabel: string;
  status: "added" | "modified" | "deleted";
  isBinary: boolean;
  eolOnly: boolean;
}
```

- [ ] **Step 6: 全量前端验证**

Run: `pnpm build && pnpm vitest run`
Expected: vue-tsc 无错误；全部测试 PASS（含既有 `useFileViewer.test.ts` 等）

- [ ] **Step 7: 提交**

```bash
git add src/utils/cmLanguage.ts src/utils/cmHighlight.ts src/utils/cmLanguage.test.ts src/components/CodeEditor.vue src/types.ts package.json pnpm-lock.yaml
git commit -m "feat(diff-viewer): DiffPair 类型 + CM 语言/高亮抽取共享 + @codemirror/merge 依赖

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: DiffViewer 组件

**Files:**
- Create: `src/components/fileviewer/DiffViewer.vue`

**Interfaces:**
- Consumes: `DiffPair`（Task 2）、`loadLanguageExtension` / `createHighlightStyle`（Task 2）、`useSettings().settings.theme`、`themes`（`src/themes/index.ts`）、`@codemirror/merge` 的 `MergeView` / `unifiedMergeView` / `goToNextChunk` / `goToPreviousChunk`。
- Produces（Task 4 依赖）: 默认导出组件 `DiffViewer`，props `{ pair: DiffPair; filePath: string }`。

- [ ] **Step 1: 创建组件**

Create `src/components/fileviewer/DiffViewer.vue`：

```vue
<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { EditorView, lineNumbers } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { syntaxHighlighting } from "@codemirror/language";
import {
  MergeView,
  unifiedMergeView,
  goToNextChunk,
  goToPreviousChunk,
} from "@codemirror/merge";
import type { Extension } from "@codemirror/state";
import type { DiffPair } from "../../types";
import { loadLanguageExtension } from "../../utils/cmLanguage";
import { createHighlightStyle } from "../../utils/cmHighlight";
import { useSettings } from "../../composables/useSettings";
import { themes } from "../../themes";

/**
 * 编辑器级 diff 查看器（@codemirror/merge）。纯查看：
 * 并排（MergeView，默认）/ 单栏（unifiedMergeView）可切，两侧只读。
 * 特例（行尾-only / 二进制 / 超大）不挂 merge 视图，只显示提示。
 */
const props = defineProps<{
  pair: DiffPair;
  filePath: string;
}>();

const { settings } = useSettings();

const mode = ref<"split" | "unified">("split");
const mountEl = ref<HTMLElement | null>(null);

let mergeView: MergeView | null = null;
let unifiedView: EditorView | null = null;
let createId = 0;

/** 对齐 useFileViewer 的 MAX_EDITABLE_SIZE：防 diff 计算卡窗 */
const MAX_DIFF_SIZE = 1_000_000;

const tooBig = computed(
  () =>
    props.pair.oldText.length > MAX_DIFF_SIZE ||
    props.pair.newText.length > MAX_DIFF_SIZE,
);
const showNotice = computed(
  () => props.pair.eolOnly || props.pair.isBinary || tooBig.value,
);
const noticeText = computed(() => {
  if (props.pair.eolOnly) return `内容与 ${props.pair.oldLabel} 无差异（仅行尾不同）`;
  if (props.pair.isBinary) return "二进制文件无法对比";
  return "文件过大（超过 1MB），无法渲染对比视图";
});

const STATUS_LABELS: Record<string, string> = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
};
const statusLabel = computed(() => STATUS_LABELS[props.pair.status] || props.pair.status);

const ext = computed(() => {
  const parts = props.filePath.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : "";
});

const themeCompartment = new Compartment();

function currentTokens() {
  return themes[settings.theme] || themes["warm-dark"];
}

// ── merge 主题（只写编辑器内部选择器，& = 编辑器根）──
// 类名读 node_modules/@codemirror/merge/dist/index.js 源码确认：
//   变更行 .cm-changedLine；行内变更段 .cm-changedText；
//   unified：新增行 .cm-insertedLine(<ins>)、删除行 .cm-deletedLine(<del>)、
//   删除块 widget .cm-deletedChunk、行内变更行 .cm-inlineChangedLine；
//   折叠条 .cm-collapsedLines；gutter 标记 .cm-changedLineGutter / .cm-deletedLineGutter；
//   编辑器根 a 侧带 .cm-merge-a、b 侧带 .cm-merge-b（源码 baseTheme 用
//   "&.cm-merge-a .cm-changedLine" 同款选择器，根元素带侧类名可确认）。
// 外层容器 .cm-mergeView 是编辑器根的祖先，这里够不到，由下方非 scoped 样式负责。
// { dark: true } 必传：让包自带 &dark 默认值生效，再由 --aide-* 精修。
const mergeTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--aide-bg-deep)",
      color: "var(--aide-text-primary)",
      fontSize: "var(--cm-font-size)",
      fontFamily: "var(--cm-font-family)",
      height: "100%",
    },
    ".cm-scroller": { overflow: "auto" },
    ".cm-gutters": {
      backgroundColor: "var(--aide-bg-deep)",
      color: "var(--aide-text-muted)",
      borderRight: "1px solid var(--aide-surface-hover)",
    },
    // 旧侧（a / 删除）= danger，新侧（b / 新增）= success
    "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": {
      backgroundColor: "color-mix(in srgb, var(--aide-danger) 8%, transparent)",
    },
    "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine": {
      backgroundColor: "color-mix(in srgb, var(--aide-success) 8%, transparent)",
    },
    ".cm-changedText": {
      backgroundColor: "color-mix(in srgb, var(--aide-warning) 22%, transparent)",
    },
    ".cm-insertedLine, .cm-deletedLine, .cm-deletedLine del": {
      textDecoration: "none",
    },
    "&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter": {
      backgroundColor: "var(--aide-danger)",
    },
    "&.cm-merge-b .cm-changedLineGutter": {
      backgroundColor: "var(--aide-success)",
    },
    ".cm-collapsedLines": {
      color: "var(--aide-text-muted)",
      background: "var(--aide-bg-base)",
    },
  },
  { dark: true },
);

function readOnlyExts(langExt: Extension): Extension[] {
  return [
    lineNumbers(),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    langExt,
    themeCompartment.of(syntaxHighlighting(createHighlightStyle(currentTokens()))),
    mergeTheme,
  ];
}

async function createView() {
  if (!mountEl.value) return;
  const id = ++createId;
  destroyView();

  const langExt = await loadLanguageExtension(ext.value);
  if (id !== createId) return; // 等待期间已被重建/销毁

  if (mode.value === "split") {
    mergeView = new MergeView({
      a: { doc: props.pair.oldText, extensions: readOnlyExts(langExt) },
      b: { doc: props.pair.newText, extensions: readOnlyExts(langExt) },
      parent: mountEl.value,
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 4 },
    });
  } else {
    unifiedView = new EditorView({
      doc: props.pair.newText,
      extensions: [
        ...readOnlyExts(langExt),
        unifiedMergeView({
          original: props.pair.oldText,
          highlightChanges: true,
          gutter: true,
          // 默认 true 会显示 accept/reject 按钮——纯查看必须关
          mergeControls: false,
          collapseUnchanged: { margin: 3, minSize: 4 },
        }),
      ],
      parent: mountEl.value,
    });
  }
}

function destroyView() {
  mergeView?.destroy();
  mergeView = null;
  unifiedView?.destroy();
  unifiedView = null;
}

/** hunk 跳转：split 模式作用于 b（新）侧编辑器；StateCommand 直接吃 EditorView */
function gotoChunk(next: boolean) {
  const view = mode.value === "split" ? mergeView?.b : unifiedView;
  if (!view) return;
  (next ? goToNextChunk : goToPreviousChunk)(view);
  view.focus();
}

function toggleMode() {
  mode.value = mode.value === "split" ? "unified" : "split";
  void createView();
}

// 主题切换：只重配语法高亮 compartment，不重建视图（同 CodeEditor 模式）
watch(
  () => settings.theme,
  () => {
    const effect = themeCompartment.reconfigure(
      syntaxHighlighting(createHighlightStyle(currentTokens())),
    );
    mergeView?.a.dispatch({ effects: effect });
    mergeView?.b.dispatch({ effects: effect });
    unifiedView?.dispatch({ effects: effect });
  },
);

// 同路径重开 → pair 被就地替换 → 重建视图
watch(
  () => props.pair,
  () => void createView(),
);

onMounted(() => void createView());
onBeforeUnmount(() => {
  createId++;
  destroyView();
});
</script>

<template>
  <div class="dv-root">
    <div class="dv-toolbar">
      <span class="dv-badge" :class="`dv-badge--${pair.status}`">{{ statusLabel }}</span>
      <span class="dv-labels" v-tooltip="filePath">{{ pair.oldLabel }} → {{ pair.newLabel }}</span>
      <div class="dv-spacer"></div>
      <template v-if="!showNotice">
        <button class="dv-btn" v-tooltip="'上一处变更'" @click="gotoChunk(false)">↑</button>
        <button class="dv-btn" v-tooltip="'下一处变更'" @click="gotoChunk(true)">↓</button>
        <button class="dv-btn" @click="toggleMode">{{ mode === "split" ? "单栏" : "并排" }}</button>
      </template>
    </div>
    <div v-if="showNotice" class="dv-notice">{{ noticeText }}</div>
    <div v-else ref="mountEl" class="dv-mount"></div>
  </div>
</template>

<style scoped>
.dv-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--aide-bg-deep);
}
.dv-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--aide-border);
  flex-shrink: 0;
}
.dv-badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: var(--aide-radius-sm);
}
.dv-badge--added {
  color: var(--aide-success);
  background: color-mix(in srgb, var(--aide-success) 12%, transparent);
}
.dv-badge--modified {
  color: var(--aide-info);
  background: color-mix(in srgb, var(--aide-info) 12%, transparent);
}
.dv-badge--deleted {
  color: var(--aide-danger);
  background: color-mix(in srgb, var(--aide-danger) 12%, transparent);
}
.dv-labels {
  font-size: 12px;
  color: var(--aide-text-muted);
}
.dv-spacer {
  flex: 1;
}
.dv-btn {
  font-size: 12px;
  padding: 2px 8px;
  border: 1px solid var(--aide-surface-hover);
  border-radius: var(--aide-radius-sm);
  color: var(--aide-text-secondary);
  background: transparent;
  cursor: pointer;
}
.dv-btn:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
.dv-notice {
  padding: 24px;
  text-align: center;
  color: var(--aide-text-muted);
  font-size: 13px;
}
.dv-mount {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>

<!-- merge 容器（.cm-mergeView 等）是编辑器根的祖先，CM 主题块和 scoped 样式都够不到，
     必须非 scoped（同 xterm 动态 DOM 的既有约定）。包文档明确要求给
     .cm-mergeView 设 height + overflow 才可滚动。 -->
<style>
.dv-mount .cm-mergeView,
.dv-mount .cm-mergeViewEditors {
  height: 100%;
}
.dv-mount .cm-mergeViewEditor {
  height: 100%;
}
</style>
```

- [ ] **Step 2: 类型检查**

Run: `pnpm build`
Expected: vue-tsc 无错误（组件尚未接线，仅验证自身编译）

- [ ] **Step 3: 提交**

```bash
git add src/components/fileviewer/DiffViewer.vue
git commit -m "feat(diff-viewer): DiffViewer 组件——并排/unified 编辑器级对比视图

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 接线 + 旧链路清理

**Files:**
- Modify: `src/composables/useFileViewer.ts`（`FileWindowState` 加 `diffPair`；`open` 支持 `{ diffPair }`）
- Modify: `src/components/fileviewer/FileWindow.vue`（模板换 DiffViewer；删 `diffHighlighted`/`escapeHtml`/`isDiff`/`.viewer-diff` 样式）
- Modify: `src/components/GitPanel.vue`（`openDiffInViewer` 改调 `git_diff_pair`；失败 AToast）
- Modify: `src/composables/useGit.ts`（删死代码 `viewingDiff`/`viewDiff`/`closeDiff` 及导出）
- Modify: `src-tauri/src/commands/git.rs`（删 `git_diff_content`，552-602 行）
- Modify: `src-tauri/src/lib.rs:205`（删 `git_diff_content` 注册行）
- Modify: `src/styles/global.css`（删 `.aide-diff-*` 五个类，105-109 行）

**Interfaces:**
- Consumes: `git_diff_pair` 命令（Task 1）、`DiffPair`（Task 2）、`DiffViewer` 组件（Task 3）、`useToast`（`src/composables/useToast.ts`：`const { toastState, showToast } = useToast()`，`showToast(text, "danger")`，模板挂 `<AToast :state="toastState" />`，组件在 `src/ui/AToast.vue`）。
- Produces: 无新接口（收尾任务）。

- [ ] **Step 1: useFileViewer 支持 diffPair 窗口**

`src/composables/useFileViewer.ts`：

1. import 区加：`import type { DiffPair } from "../types";`
2. `FileWindowState` 的 `language` 字段后加：

```ts
  /** git diff 对比数据（virtual 窗口专用）；存在则渲染 DiffViewer */
  diffPair: DiffPair | null;
```

3. `open` 签名与去重/新建逻辑改为：

```ts
  async function open(path: string, opts?: { content?: string; language?: string; diffPair?: DiffPair }) {
    const isVirtual = opts?.content !== undefined || opts?.diffPair !== undefined;
    const existing = windows.value.find((w) => w.filePath === path && w.virtual === isVirtual);
    if (existing) {
      if (opts?.diffPair) {
        existing.diffPair = opts.diffPair;
      } else if (isVirtual) {
        existing.content = opts!.content!;
        existing.editContent = opts!.content!;
        existing.language = opts?.language || existing.language;
      }
      focusedId.value = existing.id;
      return;
    }

    const win: FileWindowState = {
      id: crypto.randomUUID(),
      filePath: path,
      fileName: fileNameOf(path),
      content: "",
      editContent: "",
      imageUrl: "",
      language: opts?.language || "",
      diffPair: opts?.diffPair || null,
      error: "",
      saving: false,
      readonly: isVirtual,
      virtual: isVirtual,
      isMarkdown: !isVirtual && isMarkdownPath(path),
      mdMode: "preview",
      scrollToLine: null,
      x: 0,
      y: 0,
      w: 0,
      h: 0,
    };

    if (isVirtual) {
      if (!opts?.diffPair) {
        win.content = opts!.content!;
        win.editContent = win.content;
      }
    } else {
      // …以下磁盘/图片分支保持现状不变…
```

（`else` 分支的图片/读盘逻辑、`detectProjectRoot`、`windows.value.push`、`focusedId` 收尾全部保持现状。）

- [ ] **Step 2: FileWindow 换 DiffViewer**

`src/components/fileviewer/FileWindow.vue`：

1. import 区加：`import DiffViewer from "./DiffViewer.vue";`
2. 删除 `isDiff` computed（42 行）、`diffHighlighted` computed（70-83 行）、`escapeHtml` 函数（85-87 行）。
3. 模板 261 行的旧分支：

```html
<pre v-else-if="win.readonly && isDiff" v-scroll-memory="scrollKey('pre')" class="fw-pre"><code class="viewer-code viewer-diff" v-html="diffHighlighted"></code></pre>
```

替换为：

```html
<DiffViewer v-else-if="win.diffPair" :pair="win.diffPair" :filePath="win.filePath" />
```

4. 删除样式块末尾的 `.viewer-diff` 规则及其注释（876-887 行，`/* ── Diff viewer…` 到 `</style>` 前）。

- [ ] **Step 3: GitPanel 改调 git_diff_pair + 失败 Toast**

`src/components/GitPanel.vue`：

1. `openDiffInViewer`（137-147 行）整体替换为：

```ts
async function openDiffInViewer(relPath: string, staged?: boolean, commitHash?: string) {
  try {
    const params: Record<string, unknown> = { path: relPath };
    if (staged !== undefined) params.staged = staged;
    if (commitHash) params.commitHash = commitHash;
    const pair = await invoke<DiffPair>("git_diff_pair", params);
    fileViewer.open(relPath, { diffPair: pair });
  } catch (e) {
    showToast(`加载 diff 失败：${typeof e === "string" ? e : (e as Error).message || e}`, "danger");
  }
}
```

2. script 区新增（既有 import 附近）：

```ts
import { useToast } from "../composables/useToast";
import AToast from "../ui/AToast.vue";
import type { DiffPair } from "../types";
```

并在 setup 顶层加：`const { toastState, showToast } = useToast();`

3. 模板根容器（`position: relative` 的面板根元素）末尾加：`<AToast :state="toastState" />`

- [ ] **Step 4: 删 useGit 死代码**

`src/composables/useGit.ts` 删除：
- 17 行 `const viewingDiff = ref<...>(null);`
- 115-123 行 `viewDiff` 函数、125-127 行 `closeDiff` 函数
- return 块里的 `viewingDiff,`（235 行）与 `viewDiff,`（243 行）两个导出

（已 grep 确认全仓库除该文件自身外无任何引用。）

- [ ] **Step 5: 删 Rust 旧命令 + 注册 + 旧 CSS**

1. `src-tauri/src/commands/git.rs`：删除整个 `git_diff_content` 函数（含其上 `#[tauri::command]` 属性，552-602 行）。
2. `src-tauri/src/lib.rs`：删除 205 行 `commands::git::git_diff_content,`。
3. `src/styles/global.css`：删除 `.aide-diff-add` / `.aide-diff-del` / `.aide-diff-hunk` / `.aide-diff-meta` / `.aide-diff-ctx` 五条规则（105-109 行）。

- [ ] **Step 6: 全量验证**

Run: `pnpm build && pnpm vitest run && cd src-tauri && cargo test --lib`
Expected: 全绿（注意 `useFileViewer.test.ts` 等既有测试若构造 `FileWindowState` 字面量缺 `diffPair` 字段会被 vue-tsc/tsc 报出，按 Step 1 的字段定义补 `diffPair: null`）

- [ ] **Step 7: 提交**

```bash
git add src/composables/useFileViewer.ts src/components/fileviewer/FileWindow.vue src/components/GitPanel.vue src/composables/useGit.ts src-tauri/src/commands/git.rs src-tauri/src/lib.rs src/styles/global.css
git commit -m "refactor(diff-viewer): 接线 DiffViewer 并清除旧 diff 链路（git_diff_content/死代码/旧样式）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: 全量验证（真应用手测）

**Files:** 无改动（验证任务）

- [ ] **Step 1: 自动化全绿**

Run: `pnpm build && pnpm vitest run && cd src-tauri && cargo test --lib`
Expected: 全 PASS

- [ ] **Step 2: 真应用手测**

用 `verify` skill 启动 `pnpm tauri dev`，按 spec §7 清单逐项过：

1. 修改已跟踪文件 → Git 面板点开 diff：并排对照、行号、语法高亮、词级高亮、未变更区折叠条出现
2. 暂存同一文件 → 从「已暂存」区打开：显示 HEAD vs 已暂存
3. 新建未跟踪文件 → 打开：左空右全绿，徽章「新增」
4. 删除已跟踪文件 → 打开：左全红右空，徽章「删除」
5. 提交历史展开某提交点文件：对照 `<hash>^` vs `<hash>`
6. **行尾-only 文件（把某文件行尾 LF↔CRLF 翻转后打开 diff）→ 显示「仅行尾不同」提示，绝不出现假新文件**
7. 工具条切「单栏」再切回「并排」
8. ↑/↓ 按钮在 hunk 间跳转
9. 设置里切 warm-dark ↔ catppuccin：diff 视图整面重配色，无白底/硬编码残留
10. 断开 git 仓库的目录（或非仓库工作区）点开 diff → AToast 报错，不开窗口

任何一项失败 → 回到对应任务修复后重测。

---

## Self-Review 记录

- **Spec 覆盖**：spec §3.1→Task 1；§3.2/§5（清理）→Task 4 Step 4/5；§3.3（接入）→Task 4 Step 1/2/3；§4（组件）→Task 3；§4.2（抽取）→Task 2；§4.3（主题）→Task 3 主题块注释 + Task 5 手测 9；§6（不做）→无对应任务（正确）；§7（测试）→Task 1/2 自动测试 + Task 5 手测。无缺口。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。FileWindow.vue 的 `else` 磁盘分支以「保持现状」描述（该分支不属于改动面，全文复述反而引入漂移风险）。
- **类型一致性**：`DiffPair`（Rust camelCase ↔ TS 接口）一致；`loadLanguageExtension(ext: string)` 签名在 Task 2 定义、Task 3 调用一致；`createHighlightStyle` 一致；`DiffViewer` props `{ pair, filePath }` 在 Task 3 定义、Task 4 使用一致；`open(path, { diffPair })` 在 Task 4 定义/使用一致。
