# 代码编辑器升级 & 跳转到定义 — 实施计划

> **供 Agent 执行者使用：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实施。步骤使用 `- [ ]` 勾选语法追踪。

**目标：** 将 FileViewer 编辑模式从 textarea 升级为 CodeMirror 6 代码编辑器，并通过内嵌 grep 引擎实现 Ctrl+点击跳转到定义。

**架构：** 新建 `CodeEditor.vue`（CodeMirror 6 的 Vue 3 封装）和 `useGotoDefinition.ts`（跳转逻辑），在 Rust 侧新增 `grep_symbol` 命令（`ignore` + `regex` crate 实现），FileViewer 接入新组件。

**技术栈：** Vue 3 + TypeScript + CodeMirror 6 + Rust (ignore + regex crates) + Tauri v2

## 全局约束

- 不依赖外部二进制（不使用 ripgrep CLI），搜索能力编译进 Aide 二进制
- 语言包按文件扩展名懒加载，不预载所有语言
- CodeMirror 主题需适配 Catppuccin 暗色调色板（变量：`--bg-primary`, `--text-primary` 等）
- 所有 `Command::new(...)` 调用必须加 `#[cfg(windows)] CREATE_NO_WINDOW` 标志（本计划涉及的 Rust 命令不 spawn 外部进程，无需）
- 不破坏现有 FileViewer 行为：预览模式、Markdown 渲染、Esc 关闭均保持不变

---

### 任务 1：后端 — Rust 依赖

**文件：**
- 修改：`src-tauri/Cargo.toml`

**产出：** `ignore` 和 `regex` crate 可供编译使用

- [ ] **步骤 1：在 Cargo.toml 添加依赖**

```toml
# 在 [dependencies] 段落末尾追加
ignore = "0.4"
regex = "1"
```

- [ ] **步骤 2：验证编译通过**

```bash
cd src-tauri && cargo check
```

预期：`Finished` 无错误（会有编译新 crate 的输出）

- [ ] **步骤 3：提交**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: add ignore + regex crates for grep_symbol backend"
```

---

### 任务 2：后端 — grep_symbol 命令

**文件：**
- 修改：`src-tauri/src/commands/filesystem.rs`（末尾追加）
- 修改：`src-tauri/src/commands/mod.rs`（追加 GrepMatch 类型）
- 修改：`src-tauri/src/lib.rs`（注册命令）

**接口：**
- 消费：`WorkspaceState`（已有）、`project_root_for_commands`（已有）、`ignore` + `regex` crate
- 产出：`pub fn grep_symbol(word: String, cwd: String) -> Result<Vec<GrepMatch>, String>`

- [ ] **步骤 1：在 mod.rs 末尾追加 GrepMatch 类型**

```rust
// 追加到文件末尾，#[derive] 块放在 use 语句之后、最后一个类型定义之后
#[derive(Debug, Serialize, Clone)]
pub struct GrepMatch {
    pub file: String,
    pub line: u32,
    pub content: String,
    pub match_type: String,
}
```

- [ ] **步骤 2：在 filesystem.rs 末尾追加 grep_symbol 命令**

```rust
// ── 追加到文件末尾 ──

use regex::Regex;
use ignore::WalkBuilder;

#[derive(Debug, Serialize, Clone)]
struct GrepMatch {
    file: String,
    line: u32,
    content: String,
    match_type: String,
}

#[tauri::command]
pub fn grep_symbol(word: String, cwd: String) -> Result<Vec<GrepMatch>, String> {
    if word.trim().is_empty() {
        return Ok(Vec::new());
    }

    let escaped = regex::escape(word.trim());
    let patterns: Vec<(&str, &str)> = vec![
        (&*format!(r"^(pub\s+)?(async\s+)?fn\s+{}", escaped), "fn"),
        (&*format!(r"^(export\s+)?(async\s+)?function\s+{}", escaped), "function"),
        (&*format!(r"^(export\s+)?class\s+{}", escaped), "class"),
        (&*format!(r"^def\s+{}", escaped), "def"),
        (&*format!(r"^(export\s+)?const\s+{}", escaped), "const"),
    ];

    // Compile regexes once
    let compiled: Vec<(Regex, &str)> = patterns
        .iter()
        .filter_map(|(pat, mtype)| {
            Regex::new(pat).ok().map(|re| (re, *mtype))
        })
        .collect();

    // Fallback: any line containing the word
    let fallback = match Regex::new(&escaped) {
        Ok(re) => re,
        Err(_) => return Ok(Vec::new()),
    };

    let mut results: Vec<GrepMatch> = Vec::new();

    let walker = WalkBuilder::new(&cwd)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .max_depth(Some(20))
        .build();

    for entry in walker {
        let Ok(entry) = entry else { continue };
        let path = entry.path();

        // Skip directories, hidden files, and huge files
        if !path.is_file() {
            continue;
        }
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.starts_with('.') {
                continue;
            }
        }
        // Skip binary-ish extensions
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            let skip = matches!(
                ext,
                "png" | "jpg" | "jpeg" | "gif" | "ico" | "svg"
                    | "woff" | "woff2" | "ttf" | "eot"
                    | "mp3" | "mp4" | "wav" | "ogg"
                    | "zip" | "tar" | "gz" | "rar" | "7z"
                    | "exe" | "dll" | "so" | "dylib"
                    | "wasm" | "bin" | "dat"
            );
            if skip {
                continue;
            }
        }

        let Ok(content) = std::fs::read_to_string(path) else {
            continue;
        };

        if content.len() > 1_000_000 {
            continue; // skip files > 1MB
        }

        let rel_path = path
            .strip_prefix(&cwd)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");

        // Try definition patterns first
        for (re, mtype) in &compiled {
            for (line_num, line_content) in content.lines().enumerate() {
                if re.is_match(line_content) {
                    results.push(GrepMatch {
                        file: rel_path.clone(),
                        line: (line_num + 1) as u32,
                        content: line_content.trim().to_string(),
                        match_type: mtype.to_string(),
                    });
                    if results.len() >= 50 {
                        break;
                    }
                }
            }
            if results.len() >= 50 {
                break;
            }
        }

        // Fallback: general reference search (only if few definition results)
        if results.len() < 5 {
            for (line_num, line_content) in content.lines().enumerate() {
                if fallback.is_match(line_content) {
                    // Skip if already matched as a definition
                    let already = results.iter().any(|r| {
                        r.file == rel_path && r.line == (line_num + 1) as u32
                    });
                    if !already {
                        results.push(GrepMatch {
                            file: rel_path.clone(),
                            line: (line_num + 1) as u32,
                            content: line_content.trim().to_string(),
                            match_type: "reference".to_string(),
                        });
                        if results.len() >= 50 {
                            break;
                        }
                    }
                }
            }
        }

        if results.len() >= 50 {
            break;
        }
    }

    // Sort: definitions before references
    results.sort_by(|a, b| {
        let a_def = a.match_type != "reference";
        let b_def = b.match_type != "reference";
        b_def.cmp(&a_def)
            .then_with(|| a.file.cmp(&b.file))
            .then_with(|| a.line.cmp(&b.line))
    });

    Ok(results)
}
```

- [ ] **步骤 3：在 mod.rs 中导出 GrepMatch**

在 `mod.rs` 的 `use` 语句区域（use 语句之后、类型定义区域末尾），确保 `GrepMatch` 通过 `filesystem` 模块可使用。由于 `GrepMatch` 在 `commands/mod.rs` 中已通过 `pub use workspace::...` 模式对外暴露，我们在 `filesystem.rs` 内部定义了它（与 `FileEntry` 在 mod.rs 中定义的模式不同）。为保持一致性，将 `GrepMatch` 移到 `mod.rs` 的共享类型区域：

在 `mod.rs` 的 `DiffEntry` 定义之后追加：

```rust
#[derive(Debug, Serialize, Clone)]
pub struct GrepMatch {
    pub file: String,
    pub line: u32,
    pub content: String,
    pub match_type: String,
}
```

然后从 `filesystem.rs` 中删除 `GrepMatch` 的 struct 定义块（保留 `use` 对类型的引用，改用 `super::GrepMatch`）。

在 `filesystem.rs` 的 `grep_symbol` 函数中，所有 `GrepMatch { ... }` 改为 `super::GrepMatch { ... }`。

- [ ] **步骤 4：在 lib.rs 注册命令**

在 `lib.rs` 的 `invoke_handler` 数组中，`commands::filesystem::create_dir` 之后追加：

```rust
commands::filesystem::grep_symbol,
```

- [ ] **步骤 5：验证编译通过**

```bash
cd src-tauri && cargo check
```

预期：`Finished` 无错误

- [ ] **步骤 6：提交**

```bash
git add src-tauri/src/commands/filesystem.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat: add grep_symbol command for go-to-definition search"
```

---

### 任务 3：前端 — npm 依赖

**文件：**
- 修改：`package.json`

**产出：** CodeMirror 6 全家桶可 import

- [ ] **步骤 1：安装依赖**

```bash
cd C:/Users/<user>/IdeaProjects/aide && pnpm add codemirror @codemirror/lang-javascript @codemirror/lang-rust @codemirror/lang-java @codemirror/lang-python @codemirror/lang-json @codemirror/lang-markdown @codemirror/lang-html @codemirror/lang-css @codemirror/lang-vue @codemirror/search @codemirror/matchbrackets @codemirror/theme-one-dark
```

- [ ] **步骤 2：验证安装**

```bash
cd C:/Users/<user>/IdeaProjects/aide && node -e "require('codemirror'); console.log('OK')"
```

预期：`OK`

- [ ] **步骤 3：提交**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add CodeMirror 6 dependencies"
```

---

### 任务 4：前端 — grepSymbol API 封装

**文件：**
- 修改：`src/api.ts`

**接口：**
- 消费：现有 `invoke` 封装模式
- 产出：`api.grepSymbol(word: string, cwd: string): Promise<GrepMatch[]>`

- [ ] **步骤 1：在 types.ts 追加类型**

```typescript
// 追加到 types.ts 末尾
export interface GrepMatch {
  file: string;
  line: number;
  content: string;
  match_type: string;
}
```

- [ ] **步骤 2：在 api.ts 追加 API 方法**

在 `api` 对象的 `// Git` 区域上方（或文件相关区域末尾）追加：

```typescript
// 符号搜索（跳转到定义）
grepSymbol(word: string, cwd: string): Promise<GrepMatch[]> {
  return invoke("grep_symbol", { word, cwd });
},
```

- [ ] **步骤 3：验证 TypeScript 编译**

```bash
cd C:/Users/<user>/IdeaProjects/aide && npx vue-tsc --noEmit
```

预期：无新增类型错误

- [ ] **步骤 4：提交**

```bash
git add src/api.ts src/types.ts
git commit -m "feat: add grepSymbol API + GrepMatch type"
```

---

### 任务 5：CodeEditor.vue — CodeMirror 6 的 Vue 3 封装

**文件：**
- 新建：`src/components/CodeEditor.vue`

**接口：**
- Props: `filePath: string`, `modelValue: string`, `placeholder?: string`
- Emits: `update:modelValue`, `goto-definition: { word: string; filePath: string }`
- 对外暴露：`scrollToLine(line: number)` 方法

- [ ] **步骤 1：创建组件文件**

写入 `src/components/CodeEditor.vue`：

```vue
<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from "vue";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { searchKeymap } from "@codemirror/search";
import { bracketMatching } from "@codemirror/matchbrackets";
import { oneDark } from "@codemirror/theme-one-dark";

const props = defineProps<{
  filePath: string;
  modelValue: string;
  placeholder?: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
  (e: "goto-definition", payload: { word: string; filePath: string }): void;
}>();

const mountEl = ref<HTMLDivElement | null>(null);
let view: EditorView | null = null;

// ── Language detection ──
const ext = computed(() => {
  const parts = props.filePath.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : "";
});

async function loadLanguageExtension() {
  const e = ext.value;
  try {
    switch (e) {
      case "ts":
      case "tsx":
      case "js":
      case "jsx": {
        const { javascript } = await import("@codemirror/lang-javascript");
        return javascript({ typescript: e === "ts" || e === "tsx" });
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

// ── Editor lifecycle ──

async function createEditor() {
  if (!mountEl.value) return;

  // Destroy existing instance
  if (view) {
    view.destroy();
    view = null;
  }

  const langExt = await loadLanguageExtension();

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      const newValue = update.state.doc.toString();
      emit("update:modelValue", newValue);
    }
  });

  view = new EditorView({
    doc: props.modelValue,
    extensions: [
      basicSetup,
      langExt,
      bracketMatching(),
      keymap.of([
        ...searchKeymap,
        { key: "Mod-g", run: openGoToLine },
      ]),
      oneDark,
      updateListener,
      EditorView.domEventHandlers({
        click(event, view) {
          if (event.ctrlKey || event.metaKey) {
            const pos = view.posAtCoords({
              x: event.clientX,
              y: event.clientY,
            });
            if (pos !== null) {
              const wordAt = view.state.wordAt(pos);
              if (wordAt) {
                const word = view.state.doc.sliceString(
                  wordAt.from,
                  wordAt.to
                );
                if (word) {
                  event.preventDefault();
                  emit("goto-definition", {
                    word,
                    filePath: props.filePath,
                  });
                }
              }
            }
          }
        },
      }),
      EditorView.theme({
        "&": {
          height: "100%",
          fontSize: "13px",
          fontFamily:
            '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace',
        },
        ".cm-scroller": {
          overflow: "auto",
        },
        ".cm-gutters": {
          backgroundColor: "var(--bg-tertiary)",
          color: "var(--text-muted)",
          borderRight: "1px solid var(--surface-hover)",
        },
        ".cm-activeLineGutter": {
          backgroundColor: "var(--surface)",
        },
        ".cm-activeLine": {
          backgroundColor: "rgba(255, 255, 255, 0.03)",
        },
        ".cm-selectionBackground": {
          backgroundColor: "var(--surface-hover) !important",
        },
        ".cm-cursor": {
          borderLeftColor: "var(--text-primary)",
        },
        ".cm-searchMatch": {
          backgroundColor: "rgba(249, 226, 175, 0.3)",
        },
        ".cm-searchMatch.cm-searchMatch-selected": {
          backgroundColor: "rgba(249, 226, 175, 0.5)",
        },
        ".cm-matchingBracket": {
          backgroundColor: "rgba(137, 180, 250, 0.15)",
          outline: "1px solid var(--accent)",
        },
        ".cm-nonmatchingBracket": {
          backgroundColor: "rgba(243, 139, 168, 0.15)",
        },
        ".cm-tooltip": {
          backgroundColor: "var(--surface) !important",
          color: "var(--text-primary) !important",
          border: "1px solid var(--surface-hover) !important",
        },
      }),
    ],
    parent: mountEl.value,
  });
}

function openGoToLine(target: EditorView): boolean {
  const line = prompt("跳转到行:");
  if (line !== null && line !== "") {
    const lineNum = parseInt(line, 10);
    if (!isNaN(lineNum) && lineNum > 0) {
      const pos = target.state.doc.line(lineNum);
      target.dispatch({
        selection: { anchor: pos.from, head: pos.from },
        scrollIntoView: true,
      });
      return true;
    }
  }
  return false;
}

// ── External content update (when modelValue changes from parent) ──

watch(
  () => props.modelValue,
  (newVal) => {
    if (view && newVal !== view.state.doc.toString()) {
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: newVal,
        },
      });
    }
  }
);

// ── File extension change → recreate editor with new language ──

watch(
  () => props.filePath,
  () => {
    createEditor();
  }
);

// ── Expose scrollToLine ──

function scrollToLine(line: number) {
  if (!view) return;
  const docLine = view.state.doc.line(Math.min(line, view.state.doc.lines));
  view.dispatch({
    selection: { anchor: docLine.from, head: docLine.from },
    scrollIntoView: true,
  });
  view.focus();
}

defineExpose({ scrollToLine });

onMounted(() => {
  createEditor();
});

onUnmounted(() => {
  if (view) {
    view.destroy();
    view = null;
  }
});
</script>

<template>
  <div ref="mountEl" class="cm-editor-host"></div>
</template>

<style scoped>
.cm-editor-host {
  height: 100%;
  width: 100%;
  overflow: hidden;
}
</style>
```

- [ ] **步骤 2：验证 TypeScript 编译**

```bash
cd C:/Users/<user>/IdeaProjects/aide && npx vue-tsc --noEmit
```

预期：无类型错误

- [ ] **步骤 3：提交**

```bash
git add src/components/CodeEditor.vue
git commit -m "feat: add CodeEditor.vue — CodeMirror 6 Vue 3 wrapper"
```

---

### 任务 6：useGotoDefinition.ts — 跳转到定义逻辑

**文件：**
- 新建：`src/composables/useGotoDefinition.ts`

**接口：**
- 消费：`api.grepSymbol`（任务 4）、`useFileViewer().open()`（已有）、`projectRoot`（通过参数传入）
- 产出：`search(word, projectRoot)` 异步函数、`results`、`visible`、`selectedIndex` 响应式状态、`dismiss()` / `select(idx)` 操作方法

- [ ] **步骤 1：创建 composable**

写入 `src/composables/useGotoDefinition.ts`：

```typescript
import { ref, readonly } from "vue";
import { api } from "../api";
import type { GrepMatch } from "../types";

// Module-level singleton
const visible = ref(false);
const results = ref<GrepMatch[]>([]);
const selectedIndex = ref(0);
const searchWord = ref("");
const currentFilePath = ref("");
const targetProjectRoot = ref("");

// Cache: store last project root for jump-back navigation
let lastProjectRoot = "";

export function useGotoDefinition() {
  async function search(word: string, projectRoot: string) {
    if (!word || !projectRoot) return;

    searchWord.value = word;
    targetProjectRoot.value = projectRoot;
    lastProjectRoot = projectRoot;
    results.value = [];
    selectedIndex.value = 0;
    visible.value = true;

    try {
      const matches = await api.grepSymbol(word, projectRoot);
      results.value = matches.slice(0, 20); // cap display at 20
    } catch {
      results.value = [];
    }
  }

  function dismiss() {
    visible.value = false;
    results.value = [];
    selectedIndex.value = 0;
  }

  function selectPrev() {
    if (results.value.length === 0) return;
    selectedIndex.value =
      (selectedIndex.value - 1 + results.value.length) % results.value.length;
  }

  function selectNext() {
    if (results.value.length === 0) return;
    selectedIndex.value =
      (selectedIndex.value + 1) % results.value.length;
  }

  function getSelected(): GrepMatch | null {
    if (results.value.length === 0) return null;
    return results.value[selectedIndex.value] ?? null;
  }

  return {
    visible: readonly(visible),
    results: readonly(results),
    selectedIndex: readonly(selectedIndex),
    searchWord: readonly(searchWord),
    search,
    dismiss,
    selectPrev,
    selectNext,
    getSelected,
    getProjectRoot: () => lastProjectRoot,
  };
}
```

- [ ] **步骤 2：验证 TypeScript 编译**

```bash
cd C:/Users/<user>/IdeaProjects/aide && npx vue-tsc --noEmit
```

预期：无类型错误

- [ ] **步骤 3：提交**

```bash
git add src/composables/useGotoDefinition.ts
git commit -m "feat: add useGotoDefinition composable"
```

---

### 任务 7：集成 — FileViewer.vue + useFileViewer.ts

**文件：**
- 修改：`src/components/FileViewer.vue`（编辑区替换 + 跳转浮层）
- 修改：`src/composables/useFileViewer.ts`（暴露 projectRoot）

**接口：**
- 消费：`CodeEditor.vue`（任务 5）、`useGotoDefinition`（任务 6）、现有 FileViewer 模板
- 产出：完整的编辑器 + 跳转集成

- [ ] **步骤 1：修改 useFileViewer.ts — 暴露 projectRoot 并增加跳转后打开方法**

在 `useFileViewer.ts` 的 `useFileViewer()` 函数内部追加：

```typescript
const projectRoot = ref("");

async function openWithRoot(path: string, root: string) {
  projectRoot.value = root;
  await open(path);
}

// 跳转到目标文件，自动进入编辑模式并返回目标行
async function openAndScrollTo(targetPath: string, line: number) {
  // close current viewer
  visible.value = false;
  // brief delay to allow state reset
  await new Promise(r => setTimeout(r, 50));
  // open target in preview mode first
  await open(targetPath);
  // auto-enter edit mode so CodeEditor mounts and can scroll
  if (content.value && !error.value && content.value.length <= 1_000_000) {
    editContent.value = content.value;
    editing.value = true;
  }
  return { line };
}
```

在 return 对象中增加：

```typescript
projectRoot: readonly(projectRoot),
openWithRoot,
openAndScrollTo,
```

- [ ] **步骤 2：修改 FileViewer.vue — 替换导入和状态**

在 `<script setup>` 顶部，`useFileViewer` 解构增加 `projectRoot`：

```typescript
const { visible, filePath, content, error, editing, editContent, saving, close, startEdit, save, cancelEdit, projectRoot, openAndScrollTo } = useFileViewer();
```

追加导入：

```typescript
import CodeEditor from "./CodeEditor.vue";
import { useGotoDefinition } from "../composables/useGotoDefinition";
```

追加 goto 状态：

```typescript
const goto = useGotoDefinition();
const codeEditorRef = ref<InstanceType<typeof CodeEditor> | null>(null);

// 处理跳转到定义
async function onGotoDefinition(payload: { word: string; filePath: string }) {
  await goto.search(payload.word, projectRoot.value);
}

// 处理选中跳转结果
async function onGotoResultSelect(match: { file: string; line: number }) {
  goto.dismiss();
  // 构建绝对路径
  const separator = projectRoot.value.includes("\\") ? "\\" : "/";
  const targetPath = projectRoot.value + separator + match.file.replace(/\//g, separator);
  const result = await openAndScrollTo(targetPath, match.line);
  // 等 Vue 重新渲染 + CodeEditor 挂载（需要两次 tick：一次 VNode patch，一次 onMounted 执行完）
  await nextTick();
  await nextTick();
  codeEditorRef.value?.scrollToLine(result.line);
}

// 在浮层上用键盘导航
function onGotoKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    goto.dismiss();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    goto.selectNext();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    goto.selectPrev();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const selected = goto.getSelected();
    if (selected) {
      onGotoResultSelect(selected);
    }
  }
}
```

- [ ] **步骤 3：修改 FileViewer.vue — 替换编辑区模板**

将现有的：

```html
<div v-else-if="editing" class="viewer-editor">
  <textarea v-model="editContent" class="viewer-textarea" spellcheck="false"></textarea>
</div>
```

替换为：

```html
<div v-else-if="editing" class="viewer-editor">
  <CodeEditor
    ref="codeEditorRef"
    v-model="editContent"
    :filePath="filePath.value"
    @goto-definition="onGotoDefinition"
  />
  <!-- 跳转结果浮层 -->
  <div v-if="goto.visible.value" class="goto-popover" @keydown="onGotoKeydown">
    <div class="goto-popover-header">
      <span class="goto-popover-title">「{{ goto.searchWord.value }}」的定义</span>
      <button class="goto-popover-close" @click="goto.dismiss()">&times;</button>
    </div>
    <div class="goto-popover-body">
      <template v-if="goto.results.value.length === 0">
        <div class="goto-popover-empty">
          未找到定义 · <span class="goto-popover-hint">按 Ctrl+Shift+F 搜索所有引用</span>
        </div>
      </template>
      <template v-else>
        <div
          v-for="(match, idx) in goto.results.value"
          :key="`${match.file}:${match.line}`"
          class="goto-popover-item"
          :class="{ active: idx === goto.selectedIndex.value }"
          @click="onGotoResultSelect(match)"
        >
          <span class="goto-item-path">{{ match.file }}:{{ match.line }}</span>
          <span class="goto-item-tag" :class="'tag-' + match.match_type">{{ match.match_type }}</span>
          <span class="goto-item-content">{{ match.content }}</span>
        </div>
      </template>
    </div>
  </div>
</div>
```

- [ ] **步骤 4：修改 FileViewer.vue — 更新按钮逻辑**

将编辑器 header 中的编辑按钮从：

```html
<button v-if="!error" class="viewer-btn" :class="{ primary: editing }" @click="editing ? save() : startEdit()">
  {{ editing ? '保存' : '编辑' }}
</button>
```

改为（增加大文件判断）：

```html
<button
  v-if="!error"
  class="viewer-btn"
  :class="{ primary: editing }"
  :disabled="content.length > 1_000_000"
  :title="content.length > 1_000_000 ? '文件过大，不支持编辑' : ''"
  @click="editing ? save() : startEdit()"
>
  {{ editing ? '保存' : '编辑' }}
</button>
```

- [ ] **步骤 5：修改 FileViewer.vue — 追加跳转浮层样式**

在 `<style scoped>` 区域末尾追加：

```css
/* ── Goto popover ── */

.goto-popover {
  position: absolute;
  bottom: 8px;
  left: 8px;
  right: 8px;
  max-height: 280px;
  background: var(--surface);
  border: 1px solid var(--surface-hover);
  border-radius: 8px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
  z-index: 10;
  display: flex;
  flex-direction: column;
  animation: slideUp 0.12s ease;
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.goto-popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--surface-hover);
  flex-shrink: 0;
}

.goto-popover-title {
  font-size: 12px;
  color: var(--text-secondary);
}

.goto-popover-close {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 16px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  border-radius: 4px;
}
.goto-popover-close:hover {
  color: var(--text-primary);
  background: var(--surface-hover);
}

.goto-popover-body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.goto-popover-empty {
  padding: 16px;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
}

.goto-popover-hint {
  color: var(--accent);
  cursor: pointer;
}

.goto-popover-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  transition: background 0.08s;
}
.goto-popover-item:hover,
.goto-popover-item.active {
  background: var(--surface-hover);
}

.goto-item-path {
  font-size: 11px;
  color: var(--accent);
  white-space: nowrap;
  flex-shrink: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40%;
}

.goto-item-tag {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  text-transform: uppercase;
  flex-shrink: 0;
  background: var(--bg-tertiary);
  color: var(--text-muted);
}
.goto-item-tag.tag-fn,
.goto-item-tag.tag-function,
.goto-item-tag.tag-def {
  background: rgba(166, 227, 161, 0.15);
  color: var(--accent-green);
}
.goto-item-tag.tag-class {
  background: rgba(137, 180, 250, 0.15);
  color: var(--accent);
}
.goto-item-tag.tag-const {
  background: rgba(249, 226, 175, 0.15);
  color: var(--accent-yellow);
}

.goto-item-content {
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: "Cascadia Code", "Fira Code", "JetBrains Mono", monospace;
}
```

- [ ] **步骤 6：验证 TypeScript 编译**

```bash
cd C:/Users/<user>/IdeaProjects/aide && npx vue-tsc --noEmit
```

预期：无类型错误

- [ ] **步骤 7：验证构建**

```bash
cd C:/Users/<user>/IdeaProjects/aide && npx vite build
```

预期：构建成功，无错误

- [ ] **步骤 8：提交**

```bash
git add src/components/FileViewer.vue src/composables/useFileViewer.ts
git commit -m "feat: integrate CodeEditor + goto-definition into FileViewer"
```

---

### 验证清单（全部任务完成后）

- [ ] 通过文件树打开 `.ts` 文件 → 点击"编辑" → CodeMirror 渲染，带 TypeScript 高亮和行号
- [ ] 编辑 → 括号匹配高亮对应括号
- [ ] Ctrl+F → 搜索面板打开，搜索和替换功能正常
- [ ] Ctrl+G → 输入行号 → 跳转到指定行
- [ ] Ctrl+点击函数名 → 浮层显示定义位置 → 键盘 ↑↓ 导航 → Enter 选中 → 打开目标文件并滚动到正确行
- [ ] 打开 `.rs`、`.py`、`.vue`、`.java` 文件 → 各自获得正确的语法高亮
- [ ] 超过 1MB 文件 → "编辑"按钮禁用 + tooltip 提示
- [ ] 保存修改 → 内容持久化到磁盘
- [ ] 现有 FileViewer 行为（预览、Markdown 渲染、Esc 关闭、Ctrl+S 保存）不受影响
