# 全局搜索 + 替换（Find in Files）设计

日期：2026-08-16
状态：已确认（右侧面板 tab + 逐文件 diff 预览 + 仅工作区范围）

## 1. 背景与目标

当前应用没有「在文件中查找」的内容搜索（跨文件结果列表），更没有全局替换。目标：提供类似 IDEA「Find in Files / Replace in Files」的能力——内容搜索 + 正则支持 + 逐文件 diff 预览替换。

已确认的三个关键决策：

| 决策点 | 选择 |
|---|---|
| UI 形态 | 右侧面板新 tab（ARailBar 加「搜索」图标，与 FileTree/Git 并列） |
| 替换流程 | 逐文件 diff 预览（IDEA 式），确认后才写盘 |
| 搜索范围 | 仅整个工作区（尊重 .gitignore），v1 不做目录范围选择 |
| 快捷键 | Ctrl+Shift+F = 只搜索（不显示替换区）；Ctrl+Shift+R = 搜索+替换（显示替换区）。同一面板，快捷键决定进入的模式（IDEA 语义） |

## 2. 现状盘点：为什么另起一个

现有「搜索」相关能力与 Find in Files 语义不同，硬复用会两头别扭：

| 现有能力 | 位置 | 本质 | 与 Find in Files 的关系 |
|---|---|---|---|
| 命令面板搜索 | `src/composables/useSearchProviders.ts` | Ctrl+P 式快速跳转（会话/文件名/CodeGraph 符号） | 导航工具，**不复用** |
| `grep_symbol` | `src-tauri/src/commands/filesystem.rs:503` | goto definition 文本兜底，符号导向（fn/class/def 模式） | 导航兜底，**不复用** |
| `find_files_by_name` | `src-tauri/src/commands/filesystem.rs:705` | 面板文件名搜索 | 导航工具，**不复用** |
| 编辑器内查找/替换 | `CodeEditor.vue`（@codemirror/search） | 单文件 Ctrl+F | 单文件能力，**不冲突**，保持现状 |

**结论：新功能独立实现，但最大化复用现有基础设施**（见 §3 复用清单）。

## 3. 复用清单（已逐一核实存在）

| 复用点 | 位置 | 用途 |
|---|---|---|
| `ignore` crate `WalkBuilder`（ripgrep 同款，尊重 .gitignore） | `filesystem.rs` grep_symbol/find_files_by_name 同款模式 | 搜索遍历 |
| `regex` crate（已是依赖） | `Cargo.toml` | 正则编译/匹配/替换 |
| async + `spawn_blocking` 命令约定 | CLAUDE.md 红线 + filesystem.rs 既有模式 | 防卡主线程 |
| 右侧 tab 机制 | `App.vue` `rightTabs` computed + `ARailBar` + `onRailSelect` | 新 tab 注册 |
| `DiffViewer`（吃 `DiffPair`） | `src/components/fileviewer/DiffViewer.vue`，`DiffPair` 在 `types.ts:48` | 替换预览渲染 |
| `useFileViewer.openAndScrollTo(path, line)` | `src/composables/useFileViewer.ts:270` | 结果点击跳转定位 |
| `fileTreeRef.loadRoot()` / `revealFile(path)` | `App.vue:404/429` | 替换后刷新文件树 |
| `matchShortcut` 快捷键系统 | `src/utils/shortcut` + `App.vue` `handleKeydown` | Ctrl+Shift+F 聚焦搜索 tab |
| `GrepMatch` 类型 | `types.ts:335` | SearchMatch 的建模模板 |
| 命令注册 | `lib.rs` `generate_handler!`（`grep_symbol`/`find_files_by_name` 同款） | 注册新命令 |

## 4. 后端设计：新模块 `src-tauri/src/commands/search.rs`

filesystem.rs 已 700+ 行，不往里塞。三个命令：

### 4.1 `search_in_files(query, cwd, options) -> SearchResponse`

```rust
struct SearchOptions {
    use_regex: bool,        // 默认 false：字面量搜索
    case_sensitive: bool,   // 默认 false
    whole_word: bool,       // 默认 false
    file_mask: Option<String>, // 逗号分隔 glob，如 "*.ts,*.vue"；None = 全部
    limit: Option<usize>,   // 默认 500
}

struct SearchMatch {
    file: String,        // 绝对路径
    line: u32,           // 1-based
    column: u32,         // 1-based，char 计数（CJK 友好，供显示/跳转）
    line_text: String,   // 整行文本（供结果列表展示）
    match_start: u32,    // 行内 byte 偏移（供高亮）
    match_end: u32,
}

struct SearchResponse {
    files: Vec<SearchFileGroup>, // 按文件分组
    total: usize,                // 实际命中总数（可能 > 返回数）
    truncated: bool,             // 是否因 limit 截断
}

struct SearchFileGroup {
    file: String,
    matches: Vec<SearchMatch>,
}
```

实现要点：

- 遍历：`WalkBuilder::new(cwd).hidden(true).git_ignore(true).git_global(true).git_exclude(true).max_depth(Some(20))`——与 `grep_symbol_blocking` 完全同款。
- 文件掩码：`OverrideBuilder`（rg 同款 glob 语义），逗号分隔拆多个 pattern。
- 非正则模式：`regex::escape(query)` 后按选项编译；正则模式直接编译用户输入（非法正则返回明确错误信息）。
- 全词：`\b(?:pattern)\b` 包裹，**仅当 pattern 首尾是词字符时**（IDEA 同款语义，避免 `\b` 在非词字符边界失效）。
- 大小写：`RegexBuilder::case_insensitive(true)`。
- 二进制跳过：读取文件头 8KB 探测 null byte，命中即跳过。
- 上限：命中数达 limit 即停（`truncated = true`），文件遍历顺序稳定（WalkBuilder 默认序）。
- 大文件保护：单文件 > 1MB 跳过（对齐 DiffViewer 的 MAX_DIFF_SIZE 心智）。
- async + `spawn_blocking`（CLAUDE.md 红线，禁止主线程重 IO）。

### 4.2 `replace_in_files_preview(query, replacement, cwd, options) -> ReplacePreviewResponse`

```rust
struct ReplacePreviewFile {
    file: String,
    original: String,   // 完整原内容
    replaced: String,   // 完整替换后内容（服务端权威计算）
    match_count: usize,
}

struct ReplacePreviewResponse {
    files: Vec<ReplacePreviewFile>,
    total_matches: usize,
    truncated: bool,
}
```

实现要点：

- **服务端权威计算替换**：用 `regex` crate 的 `replace_all`（支持 `$1`/`$name`/`${name}` 捕获组），避免 JS/Rust 正则语义不一致——预览与写盘永远一致。
- 选项语义与 `search_in_files` 完全一致（同一套编译逻辑，抽公共函数 `compile_pattern(query, options) -> Result<Regex, String>`）。
- 上限保护：文件数上限（默认 50 个文件），超出置 `truncated`。
- 大文件保护：> 1MB 跳过（与搜索一致）。

### 4.3 `apply_replacements(files: Vec<ReplaceFileInput>) -> ApplyResult`

```rust
struct ReplaceFileInput {
    path: String,
    content: String,   // 必须是 preview 返回的 replaced 内容
}

struct ApplyResult {
    succeeded: Vec<String>,  // 成功写入的路径
    failed: Vec<(String, String)>, // (路径, 错误信息)
}
```

实现要点：

- 只接受 preview 返回的 content，逐文件 `fs::write`（复用 `write_file_content` 同款写盘路径，含 UTF-8 校验）。
- 返回成功/失败列表，前端逐项提示，不整体失败。
- async + `spawn_blocking`。

## 5. 前端设计：`src/components/SearchPanel.vue`

### 5.1 布局（右侧 tab 内，与 GitPanel 同款容器）

```
┌─────────────────────────────┐
│ [搜索输入框]            [×]  │  ← 300ms 防抖
│ [正则] [Aa] [全词] [掩码:___] │  ← 选项行（toggle + 掩码输入）
│ [替换模式 toggle]            │  ← 搜索/替换模式切换（快捷键预选，也可手动切）
├─────────────────────────────┤
│ 替换模式（仅替换模式显示）：    │
│ [替换为输入框] [预览替换]      │
├─────────────────────────────┤
│ 结果列表（按文件分组）          │
│  ▸ src/foo.ts (12)          │
│    12: const x = ...        │
│    45: ...                   │
│  ▸ src/bar.vue (3)          │
│  ...                        │
│ [共 87 处 · 已截断]           │
└─────────────────────────────┘
```

### 5.2 搜索模式

- 输入防抖 300ms + **请求序号防竞态**（旧请求返回时序号不匹配则丢弃）。
- 选项行：正则 toggle、大小写 toggle、全词 toggle、文件掩码输入框（逗号分隔）。
- 结果按文件分组渲染：文件头（路径 + 命中数，可折叠）+ 匹配行（行号 + 行文本，命中片段高亮）。
- 点击匹配行 → `useFileViewer.openAndScrollTo(file, line)` 跳转定位。
- 状态：搜索中 spinner、结果数、`truncated` 截断提示、无结果空态、错误提示（如非法正则）。
- **搜索模式不显示替换输入区**（Ctrl+Shift+F 进入此模式）。

### 5.3 替换模式

- 替换输入框 + 「预览替换」按钮 → `replace_in_files_preview`。
- 预览结果逐文件渲染 `DiffViewer`（复用，`initialMode: "unified"`，`DiffPair` 组装：`oldText=original`、`newText=replaced`、`oldLabel="原"`、`newLabel="替换后"`、`status="modified"`）。
- 逐文件「确认」/「全部确认」→ `apply_replacements` → 面板内状态行提示成功/失败数 → `fileTreeRef.loadRoot()` 刷新文件树。
- 预览后文件被外部改动：apply 前不重新校验（v1 简化，diff 预览已展示将要写入的内容）。
- 模式切换：面板内 toggle 可在搜索/替换模式间手动切换；快捷键进入时预选对应模式（Ctrl+Shift+F → 搜索模式，Ctrl+Shift+R → 替换模式）。切换模式不清空已输入的搜索词。

### 5.4 接线

- `App.vue`：`rightTabs` 加 `{ id: "search", icon: 放大镜 SVG }`（与现有 tabIcon* 同款 24x24 stroke 风格）；`rightTab` 联合类型加 `"search"`。
- 快捷键（`handleKeydown` + `matchShortcut`，IDEA 语义）：
  - **Ctrl+Shift+F** → 展开右侧面板并切到 search tab，**搜索模式**（不显示替换区）
  - **Ctrl+Shift+R** → 展开右侧面板并切到 search tab，**替换模式**（显示替换区）
  - 面板已打开时重复按快捷键：聚焦搜索输入框（IDEA 行为：重复按聚焦输入框）
- `api.ts`：3 个 invoke 包装（`searchInFiles` / `replaceInFilesPreview` / `applyReplacements`）。
- `lib.rs`：`generate_handler!` 注册 3 个命令。
- 类型：`types.ts` 加 `SearchOptions` / `SearchMatch` / `SearchFileGroup` / `SearchResponse` / `ReplacePreviewFile` / `ReplacePreviewResponse` / `ReplaceFileInput` / `ApplyResult`（建模参考 `GrepMatch`）。

## 6. 数据流

```
输入 query（防抖 300ms）
  → search_in_files(query, cwd, options)
  → 结果列表渲染（分组 + 高亮）
  → 点击 → openAndScrollTo(file, line)

输入 replacement → 预览替换
  → replace_in_files_preview(query, replacement, cwd, options)
  → 逐文件 DiffViewer 渲染（original vs replaced）
  → 确认 → apply_replacements([{path, content}])
  → 写盘 → 状态行反馈 → fileTreeRef.loadRoot()
```

## 7. 错误处理

| 场景 | 处理 |
|---|---|
| 非法正则 | 返回明确错误信息，前端选项行下方红字提示，不崩溃 |
| 搜索/预览超上限 | `truncated` 标志 + 前端「结果已截断」提示 |
| 二进制/超大文件 | 静默跳过（搜索不展示，预览不包含） |
| apply 部分失败 | 返回成功/失败列表，前端逐项提示 |
| 工作区为空/不存在 | 返回空结果 + 前端空态 |

## 8. 测试

### Rust 单测（`search.rs` 内 `#[cfg(test)]`）

- 字面量搜索命中/不命中
- 正则搜索 + 捕获组替换（`$1`/`$name`）
- 大小写开关
- 全词开关（含首尾非词字符的边界情况）
- 文件掩码过滤（`*.ts,*.vue`）
- 二进制跳过、超大文件跳过
- limit 截断 + truncated 标志
- 非法正则报错
- 替换正确性：多行多命中、同一行多命中、正则特殊字符字面量转义

### 前端测试

- `SearchPanel` 组件测试（mock api）：防抖、竞态丢弃、结果分组渲染、替换预览流、确认流。

## 9. 不做（YAGNI）

- 目录范围选择（v1 仅工作区）
- 撤销（diff 预览已是安全网；IDEA 靠 local history，v1 不做）
- 索引化搜索（3k 文件遍历几十毫秒，够用）
- 结果流式/增量加载
- 搜索历史/收藏
- 替换后自动打开文件

## 10. 涉及文件清单

| 文件 | 动作 |
|---|---|
| `src-tauri/src/commands/search.rs` | 新增（3 命令 + 单测） |
| `src-tauri/src/lib.rs` | 修改（注册命令） |
| `src/components/SearchPanel.vue` | 新增 |
| `src/App.vue` | 修改（rightTabs + 快捷键 + 接线） |
| `src/api.ts` | 修改（3 个 invoke 包装） |
| `src/types.ts` | 修改（新类型） |
| `src/components/SearchPanel.test.ts` | 新增（组件测试） |
