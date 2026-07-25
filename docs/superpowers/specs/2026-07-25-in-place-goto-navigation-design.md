# 设计：跳转定义/引用改为窗口内导航栈（就地覆盖 + 后退）

日期：2026-07-25
状态：已获用户确认，待实施

## 背景与问题

文件编辑器里 Ctrl+点击符号（或快捷键）触发「跳转到定义/引用」后，结果浮层（goto popover）里点击某条结果，当前实现走 `jumpToResult → openAndScrollTo → open()`，**新开一个文件窗口**。跳转几层之后窗口堆里全是一次性的跳转落点，用户要手动逐个关闭。

目标交互（用户原话）：点击引用跳转**不新开窗口**，像堆栈一样直接覆盖当前窗口显示的文件，标题栏提供**后退箭头**，每后退一步弹掉栈顶元素，逐级回到来路。语义对齐 VS Code 的「Go to Definition + Go Back」，但作用域限定在单个窗口内。

## 适用范围

- **只改「跳转定义 / 搜索所有引用」结果落点**（`FileWindow.vue` 的 `jumpToResult`）。
- 文件树点击、聊天文件链接、`openInBrowser` 等其他打开入口维持现状（新开/聚焦窗口）。
- goto 结果浮层（popover）本身不变：仍在触发窗口内渲染，`gotoOwnerId` 归属逻辑不动。

## 已确认的关键决策

1. **仅后退，无前进**（YAGNI）；栈空时后退箭头隐藏。
2. **脏文件跳转：未保存修改随栈保留**——压栈时快照 `editContent`，后退时原样恢复，不打断心流、不弹保存框。
3. **同文件内跳转也压栈**（定义就在本文件另一行时，后退回原行）。
4. **目标文件已在另一个窗口打开时退化**：不就地覆盖、不入栈，改为聚焦那个窗口并滚动到目标行——保住「同一磁盘路径 + 同一 virtual 属性只有一个窗口」的现有不变量，避免两窗口各持一份未保存修改互相覆盖。
5. **关窗即清栈**：栈是 `FileWindowState` 的字段，随窗口对象销毁，无额外清理、无泄漏；但关窗前要检查栈中是否压着 dirty entry（见「关窗检查」）。

## 数据层：`useFileViewer.ts`

### 类型

```ts
export interface NavEntry {
  filePath: string;
  /** 压栈时的未保存内容；与 content 相等表示当时干净 */
  editContent: string;
  /** 磁盘基线——恢复后 dirty 判定靠 editContent !== content 自然成立 */
  content: string;
  /** 触发跳转时光标所在行（后退落点）；未知为 null */
  line: number | null;
  /** markdown 三态随栈恢复 */
  mdMode: MarkdownMode;
}
```

`FileWindowState` 新增字段：

```ts
/** 跳转定义/引用的后退栈：栈顶 = 上一个位置；空 = 未发生过就地跳转 */
navStack: NavEntry[];
```

`open()` 创建窗口时初始化为 `[]`。

### 重构：`loadIntoWindow(win, path)`

把 `open()` 里「按路径读取文件并填充窗口字段」的部分（图片分支 / 文本读取 / `MAX_EDITABLE_SIZE` 只读判定 / error 捕获 / isMarkdown 判定 / `useRecent().recordFile`）抽成内部函数 `loadIntoWindow(win, path)`，`open()` 与导航动作共用。职责：重置 `error/imageUrl/readonly/language/diffPair/content/editContent/isMarkdown/mdMode`（mdMode 由调用方决定用默认值还是恢复值），按路径重新填充。

### 新动作

```ts
navigateInPlace(winId: string, targetPath: string, line: number | null): Promise<void>
```

1. 目标已在**另一个**非虚拟窗口打开（`w.id !== winId && w.filePath === targetPath && !w.virtual`）→ `focusWindow(thatId)` + 对其设 `scrollToLine = line`，**不入栈**，返回。
2. 否则快照当前状态压栈：`{ filePath, editContent, content, line: 触发跳转的光标行, mdMode }`。
3. `loadIntoWindow(win, targetPath)`，mdMode 用默认规则（markdown → preview），然后 `win.scrollToLine = line`（只读/出错不设，与 `openAndScrollTo` 一致）。

```ts
navigateBack(winId: string): Promise<void>
```

1. 栈空 → no-op。
2. 弹栈顶 entry，`loadIntoWindow(win, entry.filePath)` 恢复文件，随后**用 entry 覆盖**：`win.editContent = entry.editContent; win.content = entry.content; win.mdMode = entry.mdMode`。未保存修改由此恢复，dirty 指示自动正确。
3. `win.scrollToLine = entry.line`（为 null 则不设——既有 `v-scroll-memory` / `cmScrollMemory` 按文件路径做 key，滚动位置自动恢复）。

```ts
navStackHasDirty(win: FileWindowState): boolean
```

栈中是否存在 `editContent !== content` 的 entry，供关窗检查。

`closeWindow` 不改：栈随窗口对象销毁。

## 组件层：`FileWindow.vue`

### 跳转入口改造

`jumpToResult(item)` 改为：

- 记录触发跳转时的光标行（`onGotoDefinition` 的 `payload.line` 存入局部 ref；从「搜索所有引用」浮层进来时该值为 null）。
- 调 `navigateInPlace(props.win.id, fullPath, item.symbol.line)`，不再 `openAndScrollTo`。
- 浮层 `goto.dismiss()` 逻辑不变。

### 后退箭头

标题栏最左侧（dirty 圆点之前）加按钮：

- `v-if="win.navStack.length > 0"`。
- 左箭头 SVG 图标，样式复用 `fw-icon-btn`。
- `v-tooltip="'返回到 ' + 栈顶文件名"`。
- 点击 → `navigateBack(props.win.id)`。

### 关窗检查

`requestClose` 的脏检查从 `dirty` 扩为 `dirty || navStackHasDirty(win)`：

- 仅栈内 dirty（当前文件干净）时，提示文案注明「跳转前打开的文件有未保存修改」。
- 「保存并关闭」只保存当前显示的文件；栈内 dirty buffer 随关窗放弃（文案中说明）。「放弃修改」全丢。「取消」不关。

### 快捷键

现有 `onKeydown` 加一支：`Alt+←` → `navigateBack(props.win.id)`（栈空时 no-op）。

## 错误处理与边界

- **目标文件读取失败**：`loadIntoWindow` 把异常写进 `win.error`，栈已压入不弹出——窗口显示错误，用户点后退即回原文件，状态无损。
- **后退时原路径已被别的窗口打开**（跳转走后用户又从文件树打开了它）：不查重、照常就地恢复。接受该边界（概率极小；两窗口同路径时保存后者覆盖前者，与主流编辑器行为一致）。设计文档明示，代码注释标注。
- **图片 / 虚拟（diff）/ 大文件只读窗口**：无编辑器、无 goto 入口，永远不会成为压栈来源；但作为跳转**目标**时可以正常显示，后退同样可恢复。
- **栈不设上限**：跳转深度实际很浅；entry 最大为一份文件内容（文本），关窗即释放。
- **窗口关闭**：栈随 `FileWindowState` 销毁，无清理代码。

## 测试

`useFileViewer` 已有 `__resetForTest` 基建，新增单测（mock `api`）：

1. `navigateInPlace` 压栈：目标文件加载进同一窗口、`scrollToLine` 正确、栈长 +1、栈顶快照内容/行号/mdMode 正确。
2. 脏文件压栈 → `navigateBack` 恢复 `editContent`，dirty 态正确重现。
3. 干净文件压栈 → 后退后非 dirty。
4. 同文件跳转（targetPath === 当前 filePath）正常压栈/回退。
5. 目标已在另一窗口打开 → 聚焦该窗口、本窗口内容与栈不变。
6. `loadIntoWindow` 读目标失败 → `win.error` 有值、栈保留、`navigateBack` 可恢复。
7. `navStackHasDirty` 判定。
8. 关窗后 `windows` 中无残留（栈随对象销毁，无需断言栈本身）。

组件层手动验收：

1. 编辑器里跳定义 → 同窗口覆盖、出现后退箭头 → 后退回到原文件原行。
2. 连续多级跳转，逐级后退直到箭头消失。
3. 改几行不保存 → 跳定义 → 后退 → 修改还在、dirty 圆点复现。
4. 栈内有 dirty 时关窗 → 弹提示；取消不关。
5. 目标文件已在另一窗口开着时跳定义 → 聚焦那个窗口，本窗口不变。
6. `Alt+←` 等价于点箭头。
7. 双主题（warm-dark / catppuccin）下箭头与 tooltip 配色正确（全 `--aide-*` token，禁硬编码）。

## 影响面

- `src/composables/useFileViewer.ts`：NavEntry 类型、navStack 字段、`loadIntoWindow` 重构、三个新动作。
- `src/components/fileviewer/FileWindow.vue`：jumpToResult 改道、后退箭头按钮、requestClose 增强、Alt+← 快捷键。
- 测试并入已有的 `src/composables/useFileViewer.test.ts`。
- 不动 IPC 协议、不动 sidecar、不动 Rust——纯前端状态层改造，天然满足 provider-agnostic 红线。
