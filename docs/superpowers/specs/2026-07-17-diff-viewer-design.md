# Diff 查看器重设计：编辑器级对比视图

日期：2026-07-17
状态：已批准（brainstorming 对齐完成）
范围：只重做 diff 查看体验；右栏 Git 面板其余功能不动。

## 1. 背景与问题

现状：GitPanel / 提交历史里点文件 → `git_diff_content` 返回 unified diff **文本** →
`FileWindow.vue` 用 `<pre>` + 5 个 CSS 类按行首字符着色（`diffHighlighted`）。

两个硬伤：

1. **假新文件 bug（实锤）**：`git_diff_content`（`src-tauri/src/commands/git.rs:552-602`）
   在 `git diff` 输出为空时走 fallback——把文件全文读出来合成
   `new file mode 100644` / `--- /dev/null` 的假 diff。但「输出为空」≠「新文件」：
   仅行尾变化（LF↔CRLF）时 `git status` 标 `M` 而 `git diff` 为空，于是
   `src-tauri/Cargo.toml` 这种已跟踪的修改文件被显示成「全量新增文件」，
   完全无法看。
2. **体验远低于市面标准**：无行号、无并排对照、无语法高亮、无词级高亮、
   无未变更区折叠、hunk 之间无法跳转——本质是裸文本染色。

## 2. 目标

把 diff 标签页做成编辑器级对比视图（对标 VS Code）：

- 并排双栏（默认）+ unified 单栏，一键切换
- 行号、联动滚动、未变更区自动折叠、行内词级高亮
- diff 内代码按文件类型做语法高亮，配色与代码编辑器完全一致
- 新增/删除/行尾-only/二进制都有正确、明确的呈现
- 纯查看：不做 hunk 级 stage/discard

技术方案：**`@codemirror/merge`**（CodeMirror 官方 merge 扩展）。项目已是
CodeMirror 6 栈（`CodeEditor.vue` 已趟完 CM 主题化的坑），merge 视图长在同一套
主题机制上；且它吃「新旧双份原文」而非 unified diff 文本，从根上消除假新文件 bug。

否决方案：diff2html（外来样式体系、无折叠无滚动联动、bug 还要单修）、
自研渲染器 + jsdiff（并排对齐/折叠是编辑器级工作量，性能红线翻车面大）。

## 3. 数据流设计（改动核心）

### 3.1 新 Rust 命令 `git_diff_pair`

位置：`src-tauri/src/commands/git.rs`。签名：

```rust
#[tauri::command]
pub async fn git_diff_pair(
    workspace_state: State<'_, WorkspaceState>,
    path: String,
    staged: Option<bool>,
    commit_hash: Option<String>,
) -> Result<DiffPair, String>

struct DiffPair {
    old_text: String,   // HEAD 版 / commit^ 版；新增文件为 ""
    new_text: String,   // 工作区 / 索引 / commit 版；已删除为 ""
    old_label: String,  // "HEAD" / "<hash>^"
    new_label: String,  // "工作区" / "已暂存" / "<hash 短码>"
    status: String,     // "added" | "modified" | "deleted"
    is_binary: bool,
    eol_only: bool,
}
```

取数矩阵（三种调用场景）：

| 场景 | old_text | new_text | old_label | new_label |
|---|---|---|---|---|
| 未暂存（默认） | `git show HEAD:<path>` | 磁盘读文件 | `HEAD` | `工作区` |
| 已暂存（staged=true） | `git show HEAD:<path>` | `git show :<path>`（索引 blob） | `HEAD` | `已暂存` |
| 提交（commit_hash=h） | `git show h^:<path>` | `git show h:<path>` | `h^`（短码） | `h`（短码） |

规则：

- `git show <rev>:<path>` 找不到 blob（exit non-zero / 空）→ 该侧为空串：
  - old 空 + new 非空 → `status="added"`
  - old 非空 + new 空（磁盘文件不存在）→ `status="deleted"`
  - 两侧皆空（如未跟踪的空文件）→ 按存在性：磁盘文件存在 → `added`，否则 → `deleted`
  - 否则 → `status="modified"`
- **行尾归一化**：两侧文本统一 `\r\n` / `\r` → `\n` 后再返回。归一化后两侧
  相等且原本不相等 → `eol_only=true`。（`git show` 输出受 autocrlf 影响，
  磁盘文件可能是 CRLF；不归一化会让 merge 视图把每行都标成变更——这正是
  截图 bug 文件的真实情况。）
- `is_binary`：任一側前 8KB 内含 NUL 字节。
- 未暂存场景的磁盘读文件与 git 子进程放在**同一个** `git_run_blocking`
  闭包里（async 命令 + 重 IO 隔离，符合主线程禁令；`CREATE_NO_WINDOW`
  由 `git_run` 内部已有实现保证，新代码必须走 `git_run` 不得另起裸 `Command`）。
- 非 git 仓库 → `Err("Not a git repository")`。

### 3.2 删除 `git_diff_content`

前端仅 `GitPanel.vue:142` 与 `useGit.ts:118` 两处调用，全部改调
`git_diff_pair` 后，`git_diff_content`（含 synthesize fallback）从
`git.rs` 与 `lib.rs` 的 invoke_handler 注册中删除。

### 3.3 前端接入

- `src/types.ts` 增加 `DiffPair` 镜像类型（与 Rust 结构蛇形字段一致）。
- `FileWindowState`（`useFileViewer.ts`）加字段 `diffPair: DiffPair | null`。
- `useFileViewer.open(path, opts)` 的 opts 增加 `diffPair` 形态：
  `open(relPath, { diffPair })` → virtual + readonly 窗口，`language` 置空。
  同路径 virtual 窗口已存在 → 就地替换 `diffPair`（沿用现有「重开=刷新」语义）。
- `FileWindow.vue` 模板：删除 `<pre class="viewer-diff">` 分支与
  `diffHighlighted` computed，改为
  `<DiffViewer v-else-if="win.diffPair" :pair="win.diffPair" :filePath="win.filePath" />`。
  `isDiff` 改判 `!!win.diffPair`；头部「只读」徽章逻辑不变。
- `GitPanel.vue openDiffInViewer` 与 `useGit.ts viewDiff`：invoke 换成
  `git_diff_pair`，失败时 AToast 报错且**不开窗口**（现在是无 catch 直开）。

## 4. DiffViewer 组件

新文件 `src/components/fileviewer/DiffViewer.vue`，props：
`pair: DiffPair`、`filePath: string`。

### 4.1 布局

- **工具条**（顶部，全 `--aide-*` 主题化）：
  - 状态徽章：新增（success）/ 修改（info）/ 删除（danger）
  - `old_label → new_label` 文案
  - 并排 / unified 切换按钮（默认并排；本地状态，不持久化）
  - 上一处 / 下一处变更跳转（merge 提供的 chunk 导航命令）
- **主体**：`@codemirror/merge` 的 `MergeView`（并排）或
  `unifiedMergeView`（单栏）。配置：
  - 两侧 `EditorState.readOnly.of(true)` + `EditorView.editable.of(false)`
  - 行号 gutter 开
  - `collapseUnchanged({ margin: 3, minSize: 4 })` 折叠未变更区
  - `highlightChanges: true`（行内词级高亮，默认即开）
  - 语法高亮：按 `filePath` 扩展名加载语言包（见 4.2）
- **特例短路**（不挂 merge 视图，显示主题化提示文案）：
  - `pair.eol_only` → 「内容与 HEAD 无差异（仅行尾不同）」
  - `pair.is_binary` → 「二进制文件无法对比」
  - 任一侧 > 1MB（对齐 `MAX_EDITABLE_SIZE`）→ 「文件过大，无法渲染对比视图」
    （防 diff 计算卡窗，CLAUDE.md 性能红线）
- 切换并排/unified = 销毁当前 view 重建另一种；主题切换走 Compartment
  重配置（同 CodeEditor 的 `themeCompartment` 模式），不重建。

### 4.2 共享抽取

从 `CodeEditor.vue` 抽出两个纯函数，CodeEditor 与 DiffViewer 共用：

- `src/utils/cmLanguage.ts`：`loadLanguageExtension(ext: string)`——
  现有扩展名→动态 import 语言包的 switch 原样搬走。
- `src/utils/cmHighlight.ts`：`createHighlightStyle(t: ThemeTokens)`——
  现有实现原样搬走（CLAUDE.md 已规定语法高亮从 token 派生，不用 oneDark）。

`CodeEditor.vue` 改为从 utils import，行为不变。

### 4.3 主题化（CLAUDE.md 铁律）

- `EditorView.theme(spec, { dark: true })` 第二参数**必须传**（不传则 CM 当
  light 主题，`&light` 默认值出白底）。
- merge 视图类名**读 `node_modules/@codemirror/merge/dist` 源码确认，不猜**：
  变更行、行内变更段、折叠条、gutter 标记等的真实类名以源码为准，确认后
  写进 DiffViewer 主题块内联注释（同 CodeEditor.vue 既有做法）。
- 颜色只用 `var(--aide-*)`：新增=`--aide-success`、删除=`--aide-danger`
  （文字 + `color-mix` 低透明度底色）、折叠条/边框=`--aide-border` 系、
  背景=`--aide-bg` 系。**不加新 token 槽位，禁止硬编码 hex**。
- 验证：设置里切 warm-dark ↔ catppuccin，diff 视图整面重配色。

## 5. 清理清单

- 删 `git_diff_content` 命令及其 invoke_handler 注册、synthesize fallback。
- 删 `FileWindow.vue` 的 `diffHighlighted` computed、`viewer-diff` 模板分支。
- 删 `global.css` 的 `.aide-diff-*` 五个类（确认无其他引用后）。

## 6. 明确不做（YAGNI）

- hunk 级 stage / unstage / discard（stage 仍在 GitPanel 按文件粒度）
- 变更集内多文件导航（上一文件/下一文件）
- 磁盘文件变化后已开 diff 视图的自动刷新（与现状语义一致：重开=刷新）
- rename 检测（自然呈现为删除+新增）
- 视图模式偏好的持久化（本地状态，默认并排）

## 7. 测试与验证

### Rust 单元测试（`cargo test --lib`）

`git_diff_pair` 用临时目录初始化真 git 仓库，覆盖六矩阵：

1. modified 未暂存：old=HEAD 版，new=磁盘版，status=modified
2. staged：new=索引版
3. commit_hash：old=`h^:path`，new=`h:path`
4. 未跟踪新文件：old=""，status=added
5. 已删除：new=""，status=deleted
6. 行尾-only（磁盘 CRLF / 仓库 LF）：`eol_only=true`，两侧归一化后相等

### 前端

- vitest：`cmLanguage.ts` 扩展名映射（已知扩展名→非空、未知→空数组）。

### 手测（`verify` skill 跑真应用 `pnpm tauri dev`）

1. 修改已跟踪文件 → 打开 diff：并排对照、行号、语法高亮、词级高亮、折叠条出现
2. 暂存同一文件 → 从「已暂存」打开：对照 HEAD vs 索引
3. 未跟踪新文件 → 左空右全绿，徽章「新增」
4. 删除文件 → 左全红右空，徽章「删除」
5. 提交历史 → 展开提交点文件：对照 `h^` vs `h`
6. **行尾-only 文件（截图案的 Cargo.toml 场景）→ 显示「仅行尾不同」提示，
   不再出现假新文件**
7. 切 unified 单栏再切回
8. 上/下一处变更跳转
9. 主题 warm-dark ↔ catppuccin 整面重配色（无硬编码残留）
10. >1MB 文件 → 大小守卫提示，窗口不卡

## 8. 影响面与红线自查

- **跨平台**：新 Rust 代码无平台特有逻辑；路径用 `PathBuf`；子进程全走
  `git_run`（`CREATE_NO_WINDOW` 已有）。
- **provider-agnostic**：git 功能与 agent provider 无关，不触碰 IPC 协议。
- **主线程禁令**：`git_diff_pair` 为 async + `git_run_blocking`。
- **trace_command**：新命令是 async，不埋（async 埋了也抓不到）。
- **主题唯一来源**：全 `var(--aide-*)`，不加 token 槽位。
- **禁止原生 UI**：提示用 AToast / 主题化文案，hover 用 v-tooltip。
- **release 打包**：新增 `@codemirror/merge` npm 依赖，pnpm 安装即可，
  无原生资源变化。
