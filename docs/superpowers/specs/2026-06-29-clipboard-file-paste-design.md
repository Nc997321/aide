# 剪贴板粘贴文件/图片到 Claude TUI — 设计

日期：2026-06-29

## 背景与动机

原本「拖文件进终端」的功能（`useTerminalManager.ts` 的 `initDragDrop`，commit `7d85254`）依赖 Tauri 的 `onDragDropEvent`。commit `61210f4` 为修复 Windows 文件树拖拽禁止光标，在主窗口调用了 `disable_drag_drop_handler()`，副作用是 `onDragDropEvent` 永不触发，终端拖放因此失效。

与其在「终端拖放（需 Tauri OLE 开）」与「文件树 HTML5 拖拽（需 OLE 关）」的 Windows 互斥冲突里二选一，改为彻底放弃终端拖放，用 **Ctrl+V / Cmd+V 粘贴** 把文件/图片送进 Claude TUI，跨平台支持。

## 目标

终端聚焦时按粘贴键（macOS `Cmd+V`，其余 `Ctrl+V`），按优先级把剪贴板内容转成 `@路径` 写入当前会话 PTY。支持三类来源：

1. **文件管理器复制的文件**（资源管理器 / Finder / Nautilus）→ 插 `@原路径`。
2. **剪贴板图片**（截图、右键复制图片）→ 写临时 PNG 文件 → 插 `@临时文件`。
3. **Aide 文件树选中的文件**（已有应用内 `useFileClipboard`）→ 插 `@路径`。
4. 以上都空 → 回退为普通文本粘贴。

## 非目标

- 不修复 / 不恢复终端拖放（`initDragDrop` 等死代码删除）。
- 不改动文件树内部 HTML5 拖拽（`disable_drag_drop_handler` 保留）。
- 不做剪贴板历史、不做多图编辑。

## 架构

### Rust 侧：新增 `src-tauri/src/commands/clipboard.rs`

两个命令，在 `lib.rs` 的 `invoke_handler` 注册。

#### `clipboard_read_files() -> Vec<String>`

按 `cfg(target_os)` 分平台读取系统剪贴板中的文件路径，无文件返回空 `Vec`。

- **Windows**：`clipboard-win` crate 读 `CF_HDROP`，返回路径列表。
- **macOS**：`objc2-app-kit` + `objc2-foundation` 读 `NSPasteboard` 的 `public.file-url`（`NSPasteboard.readObjectsForClasses:options:` 取 `NSURL`，过滤 `isFileURL`，取 `path`）。
- **Linux**：用已有 `which` crate 探测剪贴板工具：
  - Wayland：`wl-paste --type text/uri-list`，回退 `x-special/gnome-copied-files`。
  - X11：`xclip -selection clipboard -o -t text/uri-list`，回退 `xsel -ob` 同类型。
  - 解析每行 `file://` URI，`percent_decode` 后转本地路径。
  - `x-special/gnome-copied-files` 格式：首行 `copy`/`cut`，后续为 `file://` URI，忽略首行取 URI。
  - 工具不存在或命令失败 → 返回空 `Vec`（静默）。

所有平台读取失败统一静默返回空，不抛错。

#### `clipboard_read_image() -> Option<String>`

跨平台用 `arboard` crate 读位图。

- 有图：编码为 PNG，写入 `{temp_dir}/aide-clipboard/img-{nanos}.png`（`nanos` 来自 Rust `SystemTime`，保证唯一），返回该绝对路径。
- 无图 / 编码失败：返回 `None`。
- 目录不存在则创建（`fs::create_dir_all`）。

### 依赖变更（`src-tauri/Cargo.toml`）

新增：
- `arboard = "1"`（跨平台图片读取；macOS 会间接依赖 `objc2` 系列）。
- `clipboard-win = "5"`（仅 Windows，`cfg`）。
- `objc2-app-kit`、`objc2-foundation`（仅 macOS，`cfg`；按 arboard 兼容版本选）。
- `percent-encoding = "2"`（仅 Linux，`cfg`，解析 `file://` URI）。

`which = "7"` 已存在。具体版本号在实现时按编译结果对齐。

### 前端：`useTerminalManager.ts`

1. **挂键拦截**：在 `makeTerminal()` 创建的每个 terminal 上调 `terminal.attachCustomKeyEventHandler(onKey)`。`onKey` 仅处理 `keydown`，判定粘贴键：
   - `navigator.platform` 含 `Mac` → `e.metaKey && e.key === 'v'`（不区分大小写）。
   - 其余 → `e.ctrlKey && e.key === 'v'`。
   - 命中则 `e.preventDefault()` 并 `return false`（阻止 xterm 默认 `\x16` / 浏览器粘贴），异步执行 `handlePaste(ptyId)`；其余键 `return true`。
2. **`handlePaste(ptyId)` 优先级判定**（抽成纯函数 `resolvePastePayload` 便于单测）：
   ```
   files = await api.clipboardReadFiles()
   if files.length: return files.map(p => '@'+p).join(' ') + ' '
   img = await api.clipboardReadImage()
   if img: return '@' + img + ' '
   entry = useFileClipboard clipboard.value   // op === 'copy'
   if entry: return '@' + entry.path + ' '
   text = await readClipboardText()            // navigator.clipboard.readText，失败返回 ''
   return text
   ```
   结果非空则 `api.ptyWrite(ptyId, payload).catch(() => {})`，复用现有写入通道。
3. **`useFileClipboard` 访问**：`clipboard` ref 当前为模块级 `ref`，但通过 `useFileClipboard()` 取会重复创建 `useModal`。新增一个轻量导出 `peekFileClipboard(): ClipboardEntry | null`（或直接 export readonly ref），供终端读取，不 `clear()`（不影响文件树移动语义）。
4. **删除死拖放代码**：移除 `initDragDrop` / `handleFileDrop` / `showDropOverlay` / `hideDropOverlay` / `isOverTerminalStack` / `unlistenDrop` / `dropOverlay`，及返回对象中的 `initDragDrop`；同步删 `TerminalPanel.vue` 对 `initDragDrop` 的调用与 `.terminal-drop-overlay*` 样式。

### 数据流

```
用户按 Cmd+V/Ctrl+V（终端聚焦）
  → xterm customKeyHandler 拦截 + preventDefault
  → handlePaste(ptyId)
  → [clipboardReadFiles] → [clipboardReadImage] → [useFileClipboard] → [readText]
  → api.ptyWrite(ptyId, "@... ")
  → Claude TUI 收到 @引用文本，按需读取文件
```

### 错误处理

- Rust 命令：任何平台读取失败静默返回空/`None`，不抛错。
- 前端：每步 `await` 失败回退到下一优先级；最终 `ptyWrite` 失败 `.catch(()=>{})`，与现有风格一致。
- 不弹错误对话框（粘贴是高频低风险操作）。

### 临时图片文件生命周期

- 写入 `{temp_dir}/aide-clipboard/`，**不做主动删除**：截图必须留存到 Claude 处理完 `@` 引用，过早删会导致读取失败。
- 依赖 OS 清理 temp 目录。
- 文件名用纳秒避免并发冲突。

### 测试

- **Rust**：系统剪贴板无可靠单测，按平台手动验证三来源（资源管理器/Finder/Nautilus 复制文件、截图、Aide 文件树复制）。
- **前端**：`resolvePastePayload(files, img, entry, text)` 抽成纯函数，单测断言：
  - 有 files → `@p1 @p2 `。
  - files 空 + 有 img → `@<temp> `。
  - 仅 entry → `@<path> `。
  - 全空 + text → 原文本。
  - 全空 → `''`（不写）。

## 待实现时核实

- `clipboard-win` / `objc2-app-kit` / `arboard` 具体 API（受网络限制无法在线查 docs.rs，按本地 `cargo doc` / 编译报错对齐）。
- macOS 是否需同时读旧 `NSFilenamesPboardType`（老版 Finder）——优先 `public.file-url`，必要时补。
- Linux `x-special/gnome-copied-files` 在不同文件管理器下的差异。