# 剪贴板粘贴文件/图片到 Claude TUI — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 终端聚焦时按 Ctrl+V / Cmd+V，按优先级把系统剪贴板文件、剪贴板图片、Aide 文件树选中文件转成 `@路径` 写入当前会话 PTY，全空则回退普通文本粘贴。

**Architecture:** 新增 Rust 命令模块 `commands/clipboard.rs`（`clipboard_read_files` 按 cfg 分平台读文件路径；`clipboard_read_image` 用 arboard 跨平台读位图写临时 PNG）。前端在 `useTerminalManager` 用 `attachCustomKeyEventHandler` 拦截粘贴键，调用纯函数 `resolvePastePayload` 决定写入内容，复用 `api.ptyWrite`。同时移除已失效的拖放代码。

**Tech Stack:** Rust + Tauri v2、`arboard`（跨平台图片）、`clipboard-win`（Windows）、`objc2-app-kit`/`objc2-foundation`（macOS）、`percent-encoding`（URI 解析）、`which`（Linux 工具探测）；前端 Vue 3 + xterm.js + vitest（新增）。

## Global Constraints

- 跨平台：Windows / macOS / Linux 都要工作。Windows 是当前开发机，可编译验证；macOS objc2 与 Linux shell-out 代码在 Windows 上被 `cfg` 排除、**不参与编译**，必须在目标 OS 上构建验证（计划中明确标注）。
- Windows 子进程必须加 `CREATE_NO_WINDOW (0x08000000)`（CLAUDE.md 必读坑点）——Linux shell-out 用 `std::process::Command`，无此标志。
- 平台依赖必须用 target-specific 段声明（`[target.'cfg(windows)'.dependencies]` 等），否则 macOS-only crate 会在 Windows 构建失败。
- `percent-encoding` 声明为**通用依赖**（纯 Rust，全平台可编译），以便纯函数 `parse_uri_list` 在 Windows 上也能 `cargo test`。
- 读取失败一律静默返回空 / `None`，不抛错；前端每步失败回退下一优先级。
- 临时图片写 `{temp_dir}/aide-clipboard/img-<nanos>.png`，不主动删除。
- 保留 `lib.rs` 的 `disable_drag_drop_handler()`；删除终端拖放死代码。

---

## File Structure

- **Create** `src-tauri/src/commands/clipboard.rs` — 两个 Tauri 命令 + 平台读取 + 纯 URI 解析器（含 `#[cfg(test)]`）。
- **Modify** `src-tauri/Cargo.toml` — 加 target-specific 依赖。
- **Modify** `src-tauri/src/commands/mod.rs` — `pub mod clipboard;`。
- **Modify** `src-tauri/src/lib.rs` — 注册两个命令。
- **Modify** `src/api.ts` — 加 `clipboardReadFiles` / `clipboardReadImage`。
- **Modify** `src/composables/useFileClipboard.ts` — 导出 `peekFileClipboard()`。
- **Create** `src/utils/paste.ts` — 纯函数 `resolvePastePayload`。
- **Create** `src/utils/paste.test.ts` + vitest 配置 — TDD。
- **Modify** `src/composables/useTerminalManager.ts` — 挂粘贴键拦截 + `handlePaste`；删拖放代码。
- **Modify** `src/components/TerminalPanel.vue` — 删 `initDragDrop` 调用 + 拖放遮罩样式。

---

### Task 1: Cargo.toml 平台依赖

**Files:**
- Modify: `src-tauri/Cargo.toml`

**Interfaces:**
- Produces: 依赖 `arboard`、`clipboard-win`(win)、`objc2-app-kit`/`objc2-foundation`(macos)、`percent-encoding`(通用)。

- [ ] **Step 1: 编辑 Cargo.toml，加依赖**

在 `[dependencies]` 段追加（通用，全平台编译）：

```toml
arboard = "1"
percent-encoding = "2"
```

在文件末尾追加 target-specific 段：

```toml
[target.'cfg(windows)'.dependencies]
clipboard-win = "5"

[target.'cfg(target_os = "macos")'.dependencies]
objc2 = "0.2"
objc2-app-kit = { version = "0.2", features = ["NSPasteboard", "NSPasteboardItem"] }
objc2-foundation = { version = "0.2", features = ["NSString", "NSURL", "NSArray"] }
```

> 说明：Linux 不需要额外 crate（shell-out + 已有 `which`）。`objc2` 版本以实现时 `cargo build`（macOS）对齐为准；Windows 构建会跳过该段。

- [ ] **Step 2: 验证 Windows 依赖可解析**

Run: `cd src-tauri && cargo fetch`
Expected: 成功拉取 `arboard`、`percent-encoding`、`clipboard-win`；macOS 段不下载（非 macos target）。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml
git commit -m "build: add clipboard crates (arboard, clipboard-win, objc2, percent-encoding)"
```

---

### Task 2: clipboard.rs — `clipboard_read_files` + URI 解析器（TDD）

**Files:**
- Create: `src-tauri/src/commands/clipboard.rs`
- Modify: `src-tauri/src/commands/mod.rs`（加 `pub mod clipboard;`）
- Modify: `src-tauri/src/lib.rs`（注册命令）

**Interfaces:**
- Produces: `#[tauri::command] pub fn clipboard_read_files() -> Vec<String>`（系统剪贴板文件路径，无则空）；纯函数 `parse_uri_list(raw: &str) -> Vec<PathBuf>`。

- [ ] **Step 1: 写失败测试 — `parse_uri_list`**

创建 `src-tauri/src/commands/clipboard.rs`：

```rust
use std::path::PathBuf;

/// Parse a Linux clipboard file payload (`text/uri-list` or
/// `x-special/gnome-copied-files`) into local paths.
/// - `text/uri-list`: one `file://` URI per line; `#` lines are comments.
/// - `x-special/gnome-copied-files`: first line `copy`/`cut`, rest are `file://` URIs.
pub(crate) fn parse_uri_list(raw: &str) -> Vec<PathBuf> {
    use percent_encoding::percent_decode_str;
    raw.lines()
        .map(|l| l.trim())
        .filter(|t| !t.is_empty() && !t.starts_with('#') && *t != "copy" && *t != "cut")
        .filter_map(|t| {
            let path_str = if let Some(rest) = t.strip_prefix("file://") {
                percent_decode_str(rest).decode_utf8_lossy().to_string()
            } else {
                t.to_string()
            };
            Some(PathBuf::from(path_str))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_text_uri_list() {
        let raw = "file:///home/u/a.txt\nfile:///home/u/b%20c.txt\n";
        let v = parse_uri_list(raw);
        assert_eq!(v, vec![PathBuf::from("/home/u/a.txt"), PathBuf::from("/home/u/b c.txt")]);
    }

    #[test]
    fn parses_gnome_copied_files() {
        let raw = "copy\nfile:///home/u/x.txt\n";
        assert_eq!(parse_uri_list(raw), vec![PathBuf::from("/home/u/x.txt")]);
    }

    #[test]
    fn ignores_comments_and_blank() {
        let raw = "# comment\n\nfile:///tmp/y\n";
        assert_eq!(parse_uri_list(raw), vec![PathBuf::from("/tmp/y")]);
    }
}
```

- [ ] **Step 2: 注册模块以便 cargo test 能编译**

`src-tauri/src/commands/mod.rs` 顶部 `pub mod` 列表里加一行：

```rust
pub mod clipboard;
```

- [ ] **Step 3: 跑测试，确认通过**

Run: `cd src-tauri && cargo test --lib commands::clipboard`
Expected: 3 个 test PASS。

- [ ] **Step 4: 加 `clipboard_read_files` 命令 + 平台实现**

在 `clipboard.rs` 顶部补 `use tauri::command;`，并在文件末尾追加：

```rust
#[command]
pub fn clipboard_read_files() -> Vec<String> {
    read_clipboard_files_impl()
}

#[cfg(target_os = "windows")]
fn read_clipboard_files_impl() -> Vec<String> {
    // clipboard-win 5.x API —— 以 `cargo doc --package clipboard-win --open` 为准；
    // 编译器会校正方法名。
    use clipboard_win::Clipboard;
    let cb = match Clipboard::new() {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    match cb.get_file_list() {
        Ok(paths) => paths.into_iter().map(|p| p.to_string_lossy().to_string()).collect(),
        Err(_) => Vec::new(),
    }
}

#[cfg(target_os = "macos")]
fn read_clipboard_files_impl() -> Vec<String> {
    // ⚠️ macOS-only —— Windows 上不编译，必须在 macOS 上 `cargo build` 验证。
    // 读 NSPasteboard generalPasteboard 的 public.file-url (NSURL)。
    // objc2 API 以本地 `cargo doc` 为准并按编译器校正。
    use objc2::rc::Retained;
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::{NSArray, NSURL};

    let pb = unsafe { NSPasteboard::generalPasteboard() };
    let classes: Retained<NSArray> = unsafe {
        NSArray::arrayWithObject(NSURL::class())  // best-effort；按编译器/objc2 版本校正
    };
    let opts: Retained<NSDictionary> = ... ;      // 空字典，按 objc2-foundation API 校正
    let objects = unsafe { pb.readObjectsForClasses_options(&classes, Some(&opts)) };
    objects
        .into_iter()
        .flatten()
        .filter_map(|obj| {
            let url = obj.downcast::<NSURL>().ok()?;
            if unsafe { url.isFileURL() } {
                Some(unsafe { url.path().to_string() })
            } else {
                None
            }
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn read_clipboard_files_impl() -> Vec<String> {
    // ⚠️ Linux-only —— Windows 上不编译，需在 Linux 上验证。
    // 优先 Wayland wl-paste，回退 X11 xclip / xsel。
    use std::process::Command;

    let candidates: &[&[&str]] = &[
        &["wl-paste", "--type", "text/uri-list"],
        &["wl-paste", "--type", "x-special/gnome-copied-files"],
        &["xclip", "-selection", "clipboard", "-o", "-t", "text/uri-list"],
        &["xclip", "-selection", "clipboard", "-o", "-t", "x-special/gnome-copied-files"],
        &["xsel", "--clipboard", "--input"],
    ];

    for argv in candidates {
        if which::which(argv[0]).is_err() {
            continue;
        }
        let out = Command::new(argv[0])
            .args(&argv[1..])
            .output();
        if let Ok(o) = out {
            if o.status.success() {
                let raw = String::from_utf8_lossy(&o.stdout);
                let paths = parse_uri_list(&raw);
                if !paths.is_empty() {
                    return paths.into_iter().map(|p| p.to_string_lossy().to_string()).collect();
                }
            }
        }
    }
    Vec::new()
}
```

> mac 段中的 `NSDictionary` / `NSArray::arrayWithObject` / `readObjectsForClasses_options` 是 best-effort，objc2 0.2 的确切签名需在 macOS 上用 `cargo doc` + 编译器校正。**这是计划中唯一无法在 Windows 验证的代码块**；实现时在 macOS 上构建直到通过。

- [ ] **Step 5: 在 lib.rs 注册命令**

`src-tauri/src/lib.rs` 的 `invoke_handler` 列表末尾（`run_process::run_process_stop` 之后）加：

```rust
            commands::clipboard::clipboard_read_files,
```

- [ ] **Step 6: Windows 构建验证**

Run: `cd src-tauri && cargo build`
Expected: 成功（Windows 段 + arboard + percent-encoding 编译通过；mac/linux 段被 cfg 跳过）。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/clipboard.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat: clipboard_read_files command (cross-platform file-path reading)"
```

---

### Task 3: clipboard.rs — `clipboard_read_image`（arboard → 临时 PNG）

**Files:**
- Modify: `src-tauri/src/commands/clipboard.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `#[tauri::command] pub fn clipboard_read_image() -> Option<String>`（有图返回临时 PNG 绝对路径，无图返回 `None`）。

- [ ] **Step 1: 加 `clipboard_read_image` 命令**

在 `clipboard.rs` 末尾追加：

```rust
#[command]
pub fn clipboard_read_image() -> Option<String> {
    read_clipboard_image_impl()
}

fn read_clipboard_image_impl() -> Option<String> {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    let mut cb = match arboard::Clipboard::new() {
        Ok(c) => c,
        Err(_) => return None,
    };
    let img = match cb.get_image() {
        Ok(i) => i,
        Err(_) => return None,
    };

    // 编码为 PNG
    let png_bytes = match image_to_png(&img) {
        Ok(b) => b,
        Err(_) => return None,
    };

    let tmp_root = std::env::temp_dir().join("aide-clipboard");
    let _ = fs::create_dir_all(&tmp_root);

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = tmp_root.join(format!("img-{}.png", nanos));

    if fs::write(&path, &png_bytes).is_err() {
        return None;
    }
    Some(path.to_string_lossy().to_string())
}

/// arboard Image → PNG bytes（arboard 给的是 RGBA 像素）。
fn image_to_png(img: &arboard::ImageData) -> Result<Vec<u8>, String> {
    use std::io::Cursor;
    // 用 image crate 编码？为避免再引依赖，改用 arboard 自带能力：
    // arboard 不提供编码，因此我们最小化地用 `image` crate。
    // —— 若不想引 image crate，可退而用 png crate（更轻）。
    encode_rgba_png(img.width as u32, img.height as u32, img.bytes.as_ref())
}
```

> 编码依赖：在 `Cargo.toml` `[dependencies]` 加 `png = "0.17"`（纯 Rust，全平台编译，比 `image` 轻）。`encode_rgba_png` 实现见 Step 2。

- [ ] **Step 2: 加 PNG 编码实现 + 依赖**

`Cargo.toml` `[dependencies]` 追加：

```toml
png = "0.17"
```

`clipboard.rs` 把 `image_to_png` 体替换为：

```rust
fn encode_rgba_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    use png::{BitDepth, ColorType, Encoder};
    let mut buf = Vec::new();
    {
        let mut enc = Encoder::new(&mut buf, width, height);
        enc.set_color(ColorType::Rgba);
        enc.set_depth(BitDepth::Eight);
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        writer.write_image_bytes(rgba).map_err(|e| e.to_string())?;
    }
    Ok(buf)
}
```

并把 `image_to_png` 简化为：

```rust
fn image_to_png(img: &arboard::ImageData) -> Result<Vec<u8>, String> {
    encode_rgba_png(img.width as u32, img.height as u32, img.bytes.as_ref())
}
```

> 注意：arboard `ImageData.bytes` 是 `Cow<[u8]>`，RGBA 顺序。若某平台返回 BGRA，需在此转换——实现时用真实截图验证颜色正确性，必要时加 BGRA→RGBA 交换。

- [ ] **Step 3: 在 lib.rs 注册命令**

`invoke_handler` 列表加：

```rust
            commands::clipboard::clipboard_read_image,
```

- [ ] **Step 4: Windows 构建验证**

Run: `cd src-tauri && cargo build`
Expected: 成功。

- [ ] **Step 5: 手动冒烟（Windows）**

启动应用，复制一张截图到剪贴板，在 Rust 侧临时加一个调试命令或用 `cargo test` 调 `read_clipboard_image_impl` 不便（需剪贴板）；改为在 Task 8 接通前端后整体验证。本步只需确认编译通过。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/clipboard.rs src-tauri/Cargo.toml src-tauri/src/lib.rs
git commit -m "feat: clipboard_read_image command (arboard -> temp PNG)"
```

---

### Task 4: api.ts 绑定

**Files:**
- Modify: `src/api.ts`

**Interfaces:**
- Produces: `api.clipboardReadFiles(): Promise<string[]>`、`api.clipboardReadImage(): Promise<string | null>`。

- [ ] **Step 1: 在 api 对象加两个方法**

在 `src/api.ts` 的 `api` 对象里（PTY 段之后或任意合适位置）加：

```ts
  clipboardReadFiles(): Promise<string[]> {
    return invoke("clipboard_read_files");
  },
  clipboardReadImage(): Promise<string | null> {
    return invoke("clipboard_read_image");
  },
```

- [ ] **Step 2: 类型检查**

Run: `pnpm vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/api.ts
git commit -m "feat(api): add clipboardReadFiles / clipboardReadImage bindings"
```

---

### Task 5: useFileClipboard 导出 peek

**Files:**
- Modify: `src/composables/useFileClipboard.ts`

**Interfaces:**
- Produces: `peekFileClipboard(): ClipboardEntry | null`（读当前应用内剪贴板，不 clear）。

- [ ] **Step 1: 加 peek 导出**

`src/composables/useFileClipboard.ts` 在 `useFileClipboard` 函数体内加：

```ts
  function peekFileClipboard(): ClipboardEntry | null {
    return clipboard.value;
  }
```

并把 return 改为：

```ts
  return { clipboard: readonly(clipboard), copy, cut, clear, executePaste, peekFileClipboard };
```

- [ ] **Step 2: 类型检查**

Run: `pnpm vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/composables/useFileClipboard.ts
git commit -m "feat: expose peekFileClipboard for terminal paste"
```

---

### Task 6: 纯函数 `resolvePastePayload` + vitest（TDD）

**Files:**
- Create: `src/utils/paste.ts`
- Create: `src/utils/paste.test.ts`
- Modify: `package.json`（devDeps + test script）
- Create: `vitest.config.ts`

**Interfaces:**
- Produces: `resolvePastePayload(files: string[], img: string | null, entry: ClipboardEntry | null, text: string): string`（返回要写入 PTY 的字符串，空表示不写）。

- [ ] **Step 1: 装 vitest**

Run:
```bash
pnpm add -D vitest
```

`package.json` `scripts` 加：
```json
    "test": "vitest run",
    "test:watch": "vitest"
```

创建 `vitest.config.ts`：
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
```

- [ ] **Step 2: 写失败测试**

创建 `src/utils/paste.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { resolvePastePayload } from "./paste";
import type { ClipboardEntry } from "../composables/useFileClipboard";

describe("resolvePastePayload", () => {
  it("uses OS files first", () => {
    expect(resolvePastePayload(["C:\\a.png", "C:\\b.txt"], null, null, "x"))
      .toBe("@C:\\a.png @C:\\b.txt ");
  });

  it("uses image when no files", () => {
    expect(resolvePastePayload([], "/tmp/aide-clipboard/img-1.png", null, "x"))
      .toBe("@/tmp/aide-clipboard/img-1.png ");
  });

  it("uses in-app clipboard entry when no files/image", () => {
    const entry: ClipboardEntry = { op: "copy", path: "/proj/f.ts" };
    expect(resolvePastePayload([], null, entry, "x")).toBe("@/proj/f.ts ");
  });

  it("ignores in-app cut entry", () => {
    const entry: ClipboardEntry = { op: "cut", path: "/proj/f.ts" };
    expect(resolvePastePayload([], null, entry, "fallback")).toBe("fallback");
  });

  it("falls back to text", () => {
    expect(resolvePastePayload([], null, null, "hello\nworld")).toBe("hello\nworld");
  });

  it("returns empty when nothing available", () => {
    expect(resolvePastePayload([], null, null, "")).toBe("");
  });
});
```

- [ ] **Step 3: 跑测试，确认失败**

Run: `pnpm test`
Expected: FAIL（`resolvePastePayload` 未定义 / 导入失败）。

- [ ] **Step 4: 实现 `resolvePastePayload`**

创建 `src/utils/paste.ts`：

```ts
import type { ClipboardEntry } from "../composables/useFileClipboard";

/**
 * Decide what to write to the PTY on Ctrl+V / Cmd+V, given the four
 * clipboard sources in priority order: OS files > OS image > in-app
 * file-tree copy > plain text. Returns "" to mean "write nothing".
 */
export function resolvePastePayload(
  files: string[],
  img: string | null,
  entry: ClipboardEntry | null,
  text: string,
): string {
  if (files.length > 0) {
    return files.map((p) => `@${p}`).join(" ") + " ";
  }
  if (img) {
    return `@${img} `;
  }
  if (entry && entry.op === "copy") {
    return `@${entry.path} `;
  }
  return text;
}
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `pnpm test`
Expected: 6 个 test PASS。

- [ ] **Step 6: Commit**

```bash
git add src/utils/paste.ts src/utils/paste.test.ts vitest.config.ts package.json pnpm-lock.yaml
git commit -m "feat(utils): resolvePastePayload pure function + vitest setup"
```

---

### Task 7: 在 useTerminalManager 接通粘贴 + 删除拖放死代码

**Files:**
- Modify: `src/composables/useTerminalManager.ts`
- Modify: `src/components/TerminalPanel.vue`

**Interfaces:**
- Consumes: `api.clipboardReadFiles` / `api.clipboardReadImage`（Task 4）、`peekFileClipboard`（Task 5）、`resolvePastePayload`（Task 6）。

- [ ] **Step 1: 改 import**

`src/composables/useTerminalManager.ts` 顶部 import 段，把不再需要的 `getCurrentWebviewWindow` 移除（拖放删除后若他处未用），并加：

```ts
import { api } from "../api";
import { peekFileClipboard } from "./useFileClipboard";
import { resolvePastePayload } from "../utils/paste";
```

> 若 `getCurrentWebviewWindow` 在文件他处仍被使用则保留；删除前 grep 确认。

- [ ] **Step 2: 加粘贴处理函数**

在 `makeTerminal` 之前加：

```ts
  function isMac(): boolean {
    return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
  }

  async function readClipboardText(): Promise<string> {
    try {
      return await navigator.clipboard.readText();
    } catch (_) {
      return "";
    }
  }

  async function handlePaste(ptyId: string) {
    let payload = "";
    try {
      const files = await api.clipboardReadFiles();
      const img = files.length ? null : await api.clipboardReadImage();
      const entry = files.length || img ? null : peekFileClipboard();
      const text = files.length || img || entry ? "" : await readClipboardText();
      payload = resolvePastePayload(files, img, entry, text);
    } catch (_) {
      return;
    }
    if (payload) api.ptyWrite(ptyId, payload).catch(() => {});
  }

  function makePasteKeyHandler(ptyId: () => string) {
    return (e: { type: string; ctrlKey: boolean; metaKey: boolean; key: string }): boolean => {
      if (e.type !== "keydown") return true;
      const isPaste = isMac()
        ? (e.metaKey && (e.key === "v" || e.key === "V"))
        : (e.ctrlKey && (e.key === "v" || e.key === "V"));
      if (!isPaste) return true;
      const id = ptyId();
      if (id) handlePaste(id);
      return false; // 阻止 xterm 默认（\x16 / 浏览器粘贴）
    };
  }
```

> 注：`handlePaste` 内部按优先级短路，避免无谓的剪贴板读取。

- [ ] **Step 3: 在 makeTerminal 挂 key handler**

`makeTerminal()` 里 `terminal.loadAddon(fitAddon);` 之后、`onTerminalReady?.(terminal);` 之前加：

```ts
    // ptyId 在 startClaude 里才知道，这里用闭包延迟读取
    const ptyIdRef = { current: "" };
    terminal.attachCustomKeyEventHandler(makePasteKeyHandler(() => ptyIdRef.current));
    (terminal as unknown as { __aidePtyIdRef?: { current: string } }).__aidePtyIdRef = ptyIdRef;
```

- [ ] **Step 4: 在 startClaude 里设置 ptyId**

`startClaude` 里 `const { terminal, fitAddon } = makeTerminal();` 之后加：

```ts
    const ptyIdRef = (terminal as unknown as { __aidePtyIdRef?: { current: string } }).__aidePtyIdRef;
    if (ptyIdRef) ptyIdRef.current = ptyId;
```

- [ ] **Step 5: 删除拖放死代码**

从 `useTerminalManager.ts` 删除：`initDragDrop`、`handleFileDrop`、`showDropOverlay`、`hideDropOverlay`、`isOverTerminalStack`、`unlistenDrop`、`dropOverlay` 变量，以及 return 对象里的 `initDragDrop`。同时删 `cleanup()` 里的 `unlistenDrop?.();` 与 `hideDropOverlay();` 两行。

- [ ] **Step 6: TerminalPanel.vue 删除拖放调用与样式**

`src/components/TerminalPanel.vue`：
- 从 `useTerminalManager(...)` 解构里删 `initDragDrop`。
- 删 `onMounted` 里的 `await initDragDrop();` 行。
- 删 `<style>` 里 `.terminal-drop-overlay` / `.terminal-drop-overlay__inner` / `.terminal-drop-overlay__inner svg` / `@keyframes drop-fade-in` 整块（及 `/* ── File drop overlay ── */` 注释）。

- [ ] **Step 7: 类型检查 + 构建**

Run: `pnpm vue-tsc --noEmit && pnpm build`
Expected: 无错误。

- [ ] **Step 8: 手动冒烟（Windows）**

启动应用（`pnpm tauri dev`）：
1. 资源管理器选中一个 `.png` → Ctrl+C → 终端 Ctrl+V → 应出现 `@C:\...\xxx.png `。
2. 截图（PrintScreen）→ 终端 Ctrl+V → 应出现 `@<temp>\aide-clipboard\img-*.png `。
3. Aide 文件树选中文件 → Ctrl+C（应用内）→ 终端 Ctrl+V → 应出现 `@<path> `。
4. 复制一段文本 → 终端 Ctrl+V → 应粘贴文本。
5. 拖文件进终端 → 不再有遮罩/反应（已移除，符合预期）。

- [ ] **Step 9: Commit**

```bash
git add src/composables/useTerminalManager.ts src/components/TerminalPanel.vue
git commit -m "feat: Ctrl+V/Cmd+V paste file/image/path into Claude TUI; remove dead drag-drop"
```

---

### Task 8: 跨平台验证清单与收尾

**Files:**
- 无代码改动；记录验证结果。

- [ ] **Step 1: macOS 构建验证（需 macOS 机器）**

在 macOS 上 `cd src-tauri && cargo build`，按编译器校正 `clipboard.rs` 里 `#[cfg(target_os = "macos")]` 段的 objc2 API（`NSPasteboard::generalPasteboard`、`readObjectsForClasses_options`、`NSURL::class`/`isFileURL`/`path`）。Finder 选中文件 Cmd+C → 终端 Cmd+V 验证。

- [ ] **Step 2: Linux 构建验证（需 Linux 机器）**

在 Linux 上 `cargo build`；Nautilus 选中文件 Ctrl+C → 终端 Ctrl+V 验证。若 `x-special/gnome-copied-files` 解析异常，对照实际 `wl-paste`/`xclip -o -t ...` 输出修正 `parse_uri_list`（补测用例并 `cargo test`）。

- [ ] **Step 3: 截图颜色校验**

粘贴一张彩色截图，用 FileViewer 打开临时 PNG 确认无红蓝通道颠倒；若颠倒，在 `encode_rgba_png` 前加 BGRA→RGBA 转换（按平台 cfg）。

- [ ] **Step 4: Commit 任何跨平台修正**

```bash
git add -A
git commit -m "fix: cross-platform clipboard paste verification corrections"
```

---

## Self-Review 结果

- **Spec 覆盖**：三来源（OS 文件 Task 2、截图 Task 3、应用内 Task 5/7）、优先级回退（Task 6/7）、跨平台（Task 1/2/8）、删除拖放 + 保留 `disable_drag_drop_handler`（Task 7 Step 5/6 + Global Constraints）、临时 PNG 不清理（Task 3 + Constraints）、静默错误（Task 2/3/7）。齐全。
- **占位符**：mac objc2 段为 best-effort，已在代码注释与 Task 8 Step 1 明确标注「需 macOS 构建校正」，非 TBD——提供了具体代码框架。
- **类型一致性**：`clipboard_read_files() -> Vec<String>` / `clipboard_read_image() -> Option<String>` ↔ `api.clipboardReadFiles(): Promise<string[]>` / `api.clipboardReadImage(): Promise<string | null>` ↔ `resolvePastePayload(files: string[], img: string | null, ...)` 一致。`peekFileClipboard(): ClipboardEntry | null` 一致。