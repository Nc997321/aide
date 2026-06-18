# 代码编辑器升级 & 跳转到定义 — 设计规格

**日期：** 2026-06-19  
**状态：** 已批准  

## 概述

将 FileViewer 编辑模式从纯 `<textarea>` 升级为基于 CodeMirror 6 的代码编辑器，支持语法高亮、行号、搜索替换、括号匹配，并通过内嵌 ripgrep 引擎实现"跳转到定义"。

## 动机

- 当前 textarea 过于简陋：无高亮、无行号、Tab 键会切走焦点
- 用户希望在查看/编辑代码时能舒适阅读，并能跳转到符号的定义处
- LSP 架构对偶尔使用的文件查看器来说太重（每个 language server 占用 400MB+ 内存）
- CodeMirror 6 + 内嵌 grep 库 = 零运行时依赖，二进制增量 < 2MB

## 架构

```
┌─ FileViewer.vue（弹窗外壳）──────────────────────────┐
│  ┌─ 标题栏：文件名 │ 语言标签 │ 路径 │ 按钮 ────────┐ │
│  └──────────────────────────────────────────────────┘ │
│  ┌─ 预览模式（不变）────────────────────────────────┐ │
│  │ highlight.js 渲染                                │ │
│  └──────────────────────────────────────────────────┘ │
│  ┌─ 编辑模式（替换）────────────────────────────────┐ │
│  │                                                  │ │
│  │  ┌─ CodeMirror 6 ────────────────────────────┐  │ │
│  │  │ 行号 │ 带语法高亮的代码                    │  │ │
│  │  │      │ 括号匹配、当前行高亮                │  │ │
│  │  │ Ctrl+F │ 搜索替换面板                      │  │ │
│  │  │ Ctrl+G │ 跳转到行                          │  │ │
│  │  │ Ctrl+点击 │ 跳转到定义                     │  │ │
│  │  └───────────────────────────────────────────┘  │ │
│  │                                                  │ │
│  │  ┌─ 跳转结果浮层（光标位置弹出）──────────────┐  │ │
│  │  │ src/utils/hello.ts:5  function hello()    │  │ │
│  │  │ src/tests/hello.spec.ts:12                 │  │ │
│  │  └───────────────────────────────────────────┘  │ │
│  └──────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────┘
```

## 依赖

### 前端（npm）

| 包 | 用途 |
|---|------|
| `codemirror` | 核心：EditorView、EditorState、基础扩展、命令 |
| `@codemirror/view` | （传递依赖）视图层 |
| `@codemirror/state` | （传递依赖）状态层 |
| `@codemirror/lang-javascript` | JS/TS 语法高亮 |
| `@codemirror/lang-rust` | Rust 高亮 |
| `@codemirror/lang-java` | Java 高亮 |
| `@codemirror/lang-python` | Python 高亮 |
| `@codemirror/lang-json` | JSON 高亮 |
| `@codemirror/lang-markdown` | Markdown 高亮 |
| `@codemirror/lang-html` | HTML 高亮 |
| `@codemirror/lang-css` | CSS 高亮 |
| `@codemirror/lang-vue` | Vue 单文件组件高亮 |
| `@codemirror/search` | Ctrl+F 搜索替换面板 |
| `@codemirror/matchbrackets` | 括号匹配 |
| `@codemirror/theme-one-dark` | 暗色主题（基础，后续适配 Catppuccin） |

语言包按需懒加载——只有当前文件的扩展名对应的语言才会加载。

### 后端（Cargo.toml）

| Crate | 用途 |
|-------|------|
| `grep` | ripgrep 搜索引擎核心 |
| `grep-regex` | 基于 Rust `regex` 的正则匹配引擎 |
| `grep-searcher` | 文件遍历 + 搜索执行器 |
| `ignore` | 感知 `.gitignore` 的目录遍历 |

以上均为 ripgrep 项目中提取的 crate。无外部二进制依赖。

## 文件变更清单

| 操作 | 文件 | 说明 |
|------|------|------|
| ✨ 新建 | `src/components/CodeEditor.vue` | CodeMirror 6 的 Vue 3 封装 |
| ✨ 新建 | `src/composables/useGotoDefinition.ts` | 模块级单例：跳转到定义的状态 + 搜索逻辑 |
| 🔧 修改 | `src/components/FileViewer.vue` | `<textarea>` 替换为 `<CodeEditor>`，接入跳转事件 |
| 🔧 修改 | `src/composables/useFileViewer.ts` | 增加 `editContent` 与跳转联动 |
| ➕ 修改 | `src-tauri/Cargo.toml` | 增加 `grep`、`grep-regex`、`grep-searcher`、`ignore` |
| ➕ 修改 | `src-tauri/src/commands/filesystem.rs` | 新增 `grep_symbol` 命令 |
| 🔧 修改 | `src-tauri/src/commands/mod.rs` | 重新导出 `grep_symbol` |
| 🔧 修改 | `src-tauri/src/lib.rs` | 注册 `grep_symbol` 命令 |
| 🔧 修改 | `src/api.ts` | 新增 `grepSymbol(word, cwd)` 封装 |
| 🔧 修改 | `package.json` | 增加 CodeMirror 依赖 |

## CodeEditor.vue — 组件设计

### Props
```
filePath: string       // 完整路径，用于识别文件语言
modelValue: string     // v-model 绑定的内容
placeholder?: string
```

### Emits
```
update:modelValue      // 标准 v-model 更新
goto-definition        // { word: string, filePath: string }
```

### 内部状态
- EditorView 实例（onMounted 创建，onUnmounted 销毁）
- 语言扩展：监听文件扩展名变化，动态切换
- 搜索面板显隐状态

### 语言识别

```
扩展名      → 语言
.ts/.tsx    → javascript（带 TypeScript 支持）
.js/.jsx    → javascript
.rs         → rust
.py         → python
.json       → json
.md/.mdx    → markdown
.html       → html
.css/.scss  → css
.vue        → vue
默认        → 纯文本（无高亮，其他功能正常）
```

### 快捷键（CodeMirror 键盘映射）

| 快捷键 | 行为 |
|--------|------|
| Ctrl+F | 打开/关闭搜索替换面板 |
| Ctrl+G | 跳转到指定行 |
| Ctrl+点击 / F12 | 触发 `goto-definition` 事件，携带光标下的单词 |
| Tab | 插入 4 个空格，不切走焦点 |
| Ctrl+S | 由 FileViewer 父组件处理保存 |
| Escape | 由 FileViewer 父组件处理取消/切换模式 |

## 跳转到定义 — 数据流

```
用户 Ctrl+点击 CodeMirror 中的某个单词
        │
        ▼
CodeEditor 触发 'goto-definition' { word, filePath }
        │
        ▼
useGotoDefinition.search(word, projectRoot)
        │
        ▼
api.grepSymbol(word, projectRoot)  ──→  Rust grep_symbol 命令
                                             │
                                             ▼
                                     grep crate 遍历项目目录
                                     自动感知 .gitignore（跳过 node_modules、target、dist、.git）
                                     返回 [{file, line, content}]
        │
        ▼
结果浮层在光标位置弹出（左下锚定）
    - 最多显示 8 条
    - 每条： "相对路径.ts:42  匹配行的内容"
    - 点击 → 关闭当前 FileViewer → open(目标文件) → 滚动到目标行
    - Escape → 关闭浮层
```

### 智能匹配（第一阶段）

为区分定义与引用，按优先级依次尝试以下正则模式：

1. `^(pub\s+)?(async\s+)?fn\s+<word>\b` — Rust 函数
2. `^(export\s+)?(async\s+)?function\s+<word>\b` — JS/TS 函数  
3. `^(export\s+)?class\s+<word>\b` — JS/TS 类
4. `^def\s+<word>\b` — Python 函数
5. `^(export\s+)?const\s+<word>\b` — JS/TS 常量
6. `<word>` — 兜底：任意出现

高优先级模式匹配到的结果排在最前面。

## 边界情况

| 场景 | 处理方式 |
|------|----------|
| 文件 > 1 MB | "编辑"按钮禁用，tooltip 提示"文件过大，不支持编辑" |
| 二进制文件 | 同上，Rust `read_file_content` 返回错误信息 |
| 无 grep 结果 | 浮层显示"未找到定义 · 按 Ctrl+Shift+F 搜索所有引用" |
| 结果 > 20 条 | 显示前 8 条 + "还有 N 条结果…"（点击展开） |
| 目标文件无法读取 | Toast 提示错误，保持当前文件打开 |
| 编辑内容后跳走 | **第一阶段不做未保存提示**（保存需手动）；第二阶段可加脏状态追踪 |
| `grep` crate 出错（磁盘错误） | Rust 返回错误码，前端 toast 显示 |

## 主题适配

CodeMirror 的 `@codemirror/theme-one-dark` 提供暗色基础。我们将覆盖其 CSS 变量以匹配 Aide 项目已有的 Catppuccin 调色板：

- 背景：`var(--bg-primary)`
- 行号区域：`var(--bg-tertiary)`  
- 选中：`var(--surface-hover)`
- 文本：`var(--text-primary)`
- 语法配色：参考 FileViewer.vue 中已有的 highlight.js Catppuccin 覆盖

## 不做（第一阶段）

- LSP 集成（跳转到定义仅使用 grep）
- 自动补全 / IntelliSense
- 诊断（波浪线错误提示）
- 多文件 diff 对比
- 文件查看器内重命名/移动
- 关闭时未保存提醒
- 固定标签页 / 多文件编辑

以上留到第二阶段或之后考虑。

## 验证清单

1. 通过文件树打开 `.ts` 文件 → 点击"编辑" → CodeMirror 渲染，带 TypeScript 高亮和行号
2. 输入代码 → 括号匹配高亮对应括号
3. Ctrl+F → 搜索面板打开，搜索和替换功能正常
4. Ctrl+G → 跳转到行正常
5. Ctrl+点击函数名 → 浮层显示定义位置 → 点击 → 打开目标文件并滚动到正确行
6. 打开 `.rs`、`.py`、`.vue` 文件 → 各自获得正确的语法高亮
7. 过大/二进制文件 → "编辑"按钮禁用
8. 保存修改 → 内容持久化到磁盘
9. 所有现有 FileViewer 行为（预览、Markdown 渲染、Esc 关闭）不受影响
