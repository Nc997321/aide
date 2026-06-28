# 终端文件路径 Ctrl+点击打开 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 xterm.js 终端中，当 Claude 输出包含文件路径的文本时，用户可通过 Ctrl+左键点击该路径，直接在 FileViewer 面板中打开对应文件并跳转到指定行。

**Architecture:** 新增 `useTerminalLinkProvider` composable，封装正则匹配 + hover 验证 + 点击打开逻辑；`useTerminalManager` 接受一个 `onTerminalReady` 回调，在每次创建 terminal 实例后触发，由 `TerminalPanel.vue` 将 link provider 注册进去。

**Tech Stack:** xterm.js 5.x `ILinkProvider` API、Tauri `invoke`、Vue 3 Composition API、Rust `std::path::Path::exists()`

## Global Constraints

- 所有新增 Rust `Command::new(...)` 调用必须加 `CREATE_NO_WINDOW (0x08000000)`（本次新命令不涉及子进程，可豁免，但需遵守）
- xterm.js Terminal 已设置 `allowProposedApi: true`，link provider API 可用
- 相对路径解析以当前 session 的 `workspacePath` prop 为根目录
- 文件不存在时静默忽略，不弹窗、不报错
- Ctrl+Click 才触发打开；普通 click 不响应
- hover 显示下划线（xterm.js 默认行为，只需 provider 返回匹配即可）

---

## 文件变更清单

| 文件 | 类型 | 职责 |
|---|---|---|
| `src-tauri/src/commands/filesystem.rs` | 修改 | 新增 `file_exists` 命令 |
| `src-tauri/src/lib.rs` | 修改 | 注册 `file_exists` 到 invoke_handler |
| `src/api.ts` | 修改 | 新增 `fileExists(path)` 封装 |
| `src/composables/useTerminalLinkProvider.ts` | 新增 | link provider 全部逻辑 |
| `src/composables/useTerminalManager.ts` | 修改 | 新增 `onTerminalReady` 回调参数 |
| `src/components/TerminalPanel.vue` | 修改 | 创建 link provider 并通过回调注册 |

---

### Task 1: Rust `file_exists` 命令

**Files:**
- Modify: `src-tauri/src/commands/filesystem.rs`（末尾追加函数）
- Modify: `src-tauri/src/lib.rs`（invoke_handler 列表）

**Interfaces:**
- Produces: `file_exists(path: String) -> bool`，供 Task 2 的 `api.fileExists()` 调用

- [ ] **Step 1: 在 `filesystem.rs` 末尾追加命令函数**

打开 `src-tauri/src/commands/filesystem.rs`，在文件末尾追加：

```rust
#[tauri::command]
pub fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}
```

- [ ] **Step 2: 在 `lib.rs` 的 invoke_handler 中注册**

打开 `src-tauri/src/lib.rs`，找到 `commands::filesystem::grep_symbol,` 这一行，在其后追加：

```rust
commands::filesystem::file_exists,
```

- [ ] **Step 3: 编译验证**

```bash
cd src-tauri && cargo check
```

期望：无编译错误，`file_exists` 函数被识别。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/filesystem.rs src-tauri/src/lib.rs
git commit -m "feat: add file_exists Tauri command"
```

---

### Task 2: 前端 API 封装 + `useTerminalLinkProvider` composable

**Files:**
- Modify: `src/api.ts`
- Create: `src/composables/useTerminalLinkProvider.ts`

**Interfaces:**
- Consumes: `file_exists` Rust 命令（Task 1）；`useFileViewer().openAndScrollTo(path, line)` 已存在
- Produces:
  ```typescript
  function useTerminalLinkProvider(options: {
    workspacePath: () => string   // getter，避免 Ref 传递问题
    openFile: (path: string, line?: number) => void
  }): {
    registerTo: (terminal: Terminal) => void
  }
  ```

- [ ] **Step 1: 在 `api.ts` 中追加 `fileExists`**

打开 `src/api.ts`，在 `deleteFile` 方法后追加：

```typescript
fileExists(path: string): Promise<boolean> {
  return invoke("file_exists", { path });
},
```

- [ ] **Step 2: 创建 `useTerminalLinkProvider.ts`**

新建 `src/composables/useTerminalLinkProvider.ts`：

```typescript
import type { Terminal, ILink } from "xterm";
import { api } from "../api";

const FILE_PATH_RE =
  /((?:[\w./\\-]+\/)?[\w.-]+\.(ts|tsx|vue|rs|js|jsx|css|scss|json|md|toml|yaml|yml|sh|py))(:\d+)?/g;

interface LinkProviderOptions {
  workspacePath: () => string;
  openFile: (path: string, line?: number) => void;
}

export function useTerminalLinkProvider({ workspacePath, openFile }: LinkProviderOptions) {
  function registerTo(terminal: Terminal) {
    terminal.registerLinkProvider({
      provideLinks(y, callback) {
        const line = terminal.buffer.active.getLine(y);
        if (!line) { callback(undefined); return; }

        const text = line.translateToString(true);
        const links: ILink[] = [];
        let match: RegExpExecArray | null;
        FILE_PATH_RE.lastIndex = 0;

        const pending: Promise<void>[] = [];

        while ((match = FILE_PATH_RE.exec(text)) !== null) {
          const rawPath = match[1];
          const lineNum = match[3] ? parseInt(match[3].slice(1), 10) : undefined;
          const startX = match.index;
          const endX = match.index + match[0].length;

          if (rawPath.startsWith("http://") || rawPath.startsWith("https://")) continue;

          const capturedPath = rawPath;
          const capturedLine = lineNum;
          const capturedText = match[0];

          pending.push(
            (async () => {
              const ws = workspacePath();
              const isAbsolute = capturedPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(capturedPath);
              const fullPath = isAbsolute ? capturedPath : `${ws}/${capturedPath}`.replace(/\\/g, "/");

              const exists = await api.fileExists(fullPath);
              if (!exists) return;

              links.push({
                range: { start: { x: startX + 1, y }, end: { x: endX, y } },
                text: capturedText,
                activate(event: MouseEvent) {
                  if (!event.ctrlKey) return;
                  openFile(fullPath, capturedLine);
                },
              });
            })()
          );
        }

        Promise.all(pending).then(() => callback(links.length ? links : undefined));
      },
    });
  }

  return { registerTo };
}
```

- [ ] **Step 3: 手动检查 TypeScript 编译**

```bash
npx tsc --noEmit
```

期望：无类型错误（xterm.js 的 `ILinkProvider` 已通过 `allowProposedApi: true` 解锁）。

- [ ] **Step 4: Commit**

```bash
git add src/api.ts src/composables/useTerminalLinkProvider.ts
git commit -m "feat: add useTerminalLinkProvider composable and fileExists API"
```

---

### Task 3: 接入 `useTerminalManager` + `TerminalPanel`

**Files:**
- Modify: `src/composables/useTerminalManager.ts`
- Modify: `src/components/TerminalPanel.vue`

**Interfaces:**
- Consumes: `useTerminalLinkProvider({ workspacePath, openFile }).registerTo` (Task 2)
- `useTerminalManager` 新增可选参数：
  ```typescript
  onTerminalReady?: (terminal: Terminal) => void
  ```

- [ ] **Step 1: 修改 `useTerminalManager` 函数签名**

打开 `src/composables/useTerminalManager.ts`，找到：

```typescript
export function useTerminalManager(
  stackRef: { value: HTMLDivElement | undefined },
  previewRef: { value: HTMLDivElement | undefined },
  onSessionUpdated: (newId?: string) => void,
  onShowPreview: (sid: string) => void,
) {
```

替换为：

```typescript
export function useTerminalManager(
  stackRef: { value: HTMLDivElement | undefined },
  previewRef: { value: HTMLDivElement | undefined },
  onSessionUpdated: (newId?: string) => void,
  onShowPreview: (sid: string) => void,
  onTerminalReady?: (terminal: Terminal) => void,
) {
```

- [ ] **Step 2: 在 `makeTerminal` 末尾调用回调**

在 `makeTerminal` 函数内，`terminal.loadAddon(fitAddon)` 之后，`return` 语句之前，追加：

```typescript
onTerminalReady?.(terminal);
```

完整函数变为：

```typescript
function makeTerminal(): { terminal: Terminal; fitAddon: FitAddon } {
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily,
    theme: catppuccinMochaTheme,
    allowProposedApi: true,
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  onTerminalReady?.(terminal);
  return { terminal, fitAddon };
}
```

- [ ] **Step 3: 在 `TerminalPanel.vue` 中接入 link provider**

打开 `src/components/TerminalPanel.vue`，在 `import` 区追加：

```typescript
import { useTerminalLinkProvider } from "../composables/useTerminalLinkProvider";
import { useFileViewer } from "../composables/useFileViewer";
```

在 `useTerminalManager(...)` 调用处，先创建 link provider，再将 `registerTo` 传入：

```typescript
const { open: openFileViewer, openAndScrollTo } = useFileViewer();

const { registerTo } = useTerminalLinkProvider({
  workspacePath: () => props.workspacePath,
  openFile: (path, line) => {
    if (line !== undefined) {
      openAndScrollTo(path, line);
    } else {
      openFileViewer(path);
    }
  },
});

const {
  liveDisplayIds,
  currentSid,
  showSession,
  startClaude,
  stopClaude,
  resetView,
  initPtyListener,
  initExitListener,
  initDragDrop,
  cleanup,
} = useTerminalManager(stackRef, previewRef, (newId) => emit("session-updated", newId), loadPreviewContent, registerTo);
```

- [ ] **Step 4: 手动检查 TypeScript 编译**

```bash
npx tsc --noEmit
```

期望：无类型错误。

- [ ] **Step 5: 启动 dev 服务手动验证**

```bash
pnpm tauri dev
```

验证步骤：
1. 打开一个会话，让 Claude 输出包含文件路径的内容（例如发送 `列出项目中的主要文件`）
2. 将鼠标悬停在输出中的路径（如 `src/components/TerminalPanel.vue`）上——应显示下划线
3. 普通点击路径——FileViewer **不**应打开
4. Ctrl+左键点击路径——FileViewer **应**打开对应文件
5. 若路径带行号（如 `:45`），FileViewer 应跳转到第 45 行
6. 悬停在不存在的路径上——**不**显示下划线

- [ ] **Step 6: Commit**

```bash
git add src/composables/useTerminalManager.ts src/components/TerminalPanel.vue
git commit -m "feat: 终端文件路径 Ctrl+点击打开 FileViewer"
```
