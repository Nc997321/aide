# Aide × AllInKit 工具面板 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Aide 内嵌入 AllInKit 插件运行时，新增独立「工具」面板，能从本地 `.aikpkg` / URL 安装并运行 AllInKit 插件，插件 UI 在隔离 iframe 中渲染、经 postMessage 桥回调宿主能力或插件自身 dll。

**Architecture:** Aide 以 path 依赖引入 `aik-host` + `aik-capability`；启动时用 `HostServices::builder` 注入 4 个 Aide 后端（clipboard/notify/dialog/fs），http/kv 用默认；`PluginLoader::load_all` 加载 `plugins_dir` 下插件进 `PluginRegistry`，`Dispatcher` 分发插件调用。前端「工具」面板用 `sandbox="allow-scripts"` iframe 加载 `aik-plugin://<id>/index.html`（自定义协议服务端注入 `window.aik` bootstrap 脚本，因 sandbox 无 `allow-same-origin` 父窗口无法跨源注入）。主窗口 message 处理器按 `msg.type` 分支：`aik_call` → `aide_capability_call` → `HostServices::dispatch_for`（走全局 HOST 单例，保 kv_locks 共享）；`aik_invoke` → `aide_plugin_call` → `Dispatcher::plugin_call`。`plugin_id` 从 iframe 来源映射绑定，防伪造。

**Tech Stack:** Rust / Tauri v2；`aik-host` + `aik-capability`（path 依赖 `../../allinkit/crates/...`）；`arboard 1`（剪贴板，已有）；`notify-rust 4`（通知，已有）；`rfd`（OS 对话框，新增）；`mime_guess 2`（协议 MIME，新增）；Vue 3 + Composition API + TypeScript 前端。

## Global Constraints

- **Windows CREATE_NO_WINDOW**：任何 `Command::new(...)` spawn 必须加 `creation_flags(0x08000000)`（CLAUDE.md 坑点）。
- **kv_root 与 plugins_dir 必须是两棵独立目录树**，不能同目录（对接指南 §十二）。本计划用 `aik_root/plugins` 和 `aik_root/aik-kv`。
- **`HostServices::install()` 只能调一次，必须在 `PluginLoader::load_all` 之前**（指南 §四）。
- **能力调用必须走 `HostServices::dispatch_for`**，绝不新建 `DefaultKvBackend` 实例，否则 `kv_locks` 不同实例导致并发 RMW 数据竞争（指南 §九.5）。
- **iframe `sandbox="allow-scripts"`，不给 `allow-same-origin`**；bootstrap 脚本由 `aik-plugin://` 协议在返回 `index.html` 时服务端注入（指南 §九.3）。
- **命令前缀 `aide_`**（指南 §九.5）；现有 Aide 命令无前缀，新增 AllInKit 相关命令统一 `aide_`。
- **样式**：用设计系统变量（`--aide-bg-deep` / `--aide-surface-default` / `--aide-accent` / `--aide-text-muted` / `--aide-border` / `--aide-radius-md` 等），三角箭头 `font-size: 14px`（CLAUDE.md）。
- **签名**：开发期 `AIK_DEV_TRUST=1` 放行未签名插件；`Ed25519Verifier::from_env()` 自动识别。
- **AllInKit 不热加载**：安装后下次启动才 `load_all`（指南 §六）。

## File Structure

**新增（Rust）：**
- `src-tauri/src/aik_backends.rs` — `AideClipboard` / `AideNotify` / `AideDialog` / `AideFs` 四个后端 trait impl。
- `src-tauri/src/commands/aik.rs` — `AideAppState` + Tauri 命令（`aide_capability_call` / `aide_plugin_call` / `aide_install_from_path` / `aide_install_from_url` / `aide_uninstall` / `aide_list_installed` / `aide_toggle`）+ 启动初始化 `init_allinkit_runtime`。

**新增（前端）：**
- `src/types/aik.ts` — TS 类型（`InstalledAikPlugin` / `AikError` / 能力枚举）。
- `src/api/aik.ts` — `api.aik.*` invoke 封装。
- `src/composables/useAikPlugins.ts` — 模块级 reactive 单例（installed 列表 / activeId / 动作）。
- `src/utils/aikBootstrap.ts` — bootstrap 脚本字符串常量（指南 §九.3，注入到 iframe index.html）。
- `src/components/PluginIframe.vue` — sandbox iframe + 主窗口 message 处理器 + iframe→pluginId 映射。
- `src/components/PluginPanel.vue` — 已装列表 + 安装弹窗 + 右键菜单。

**改动：**
- `src-tauri/Cargo.toml` — 加 `aik-host` / `aik-capability` / `rfd` / `mime_guess`。
- `src-tauri/src/lib.rs` — 计算路径 + 注册 `aik-plugin://` 协议 + setup 调 `init_allinkit_runtime` + `manage(AideAppState)` + `invoke_handler` 注册新命令。
- `src-tauri/src/commands/mod.rs` — `pub mod aik;`。
- `src/components/SidebarLeft.vue` — 状态栏加「工具」按钮，emit `open-tools`。
- `src/App.vue` — 主区加 `tools` 视图，渲染 `<PluginPanel>`。
- `src/menus/contextMenus.ts` — 加 `pluginMenuItems` 工厂。
- `CLAUDE.md` / `docs/ARCHITECTURE.md` — 文档化「工具」子系统、`aide_` 命名空间、iframe 沙箱坑点。

---

## Task 1: 加 Cargo 依赖

**Files:**
- Modify: `src-tauri/Cargo.toml`

**Interfaces:**
- Produces: `aik-host` / `aik-capability` / `rfd` / `mime_guess` 可被 `cargo build` 解析。

- [ ] **Step 1: 加依赖**

在 `src-tauri/Cargo.toml` 的 `[dependencies]` 末尾（`png = "0.17"` 之后）加：

```toml
# ── AllInKit 插件运行时（path 依赖，见 docs/superpowers/specs/2026-06-30-aide-allinkit-integration-design.md）──
aik-host = { path = "../../allinkit/crates/aik-host" }
aik-capability = { path = "../../allinkit/crates/aik-capability" }
# 插件 dialog 后端的 OS 文件选择器
rfd = "0.14"
# aik-plugin:// 自定义协议的 MIME 推断
mime_guess = "2"
```

- [ ] **Step 2: 验证依赖解析**

Run: `cd src-tauri && cargo build`
Expected: 编译通过（path 依赖 `../../allinkit/crates/aik-host` 能被找到；若报找不到，确认 `C:\document\owner\allinkit\crates\aik-host` 存在且 `aik-host` 已通过其自身验收 build clean）。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml
git commit -m "feat(aik): 加 aik-host/aik-capability/rfd/mime_guess 依赖"
```

---

## Task 2: AideClipboard 后端（TDD）

**Files:**
- Create: `src-tauri/src/aik_backends.rs`
- Test: `src-tauri/src/aik_backends.rs`（内联 `#[cfg(test)] mod tests`）

**Interfaces:**
- Consumes: `aik_host::ClipboardBackend` trait（指南 §三）。
- Produces: `pub struct AideClipboard;` + `impl ClipboardBackend for AideClipboard`，方法集 `read_text`/`write_text`，返回 `{ "text": "..." }` / `{}`，错误 `{ "error": { code, message, plugin } }`。

- [ ] **Step 1: 写失败测试**

在 `src-tauri/src/aik_backends.rs` 写：

```rust
//! Aide 注入 AllInKit 的宿主能力后端实现。
//!
//! 四个后端（clipboard/notify/dialog/fs）把 AllInKit 的能力调用委托到 Aide 已有实现或
//! 对应 OS crate。http/kv 用 AllInKit 默认实现，Aide 不注入。

use aik_host::{ClipboardBackend, NotifyBackend, DialogBackend, FsBackend};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

// ── 错误构造辅助 ──

fn err(code: &str, message: impl Into<String>, plugin: &str) -> Value {
    json!({ "error": { "code": code, "message": message.into(), "plugin": plugin } })
}

// ── AideClipboard ──

pub struct AideClipboard;

impl AideClipboard {
    pub fn new() -> Self { Self }
}

impl ClipboardBackend for AideClipboard {
    fn call(&self, plugin_id: &str, method: &str, args: &Value) -> Value {
        match method {
            "read_text" => {
                match arboard::Clipboard::new() {
                    Ok(mut cb) => match cb.get_text() {
                        Ok(text) => json!({ "text": text }),
                        Err(_) => json!({ "text": "" }),
                    },
                    Err(e) => err("HOST_ERROR", format!("clipboard: {e}"), plugin_id),
                }
            }
            "write_text" => {
                let text = match args.get("text").and_then(|v| v.as_str()) {
                    Some(t) => t,
                    None => return err("INVALID_ARGS", "missing text", plugin_id),
                };
                match arboard::Clipboard::new() {
                    Ok(mut cb) => match cb.set_text().with_text(text).wait() {
                        Ok(()) => json!({}),
                        Err(e) => err("HOST_ERROR", format!("clipboard: {e}"), plugin_id),
                    },
                    Err(e) => err("HOST_ERROR", format!("clipboard: {e}"), plugin_id),
                }
            }
            _ => err("INVALID_ARGS", format!("unknown method: {method}"), plugin_id),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plugin() -> &'static str { "test-plugin" }

    #[test]
    fn clipboard_unknown_method_returns_invalid_args() {
        let b = AideClipboard::new();
        let v = b.call(plugin(), "frobnicate", &json!({}));
        assert_eq!(v["error"]["code"], "INVALID_ARGS");
    }

    #[test]
    fn clipboard_write_text_missing_arg_returns_invalid_args() {
        let b = AideClipboard::new();
        let v = b.call(plugin(), "write_text", &json!({}));
        assert_eq!(v["error"]["code"], "INVALID_ARGS");
    }

    #[test]
    fn clipboard_write_then_read_roundtrip() {
        // 写入再读回，验证 read_text/write_text 返回结构正确。
        // 注意：触碰真实系统剪贴板，CI 环境若无剪贴板可能 read 返回空字符串。
        let b = AideClipboard::new();
        let w = b.call(plugin(), "write_text", &json!({ "text": "aide-aik-test" }));
        assert!(w.get("error").is_none(), "write should succeed: {w}");
        let r = b.call(plugin(), "read_text", &json!({}));
        // 返回结构必须含 text 字段（即使为空）
        assert!(r.get("text").is_some(), "read must return {text:...}: {r}");
    }
}
```

- [ ] **Step 2: 运行测试验证失败/通过**

Run: `cd src-tauri && cargo test --lib aik_backends`
Expected: 三个测试通过（若 `arboard::Clipboard::new()` 在无头环境失败，`read_text` 返回 `{text:""}`，roundtrip 的 `text` 字段仍存在，断言通过）。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/aik_backends.rs
git commit -m "feat(aik): AideClipboard 后端（read_text/write_text）"
```

---

## Task 3: AideNotify 后端（TDD）

**Files:**
- Modify: `src-tauri/src/aik_backends.rs`

**Interfaces:**
- Consumes: `aik_host::NotifyBackend`；复用 `commands::settings::notify_send` 的通知逻辑（强制 `app_id("com.aide.app")`，CLAUDE.md 坑点）。
- Produces: `pub struct AideNotify;` + `impl NotifyBackend`，method `send`，返回 `{}`。

- [ ] **Step 1: 抽出共享通知 helper**

`commands/settings.rs` 现有 `notify_send` 命令内部逻辑是「用 notify-rust + 强制 app_id」。为复用，先读 `src-tauri/src/commands/settings.rs` 找到 `notify_send` 的实现体，把发通知的核心抽成 `pub(crate) fn send_notify(title: &str, body: &str) -> Result<(), String>`（保留 `app_id("com.aide.app")`），让 `notify_send` 命令调用它。若该逻辑已是一个独立函数，直接复用，不重复抽。

> 若 `notify_send` 实现较复杂（含 pending notification 缓存等），不要破坏现有行为——只抽「实际发起 notify-rust 通知」那一小段为 `send_notify`，其余原样保留。

- [ ] **Step 2: 写 AideNotify**

在 `aik_backends.rs` 追加：

```rust
pub struct AideNotify;

impl AideNotify {
    pub fn new() -> Self { Self }
}

impl NotifyBackend for AideNotify {
    fn call(&self, plugin_id: &str, method: &str, args: &Value) -> Value {
        match method {
            "send" => {
                let title = match args.get("title").and_then(|v| v.as_str()) {
                    Some(t) => t.to_string(),
                    None => return err("INVALID_ARGS", "missing title", plugin_id),
                };
                let body = args.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
                // 强制 app_id("com.aide.app") 在 send_notify 内已落实
                match crate::commands::send_notify(&title, &body) {
                    Ok(()) => json!({}),
                    Err(e) => err("HOST_ERROR", e, plugin_id),
                }
            }
            _ => err("INVALID_ARGS", format!("unknown method: {method}"), plugin_id),
        }
    }
}
```

> 调用路径取决于 Step 1 抽出的函数位置。若 `send_notify` 放在 `commands/mod.rs` 作 `pub(crate)`，用 `crate::commands::send_notify`；若留在 `commands::settings`，用 `crate::commands::settings::send_notify`。以 Step 1 实际放置为准。

- [ ] **Step 3: 写测试**

在 `tests` 模块追加：

```rust
#[test]
fn notify_unknown_method_returns_invalid_args() {
    let b = AideNotify::new();
    let v = b.call("p", "shout", &json!({}));
    assert_eq!(v["error"]["code"], "INVALID_ARGS");
}

#[test]
fn notify_send_missing_title_returns_invalid_args() {
    let b = AideNotify::new();
    let v = b.call("p", "send", &json!({ "body": "x" }));
    assert_eq!(v["error"]["code"], "INVALID_ARGS");
}

#[test]
fn notify_send_valid_args_returns_ok() {
    // 真实发起一次桌面通知（dev 环境可见）。
    let b = AideNotify::new();
    let v = b.call("p", "send", &json!({ "title": "aik-test", "body": "hello" }));
    assert!(v.get("error").is_none(), "send should succeed: {v}");
}
```

- [ ] **Step 4: 运行测试**

Run: `cd src-tauri && cargo test --lib aik_backends`
Expected: 全部通过。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/aik_backends.rs src-tauri/src/commands/settings.rs src-tauri/src/commands/mod.rs
git commit -m "feat(aik): AideNotify 后端，复用 send_notify（强制 app_id）"
```

---

## Task 4: AideDialog 后端（TDD）

**Files:**
- Modify: `src-tauri/src/aik_backends.rs`

**Interfaces:**
- Consumes: `aik_host::DialogBackend`；`rfd::FileDialog`（OS 对话框）。
- Produces: `pub struct AideDialog;` + `impl DialogBackend`，methods `open_file`/`save_file`/`pick_folder`/`message`，返回 `{ "path": ... }` / `{ "cancelled": true }` / `{}`。

- [ ] **Step 1: 写 AideDialog**

在 `aik_backends.rs` 追加：

```rust
pub struct AideDialog;

impl AideDialog {
    pub fn new() -> Self { Self }
}

impl DialogBackend for AideDialog {
    fn call(&self, plugin_id: &str, method: &str, args: &Value) -> Value {
        match method {
            "open_file" => {
                let mut d = rfd::FileDialog::new();
                if let Some(t) = args.get("title").and_then(|v| v.as_str()) { d = d.set_title(t); }
                if let Some(filters) = args.get("filters").and_then(|v| v.as_array()) {
                    for f in filters {
                        let name = f.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        let exts: Vec<&str> = f.get("extensions")
                            .and_then(|v| v.as_array())
                            .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
                            .unwrap_or_default();
                        if !exts.is_empty() {
                            d = d.add_filter(name, &exts);
                        }
                    }
                }
                match d.pick_file() {
                    Some(p) => json!({ "path": p.to_string_lossy() }),
                    None => json!({ "cancelled": true }),
                }
            }
            "save_file" => {
                let mut d = rfd::FileDialog::new();
                if let Some(t) = args.get("title").and_then(|v| v.as_str()) { d = d.set_title(t); }
                if let Some(n) = args.get("default_name").and_then(|v| v.as_str()) { d = d.set_file_name(n); }
                match d.save_file() {
                    Some(p) => json!({ "path": p.to_string_lossy() }),
                    None => json!({ "cancelled": true }),
                }
            }
            "pick_folder" => {
                let mut d = rfd::FileDialog::new();
                if let Some(t) = args.get("title").and_then(|v| v.as_str()) { d = d.set_title(t); }
                match d.pick_folder() {
                    Some(p) => json!({ "path": p.to_string_lossy() }),
                    None => json!({ "cancelled": true }),
                }
            }
            "message" => {
                let text = match args.get("text").and_then(|v| v.as_str()) {
                    Some(t) => t.to_string(),
                    None => return err("INVALID_ARGS", "missing text", plugin_id),
                };
                // rfd 的 message 对话框
                let kind = args.get("kind").and_then(|v| v.as_str()).unwrap_or("info");
                let _ = (text, kind); // rfd::MessageDialog 非阻塞，此处仅返回 {}
                // 注：rfd::MessageDialog::new().set_title(..).set_level(..).show() 是同步阻塞展示，
                // 为避免阻塞宿主线程，Aide 这里选择「不弹 OS 消息框，仅返回 {}」，
                // 真正的消息提示由 Aide 前端 toast 处理（见 PluginPanel）。如需 OS 消息框，可在此调用
                // rfd::MessageDialog 并用 spawn_blocking 包裹（见 aide_plugin_call 模式）。
                json!({})
            }
            _ => err("INVALID_ARGS", format!("unknown method: {method}"), plugin_id),
        }
    }
}
```

> **设计决定**：`message` 方法不弹 OS 消息框（避免阻塞宿主线程），仅返回 `{}`。`message` 的实际展示由 Aide 前端在收到结果后用 toast 呈现。若后续需要 OS 消息框，改用 `spawn_blocking` 调 `rfd::MessageDialog`。此决定写入 `CLAUDE.md`。

- [ ] **Step 2: 写测试**

在 `tests` 模块追加：

```rust
#[test]
fn dialog_unknown_method_returns_invalid_args() {
    let b = AideDialog::new();
    let v = b.call("p", "ask", &json!({}));
    assert_eq!(v["error"]["code"], "INVALID_ARGS");
}

#[test]
fn dialog_message_missing_text_returns_invalid_args() {
    let b = AideDialog::new();
    let v = b.call("p", "message", &json!({ "title": "x" }));
    assert_eq!(v["error"]["code"], "INVALID_ARGS");
}

#[test]
fn dialog_message_valid_returns_ok() {
    let b = AideDialog::new();
    let v = b.call("p", "message", &json!({ "title": "t", "text": "hi" }));
    assert!(v.get("error").is_none(), "{v}");
}
```

> `open_file`/`save_file`/`pick_folder` 触发真实 OS 对话框（阻塞），不进单测，留 e2e 手动验证（Task 18）。

- [ ] **Step 3: 运行测试**

Run: `cd src-tauri && cargo test --lib aik_backends`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/aik_backends.rs
git commit -m "feat(aik): AideDialog 后端（rfd 文件选择 + message 轻量返回）"
```

---

## Task 5: AideFs 后端（TDD，完整）

**Files:**
- Modify: `src-tauri/src/aik_backends.rs`

**Interfaces:**
- Consumes: `aik_host::FsBackend`（带 `allowed_paths: &[PathBuf]`）。
- Produces: `pub struct AideFs;` + `impl FsBackend`，methods `read_file`/`write_file`/`delete_file`/`list_dir`/`exists`/`create_dir`，路径越界 → `PERMISSION_DENIED`。

- [ ] **Step 1: 写 AideFs**

在 `aik_backends.rs` 追加（参考指南 §八）：

```rust
pub struct AideFs;

impl AideFs {
    pub fn new() -> Self { Self }
}

impl FsBackend for AideFs {
    fn call(
        &self,
        plugin_id: &str,
        method: &str,
        args: &Value,
        allowed_paths: &[PathBuf],
    ) -> Value {
        fn check(path: &Path, allowed: &[PathBuf]) -> bool {
            let p = path.to_string_lossy().replace('\\', "/");
            allowed.iter().any(|a| {
                let a = a.to_string_lossy().replace('\\', "/");
                p == a || p.starts_with(&format!("{a}/"))
            })
        }
        macro_rules! require_path {
            () => {
                match args.get("path").and_then(|v| v.as_str()) {
                    Some(p) => PathBuf::from(p),
                    None => return err("INVALID_ARGS", "missing path", plugin_id),
                }
            };
        }
        macro_rules! deny_if_outside {
            ($path:expr) => {
                if !check(&$path, allowed_paths) {
                    return err("PERMISSION_DENIED", "path outside allowed", plugin_id);
                }
            };
        }

        match method {
            "read_file" => {
                let path = require_path!();
                deny_if_outside!(path);
                match std::fs::read_to_string(&path) {
                    Ok(c) => json!({ "content": c }),
                    Err(e) => err("HOST_ERROR", e.to_string(), plugin_id),
                }
            }
            "write_file" => {
                let path = require_path!();
                deny_if_outside!(path);
                let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
                if let Err(e) = std::fs::write(&path, content) {
                    return err("HOST_ERROR", e.to_string(), plugin_id);
                }
                json!({})
            }
            "delete_file" => {
                let path = require_path!();
                deny_if_outside!(path);
                let r = if path.is_dir() {
                    std::fs::remove_dir_all(&path)
                } else {
                    std::fs::remove_file(&path)
                };
                match r {
                    Ok(()) => json!({}),
                    Err(e) => err("HOST_ERROR", e.to_string(), plugin_id),
                }
            }
            "list_dir" => {
                let path = require_path!();
                deny_if_outside!(path);
                match std::fs::read_dir(&path) {
                    Ok(rd) => {
                        let entries: Vec<Value> = rd.filter_map(|e| e.ok()).map(|e| {
                            let name = e.file_name().to_string_lossy().to_string();
                            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                            json!({ "name": name, "is_dir": is_dir })
                        }).collect();
                        json!({ "entries": entries })
                    }
                    Err(e) => err("HOST_ERROR", e.to_string(), plugin_id),
                }
            }
            "exists" => {
                let path = require_path!();
                deny_if_outside!(path);
                json!({ "exists": path.exists() })
            }
            "create_dir" => {
                let path = require_path!();
                deny_if_outside!(path);
                match std::fs::create_dir_all(&path) {
                    Ok(()) => json!({}),
                    Err(e) => err("HOST_ERROR", e.to_string(), plugin_id),
                }
            }
            _ => err("INVALID_ARGS", format!("unknown method: {method}"), plugin_id),
        }
    }
}
```

- [ ] **Step 2: 写测试（tempdir）**

在 `tests` 模块追加（用 `std::env::temp_dir` 建临时目录）：

```rust
use std::fs;

fn tmp_allowed() -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("aik-fs-test-{}", std::process::id()));
    let _ = fs::create_dir_all(&root);
    let inside = root.join("inside.txt");
    let _ = fs::write(&inside, "hello");
    (root.clone(), inside)
}

#[test]
fn fs_unknown_method_returns_invalid_args() {
    let b = AideFs::new();
    let v = b.call("p", "teleport", &json!({}), &[]);
    assert_eq!(v["error"]["code"], "INVALID_ARGS");
}

#[test]
fn fs_read_outside_allowed_returns_permission_denied() {
    let b = AideFs::new();
    let (root, _inside) = tmp_allowed();
    let outside = std::env::temp_dir().join("aik-fs-outside.txt");
    let _ = fs::write(&outside, "secret");
    let v = b.call("p", "read_file", &json!({ "path": outside.to_string_lossy() }), &[root.clone()]);
    assert_eq!(v["error"]["code"], "PERMISSION_DENIED");
    let _ = fs::remove_file(outside);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn fs_read_inside_allowed_returns_content() {
    let b = AideFs::new();
    let (root, inside) = tmp_allowed();
    let v = b.call("p", "read_file", &json!({ "path": inside.to_string_lossy() }), &[root.clone()]);
    assert_eq!(v["content"], "hello");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn fs_write_inside_allowed_succeeds() {
    let b = AideFs::new();
    let (root, _inside) = tmp_allowed();
    let target = root.join("new.txt");
    let v = b.call("p", "write_file", &json!({ "path": target.to_string_lossy(), "content": "x" }), &[root.clone()]);
    assert!(v.get("error").is_none(), "{v}");
    assert_eq!(fs::read_to_string(&target).unwrap(), "x");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn fs_exists_returns_bool() {
    let b = AideFs::new();
    let (root, inside) = tmp_allowed();
    let v = b.call("p", "exists", &json!({ "path": inside.to_string_lossy() }), &[root.clone()]);
    assert_eq!(v["exists"], true);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn fs_list_dir_returns_entries() {
    let b = AideFs::new();
    let (root, _inside) = tmp_allowed();
    let v = b.call("p", "list_dir", &json!({ "path": root.to_string_lossy() }), &[root.clone()]);
    let entries = v["entries"].as_array().unwrap();
    assert!(entries.iter().any(|e| e["name"] == "inside.txt"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn fs_missing_path_returns_invalid_args() {
    let b = AideFs::new();
    let v = b.call("p", "read_file", &json!({}), &[]);
    assert_eq!(v["error"]["code"], "INVALID_ARGS");
}
```

- [ ] **Step 3: 运行测试**

Run: `cd src-tauri && cargo test --lib aik_backends`
Expected: 全部通过。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/aik_backends.rs
git commit -m "feat(aik): AideFs 后端（allowed_paths 越界校验 + 6 方法）"
```

---

## Task 6: 注册 aik 模块 + AideAppState + 启动初始化

**Files:**
- Create: `src-tauri/src/commands/aik.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `aik_host::*` + `aik_capability::Ed25519Verifier`（指南 §四）；`crate::aik_backends::{AideClipboard, AideNotify, AideDialog, AideFs}`；`crate::commands::our_config_dir`。
- Produces: `pub struct AideAppState { pub registry: PluginRegistry, pub dispatcher: Dispatcher, pub store: Arc<Mutex<RegistryStore>>, pub plugins_dir: PathBuf, pub aik_root: PathBuf }`；`pub fn init_allinkit_runtime(aik_root: PathBuf) -> AideAppState`。

- [ ] **Step 1: 注册模块**

`src-tauri/src/commands/mod.rs` 在 `pub mod clipboard;` 后加：

```rust
pub mod aik;
```

并在 `commands/mod.rs` 末尾的 helpers 区加一个复用的 `send_notify`（若 Task 3 Step 1 已放在此处则跳过）：

```rust
// 复用通知逻辑（强制 app_id("com.aide.app")），供 AideNotify 后端与 notify_send 命令共用。
pub(crate) fn send_notify(title: &str, body: &str) -> Result<(), String> {
    use notify_rust::Notification;
    Notification::new()
        .app_id("com.aide.app")
        .summary(title)
        .body(body)
        .show()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
```

> 若 `notify_send` 命令原本就在 `commands/mod.rs` 或 `settings.rs` 内联实现，改为调用此 `send_notify`，保持 `app_id` 强制不丢。

- [ ] **Step 2: 写 AideAppState + init_allinkit_runtime**

`src-tauri/src/commands/aik.rs`：

```rust
//! AllInKit 运行时嵌入：启动初始化、Tauri 命令、应用状态。
//!
//! 对接指南：C:\document\owner\allinkit\docs\aide-integration-guide.md

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use aik_host::{
    CapabilityGate, Dispatcher, HostServices, PluginLoader, PluginRegistry, RegistryStore,
};
use aik_capability::Ed25519Verifier;

use crate::aik_backends::{AideClipboard, AideDialog, AideFs, AideNotify};
use crate::commands::our_config_dir;

/// 进程级共享状态，注入到 Tauri `app.manage()`。
pub struct AideAppState {
    pub registry: PluginRegistry,
    pub dispatcher: Dispatcher,
    pub store: Arc<Mutex<RegistryStore>>,
    pub plugins_dir: PathBuf,
    pub aik_root: PathBuf,
}

/// AllInKit 数据根目录：`~/.claude-code-desktop/aik`
pub fn aik_root() -> PathBuf {
    our_config_dir().join("aik")
}

/// 完整启动流程（指南 §四）：注入后端 → install → 载账本 → 清待卸载 → load_all → 对齐账本 → register → Dispatcher。
///
/// 必须在 Tauri setup 中、且在任何插件相关 Tauri 命令被调用前执行。
/// `HostServices::install()` 写入全局 OnceLock，进程内只能调一次。
pub fn init_allinkit_runtime(aik_root: PathBuf) -> AideAppState {
    let plugins_dir = aik_root.join("plugins");
    let kv_root = aik_root.join("aik-kv");
    // ⚠️ plugins_dir 与 kv_root 必须是两棵独立目录树（指南 §十二）
    let _ = std::fs::create_dir_all(&plugins_dir);
    let _ = std::fs::create_dir_all(&kv_root);
    let _ = std::fs::create_dir_all(aik_root.join("logs").join("plugins"));

    let registry = PluginRegistry::new();
    let gate = CapabilityGate::new(registry.clone());

    // install() 必须在 load_all 之前
    HostServices::builder(gate, kv_root)
        .with_clipboard(AideClipboard::new())
        .with_notify(AideNotify::new())
        .with_dialog(AideDialog::new())
        .with_fs(AideFs::new())
        .build()
        .install();

    // 加载持久化账本
    let store = Arc::new(Mutex::new(RegistryStore::load(aik_root.join("registry.json"))));

    // 清理上次标记待卸载的插件
    let pinned = {
        let mut s = store.lock().unwrap();
        let removed = aik_host::execute_pending_uninstalls(&plugins_dir, &mut s);
        if !removed.is_empty() {
            tracing::info!("[aik] 清理待卸载插件: {removed:?}");
        }
        s.pinned_keys()
    };

    // 加载插件目录
    let verifier = Ed25519Verifier::from_env();
    let vtable = HostServices::vtable(); // 必须在 install() 之后
    let (loaded, failures) = PluginLoader::load_all(&plugins_dir, &verifier, vtable, &pinned);
    if !failures.is_empty() {
        tracing::warn!("[aik] 部分插件加载失败（已跳过）: {failures:?}");
    }

    // 对齐账本 + 注册进内存表
    let enabled_map = {
        let mut s = store.lock().unwrap();
        let discovered: Vec<_> = loaded.iter()
            .map(|p| (p.manifest.id.clone(), p.trust, p.manifest.capabilities.clone()))
            .collect();
        let enabled_map = s.reconcile(&discovered);
        let _ = s.save();
        enabled_map
    };
    for mut p in loaded {
        let id = p.manifest.id.clone();
        p.enabled = enabled_map.get(&id).copied().unwrap_or(true);
        registry.register(p);
    }

    let dispatcher = Dispatcher::new(registry.clone(), Some(aik_root.join("logs").join("plugins")));

    AideAppState { registry, dispatcher, store, plugins_dir, aik_root }
}
```

> **类型注意**：`loaded.iter().map(|p| (p.manifest.id.clone(), p.trust, p.manifest.capabilities.clone()))` 的字段名 `manifest` / `trust` / `capabilities` 与 `enabled` 取自指南 §四示例。若 `aik-host` 实际 `LoadedPlugin` 字段名不同，按编译器提示对齐——以 `aik-host` 公开 API 为准。

- [ ] **Step 3: 在 lib.rs setup 中调用并 manage**

`src-tauri/src/lib.rs`：在 `tauri::Builder::default()` 链中，**在 `.setup(|app| {...})` 之前**插入 `aik_root` 计算 + `aik-plugin://` 协议注册（协议在 Task 8 完整实现，此处先放占位闭包保证 build；Task 8 再填实）。先在 `run()` 开头（`init_logging()` 之后、`PtyManager::new()` 之前）加：

```rust
let aik_root = commands::aik::aik_root();
let aik_plugins_dir = aik_root.join("plugins");
```

在 `.setup(|app| {...})` 闭包内、`Ok(())` 之前加：

```rust
// 初始化 AllInKit 插件运行时（install + 加载 + Dispatcher）
let aik_state = commands::aik::init_allinkit_runtime(aik_root.clone());
app.manage(aik_state);
```

> `aik_root` 需在闭包前定义并 `move` 进 setup；调整闭包捕获。`app.manage(aik_state)` 让 `AideAppState` 可被 Tauri 命令以 `tauri::State<'_, AideAppState>` 取用。

- [ ] **Step 4: 验证编译**

Run: `cd src-tauri && cargo build`
Expected: 编译通过。若 `aik-host` 公开 API 字段名与本计划示例不符，按编译器提示修正 `aik.rs`（以 `aik-host` 实际为准）。

- [ ] **Step 5: 冒烟运行**

Run: `cd src-tauri && cargo build --release` 或开发启动 `pnpm tauri dev`
Expected: 应用启动不崩，日志无 `[aik]` 失败（空 plugins_dir 时 `load_all` 返回空，正常）。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/aik.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/src/aik_backends.rs
git commit -m "feat(aik): AideAppState + init_allinkit_runtime 启动嵌入运行时"
```

---

## Task 7: 分发命令 aide_capability_call + aide_plugin_call

**Files:**
- Modify: `src-tauri/src/commands/aik.rs`
- Modify: `src-tauri/src/lib.rs`（invoke_handler 注册）

**Interfaces:**
- Consumes: `AideAppState`；`aik_host::HostServices::dispatch_for`（全局 HOST 单例）；`Dispatcher::plugin_call`。
- Produces: `#[tauri::command] aide_capability_call(plugin_id, service, method, args) -> Result<Value, String>`；`#[tauri::command] async aide_plugin_call(state, id, method, args) -> Result<Value, String>`。

- [ ] **Step 1: 写两个命令**

在 `aik.rs` 追加：

```rust
use tauri::State;
use serde_json::Value;

/// 能力调用：插件 UI 的 window.aik.call(service, method, args) 走这条路径。
/// 必须经 HostServices 全局单例（dispatch_for），保证 kv_locks 与插件 dll 内 host_call 共享同一实例。
#[tauri::command]
pub async fn aide_capability_call(
    plugin_id: String,
    service: String,
    method: String,
    args: Value,
) -> Result<Value, String> {
    // dispatch_for 内部经 CapabilityGate（检查 plugin.toml 是否声明该能力）→ 后端
    let v = tauri::async_runtime::spawn_blocking(move || {
        aik_host::HostServices::dispatch_for(&plugin_id, &service, &method, &args)
    })
    .await
    .map_err(|e| format!("host error: {e}"))?;
    Ok(v)
}

/// 插件 dll 调用：插件 UI 的 window.aik.invoke(method, args) 走这条路径。
/// method 是插件自己暴露的方法名（如 "encode"），不是服务名。
#[tauri::command]
pub async fn aide_plugin_call(
    state: State<'_, AideAppState>,
    id: String,
    method: String,
    args: Value,
) -> Result<Value, String> {
    let dispatcher = state.dispatcher.clone();
    let v = tauri::async_runtime::spawn_blocking(move || {
        dispatcher.plugin_call(&id, &method, &args)
    })
    .await
    .map_err(|e| format!("host error: {e}"))?;
    Ok(v)
}
```

> `aide_capability_call` 不需要 `AideAppState`（走全局单例），但仍需 `plugin_id` 做 CapabilityGate 鉴权——`plugin_id` 由前端从 iframe 来源映射绑定后传入（见 PluginIframe.vue）。

- [ ] **Step 2: 注册命令**

`src-tauri/src/lib.rs` 的 `invoke_handler` 列表末尾（`commands::clipboard::clipboard_read_image,` 之后）加：

```rust
// AllInKit 工具面板
commands::aik::aide_capability_call,
commands::aik::aide_plugin_call,
```

- [ ] **Step 3: 验证编译**

Run: `cd src-tauri && cargo build`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/aik.rs src-tauri/src/lib.rs
git commit -m "feat(aik): aide_capability_call + aide_plugin_call 分发命令"
```

---

## Task 8: 安装/卸载/列表/开关命令

**Files:**
- Modify: `src-tauri/src/commands/aik.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `AideAppState`；`aik_host::{install_aikpkg, PluginRecord, PendingAction, InstallError}`；`aik_capability::Ed25519Verifier`；`RegistryStore` 方法（`pinned_keys`/`get`/`update_on_upgrade`/`register_if_absent`/`set_pending`/`set_enabled`/`save`）。
- Produces: `aide_install_from_path` / `aide_install_from_url` / `aide_uninstall` / `aide_list_installed` / `aide_toggle`。`InstalledAikPlugin` 序列化结构。

- [ ] **Step 1: 写列表 + 序列化结构**

在 `aik.rs` 追加：

```rust
use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct InstalledAikPlugin {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub enabled: bool,
    pub capabilities: Vec<String>,
    pub trust: String, // trust 级别字符串（按 LoadedPlugin.trust 序列化）
    pub ui_entry: Option<String>,
}

/// 列出已加载（已注册进内存表）的插件。
#[tauri::command]
pub fn aide_list_installed(state: State<'_, AideAppState>) -> Vec<InstalledAikPlugin> {
    // PluginRegistry 需要一个遍历接口；若 aik-host 提供 list()/iter()，用之；
    // 否则从 store + registry 组合。以下假定 registry 有 `list()` 返回已注册插件信息。
    state.registry.list().into_iter().map(|p| InstalledAikPlugin {
        id: p.manifest.id.clone(),
        name: p.manifest.name.clone(),
        description: p.manifest.description.clone().unwrap_or_default(),
        version: p.manifest.version.clone(),
        enabled: p.enabled,
        capabilities: p.manifest.capabilities.clone(),
        trust: format!("{:?}", p.trust),
        ui_entry: state.registry.ui_entry(&p.manifest.id),
    }).collect()
}
```

> **类型注意**：`PluginRegistry::list()` 与 `LoadedPlugin`/`manifest` 字段名（`name`/`description`/`version`/`capabilities`/`trust`/`enabled`）以 `aik-host` 实际公开 API 为准。若 `registry` 不直接暴露遍历，改用「store 所有 record + registry 查每个 id 的 enabled/ui_entry」组合。编译时按提示对齐。

- [ ] **Step 2: 写安装命令**

在 `aik.rs` 追加（指南 §六）：

```rust
use aik_host::{install_aikpkg, InstallError, InstallResult, PluginRecord, PendingAction};
use std::path::Path;

fn record_from_result(result: &InstallResult) -> PluginRecord {
    PluginRecord {
        enabled: true,
        trust: result.trust.clone(),
        granted_capabilities: result.manifest.capabilities.clone(),
        pinned_pubkey: result.signing_pubkey.clone(),
        pending: PendingAction::None,
        granted_fs_paths: vec![],
    }
}

#[tauri::command]
pub async fn aide_install_from_path(
    state: State<'_, AideAppState>,
    path: String,
    upgrade: bool,
) -> Result<Value, String> {
    let plugins_dir = state.plugins_dir.clone();
    let aik_root = state.aik_root.clone();
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let verifier = Ed25519Verifier::from_env();
        let pinned_keys = { store.lock().unwrap().pinned_keys() };
        let result = install_aikpkg(Path::new(&path), &plugins_dir, &verifier, upgrade, &pinned_keys)
            .map_err(|e| format!("{e:?}"))?;
        let id = result.manifest.id.clone();
        let rec = record_from_result(&result);
        {
            let mut s = store.lock().unwrap();
            if upgrade && s.get(&id).is_some() {
                s.update_on_upgrade(&id, rec);
            } else {
                s.register_if_absent(&id, rec);
            }
            let _ = s.save();
        }
        Ok::<Value, String>(json!({ "id": id, "name": result.manifest.name.clone(), "restart_required": true }))
    }).await.map_err(|e| format!("host error: {e}"))?
}
```

`aide_install_from_url`：先下载到临时 `.aikpkg` 再调同逻辑。在 `aik.rs` 追加：

```rust
#[tauri::command]
pub async fn aide_install_from_url(
    state: State<'_, AideAppState>,
    url: String,
    upgrade: bool,
) -> Result<Value, String> {
    let tmp = std::env::temp_dir().join(format!("aide-aik-{}.aikpkg", std::process::id()));
    // 简单 GET 下载（Aide 已有 reqwest 经 aik-host 传递依赖可用）
    let bytes = reqwest::blocking::get(&url)
        .map_err(|e| e.to_string())?
        .bytes()
        .map_err(|e| e.to_string())?;
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    let r = aide_install_from_path(state, tmp.to_string_lossy().to_string(), upgrade).await;
    let _ = std::fs::remove_file(&tmp);
    r
}
```

> `reqwest` 通过 `aik-host` 传递依赖可用；若 cargo 报 `reqwest` 未直接声明，在 `Cargo.toml` 加 `reqwest = { version = "0.12", default-features = false, features = ["blocking"] }`。下载用 `spawn_blocking` 包裹的 blocking 客户端；`aide_install_from_path` 内已 `spawn_blocking`，URL 命令的下载段也在 async 命令里直接用 blocking（命令本身 async，下载段最好也挪进 `spawn_blocking`，避免阻塞 runtime）。落地时把下载也放进 `spawn_blocking` 闭包。

- [ ] **Step 3: 写卸载 + 开关命令**

在 `aik.rs` 追加：

```rust
#[tauri::command]
pub fn aide_uninstall(state: State<'_, AideAppState>, id: String) -> Result<bool, String> {
    state.registry.set_enabled(&id, false);
    let mut s = state.store.lock().map_err(|e| e.to_string())?;
    if !s.set_pending(&id, PendingAction::Uninstall) {
        return Ok(false); // id 不在账本
    }
    s.set_enabled(&id, false);
    let _ = s.save();
    Ok(true)
}

#[tauri::command]
pub fn aide_toggle(state: State<'_, AideAppState>, id: String, enabled: bool) -> Result<(), String> {
    state.registry.set_enabled(&id, enabled);
    let mut s = state.store.lock().map_err(|e| e.to_string())?;
    s.set_enabled(&id, enabled);
    let _ = s.save();
    Ok(())
}
```

- [ ] **Step 4: 注册命令**

`lib.rs` `invoke_handler` 末尾加：

```rust
commands::aik::aide_list_installed,
commands::aik::aide_install_from_path,
commands::aik::aide_install_from_url,
commands::aik::aide_uninstall,
commands::aik::aide_toggle,
```

- [ ] **Step 5: 验证编译**

Run: `cd src-tauri && cargo build`
Expected: 通过；按编译器提示对齐 `aik-host` 实际 API 字段/方法名。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/aik.rs src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat(aik): install/uninstall/list/toggle 命令"
```

---

## Task 9: aik-plugin:// 自定义协议 + bootstrap 注入

**Files:**
- Create: `src/utils/aikBootstrap.ts`（前端常量，供参考；实际注入在 Rust 侧）
- Modify: `src-tauri/src/commands/aik.rs`（bootstrap 字符串 + 协议处理器）
- Modify: `src-tauri/src/lib.rs`（注册协议）

**Interfaces:**
- Consumes: `aik_host::PluginRegistry::ui_entry`；`mime_guess`；`registry`（setup 前创建，Arc-backed clone 共享）。
- Produces: `pub const AIK_BOOTSTRAP_JS: &str`；`aik-plugin://<id>/<rel>` 协议返回插件 `ui/` 文件，对入口 HTML 注入 bootstrap `<script>`。

- [ ] **Step 1: 写 bootstrap 常量（Rust）**

在 `aik.rs` 顶部加（指南 §九.3 原文，注入到 iframe）：

```rust
/// 注入到插件 iframe index.html 的 window.aik bootstrap（指南 §九.3）。
/// 因 iframe sandbox 无 allow-same-origin，父窗口无法跨源注入脚本，
/// 必须由本协议在返回 HTML 时服务端插入这段 <script>。
pub const AIK_BOOTSTRAP_JS: &str = r#"(function () {
  const pending = new Map();
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const msg = e.data;
    if (!msg || msg.type !== 'aik_response' || !msg.id) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(msg.error);
    else p.resolve(msg.result ?? {});
  });
  function makeCall(type, payload) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { pending.delete(id); reject({ code: 'HOST_ERROR', message: 'timeout' }); }, 30000);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject:  (e) => { clearTimeout(timer); reject(e); },
      });
      window.parent.postMessage({ type, id, ...payload }, '*');
    });
  }
  window.aik = {
    call(service, method, args = {}) { return makeCall('aik_call', { service, method, args }); },
    invoke(method, args = {}) { return makeCall('aik_invoke', { method, args }); },
  };
})();
"#;

const BOOTSTRAP_TAG: &str = "<script>(function(){window.__aik_bootstrap=true;";
const BOOTSTRAP_CLOSE: &str = "})();<\/script>";

/// 把 bootstrap 注入到 HTML 文本（</head> 前，无则 <html> 后）。
fn inject_bootstrap(html: &str) -> String {
    let tag = format!("{tag}{js}{close}", tag = BOOTSTRAP_TAG, js = AIK_BOOTSTRAP_JS, close = BOOTSTRAP_CLOSE);
    if let Some(idx) = html.find("</head>") {
        let mut s = String::with_capacity(html.len() + tag.len());
        s.push_str(&html[..idx]);
        s.push_str(&tag);
        s.push_str(&html[idx..]);
        return s;
    }
    if let Some(idx) = html.find("<body") {
        let body_open_end = html[idx..].find('>').map(|o| idx + o + 1).unwrap_or(idx);
        let mut s = String::with_capacity(html.len() + tag.len());
        s.push_str(&html[..body_open_end]);
        s.push_str(&tag);
        s.push_str(&html[body_open_end..]);
        return s;
    }
    format!("{tag}{html}")
}
```

> 注意 `<\/script>` 转义，避免提前结束外层字符串（在 Rust 原始字符串里 `</script>` 不需要转义，但若该 JS 将被嵌进 HTML，`</script>` 序列会终止 HTML script 解析——用 `<\/script>` 写法在 JS 字面量里安全）。本常量作为纯文本注入 HTML，需保证不含裸 `</script>`。`BOOTSTRAP_CLOSE` 用 `<\/script>`。

- [ ] **Step 2: 写协议处理器**

在 `aik.rs` 加：

```rust
use tauri::http::Response;

/// 构建 aik-plugin:// 协议处理器闭包，注册到 Tauri Builder。
/// `registry` 与 `plugins_dir` 在 setup 前创建（Arc-backed clone），协议闭包捕获 clone，
/// setup 中 load_all 注册进同一 registry 实例，闭包即可见。
pub fn aik_plugin_protocol(
    registry: PluginRegistry,
    plugins_dir: PathBuf,
) -> impl Fn(&tauri::AppHandle, tauri::http::Request<Vec<u8>>) -> Response<Vec<u8>> + Send + Sync + 'static {
    move |_app, req| {
        let uri = req.uri();
        let host = uri.host().unwrap_or("");
        let path_str = uri.path().trim_start_matches('/');
        let entry = registry.ui_entry(host); // e.g. Some("ui/index.html")

        if entry.is_none() {
            return Response::builder().status(404).body(b"plugin not found".to_vec()).unwrap();
        }
        let entry = entry.unwrap();

        let asset_path = plugins_dir.join(host).join("ui").join(path_str);
        // 路径穿越防护：规范化后必须仍在该插件 ui/ 子树内
        let ui_root = plugins_dir.join(host).join("ui");
        let canon = match asset_path.canonicalize() {
            Ok(c) => c,
            Err(_) => return Response::builder().status(404).body(b"not found".to_vec()).unwrap(),
        };
        let ui_root_canon = ui_root.canonicalize().unwrap_or(ui_root.clone());
        if !canon.starts_with(&ui_root_canon) {
            return Response::builder().status(403).body(b"path traversal denied".to_vec()).unwrap();
        }

        match std::fs::read(&canon) {
            Ok(bytes) => {
                let mime = mime_guess::from_path(&canon).first_or_octet_stream().to_string();
                // 若请求的是入口 HTML，注入 bootstrap
                let entry_path = plugins_dir.join(host).join(entry);
                let is_entry = entry_path.canonicalize()
                    .map(|e| e == canon)
                    .unwrap_or(false);
                let body = if is_entry && mime.contains("html") {
                    let html = String::from_utf8_lossy(&bytes);
                    inject_bootstrap(&html).into_bytes()
                } else {
                    bytes
                };
                Response::builder()
                    .header("Content-Type", mime)
                    .header("X-Frame-Options", "SAMEORIGIN")
                    .body(body)
                    .unwrap()
            }
            Err(_) => Response::builder().status(404).body(b"not found".to_vec()).unwrap(),
        }
    }
}
```

- [ ] **Step 3: 在 lib.rs 注册协议**

`run()` 中，`aik_root`/`aik_plugins_dir` 计算后，先建 `registry`（Arc-backed，setup 与协议共享）：

```rust
let aik_registry = commands::aik::PluginRegistryLocal::new(); // 见下注
```

> **时序设计**：`PluginRegistry` 在 setup 内由 `init_allinkit_runtime` 创建。但协议闭包在 builder 阶段就要捕获它。因 `PluginRegistry` 是 Clone（Arc-backed），方案：把 `init_allinkit_runtime` 拆为「创建 registry 并 install HostServices」前置部分 + 「load_all + register + dispatcher」setup 部分；或更简单——在 `run()` 顶层创建 `let registry = PluginRegistry::new();`，协议闭包捕获 `registry.clone()`，setup 内 `init_allinkit_runtime(aik_root, registry.clone())` 用同一实例。

调整 `init_allinkit_runtime` 签名为 `pub fn init_allinkit_runtime(aik_root: PathBuf, registry: PluginRegistry) -> AideAppState`，内部不再 `PluginRegistry::new()`，改用传入的 `registry`。`run()` 顶层：

```rust
use aik_host::PluginRegistry;
let aik_registry = PluginRegistry::new();
let aik_plugins_dir = commands::aik::aik_root().join("plugins");
```

在 builder 链 `.setup(..)` **之前**加协议注册：

```rust
.register_uri_scheme_protocol("aik-plugin", commands::aik::aik_plugin_protocol(aik_registry.clone(), aik_plugins_dir.clone()))
```

`.setup` 闭包改为：

```rust
.setup({
    let aik_root = aik_root.clone();
    let aik_registry = aik_registry.clone();
    move |app| {
        // ... 现有窗口创建代码 ...
        let aik_state = commands::aik::init_allinkit_runtime(aik_root.clone(), aik_registry.clone());
        app.manage(aik_state);
        Ok(())
    }
})
```

> 同时更新 Task 6 Step 3 的 setup 代码：`init_allinkit_runtime` 现在接收 `aik_registry.clone()`。

- [ ] **Step 4: 写前端 bootstrap 常量（文档参考）**

`src/utils/aikBootstrap.ts`：

```typescript
/**
 * 注入到插件 iframe 的 window.aik bootstrap（与 Rust 侧 AIK_BOOTSTRAP_JS 对应，见对接指南 §九.3）。
 * 真正注入由 aik-plugin:// 协议在服务端完成，本文件仅作前端参考/调试用。
 */
export const AIK_BOOTSTRAP_JS = `(function () {
  const pending = new Map();
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const msg = e.data;
    if (!msg || msg.type !== 'aik_response' || !msg.id) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(msg.error);
    else p.resolve(msg.result ?? {});
  });
  function makeCall(type, payload) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { pending.delete(id); reject({ code: 'HOST_ERROR', message: 'timeout' }); }, 30000);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      window.parent.postMessage({ type, id, ...payload }, '*');
    });
  }
  window.aik = {
    call(service, method, args = {}) { return makeCall('aik_call', { service, method, args }); },
    invoke(method, args = {}) { return makeCall('aik_invoke', { method, args }); },
  };
})();`;
```

- [ ] **Step 5: 验证编译 + 运行**

Run: `cd src-tauri && cargo build`
Expected: 通过。运行 `pnpm tauri dev`，浏览器开发者工具对一个已装插件 iframe 的 `aik-plugin://.../index.html` 网络请求应返回注入了 bootstrap 的 HTML（可在 Network 响应里看到 `window.aik` 定义）。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/aik.rs src-tauri/src/lib.rs src/utils/aikBootstrap.ts
git commit -m "feat(aik): aik-plugin:// 协议 + 服务端注入 window.aik bootstrap"
```

---

## Task 10: 前端类型 + API 封装

**Files:**
- Create: `src/types/aik.ts`
- Create: `src/api/aik.ts`
- Modify: `src/api.ts`（re-export 或并入；Aide 现有 `api` 对象在 `src/api.ts`，新增 `api/aik.ts` 按现有 `src/api/` 目录惯例，再在 `api.ts` 末尾 re-export）

**Interfaces:**
- Produces: `InstalledAikPlugin` / `AikError` 类型；`api.aik.*` 方法（listInstalled/installFromPath/installFromUrl/uninstall/toggle/capabilityCall/pluginCall）。

- [ ] **Step 1: 写类型**

`src/types/aik.ts`：

```typescript
/** AllInKit 已装插件（对应 Rust InstalledAikPlugin） */
export interface InstalledAikPlugin {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  capabilities: string[];
  trust: string;
  ui_entry: string | null;
}

/** 后端/能力调用错误（指南 §十） */
export interface AikError {
  code:
    | "INVALID_ARGS" | "PERMISSION_DENIED" | "HOST_ERROR"
    | "PLUGIN_ERROR" | "PLUGIN_NOT_FOUND" | "PLUGIN_DISABLED" | "PLUGIN_PANIC";
  message: string;
  plugin: string;
}

export interface AikInstallResult {
  id: string;
  name: string;
  restart_required: boolean;
}
```

- [ ] **Step 2: 写 API 封装**

`src/api/aik.ts`：

```typescript
import { invoke } from "@tauri-apps/api/core";
import type { InstalledAikPlugin, AikInstallResult } from "../types/aik";

export const aikApi = {
  listInstalled(): Promise<InstalledAikPlugin[]> {
    return invoke("aide_list_installed");
  },
  installFromPath(path: string, upgrade = false): Promise<AikInstallResult> {
    return invoke("aide_install_from_path", { path, upgrade });
  },
  installFromUrl(url: string, upgrade = false): Promise<AikInstallResult> {
    return invoke("aide_install_from_url", { url, upgrade });
  },
  uninstall(id: string): Promise<boolean> {
    return invoke("aide_uninstall", { id });
  },
  toggle(id: string, enabled: boolean): Promise<void> {
    return invoke("aide_toggle", { id, enabled });
  },
  /** 能力调用（window.aik.call 路径） */
  capabilityCall(pluginId: string, service: string, method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return invoke("aide_capability_call", { pluginId, service, method, args });
  },
  /** 插件 dll 调用（window.aik.invoke 路径） */
  pluginCall(id: string, method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return invoke("aide_plugin_call", { id, method, args });
  },
};
```

- [ ] **Step 3: 在 api.ts re-export**

`src/api.ts` 顶部 import 区加 `export * from "./api/aik";` 并在 `api` 对象末尾不合并（保持 `aikApi` 独立命名空间，避免与现有 `api` 字段冲突）。或更贴近现有风格：把 `aikApi` 方法并入 `api` 对象为 `api.aikListInstalled()` 等。**采用后者**以与 `api.ts` 现有风格一致：

在 `src/api.ts` 的 `export const api = { ... }` 对象末尾（`clearRecent` 之后）加：

```typescript
  // AllInKit 工具面板
  aikListInstalled(): Promise<import("./types/aik").InstalledAikPlugin[]> {
    return invoke("aide_list_installed");
  },
  aikInstallFromPath(path: string, upgrade = false): Promise<import("./types/aik").AikInstallResult> {
    return invoke("aide_install_from_path", { path, upgrade });
  },
  aikInstallFromUrl(url: string, upgrade = false): Promise<import("./types/aik").AikInstallResult> {
    return invoke("aide_install_from_url", { url, upgrade });
  },
  aikUninstall(id: string): Promise<boolean> {
    return invoke("aide_uninstall", { id });
  },
  aikToggle(id: string, enabled: boolean): Promise<void> {
    return invoke("aide_toggle", { id, enabled });
  },
  aikCapabilityCall(pluginId: string, service: string, method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return invoke("aide_capability_call", { pluginId, service, method, args });
  },
  aikPluginCall(id: string, method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return invoke("aide_plugin_call", { id, method, args });
  },
```

> 选定「并入 `api` 对象」方案后，`src/api/aik.ts` 可不创建（避免重复）。**采用：只改 `src/api.ts`，不建 `src/api/aik.ts`**。把 Step 2 的 `aikApi` 丢弃，仅留类型文件。

- [ ] **Step 4: 验证类型**

Run: `pnpm build`（或 `pnpm tsc --noEmit` 若有）
Expected: 无类型错误。

- [ ] **Step 5: Commit**

```bash
git add src/types/aik.ts src/api.ts
git commit -m "feat(aik): 前端类型 + api 封装（aide_ 命令）"
```

---

## Task 11: useAikPlugins composable

**Files:**
- Create: `src/composables/useAikPlugins.ts`

**Interfaces:**
- Consumes: `api.aikListInstalled/aikInstallFromPath/aikInstallFromUrl/aikUninstall/aikToggle`。
- Produces: 模块级 reactive 单例：`installed: Ref<InstalledAikPlugin[]>`、`activeId: Ref<string|null>`、`loadInstalled()`、`installFromPath()`、`installFromUrl()`、`uninstall()`、`toggle()`、`select()`。

- [ ] **Step 1: 写 composable**

`src/composables/useAikPlugins.ts`：

```typescript
import { ref } from "vue";
import { api } from "../api";
import type { InstalledAikPlugin } from "../types/aik";

// 模块级单例（对齐 useSettings 模式）
const installed = ref<InstalledAikPlugin[]>([]);
const activeId = ref<string | null>(null);
const installing = ref(false);
const installError = ref<string | null>(null);

export function useAikPlugins() {
  async function loadInstalled(): Promise<void> {
    try {
      installed.value = await api.aikListInstalled();
      // activeId 仍在列表中则保留，否则清空
      if (activeId.value && !installed.value.some(p => p.id === activeId.value)) {
        activeId.value = installed.value[0]?.id ?? null;
      } else if (!activeId.value && installed.value.length) {
        activeId.value = installed.value[0].id;
      }
    } catch (e) {
      installed.value = [];
    }
  }

  function select(id: string): void {
    activeId.value = id;
  }

  async function installFromPath(path: string, upgrade = false): Promise<boolean> {
    installing.value = true;
    installError.value = null;
    try {
      await api.aikInstallFromPath(path, upgrade);
      // AllInKit 不热加载，安装后下次启动才生效
      await loadInstalled();
      return true;
    } catch (e) {
      installError.value = String(e);
      return false;
    } finally {
      installing.value = false;
    }
  }

  async function installFromUrl(url: string, upgrade = false): Promise<boolean> {
    installing.value = true;
    installError.value = null;
    try {
      await api.aikInstallFromUrl(url, upgrade);
      await loadInstalled();
      return true;
    } catch (e) {
      installError.value = String(e);
      return false;
    } finally {
      installing.value = false;
    }
  }

  async function uninstall(id: string): Promise<boolean> {
    try {
      const ok = await api.aikUninstall(id);
      if (ok && activeId.value === id) activeId.value = null;
      await loadInstalled();
      return ok;
    } catch (e) {
      installError.value = String(e);
      return false;
    }
  }

  async function toggle(id: string, enabled: boolean): Promise<void> {
    try {
      await api.aikToggle(id, enabled);
      const p = installed.value.find(x => x.id === id);
      if (p) p.enabled = enabled;
    } catch (e) {
      installError.value = String(e);
    }
  }

  return { installed, activeId, installing, installError, loadInstalled, select, installFromPath, installFromUrl, uninstall, toggle };
}
```

- [ ] **Step 2: 验证类型**

Run: `pnpm tsc --noEmit`（或 `pnpm build`）
Expected: 通过。

- [ ] **Step 3: Commit**

```bash
git add src/composables/useAikPlugins.ts
git commit -m "feat(aik): useAikPlugins 模块级单例 composable"
```

---

## Task 12: PluginIframe.vue — sandbox iframe + 宿主消息处理器

**Files:**
- Create: `src/components/PluginIframe.vue`

**Interfaces:**
- Consumes: `api.aikCapabilityCall/aikPluginCall`；`InstalledAikPlugin`。
- Produces: `<PluginIframe :plugin="..." />`，渲染 `sandbox="allow-scripts"` iframe，主窗口监听 `message` 按 `aik_call`/`aik_invoke` 分支路由，iframe→pluginId 用 `e.source` 反查。

- [ ] **Step 1: 写组件**

`src/components/PluginIframe.vue`：

```vue
<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { api } from "../api";
import type { InstalledAikPlugin, AikError } from "../types/aik";

const props = defineProps<{ plugin: InstalledAikPlugin }>();

const iframeRef = ref<HTMLIFrameElement | null>(null);
// pluginId 反查表：iframe contentWindow → pluginId（sandbox 无 allow-same-origin，
// 无法从 origin 推断，靠我们自己维护 source → id 映射）
const sourceToId = new WeakMap<Window, string>();

function src(plugin: InstalledAikPlugin): string {
  // aik-plugin://<id>/<entry-relative-to-ui>
  const entry = plugin.ui_entry ?? "ui/index.html";
  const rel = entry.replace(/^ui\//, "");
  return `aik-plugin://${plugin.id}/${rel}`;
}

async function onMessage(e: MessageEvent) {
  const msg = e.data;
  if (!msg || typeof msg !== "object" || !msg.id) return;
  // 只处理来自我们 iframe 的请求
  const pluginId = sourceToId.get(e.source as Window);
  if (!pluginId) return;

  try {
    let result: unknown;
    if (msg.type === "aik_call") {
      result = await api.aikCapabilityCall(pluginId, msg.service, msg.method, msg.args ?? {});
    } else if (msg.type === "aik_invoke") {
      result = await api.aikPluginCall(pluginId, msg.method, msg.args ?? {});
    } else {
      return;
    }
    (e.source as Window).postMessage(
      { type: "aik_response", id: msg.id, result: result ?? {} },
      "*",
    );
  } catch (err) {
    const error: AikError = { code: "HOST_ERROR", message: String(err), plugin: pluginId };
    (e.source as Window).postMessage({ type: "aik_response", id: msg.id, error }, "*");
  }
}

function onLoad() {
  const w = iframeRef.value?.contentWindow;
  if (w) sourceToId.set(w, props.plugin.id);
}

onMounted(() => window.addEventListener("message", onMessage));
onUnmounted(() => window.removeEventListener("message", onMessage));

// 切换插件时清映射（WeakMap 自动回收，无需显式清，但 src 变了 onLoad 会重新绑定）
watch(() => props.plugin.id, () => {
  // iframe src 变化触发 reload，onLoad 重新绑定新 contentWindow
});
</script>

<template>
  <div class="plugin-iframe-host">
    <iframe
      ref="iframeRef"
      :src="src(plugin)"
      sandbox="allow-scripts"
      referrerpolicy="no-referrer"
      class="plugin-iframe"
      @load="onLoad"
    />
  </div>
</template>

<style scoped>
.plugin-iframe-host {
  width: 100%;
  height: 100%;
  background: var(--aide-bg-deep);
}
.plugin-iframe {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}
</style>
```

> **关键点**：`onLoad` 在 iframe 加载完成时把 `contentWindow → pluginId` 写入 `sourceToId`。但 bootstrap 脚本在 iframe 内 `DOMContentLoaded` 前就由协议注入（服务端），早于 `@load` 触发；若插件 UI 在 `@load` 之前就 postMessage，`sourceToId` 还没绑定 → 请求被丢弃。**缓解**：在 `onLoad` 之外，也在 `onMessage` 里用 `WeakMap` 兜底——若 `sourceToId.get(e.source)` 为空但 `e.source` 是某个我们创建的 iframe 的 contentWindow，可遍历 `document` 的 iframe 元素反查。**更稳的方案**：在 `onMessage` 里，若反查失败，遍历 `PluginPanel` 内所有 `<iframe>` 元素的 `contentWindow === e.source` 找到对应 `data-plugin-id`。本组件单插件，简化为 `onLoad` 绑定 + `onMessage` 兜底遍历。落地时优先 `onLoad` 绑定，并接受首条消息可能丢失的边界（插件 UI 通常在 mount 后才交互）。

- [ ] **Step 2: 验证类型**

Run: `pnpm tsc --noEmit`
Expected: 通过。

- [ ] **Step 3: Commit**

```bash
git add src/components/PluginIframe.vue
git commit -m "feat(aik): PluginIframe sandbox iframe + 宿主消息处理器"
```

---

## Task 13: PluginPanel.vue — 列表 + 安装弹窗 + 右键菜单

**Files:**
- Create: `src/components/PluginPanel.vue`
- Modify: `src/menus/contextMenus.ts`（加 `pluginMenuItems` 工厂）

**Interfaces:**
- Consumes: `useAikPlugins`、`useContextMenu`、`ContextMenu.vue`、`ModalDialog.vue`、`pluginMenuItems`。
- Produces: `<PluginPanel />` 主区视图：左已装列表，右 `PluginIframe`，顶部「安装」按钮弹模态。

- [ ] **Step 1: 加 pluginMenuItems 工厂**

读 `src/menus/contextMenus.ts` 现有工厂签名（如 `sessionMenuItems(id, rename, reload)`），按同风格追加：

```typescript
export function pluginMenuItems(
  pluginId: string,
  onToggle: (id: string, enabled: boolean) => void,
  onUninstall: (id: string) => void,
  currentEnabled: boolean,
): ContextMenuItem[] {
  return [
    {
      label: currentEnabled ? "禁用" : "启用",
      action: () => onToggle(pluginId, !currentEnabled),
    },
    {
      label: "卸载",
      action: () => onUninstall(pluginId),
      danger: true,
    },
  ];
}
```

> `ContextMenuItem` 类型与 `danger` 字段以 `contextMenus.ts` 现有定义为准对齐。

- [ ] **Step 2: 写 PluginPanel.vue**

`src/components/PluginPanel.vue`：

```vue
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useAikPlugins } from "../composables/useAikPlugins";
import { useContextMenu } from "../composables/useContextMenu";
import { pluginMenuItems } from "../menus/contextMenus";
import PluginIframe from "./PluginIframe.vue";
import ModalDialog from "./ModalDialog.vue";
import type { InstalledAikPlugin } from "../types/aik";

const { installed, activeId, installing, installError, loadInstalled, select, installFromPath, installFromUrl, uninstall, toggle } = useAikPlugins();
const { show } = useContextMenu();

const showInstall = ref(false);
const installMode = ref<"path" | "url">("path");
const installInput = ref("");
const upgrade = ref(false);

const activePlugin = computed<InstalledAikPlugin | null>(
  () => installed.value.find(p => p.id === activeId.value) ?? null,
);

onMounted(loadInstalled);

async function doInstall() {
  const ok = installMode.value === "path"
    ? await installFromPath(installInput.value, upgrade.value)
    : await installFromUrl(installInput.value, upgrade.value);
  if (ok) showInstall.value = false;
}

function onContextMenu(e: MouseEvent, p: InstalledAikPlugin) {
  e.preventDefault();
  show(e.clientX, e.clientY, pluginMenuItems(p.id, toggle, uninstall, p.enabled));
}
</script>

<template>
  <div class="plugin-panel">
    <!-- 左：已装列表 -->
    <div class="plugin-list">
      <div class="plugin-list-header">
        <span class="header-title">工具</span>
        <button class="install-btn" @click="showInstall = true">安装</button>
      </div>
      <div v-if="installed.length === 0" class="plugin-empty muted">
        暂无插件。点「安装」从本地 .aikpkg 或 URL 安装。
      </div>
      <div
        v-for="p in installed"
        :key="p.id"
        class="plugin-item"
        :class="{ active: p.id === activeId, disabled: !p.enabled }"
        @click="select(p.id)"
        @contextmenu.prevent="onContextMenu($event, p)"
      >
        <div class="plugin-item-name">{{ p.name }}</div>
        <div class="plugin-item-desc">{{ p.description }}</div>
        <div class="plugin-item-caps">
          <span v-for="c in p.capabilities" :key="c" class="cap-badge">{{ c }}</span>
        </div>
      </div>
    </div>

    <!-- 右：iframe 宿主 -->
    <div class="plugin-stage">
      <PluginIframe v-if="activePlugin" :plugin="activePlugin" />
      <div v-else class="plugin-stage-empty muted">选择左侧插件以打开其界面</div>
    </div>

    <!-- 安装弹窗 -->
    <ModalDialog
      v-if="showInstall"
      title="安装插件"
      :width="460"
      @close="showInstall = false"
    >
      <div class="install-form">
        <div class="install-tabs">
          <button :class="{ active: installMode === 'path' }" @click="installMode = 'path'">本地文件</button>
          <button :class="{ active: installMode === 'url' }" @click="installMode = 'url'">URL</button>
        </div>
        <input
          v-model="installInput"
          class="install-input"
          :placeholder="installMode === 'path' ? 'C:\\path\\to\\plugin.aikpkg' : 'https://example.com/plugin.aikpkg'"
        />
        <label class="install-upgrade">
          <input type="checkbox" v-model="upgrade" /> 升级模式（已装同 id 时覆盖）
        </label>
        <div v-if="installError" class="install-error">{{ installError }}</div>
        <div class="install-actions">
          <button class="install-cancel" @click="showInstall = false">取消</button>
          <button class="install-ok" :disabled="installing || !installInput" @click="doInstall">
            {{ installing ? "安装中…" : "安装" }}
          </button>
        </div>
        <div class="install-note muted">安装后需重启 Aide 生效（AllInKit 不热加载）</div>
      </div>
    </ModalDialog>
  </div>
</template>

<style scoped>
.plugin-panel { display: flex; height: 100%; overflow: hidden; }
.plugin-list { width: 260px; flex-shrink: 0; border-right: 1px solid var(--aide-border); display: flex; flex-direction: column; }
.plugin-list-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--aide-surface-default); }
.header-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: var(--aide-text-muted); }
.install-btn { background: var(--aide-accent-subtle); border: 1px solid color-mix(in srgb, var(--aide-accent) 20%, transparent); color: var(--aide-accent); padding: 4px 12px; border-radius: var(--aide-radius-sm); font-size: 11px; cursor: pointer; }
.plugin-item { padding: 10px 14px; cursor: pointer; border-bottom: 1px solid var(--aide-surface-default); }
.plugin-item:hover { background: var(--aide-surface-default); }
.plugin-item.active { background: color-mix(in srgb, var(--aide-accent) 12%, transparent); }
.plugin-item.disabled { opacity: 0.5; }
.plugin-item-name { font-size: 13px; font-weight: 500; color: var(--aide-text-primary); }
.plugin-item-desc { font-size: 11px; color: var(--aide-text-muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plugin-item-caps { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
.cap-badge { font-size: 10px; color: var(--aide-text-muted); background: var(--aide-surface-default); padding: 1px 6px; border-radius: 6px; }
.plugin-empty, .plugin-stage-empty { padding: 16px; font-size: 12px; }
.muted { color: var(--aide-text-muted); }
.plugin-stage { flex: 1; min-width: 0; display: flex; }
.plugin-stage-empty { flex: 1; display: flex; align-items: center; justify-content: center; }
.install-form { display: flex; flex-direction: column; gap: 10px; padding: 8px 4px; }
.install-tabs { display: flex; gap: 4px; }
.install-tabs button { flex: 1; padding: 6px; background: var(--aide-surface-default); border: 1px solid var(--aide-border); border-radius: var(--aide-radius-sm); color: var(--aide-text-secondary); cursor: pointer; font-size: 12px; }
.install-tabs button.active { color: var(--aide-accent); border-color: color-mix(in srgb, var(--aide-accent) 40%, transparent); }
.install-input { padding: 8px 10px; background: var(--aide-bg-deep); border: 1px solid var(--aide-border); border-radius: var(--aide-radius-sm); color: var(--aide-text-primary); font-size: 12px; font-family: inherit; }
.install-upgrade { font-size: 12px; color: var(--aide-text-secondary); display: flex; align-items: center; gap: 6px; }
.install-error { font-size: 11px; color: var(--aide-warning); }
.install-actions { display: flex; justify-content: flex-end; gap: 8px; }
.install-cancel, .install-ok { padding: 6px 16px; border-radius: var(--aide-radius-sm); font-size: 12px; cursor: pointer; }
.install-cancel { background: var(--aide-surface-default); border: 1px solid var(--aide-border); color: var(--aide-text-secondary); }
.install-ok { background: var(--aide-accent); border: none; color: var(--aide-bg-deep); }
.install-ok:disabled { opacity: 0.5; cursor: not-allowed; }
.install-note { font-size: 10px; margin-top: 4px; }
</style>
```

> `ModalDialog` 的 props（`title`/`width`/`@close`/默认 slot）以现有 `src/components/ModalDialog.vue` 实际接口为准对齐——先 Read 该文件确认 props 名，再填。

- [ ] **Step 3: 验证类型**

Run: `pnpm tsc --noEmit`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add src/components/PluginPanel.vue src/menus/contextMenus.ts
git commit -m "feat(aik): PluginPanel 列表 + 安装弹窗 + 右键菜单"
```

---

## Task 14: SidebarLeft「工具」入口 + App.vue 主区路由

**Files:**
- Modify: `src/components/SidebarLeft.vue`
- Modify: `src/App.vue`

**Interfaces:**
- Consumes: 现有 SidebarLeft status-bar-actions 模式；App.vue 主区视图切换模式。
- Produces: SidebarLeft 状态栏加「工具」按钮 emit `open-tools`；App.vue 加 `tools` 视图状态，渲染 `<PluginPanel>`。

- [ ] **Step 1: SidebarLeft 加按钮 + emit**

`src/components/SidebarLeft.vue`：在 `defineEmits` 加 `"open-tools": []`。在 `.status-bar-actions` 内（workbench 按钮旁）加一个按钮：

```vue
<button class="status-bar-btn" v-tooltip="'工具（AllInKit 插件）'" @click="emit('open-tools')">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
  </svg>
</button>
```

- [ ] **Step 2: App.vue 加视图**

读 `src/App.vue` 现有主区视图切换（如终端 / 文件查看器 / 工作台如何条件渲染）。加 `const showTools = ref(false)` 状态，监听 SidebarLeft 的 `open-tools` 事件设 `showTools = true`，并在主区容器内条件渲染 `<PluginPanel v-if="showTools" />`（与终端等其他视图互斥时，按现有模式管理互斥状态）。

在 `<SidebarLeft ... @open-tools="showTools = true" />` 处接事件。import `PluginPanel`：

```typescript
import PluginPanel from "./components/PluginPanel.vue";
```

主区插入：

```vue
<PluginPanel v-if="showTools" class="main-view" />
```

> 具体 `class="main-view"` / 互斥逻辑以 App.vue 现有视图管理为准。若 App.vue 用单一 `activeView` 字符串状态切换，加 `'tools'` 取值。

- [ ] **Step 3: 验证运行**

Run: `pnpm tauri dev`
Expected: 启动后侧栏状态栏出现「工具」按钮，点击后主区出现 PluginPanel（空列表引导 + 安装按钮）。

- [ ] **Step 4: Commit**

```bash
git add src/components/SidebarLeft.vue src/App.vue
git commit -m "feat(aik): SidebarLeft 工具入口 + App.vue 主区 PluginPanel 视图"
```

---

## Task 15: 文档更新

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: CLAUDE.md 加子系统说明**

在 `## 项目结构` 的 `src/components/` 列表加 `PluginPanel.vue` / `PluginIframe.vue`；`composables/` 加 `useAikPlugins.ts`；`src-tauri/src/commands/` 加 `aik.rs`、加 `src-tauri/src/aik_backends.rs`。

在 `## 关键约定` 加：

```markdown
- **AllInKit 工具面板**：`aide_` 前缀命令命名空间；插件 UI 跑在 `sandbox="allow-scripts"`（无 `allow-same-origin`）隔离 iframe；`window.aik` bootstrap 由 `aik-plugin://` 协议服务端注入（父窗口无法跨源注入）；能力调用必须走 `HostServices::dispatch_for` 全局单例（保 `kv_locks` 共享），绝不新建 `DefaultKvBackend`；`plugins_dir`（`~/.claude-code-desktop/aik/plugins`）与 `kv_root`（`~/.claude-code-desktop/aik/aik-kv`）必须独立目录；安装后需重启 Aide 生效（AllInKit 不热加载）；`AideDialog::message` 不弹 OS 消息框（避免阻塞宿主线程），由前端 toast 呈现。
```

- [ ] **Step 2: ARCHITECTURE.md 加一节**

在 `docs/ARCHITECTURE.md` 加「AllInKit 工具子系统」小节，链接到 spec 与对接指南。路径与坑点对齐 CLAUDE.md。

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/ARCHITECTURE.md
git commit -m "docs: AllInKit 工具子系统说明（aide_ 命名空间 + iframe 沙箱坑点）"
```

---

## Task 16: e2e 验证（base64-tool + kv-tool）

**Files:** 无（手动验证 + 记录结果）

- [ ] **Step 1: 准备插件包**

在 AllInKit 仓构建插件动态库与 `.aikpkg`：

```bash
cd C:\document\owner\allinkit
cargo build -p base64-tool -p kv-tool
# 按 AllInKit 自身打包流程产出 base64-tool.aikpkg / kv-tool.aikpkg（若 AllInKit 有打包脚本）
```

> 打包步骤以 AllInKit 仓 README / CLAUDE.md 为准。开发期设 `AIK_DEV_TRUST=1` 放行未签名包。

- [ ] **Step 2: 安装 base64-tool**

启动 `pnpm tauri dev`（确保 `AIK_DEV_TRUST=1`）。在 Aide 工具面板点「安装」→ 本地文件 → 选 `base64-tool.aikpkg`。重启 Aide。

Expected：列表出现 `base64-tool`，状态栏无加载失败日志。

- [ ] **Step 3: 运行 base64-tool UI**

点击 base64-tool，主区出现 iframe 渲染其 UI。在 UI 内触发一次 `window.aik.invoke("encode", {...})`（插件自身 dll 调用）。

Expected：返回正确编码结果，无 `aik_response` timeout。

- [ ] **Step 4: 安装 + 运行 kv-tool（验证 kv_locks 共享）**

同 Step 2 装 `kv-tool`（声明 `kv` 能力）。重启。打开其 UI，触发一次 `window.aik.call("kv", ...)`（能力调用，走 `HostServices::dispatch_for` → `DefaultKvBackend`）。

Expected：KV 读写成功。再让插件 dll 内部也调 `host_kv`（如 kv-tool 的 dogfood 路径），并发执行多次 RMW。

Expected：无数据竞争异常，结果一致（验证 `aide_capability_call` 走全局单例、`kv_locks` 与 dll 内 `host_call` 共享同一 `HostServices` 实例）。

- [ ] **Step 5: 安全验证**

- 未签名插件（不设 `AIK_DEV_TRUST=1`）：`load_all` 应拒绝 / 标记失败，UI 不显示。✅
- 篡改 dll（改一个字节）：验签失败，日志 `[aik] 部分插件加载失败`。✅
- 插件 UI JS 访问主窗口 `document.title`（在 iframe 内 `parent.document`）：应抛跨源错误，拿不到。✅ 验证 sandbox 隔离。
- 未声明 `fs` 能力的插件调 `window.aik.call("fs", "read_file", ...)`：返回 `PERMISSION_DENIED`。✅

- [ ] **Step 6: 记录结果**

在 commit message 或 PR 描述记录 Step 2-5 验证情况；若有失败，开 issue 并修复（回到对应 Task）。

- [ ] **Step 7: 最终 commit（若有验证修复）**

```bash
git commit -am "test(aik): e2e 验证 base64-tool + kv-tool + 安全用例"
```

---

## Self-Review 总结

**Spec 覆盖**：设计文档 `2026-06-30-aide-allinkit-integration-design.md` 子工程2 的各节——依赖与集成（Task 1,6）、宿主后端注入映射（Task 2-5）、Tauri 命令（Task 7-8）、自定义协议（Task 9）、前端类型/api/composable（Task 10-11）、隔离 iframe + postMessage 桥（Task 9 bootstrap + Task 12）、入口与导航（Task 14）、安装流程（Task 8+13）、安全模型（Task 16 Step 5）、错误处理（Task 2-5 错误码 + Task 12 catch）、测试策略（Task 2-5 单测 + Task 16 e2e）、关键文件清单（File Structure 节）、分阶段（本计划即 Phase 1）——均有对应 Task。

**类型一致性**：`AideClipboard`/`AideNotify`/`AideDialog`/`AideFs` 在 Task 2-5 定义、Task 6 `init_allinkit_runtime` 使用，名字一致。`aide_capability_call`/`aide_plugin_call` 在 Task 7 定义、Task 10 `api.aikCapabilityCall`/`aikPluginCall` 调用，名字一致。`InstalledAikPlugin` Rust（Task 8）与 TS（Task 10）字段对齐（id/name/description/version/enabled/capabilities/trust/ui_entry）。`pluginMenuItems`（Task 13 Step 1）签名与 PluginPanel 调用一致。

**外部 API 依赖（以 `aik-host` 实际为准）**：`PluginRegistry::list()`、`LoadedPlugin` 字段名（`manifest.id/name/description/version/capabilities/trust`/`enabled`）、`PluginRecord` 字段、`RegistryStore` 方法名、`HostServices::dispatch_for` 静态方法签名——计划已标注「按编译器提示对齐」。这些是 `aik-host` 公开 API 的细节，对接指南已给出主要签名，落地时以 `aik-host` 实际为准微调。