# 文件树操作（复制/剪切/拖拽移动）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为文件树添加复制、剪切、粘贴（右键菜单 + 快捷键 Ctrl+C/X/V/Esc）和拖拽移动功能。

**Architecture:** 模块级剪贴板单例 `useFileClipboard.ts` 持有复制/剪切状态和 `executePaste` 逻辑；Rust 后端新增 `copy_file` / `move_file` 命令；`TreeNodeItem.vue` 加 HTML5 拖拽；`FileTree.vue` 加键盘处理。

**Tech Stack:** Tauri v2, Vue 3 Composition API, TypeScript, Rust `std::fs`

## Global Constraints

- Rust 新命令使用纯 `std::fs`，不 spawn 外部进程，无需 `CREATE_NO_WINDOW`
- 错误协议：Rust 返回 `Err("EXISTS:<filename>")` 表示目标已存在，前端识别 `EXISTS:` 前缀
- 所有 composable 遵循模块级 reactive 单例模式（参见 `useSessionState`、`useGit`）
- 右键菜单工厂函数每次右键调用时重新执行，reactive 读取在调用时发生
- 路径分隔符：通过 `path.includes("\\")` 检测，与输入保持一致

---

### Task 1: Rust `copy_file` + `move_file` + API 绑定

**Files:**
- Modify: `src-tauri/src/commands/filesystem.rs`（`create_dir` 函数之后，`// ── grep_symbol` 注释之前）
- Modify: `src-tauri/src/lib.rs`（`commands::filesystem::file_exists,` 一行之后）
- Modify: `src/api.ts`（`fileExists` 方法之后）

**Interfaces:**
- Produces: `api.copyFile(src: string, dest: string): Promise<void>`
- Produces: `api.moveFile(src: string, dest: string): Promise<void>`
- 两者均在失败时 throw；`"EXISTS:<filename>"` 前缀表示冲突

- [ ] **Step 1: 在 `filesystem.rs` 中插入 `copy_dir_recursive`、`copy_file`、`move_file`**

在 `create_dir` 函数结束后（约第 312 行）、`// ── grep_symbol` 注释之前，插入：

```rust
fn copy_dir_recursive(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("Failed to create dir: {}", e))?;
    for entry in fs::read_dir(src).map_err(|e| format!("Failed to read dir: {}", e))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_child = entry.path();
        let dest_child = dest.join(entry.file_name());
        if src_child.is_dir() {
            copy_dir_recursive(&src_child, &dest_child)?;
        } else {
            fs::copy(&src_child, &dest_child)
                .map_err(|e| format!("Failed to copy {}: {}", src_child.display(), e))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn copy_file(src: String, dest: String) -> Result<(), String> {
    let src_path = PathBuf::from(&src);
    let dest_path = PathBuf::from(&dest);
    if dest_path.exists() {
        let name = dest_path.file_name().unwrap_or_default().to_string_lossy().to_string();
        return Err(format!("EXISTS:{}", name));
    }
    if src_path.is_dir() {
        copy_dir_recursive(&src_path, &dest_path)
    } else {
        fs::copy(&src_path, &dest_path)
            .map(|_| ())
            .map_err(|e| format!("Failed to copy: {}", e))
    }
}

#[tauri::command]
pub fn move_file(src: String, dest: String) -> Result<(), String> {
    let src_path = PathBuf::from(&src);
    let dest_path = PathBuf::from(&dest);
    if dest_path.exists() {
        let name = dest_path.file_name().unwrap_or_default().to_string_lossy().to_string();
        return Err(format!("EXISTS:{}", name));
    }
    // 同盘快速路径
    if fs::rename(&src_path, &dest_path).is_ok() {
        return Ok(());
    }
    // 跨盘 fallback：复制后删除源
    if src_path.is_dir() {
        copy_dir_recursive(&src_path, &dest_path)?;
        fs::remove_dir_all(&src_path)
            .map_err(|e| format!("Failed to remove source dir: {}", e))?;
    } else {
        fs::copy(&src_path, &dest_path)
            .map_err(|e| format!("Failed to copy: {}", e))?;
        fs::remove_file(&src_path)
            .map_err(|e| format!("Failed to remove source: {}", e))?;
    }
    Ok(())
}
```

- [ ] **Step 2: 在 `lib.rs` 注册两个新命令**

找到 `commands::filesystem::file_exists,` 这一行，在其后紧接着加：

```rust
            commands::filesystem::copy_file,
            commands::filesystem::move_file,
```

- [ ] **Step 3: 验证 Rust 编译通过**

```bash
cd src-tauri && cargo build
```

Expected: 无编译错误（`unused import` 警告可忽略）

- [ ] **Step 4: 在 `src/api.ts` 添加 API 方法**

找到 `fileExists(path: string): Promise<boolean> { ... },` 这一行，在其后加：

```ts
  copyFile(src: string, dest: string): Promise<void> {
    return invoke("copy_file", { src, dest });
  },
  moveFile(src: string, dest: string): Promise<void> {
    return invoke("move_file", { src, dest });
  },
```

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/commands/filesystem.rs src-tauri/src/lib.rs src/api.ts
git commit -m "feat: add copy_file and move_file Rust commands + api bindings"
```

---

### Task 2: `useFileClipboard.ts` 剪贴板 composable

**Files:**
- Create: `src/composables/useFileClipboard.ts`

**Interfaces:**
- Produces: `useFileClipboard()` → `{ clipboard, copy, cut, clear, executePaste }`
- Produces: `getParentPath(path: string): string`（命名导出，供其他文件使用）
- `clipboard`: `Readonly<Ref<ClipboardEntry | null>>`
- `executePaste(targetDir, onRefreshSrc, onRefreshDest): Promise<void>` — 读取 `clipboard.value`、处理冲突弹窗、成功后调用 `clear()`

- [ ] **Step 1: 创建 `src/composables/useFileClipboard.ts`**

```ts
import { ref, readonly } from "vue";
import { api } from "../api";
import { useModal } from "./useModal";

export interface ClipboardEntry {
  op: 'copy' | 'cut';
  path: string;
}

const clipboard = ref<ClipboardEntry | null>(null);
const modal = useModal();

export function getParentPath(path: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  const i = path.lastIndexOf(sep);
  return i > 0 ? path.slice(0, i) : path;
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

export function useFileClipboard() {
  function copy(path: string) { clipboard.value = { op: 'copy', path }; }
  function cut(path: string)  { clipboard.value = { op: 'cut',  path }; }
  function clear()            { clipboard.value = null; }

  async function executePaste(
    targetDir: string,
    onRefreshSrc: () => void,
    onRefreshDest: () => void,
  ): Promise<void> {
    const entry = clipboard.value;
    if (!entry) return;

    const sep = targetDir.includes("\\") ? "\\" : "/";
    const dest = `${targetDir}${sep}${basename(entry.path)}`;

    // 粘贴到相同位置是空操作
    if (entry.path === dest) { clear(); return; }

    async function doOp() {
      if (entry.op === 'copy') {
        await api.copyFile(entry.path, dest);
      } else {
        await api.moveFile(entry.path, dest);
      }
    }

    try {
      await doOp();
    } catch (err) {
      const msg = String(err);
      if (msg.startsWith("EXISTS:")) {
        const filename = msg.slice("EXISTS:".length);
        const ok = await modal.confirm(
          "目标已存在",
          `目标已存在「${filename}」，是否覆盖？`,
          "覆盖",
          true,
        );
        if (!ok) return;
        await api.deleteFile(dest);
        await doOp();
      } else {
        throw err;
      }
    }

    clear();
    onRefreshDest();
    if (entry.op === 'cut') onRefreshSrc();
  }

  return { clipboard: readonly(clipboard), copy, cut, clear, executePaste };
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
pnpm tsc --noEmit
```

Expected: 无与 `useFileClipboard.ts` 相关的错误

- [ ] **Step 3: 提交**

```bash
git add src/composables/useFileClipboard.ts
git commit -m "feat: add useFileClipboard composable (clipboard state + executePaste)"
```

---

### Task 3: 右键菜单新增复制/剪切/粘贴

**Files:**
- Modify: `src/menus/contextMenus.ts`

**Interfaces:**
- Consumes: `useFileClipboard`, `getParentPath` from `../composables/useFileClipboard`
- 变更 `directoryMenuItems` 签名：新增第 6 个可选参数 `refreshDir?: (path: string) => void`

- [ ] **Step 1: 更新 `contextMenus.ts` 的 import 和模块级实例**

在文件顶部已有的 import 后，追加：

```ts
import { useFileClipboard, getParentPath } from "../composables/useFileClipboard";
```

在 `const modal = useModal();` 后追加：

```ts
const cb = useFileClipboard();
```

- [ ] **Step 2: 在 `fileMenuItems` 中添加复制/剪切菜单项**

找到文件菜单中已有的 `sep()` + "删除" 两行，在 `sep()` 之前插入：

```ts
    sep(),
    { label: "复制", action: () => cb.copy(path) },
    { label: "剪切", action: () => cb.cut(path) },
```

最终文件菜单结构（`fileMenuItems` 返回数组）：

```ts
  return [
    { label: "查看/编辑", action: () => viewer.open(path) },
    { label: "其他方式打开", action: () => api.fileOpen(path) },
    { label: "在文件资源管理器中打开", action: () => api.showInExplorer(path) },
    ...(sessionId ? [{
      label: "添加到对话",
      action: () => api.ptyWrite(sessionId, `@${relPath} `).catch(() => {}),
    }] : []),
    { label: "复制路径", action: () => navigator.clipboard.writeText(path) },
    {
      label: "复制相对路径",
      action: () => {
        const rel = path.startsWith(projectRoot)
          ? path.slice(projectRoot.length).replace(/^[/\\]/, "")
          : path;
        navigator.clipboard.writeText(rel);
      },
    },
    sep(),
    { label: "复制", action: () => cb.copy(path) },
    { label: "剪切", action: () => cb.cut(path) },
    sep(),
    {
      label: "删除",
      danger: true,
      action: async () => {
        const ok = await modal.confirm("删除文件", `确定要删除「${fileName}」吗？`, "删除", true);
        if (!ok) return;
        await api.deleteFile(path);
        onDeleted?.();
      },
    },
  ];
```

- [ ] **Step 3: 更新 `directoryMenuItems` 签名并添加粘贴项**

将函数签名从：

```ts
export function directoryMenuItems(
  path: string,
  projectRoot: string,
  onToggle?: () => void,
  onRefresh?: () => void,
  onDeleted?: () => void,
): MenuItem[]
```

改为：

```ts
export function directoryMenuItems(
  path: string,
  projectRoot: string,
  onToggle?: () => void,
  onRefresh?: () => void,
  onDeleted?: () => void,
  refreshDir?: (dirPath: string) => void,
): MenuItem[]
```

在"新建文件夹"项之后、最后的 `sep()` + "删除" 之前，添加粘贴项（条件渲染）：

```ts
    ...(cb.clipboard.value ? [
      sep(),
      {
        label: "粘贴",
        action: async () => {
          const entry = cb.clipboard.value;
          if (!entry) return;
          const srcParent = getParentPath(entry.path);
          await cb.executePaste(
            path,
            () => (refreshDir ? refreshDir(srcParent) : onRefresh?.()),
            () => onRefresh?.(),
          );
        },
      },
    ] : []),
```

最终 `directoryMenuItems` 返回数组结构（含复制/剪切/粘贴）：

```ts
  return [
    { label: "展开/折叠", action: onToggle },
    { label: "在文件资源管理器中打开", action: () => api.showInExplorer(path) },
    { label: "复制路径", action: () => navigator.clipboard.writeText(path) },
    sep(),
    {
      label: "新建文件",
      action: async () => {
        const name = await modal.prompt("新建文件", "输入文件名...", "创建");
        if (!name) return;
        await api.createFile(path, name);
        onRefresh?.();
      },
    },
    {
      label: "新建文件夹",
      action: async () => {
        const name = await modal.prompt("新建文件夹", "输入文件夹名...", "创建");
        if (!name) return;
        await api.createDir(path, name);
        onRefresh?.();
      },
    },
    sep(),
    { label: "复制", action: () => cb.copy(path) },
    // 根目录不可剪切
    ...(path !== projectRoot ? [{ label: "剪切", action: () => cb.cut(path) }] : []),
    ...(cb.clipboard.value ? [
      {
        label: "粘贴",
        action: async () => {
          const entry = cb.clipboard.value;
          if (!entry) return;
          const srcParent = getParentPath(entry.path);
          await cb.executePaste(
            path,
            () => (refreshDir ? refreshDir(srcParent) : onRefresh?.()),
            () => onRefresh?.(),
          );
        },
      },
    ] : []),
    sep(),
    {
      label: "删除",
      danger: true,
      action: async () => {
        const ok = await modal.confirm("删除文件夹", `确定要删除「${dirName}」及其所有内容吗？`, "删除", true);
        if (!ok) return;
        await api.deleteFile(path);
        onDeleted?.();
      },
    },
  ];
```

- [ ] **Step 4: 更新 `TreeNodeItem.vue` 中 `directoryMenuItems` 的调用，传入第 6 个参数**

找到 `TreeNodeItem.vue` 中调用 `directoryMenuItems` 的地方（`onContextMenu` 函数内），将：

```ts
    : directoryMenuItems(
        props.node.path,
        props.projectRoot,
        () => emit("toggle", props.node.path),
        () => refresh(props.node.path),
        () => refresh(parentPath),
      )
```

改为：

```ts
    : directoryMenuItems(
        props.node.path,
        props.projectRoot,
        () => emit("toggle", props.node.path),
        () => refresh(props.node.path),
        () => refresh(parentPath),
        refresh,
      )
```

- [ ] **Step 5: 验证 TypeScript 编译**

```bash
pnpm tsc --noEmit
```

Expected: 无错误

- [ ] **Step 6: 手动验证右键菜单**

启动应用（`pnpm tauri dev`），在文件树中：
1. 右键一个文件 → 应出现"复制"和"剪切"选项
2. 点"复制" → 右键一个目录 → 应出现"粘贴"选项
3. 点"粘贴" → 文件出现在目标目录中
4. 右键另一个文件点"剪切" → 右键目录点"粘贴" → 文件从源目录消失、出现在目标目录

- [ ] **Step 7: 提交**

```bash
git add src/menus/contextMenus.ts src/components/TreeNodeItem.vue
git commit -m "feat: add copy/cut/paste to file tree context menus"
```

---

### Task 4: `TreeNodeItem.vue` 拖拽移动 + 剪切态视觉

**Files:**
- Modify: `src/components/TreeNodeItem.vue`

**Interfaces:**
- Consumes: `useFileClipboard()` → `{ clipboard, cut, clear, executePaste }` 和 `getParentPath`
- Consumes: `useModal()` → `{ confirm }` （用于无效操作提示）
- 内部状态: `isDragOver: Ref<boolean>`, `insertPos: Ref<'top'|'bottom'|null>`（组件本地 ref）

- [ ] **Step 1: 添加 import**

在 `TreeNodeItem.vue` `<script setup>` 顶部已有的 import 后添加：

```ts
import { ref } from "vue";
import { useFileClipboard, getParentPath } from "../composables/useFileClipboard";
import { useModal } from "../composables/useModal";
```

在 `const { show } = useContextMenu();` 后添加：

```ts
const cb = useFileClipboard();
const modal = useModal();
const { clipboard, cut, clear, executePaste } = cb;

const isDragOver = ref(false);
const insertPos = ref<'top' | 'bottom' | null>(null);
```

- [ ] **Step 2: 添加拖拽事件处理函数**

在 `onContextMenu` 函数之后、`const isExpanded` 之前，插入：

```ts
function onDragStart(e: DragEvent) {
  e.dataTransfer!.setData('text/plain', props.node.path);
  e.dataTransfer!.effectAllowed = 'move';
  cut(props.node.path);
}

function onDragOver(e: DragEvent) {
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'move';
  if (props.node.is_dir) {
    isDragOver.value = true;
    insertPos.value = null;
  } else {
    isDragOver.value = false;
    insertPos.value = (e.offsetY < 13) ? 'top' : 'bottom';
  }
}

function onDragLeave(e: DragEvent) {
  if (e.relatedTarget && (e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) return;
  isDragOver.value = false;
  insertPos.value = null;
}

function onDragEnd(e: DragEvent) {
  // 拖拽取消（Esc 或拖到树外），清空剪贴板
  if (e.dataTransfer?.dropEffect === 'none') clear();
}

async function onDrop(e: DragEvent) {
  e.preventDefault();
  isDragOver.value = false;
  insertPos.value = null;

  const srcPath = e.dataTransfer!.getData('text/plain');
  if (!srcPath) return;

  const targetDir = props.node.is_dir ? props.node.path : getParentPath(props.node.path);
  const srcParent = getParentPath(srcPath);
  const sep = targetDir.includes("\\") ? "\\" : "/";

  // 拖到自身所在目录，忽略
  if (targetDir === srcParent || srcPath === targetDir) {
    clear();
    return;
  }

  // 禁止把目录拖到自身子目录
  if (targetDir.startsWith(srcPath + sep)) {
    await modal.confirm("操作无效", "不能将文件夹移动到其自身的子目录中", "确定", false);
    clear();
    return;
  }

  const srcName = srcPath.split(/[/\\]/).pop() || srcPath;
  const targetName = targetDir.split(/[/\\]/).pop() || targetDir;
  const ok = await modal.confirm(
    "移动文件",
    `确定要将「${srcName}」移动到「${targetName}」吗？`,
    "移动",
    false,
  );
  if (!ok) {
    clear();
    return;
  }

  const refresh = props.onRefreshDir;
  await executePaste(
    targetDir,
    () => refresh(srcParent),
    () => refresh(targetDir),
  );
}
```

- [ ] **Step 3: 更新 template，添加拖拽属性和动态样式**

找到 `.tree-node` 的 `<div>`，将：

```html
    <div
      class="tree-node"
      :class="{ active: node.path === selectedPath }"
      :style="{ paddingLeft: (depth * 18 + 8) + 'px' }"
      @click="handleClick"
      @contextmenu.prevent.stop="onContextMenu"
    >
```

改为：

```html
    <div
      class="tree-node"
      :class="{
        active: node.path === selectedPath,
        'drag-over-folder': isDragOver,
        'drag-insert-top': insertPos === 'top',
        'drag-insert-bottom': insertPos === 'bottom',
        'cut-state': clipboard.value?.op === 'cut' && clipboard.value?.path === node.path,
      }"
      :style="{ paddingLeft: (depth * 18 + 8) + 'px' }"
      draggable="true"
      @click="handleClick"
      @contextmenu.prevent.stop="onContextMenu"
      @dragstart="onDragStart"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @dragend="onDragEnd"
      @drop="onDrop"
    >
```

- [ ] **Step 4: 添加拖拽样式到 `<style scoped>`**

在 `.tree-status.error` 之前（或 `<style scoped>` 末尾）插入：

```css
/* ── 拖拽视觉 ── */

.tree-node.drag-over-folder {
  background: var(--aide-accent-subtle);
  outline: 1px solid var(--aide-accent);
  outline-offset: -1px;
}

.tree-node.drag-insert-top::before {
  content: '';
  position: absolute;
  top: 0;
  left: 8px;
  right: 8px;
  height: 2px;
  background: var(--aide-accent);
  border-radius: 1px;
  pointer-events: none;
}

.tree-node.drag-insert-bottom::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 8px;
  right: 8px;
  height: 2px;
  background: var(--aide-accent);
  border-radius: 1px;
  pointer-events: none;
}

/* 被剪切的节点半透明 */
.tree-node.cut-state {
  opacity: 0.45;
}
```

- [ ] **Step 5: 验证 TypeScript 编译**

```bash
pnpm tsc --noEmit
```

Expected: 无错误

- [ ] **Step 6: 手动验证拖拽**

启动应用，在文件树中：
1. 拖拽一个文件到另一个目录 → 目标目录整行高亮
2. 拖拽经过文件节点 → 顶部/底部出现插入线
3. 放开后弹出确认框"确定要将 X 移动到 Y 吗？"
4. 确认后文件出现在目标目录，从源目录消失
5. 取消 → 文件不移动，剪切态消失
6. 拖拽到同一目录 → 静默忽略，无弹框
7. 拖拽 Esc 取消 → 剪切态消失

- [ ] **Step 7: 提交**

```bash
git add src/components/TreeNodeItem.vue
git commit -m "feat: add drag-to-move and cut visual state to TreeNodeItem"
```

---

### Task 5: `FileTree.vue` 键盘快捷键

**Files:**
- Modify: `src/components/FileTree.vue`

**Interfaces:**
- Consumes: `useFileClipboard()` → `{ clipboard, copy, cut, clear, executePaste }` 和 `getParentPath`

- [ ] **Step 1: 添加 import 和解构**

在 `FileTree.vue` `<script setup>` 顶部，已有 `import { api } from "../api";` 之后添加：

```ts
import { useFileClipboard, getParentPath } from "../composables/useFileClipboard";
```

在 `const fileViewer = useFileViewer();` 之后添加：

```ts
const { clipboard, copy, cut, clear, executePaste } = useFileClipboard();
```

- [ ] **Step 2: 添加键盘处理函数**

在 `defineExpose({ loadRoot });` 之前插入：

```ts
function getSelectedNodeIsDir(): boolean {
  if (!selectedPath.value) return false;
  const node = findNode(treeData.value, selectedPath.value);
  return node?.is_dir ?? false;
}

async function onTreeKeydown(e: KeyboardEvent) {
  if (e.ctrlKey && e.key === 'c') {
    if (!selectedPath.value) return;
    e.preventDefault();
    copy(selectedPath.value);
  } else if (e.ctrlKey && e.key === 'x') {
    if (!selectedPath.value || selectedPath.value === projectInfo.value.root) return;
    e.preventDefault();
    cut(selectedPath.value);
  } else if (e.ctrlKey && e.key === 'v') {
    if (!clipboard.value) return;
    e.preventDefault();
    const targetDir = selectedPath.value
      ? (getSelectedNodeIsDir() ? selectedPath.value : getParentPath(selectedPath.value))
      : projectInfo.value.root;
    const srcParent = getParentPath(clipboard.value.path);
    await executePaste(
      targetDir,
      () => loadChildren(srcParent),
      () => loadChildren(targetDir),
    );
  } else if (e.key === 'Escape') {
    if (!clipboard.value) return;
    e.preventDefault();
    clear();
  }
}
```

- [ ] **Step 3: 更新 template，给 `.tree-content` 加 `tabindex` 和键盘事件**

找到 `<div class="tree-content" @contextmenu="onAreaContextMenu">` 这一行，改为：

```html
    <div class="tree-content" tabindex="0" @contextmenu="onAreaContextMenu" @keydown="onTreeKeydown">
```

- [ ] **Step 4: 验证 TypeScript 编译**

```bash
pnpm tsc --noEmit
```

Expected: 无错误

- [ ] **Step 5: 手动验证快捷键**

启动应用，点击文件树中的一个文件（使树获得焦点）：
1. `Ctrl+C` → 复制该文件（无可见反馈，但剪贴板已设置）
2. 在另一个目录上右键 → 应出现"粘贴"选项 → 点击后文件被复制过去
3. 选中另一个文件，`Ctrl+X` → 文件变半透明（剪切态）
4. 在目标目录右键 → 粘贴 → 文件移动，半透明消失
5. 选中文件，`Ctrl+X`，然后按 `Esc` → 半透明消失，剪切取消
6. `Ctrl+V`（无剪贴板内容时）→ 无反应
7. 根目录上 `Ctrl+X` → 无反应（根目录不可剪切）

- [ ] **Step 6: 提交**

```bash
git add src/components/FileTree.vue
git commit -m "feat: add Ctrl+C/X/V/Esc keyboard shortcuts to file tree"
```

---

## 完整验证清单

完成所有 Task 后，端到端验证：

- [ ] 右键文件 → 复制 → 右键目录 → 粘贴 → 文件出现在目标（原文件保留）
- [ ] 右键文件 → 剪切（文件半透明）→ 右键目录 → 粘贴 → 文件移动，半透明消失
- [ ] 拖拽文件到目录 → 高亮 → 确认弹窗 → 确认 → 移动完成
- [ ] 拖拽文件到同级文件上方/下方 → 插入线 → 确认 → 移入父目录
- [ ] 粘贴时目标同名 → 弹"是否覆盖"→ 确认覆盖 → 目标被替换
- [ ] 粘贴时目标同名 → 取消 → 源文件不变
- [ ] Ctrl+C → Ctrl+V（目标目录 = 选中文件的父目录）
- [ ] Ctrl+X → Esc → 半透明消失
- [ ] 拖拽目录到自身子目录 → 弹"操作无效"提示
- [ ] 拖拽到相同父目录 → 静默忽略
