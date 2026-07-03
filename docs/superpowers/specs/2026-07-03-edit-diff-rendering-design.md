# Edit 工具卡片 diff 渲染 — 设计

对应 PLANS.md 第 3 项。

## 背景

`ToolCallBlock.vue` 现在对所有工具统一渲染：折叠状态只显示图标 + 工具名 + 摘要，展开后显示 `block.result`（工具返回的文本）。对 `Edit` 工具来说，`block.result` 通常只是一句确认信息，真正的改动内容（`input.old_string` / `input.new_string`）完全没有被渲染——用户在聊天流里只能看到「✅ Edit path/to/file」，看不出改了什么，必须切到 GitPanel 或自己打开文件才能确认。Edit 是编码 agent 里发生频率最高的工具调用之一，这个空白是当前正常使用中影响最大的一处。

`FileViewer.vue:90-104` 已经有一套手写的 unified diff 行着色逻辑（按行前缀 `+`/`-`/`@@` 分类上色），用于展示 GitPanel 里 `git_diff_content` 返回的真实 git diff文本，目前是 FileViewer 私有的 scoped 样式。

## 方案：整段红/绿块 diff，复用 FileViewer 的着色语言

不引入 diff 算法依赖，不做逐行 LCS 比对。`old_string` 整体按行拆分标红（`-` 前缀），`new_string` 整体按行拆分标绿（`+` 前缀），先删后增上下拼接展示。这不是精确到"哪一行真正变了"的 diff，但对 Edit 工具常见的几行到几十行改动已经足够传达"删了什么、加了什么"，实现成本和视觉复杂度都最低，作为这个功能的第一版起步。

样式不在 `ToolCallBlock.vue` 里重新定义一份，而是把 `FileViewer.vue` 里 `.diff-add`/`.diff-del`/`.diff-hunk`/`.diff-meta`/`.diff-ctx` 的着色规则上移到 `src/styles/global.css`（该文件目前只放设计 token 和 Tailwind 指令，这是它第一次承担组件级共享 class 的角色），两个组件都引用同一套 class。这是唯一超出「只改 ToolCallBlock.vue」字面范围的改动，理由是消除样式重复，不是顺手重构无关代码。

## 改动范围

### `src/styles/global.css`
新增全局 class（从 `FileViewer.vue` 现有的 scoped 样式原样迁移，改名加 `aide-` 前缀避免和业务 class 混淆）：

```css
.aide-diff-add { color: var(--aide-success); background: color-mix(in srgb, var(--aide-success) 4%, transparent); display: block; }
.aide-diff-del { color: var(--aide-danger); background: color-mix(in srgb, var(--aide-danger) 4%, transparent); display: block; }
.aide-diff-hunk { color: var(--aide-info); display: block; }
.aide-diff-meta { color: var(--aide-warning); display: block; }
.aide-diff-ctx { color: var(--aide-text-muted); display: block; }
```

### `src/components/FileViewer.vue`
- 删除本地重复定义的 `.diff-add`/`.diff-del`/`.diff-hunk`/`.diff-meta`/`.diff-ctx`，改用 `aide-diff-*` class。
- `diffHighlighted` 计算属性里拼的 class 名同步改成 `aide-diff-*`。
- 纯样式位置迁移，行为不变。

### `src/components/ToolCallBlock.vue`
- 新增本地 interface（不进 `types/chat.ts`——这是 Claude `Edit` 工具专属的输入形状，不是核心 IPC 协议类型；`types/chat.ts` 是 provider-agnostic 的核心协议，Edit 工具的字段结构属于展示层对特定工具的可选增强）：
  ```ts
  interface EditToolInput {
    file_path: string;
    old_string: string;
    new_string: string;
  }
  ```
- 新增 `parseEditInput(input: unknown): EditToolInput | null`：校验 `file_path`/`old_string`/`new_string` 都是 string，否则返回 `null`（格式不符时静默回退，不让渲染报错）。
- 新增 `computed` `editDiffLines`：当 `block.name === "Edit"` 且 `!block.isError` 且 `parseEditInput` 成功时，返回按行拆分好的 `{ text: string; cls: string }[]`（`old_string` 每行 `cls: "aide-diff-del"` 前缀 `-`，`new_string` 每行 `cls: "aide-diff-add"` 前缀 `+`）；否则为 `null`。
- `tool-body` 模板逻辑调整为三分支：
  1. `isBash && block.result` → 现有 `BashOutputBlock`（不变）。
  2. `editDiffLines` 非空 → 新增的 diff 渲染（`<pre><code class="aide-diff-*">` 逐行渲染，复用现有 `.tool-result` 的 `max-height: 160px; overflow: auto` 尺寸约束）。
  3. 其余 → 现有 `<pre class="tool-result">{{ block.result }}</pre>` / `等待结果…`（不变，包括 Edit 失败时的报错文本）。
- `inputSummary` 对 `Edit` 的分支，在 `file_path` 后追加行数统计：`+{addLines} -{delLines}`，样式复用 GitPanel 已有的 `.stat-add`/`.stat-del` 配色语言（`color: var(--aide-success)` / `var(--aide-danger)`，在 `ToolCallBlock.vue` 里新增等价的 scoped class，不跨组件复用 GitPanel 的 scoped 样式）。行数按 `old_string`/`new_string` 各自 `split("\n").length` 算，不是净变化行数。

## 边界情况

- **`isError` 为 true**（如 old_string 未找到/不唯一导致编辑失败）：不进入 diff 分支，回退到现在的错误文本展示。展示一个没有真正发生的 diff 会误导用户判断改动是否生效。
- **`parseEditInput` 校验失败**（字段缺失或类型不对，理论上不应发生但作为防御）：回退到现在的文本展示，不抛错、不让整个消息渲染中断。
- **内容超长**：沿用现有 `.tool-result` 的 `max-height: 160px; overflow: auto`，不新增截断逻辑。
- **`old_string`/`new_string` 为空字符串**：`split("\n")` 得到 `[""]`，正常渲染成一个空行，不特殊处理。
- **折叠状态**：默认折叠，与其他工具卡片一致；折叠状态下的 `+N -M` 统计让用户不展开也能判断改动规模。

## 范围边界（明确不做）

- 不做逐行 LCS/Myers diff 算法，不引入第三方 diff 依赖。
- 不处理 `Write` 工具（新建文件/整篇覆盖）——`Write` 没有 `old_string` 可比较，"diff" 语义不同，留给后续单独评估。
- 不处理 `MultiEdit`（当前 SDK 工具集里没有这个工具）。
- 不在 diff 视图里做语法高亮（hljs 未注册 `diff` 语言，且整段红/绿块不需要按目标文件类型高亮，保持和 FileViewer 现有 git diff 视图一致的纯着色风格）。

## 测试

纯前端展示层，手动验证：
- 正常 Edit（单行改动 / 多行改动）折叠态显示 `+N -M`，展开后红块在上、绿块在下。
- 失败 Edit（构造 old_string 不唯一的场景）仍显示原有错误文本，不出现 diff。
- 超长 diff 内容可滚动，卡片不撑高整个消息流。
- 折叠/展开交互与其他工具卡片行为一致。
- FileViewer 里打开 git diff（GitPanel → 点击文件）视觉效果与迁移前一致（回归）。
