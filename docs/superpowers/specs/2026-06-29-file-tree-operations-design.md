# 设计文档：文件树复制/剪切/拖拽移动

**日期**：2026-06-29  
**状态**：已批准

---

## 需求概述

为文件树（FileTree + TreeNodeItem）添加以下能力：

1. **复制**：右键文件/目录 → 复制，右键目标目录 → 粘贴（执行文件/目录复制）
2. **剪切**：右键文件/目录 → 剪切，右键目标目录 → 粘贴（执行移动）
3. **拖拽移动**：拖拽任意节点到目标文件夹 → 弹确认框 → 确认后移动
4. **冲突处理**：目标已存在同名时弹窗询问覆盖或取消
5. **视觉反馈**：拖拽时目标文件夹整行高亮 + 节点间显示插入线；被剪切节点半透明

---

## 方案选型

采用**方案 A：模块级剪贴板单例 + HTML5 原生拖拽**，和项目现有架构（`useSessionState`、`useGit` 等模块级 reactive 单例）完全一致。

---

## 第一节：后端 Rust（`filesystem.rs` + `lib.rs`）

### 新增命令

#### `copy_file(src: String, dest: String) -> Result<(), String>`

- `dest` 为含文件名的完整目标路径，由前端拼接
- 文件：`fs::copy(src, dest)`
- 目录：递归遍历 + `fs::copy` 每个条目（`fs::create_dir_all` 创建目录结构）
- 若 `dest` 已存在 → 返回 `Err("EXISTS:<filename>")`（前端识别 `EXISTS:` 前缀）

#### `move_file(src: String, dest: String) -> Result<(), String>`

- 优先 `fs::rename`（同盘 O(1)）
- 跨盘 fallback：先 copy 再 `fs::remove_file`/`fs::remove_dir_all`
- 若 `dest` 已存在 → 返回 `Err("EXISTS:<filename>")`

两个命令均无需 `CREATE_NO_WINDOW`（不 spawn 外部进程，纯 Rust std fs 操作）。

在 `lib.rs` 的 `.invoke_handler` 中注册：`copy_file`、`move_file`。

---

## 第二节：前端状态层 `useFileClipboard.ts`

新建 `src/composables/useFileClipboard.ts`，模块级单例：

```ts
interface ClipboardEntry {
  op: 'copy' | 'cut';
  path: string;
}

const clipboard = ref<ClipboardEntry | null>(null);

export function useFileClipboard() {
  function copy(path: string) { clipboard.value = { op: 'copy', path }; }
  function cut(path: string)  { clipboard.value = { op: 'cut',  path }; }
  function clear()            { clipboard.value = null; }
  return { clipboard: readonly(clipboard), copy, cut, clear };
}
```

**被剪切节点的样式**：`TreeNodeItem.vue` 中当 `clipboard.op === 'cut' && clipboard.path === node.path` 时，给 `.tree-node` 加 `opacity: 0.45`。

---

## 第三节：右键菜单扩展（`contextMenus.ts`）

### `fileMenuItems` 变更

在"复制路径"/"复制相对路径"下方新增分隔线和操作：

```
──────────
复制              → clipboard.copy(path)
剪切              → clipboard.cut(path)
```

### `directoryMenuItems` 变更

在"新建文件夹"下方新增（仅当 `clipboard` 非空时显示）：

```
──────────
粘贴              → executePaste(targetDir, clipboard, onRefreshSrc, onRefreshDest)
```

### `executePaste` 公共函数

提取为独立函数供菜单和拖拽共用：

```ts
async function executePaste(
  targetDir: string,
  entry: ClipboardEntry,
  onRefreshSrc: () => void,
  onRefreshDest: () => void,
): Promise<void>
```

流程：
1. 拼接 `dest = targetDir + pathSep + basename(entry.path)`
2. 调用 `api.copyFile(src, dest)` 或 `api.moveFile(src, dest)`
3. 若返回错误含 `EXISTS:` → 弹冲突弹窗："目标已存在「xxx」，是否覆盖？"（danger confirm）
   - 确认：`api.deleteFile(dest)` 后重新执行
   - 取消：abort
4. 成功后：`clipboard.clear()`，调 `onRefreshDest()`，若为 cut 还调 `onRefreshSrc()`

---

## 第四节：拖拽 UX（`TreeNodeItem.vue`）

### 拖拽源

所有节点加 `draggable="true"`：

```
dragstart → dataTransfer.setData('text/plain', node.path)
            clipboard.cut(node.path)   // 拖拽视为剪切
```

### 拖拽目标

`dragover`（阻止默认行为以允许 drop）：

- 目标为**文件夹** → 给该行加 `.drag-over-folder`（背景高亮）
- 目标为**文件** → 根据 `event.offsetY < 13`（行高 26px 的一半）判断上/下半，给行加 `.drag-insert-top` 或 `.drag-insert-bottom`；实际 drop 目标记为该文件的父目录

`dragleave` → 清除所有拖拽样式

`drop`：
1. 清除拖拽样式
2. 取 `dataTransfer.getData('text/plain')` 作为源路径
3. 确定目标目录（文件夹节点 = 自身，文件节点 = 父目录）
4. 若源路径 === 目标目录 → 忽略
5. 弹确认框："确定要将「A」移动到「B」吗？"（非 danger）
6. 确认后调 `executePaste`（op = 'cut'）

### 拖拽样式（scoped CSS）

```css
.tree-node.drag-over-folder {
  background: var(--aide-accent-subtle);
  outline: 1px solid var(--aide-accent);
  outline-offset: -1px;
}

.tree-node.drag-insert-top::before {
  content: '';
  position: absolute;
  top: 0; left: 8px; right: 8px;
  height: 2px;
  background: var(--aide-accent);
  border-radius: 1px;
}

.tree-node.drag-insert-bottom::after {
  content: '';
  position: absolute;
  bottom: 0; left: 8px; right: 8px;
  height: 2px;
  background: var(--aide-accent);
  border-radius: 1px;
}
```

---

## 变更文件清单

| 文件 | 变更类型 |
|------|---------|
| `src-tauri/src/commands/filesystem.rs` | 新增 `copy_file`、`move_file` 命令 |
| `src-tauri/src/lib.rs` | 注册新命令 |
| `src/composables/useFileClipboard.ts` | 新建 |
| `src/api.ts` | 新增 `copyFile`、`moveFile` |
| `src/menus/contextMenus.ts` | 扩展文件/目录菜单；新增 `executePaste` |
| `src/components/TreeNodeItem.vue` | 拖拽事件、样式、剪切态半透明 |

---

## 边界条件

- 拖拽节点到自身所在目录 → 静默忽略（不弹框）
- 拖拽目录到其自身子目录 → 前端检测（`dest.startsWith(src + sep)`）→ 弹错误提示
- 跨工作区操作：当前设计仅在当前工作区内操作，无跨工作区需求
- 根目录不可被移动/删除（`path === projectRoot` 时不显示剪切）
