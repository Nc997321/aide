# 内置 LSP 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 基于 existing 探测器检测工作区语言（可能跨语言），自动为每种语言拉起对应 LSP server，给 CodeMirror 编辑器接上诊断/补全/悬停/定义；默认关闭，按工作区粒度开启。

**Architecture:** Rust 拥有 server 进程 + 自写薄 JSON-RPC 派发器（方案 A）。复用 runtime/mod.rs 的 stdio 泵模板、codegraph 的命令形状与 QueryResult、cmCtrlHover 的 CM 三层扩展范式、useGotoDefinition 的多 provider 链、`CREATE_NO_WINDOW`+`dunce`、workspace trust 门、codegraph 的 `ALWAYS_IGNORE_DIRS` 黑名单。新增的仅 Content-Length 帧解析器 + JSON-RPC 派发器两块真新代码。

**Tech Stack:** Rust（tokio full、`lsp-types` 0.97 新增、`which`/`dunce`/`ignore`/`serde_json` 已有）、Tauri v2 async 命令、Vue 3 + CodeMirror 6（`@codemirror/autocomplete`/`@codemirror/lint` 已随 basicSetup 引入）。

## Global Constraints

- **拆分红线**：源文件超 1000 行必须拆，且提早拆（预见会超就先拆）。`lsp/` 子模块按职责预先分文件，实现中若某块膨胀立即再拆。
- **Windows `CREATE_NO_WINDOW (0x08000000)`**：所有 `Command::new`（含 LSP server spawn）必须加此 flag，否则 release 弹控制台窗。模板见 `runtime/mod.rs:187`。
- **Windows `dunce::simplified()`**：资源路径（`resource_dir()` 返回的 `\\?\` verbatim 路径）传给 server 子进程前必须剥前缀。模板见 `runtime/mod.rs:115,156`。
- **async command 带 `State<'_, T>` 引用参数须返回 `Result`**（Tauri v2 E0277）；`State<T>` 不跨 `spawn_blocking`，注册成 `Arc<T>`（`lib.rs:108-116` 范式）。`lsp_*` 命令全 `async`，纯异步 IO（await oneshot），无需 `spawn_blocking`。
- **同步命令禁重 IO/CPU**；本计划所有 `lsp_*` 命令均为 `async fn`。
- **命名**：Rust 命令 `snake_case` 前缀 `lsp_`（如 `lsp_definition`）；前端 `invoke` 名同 Rust；前端 api 封装 `camelCase`（如 `api.lspDefinition`）。
- **依赖**：仅新增 `lsp-types`（最新 0.9x）。前端无新依赖。
- **跨平台**：路径用 `PathBuf`/`path.join`，Windows 特有逻辑 `#[cfg(windows)]` 隔离。

---

## File Structure

### 新建（Rust，`src-tauri/src/`）

| 文件 | 职责 | 体量目标 |
|---|---|---|
| `ignore_dirs.rs` | 共享 `ALWAYS_IGNORE_DIRS` 黑名单（从 `codegraph/indexer/walk.rs:13-34` 抽出，单一真源） | ~30 行 |
| `lsp/mod.rs` | `LspState`（managed state）+ `lsp_*` Tauri 命令 + lib.rs 注册 | ~250 行 |
| `lsp/detector.rs` | `LanguageId` 枚举 + `detect_languages(root)` + `FileExtFallbackDetector` | ~150 行 |
| `lsp/registry.rs` | `ServerSource` 枚举 + `resolve`（settings > bundled > which）+ `to_command` | ~150 行 |
| `lsp/transport.rs` | `Framer`（Content-Length 帧解析器）+ `format_frame`/`write_frame` + `LspTransport`（stdin 写 + stdout reader + 请求/响应 oneshot 表） | ~250 行 |
| `lsp/rpc.rs` | `IdAllocator` + `Router`（请求/响应 oneshot 关联 + server→client 通知路由）+ `dispatch` | ~180 行 |
| `lsp/docs.rs` | `OpenDocs`：`HashMap<Uri,{version,text}>`，Full 同步 version 追踪 | ~60 行 |
| `lsp/protocol.rs` | LSP `Location`→`QueryResult`、`CompletionItem`→CM Completion 映射、path↔uri | ~120 行 |
| `lsp/manager.rs` | `LspManager`：`HashMap<(workspace,lang),ServerHandle>` + ensure/kill/restart + `build_exclude_globs` + spawn+initialize 握手 | ~280 行 |
| `lsp/mock_server.rs` | `#[cfg(test)]` in-process async LSP responder（duplex 管道，握手 + definition 回固定 Location + 推 publishDiagnostics） | ~150 行 |

### 修改（Rust）

| 文件 | 改动 |
|---|---|
| `Cargo.toml:6` `[dependencies]` | 加 `lsp-types` |
| `lib.rs:1-8` mod 声明 | 加 `mod lsp;` `mod ignore_dirs;` |
| `lib.rs:116` `.manage(...)` | 加 `.manage(std::sync::Arc::new(lsp::LspState::new()))` |
| `lib.rs:205` `generate_handler!` | 追加 `lsp::*` 命令 |
| `commands/detectors.rs:17` `ProjectDetector` trait | 加 `fn languages(&self, _root: &Path) -> Vec<&'static str> { vec![] }` 默认空；relevant 探测器覆盖 |
| `commands/detectors.rs` | 加 `pub(crate) fn detect_languages_from_markers(root) -> Vec<&'static str>`（链上收集） |
| `codegraph/indexer/walk.rs:13-34` | 删除 `ALWAYS_IGNORE_DIRS` 常量，改 `use crate::ignore_dirs::ALWAYS_IGNORE_DIRS;` |
| `commands/settings.rs` `AppSettings` | 加 `lsp: LspSettings` 字段（全局 `servers` 覆盖） |
| `commands/workspace.rs` 或 `settings.rs` | 加 per-workspace lsp 配置 helper（`lsp_workspace_config`/`set_lsp_enabled`/`set_lsp_excludes`，走 `with_state_mut`） |

### 新建（前端，`src/`）

| 文件 | 职责 |
|---|---|
| `extensions/cmLsp.ts` | CM 扩展（State/Plugin/Theme 三层）：didOpen/didChange(debounce 300ms)/autocompletion/linter/hoverTooltip |
| `extensions/cmLsp.test.ts` | vitest 测试 |
| `composables/useLsp.ts` | 工作区级控制器：on/off、诊断 store、关区清理、事件监听 |

### 修改（前端）

| 文件 | 改动 |
|---|---|
| `api.ts:349` 附近 | 加 `lsp*` 封装（照 `codegraphGotoDefinition` 形状） |
| `components/CodeEditor.vue:81-91` extensions 数组 | 加一行 `cmLsp({workspaceRoot, enabled})` |
| `components/CodeEditor.vue:109` goto emit payload | 加 `column` |
| `composables/useGotoDefinition.ts:20-90` `search()` | 插 LSP 为第一 provider；`source` 加 `sourceColumn`；第 43 行 `0` 改 `source?.sourceColumn ?? 0` |
| `composables/useGotoDefinition.test.ts` | 扩测：lsp_first_then_codegraph_then_grep / lsp_error_falls_through |
| Settings UI（`SettingsPanel.vue` 工作区段） | 工作区 LSP 开关 + 排除目录列表编辑器 |

---

## Task 1: Foundation — 共享 ignore_dirs、lsp-types 依赖、lsp 模块骨架、lib.rs 注册

**Files:**
- Create: `src-tauri/src/ignore_dirs.rs`
- Create: `src-tauri/src/lsp/mod.rs`（空骨架，声明子模块）
- Modify: `src-tauri/Cargo.toml:6` `[dependencies]`
- Modify: `src-tauri/src/codegraph/indexer/walk.rs:1-13`（删常量、加 `use`）
- Modify: `src-tauri/src/lib.rs:1-8`（mod 声明）+ `lib.rs:116`（manage）+ `lib.rs:205`（handler，先不追加命令——Task 11 加）
- Test: `src-tauri/src/ignore_dirs.rs` 内 `#[cfg(test)]`；现有 `walk.rs:94` 回归

**Interfaces:**
- Produces: `crate::ignore_dirs::ALWAYS_IGNORE_DIRS: &[&str]`（pub，单一真源）；`crate::lsp` 模块（空，后续 task 填）

- [ ] **Step 1: 抽 ALWAYS_IGNORE_DIRS 到共享模块**

写 `src-tauri/src/ignore_dirs.rs`：

```rust
//! 跨子系统共享的"始终 prune"目录黑名单。
//!
//! 单一真源：codegraph indexer walk 与 lsp server exclude 都从这里取，
//! 避免两处硬编码漂移。背景见原 codegraph/indexer/walk.rs 注释——
//! `ignore` crate 的 standard_filters 只在有 .gitignore 时忽略 node_modules 等，
//! 无 .gitignore 项目会让 walk/index 钻进构建产物与依赖目录。

/// 始终 prune 的目录名（不依赖 .gitignore 是否存在）。
pub const ALWAYS_IGNORE_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "coverage",
    ".git",
    ".aide",
    ".next",
    ".nuxt",
    ".turbo",
    ".parcel-cache",
    ".svelte-kit",
    ".angular",
    ".cache",
    "__pycache__",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn always_ignore_dirs_contains_junk_dirs() {
        // 单一真源内容锁定：增删目录需显式改这里，并同步 codegraph/lsp 测试。
        assert!(ALWAYS_IGNORE_DIRS.contains(&"node_modules"));
        assert!(ALWAYS_IGNORE_DIRS.contains(&"target"));
        assert!(ALWAYS_IGNORE_DIRS.contains(&".git"));
        assert!(ALWAYS_IGNORE_DIRS.contains(&".aide"));
    }
}
```

- [ ] **Step 2: codegraph walk.rs 改引用**

`src-tauri/src/codegraph/indexer/walk.rs`：删除第 13-34 行的 `const ALWAYS_IGNORE_DIRS: &[&str] = &[ ... ];` 整块（含其上注释），在文件顶部 `use ignore::WalkBuilder;` 下加：

```rust
use crate::ignore_dirs::ALWAYS_IGNORE_DIRS;
```

第 59 行 `if ALWAYS_IGNORE_DIRS.contains(&name)` 保持不变（现在引用共享常量）。

- [ ] **Step 3: 加 lsp-types 依赖**

Run: `cd src-tauri && cargo add lsp-types`
Expected: `Cargo.toml` `[dependencies]` 多一行 `lsp-types = "0.9x"`（cargo 解析最新兼容版）。验证 `cargo build` 通过。

- [ ] **Step 4: lib.rs mod 声明**

`src-tauri/src/lib.rs` 第 1-8 行 mod 块，按字母序加：

```rust
mod codegraph;
mod commands;
mod diagnostics;
mod ignore_dirs;
mod lsp;
mod shell;
mod runtime;
mod conversation;
mod skills;
mod policy;
mod settings;
```

- [ ] **Step 5: lsp/mod.rs 空骨架**

写 `src-tauri/src/lsp/mod.rs`：

```rust
//! 内置 LSP 支持。设计见 docs/superpowers/specs/2026-08-04-lsp-builtin-design.md。
//! 子模块逐 task 填充：detector / registry / transport / rpc / docs / protocol / manager。

#[cfg(test)]
mod mock_server;
pub mod detector;
pub mod docs;
pub mod manager;
pub mod protocol;
pub mod registry;
pub mod rpc;
pub mod transport;
```

各子模块文件此时还不存在——为让 `cargo build` 通过，本步**只创建 `lsp/mod.rs` 但注释掉 `pub mod` 行**，随后续 task 逐个取消注释。即实际写入：

```rust
//! 内置 LSP 支持。设计见 docs/superpowers/specs/2026-08-04-lsp-builtin-design.md。
//! 子模块逐 task 填充。每个 task 创建对应子模块文件后，在此取消注释其 pub mod 行。

// pub mod detector;
// pub mod docs;
// pub mod manager;
// pub mod protocol;
// pub mod registry;
// pub mod rpc;
// pub mod transport;

// LspState 与命令在 Task 11 加入。
```

`#[cfg(test)] mod mock_server;` 同理在 Task 9 取消注释。

- [ ] **Step 6: lib.rs 注册 LspState（占位）**

Task 11 才定义 `LspState`，故本步**先不动** `.manage(...)` 与 `generate_handler!`。此处仅记录：Task 11 将在 `lib.rs:116` 后加 `.manage(std::sync::Arc::new(lsp::LspState::new()))`，在 `lib.rs:205` 的 `generate_handler!` 列表末尾追加 `lsp::*` 命令。

- [ ] **Step 7: 验证编译 + 回归测试**

Run: `cd src-tauri && cargo build`
Expected: 通过（共享常量抽取不改语义）。

Run: `cd src-tauri && cargo test --lib codegraph::indexer::walk::tests`
Expected: PASS（`skips_junk_dirs_minified_and_huge_files_without_gitignore` 仍过——抽取未改行为）。

Run: `cd src-tauri && cargo test --lib ignore_dirs`
Expected: PASS。

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/ignore_dirs.rs src-tauri/src/lsp/mod.rs \
        src-tauri/src/codegraph/indexer/walk.rs src-tauri/src/lib.rs \
        src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(lsp): foundation — 共享 ignore_dirs、lsp-types 依赖、lsp 模块骨架"
```

---

## Task 2: Settings 类型 — 全局 `lsp.servers` + per-workspace lsp 配置 helper

**Files:**
- Modify: `src-tauri/src/commands/settings.rs`（`AppSettings` 加 `lsp` 字段 + `LspSettings`/`ServerOverride` 类型）
- Modify: `src-tauri/src/commands/workspace.rs` 或 `settings.rs`（per-workspace helper）
- Test: 对应 `#[cfg(test)] mod tests`

**Interfaces:**
- Produces:
  - `crate::commands::settings::LspSettings { pub servers: std::collections::HashMap<String, ServerOverride> }`
  - `crate::commands::settings::ServerOverride { pub program: String, pub args: Vec<String> }`
  - `AppSettings` 新增字段 `pub lsp: LspSettings`（`#[serde(default)]`）
  - `crate::commands::workspace::lsp_workspace_config(key: &str) -> WorkspaceLspConfig`
  - `crate::commands::workspace::set_lsp_enabled(key: &str, enabled: bool) -> Result<(), String>`
  - `crate::commands::workspace::set_lsp_excludes(key: &str, dirs: Vec<String>) -> Result<(), String>`
  - `WorkspaceLspConfig { pub enabled: bool, pub exclude_dirs: Vec<String> }`（`#[serde(default)]`，默认 `enabled=false`/空）

- Consumes: `crate::commands::settings::with_state_mut`（`settings.rs:323`）、`load_state`（`settings.rs:200`）

**Note:** registry.rs（Task 4）会消费 `ServerOverride`；mod.rs 命令（Task 11）会消费 `lsp_workspace_config`/`set_lsp_*`。故本 task 必须先于 Task 4/11。

- [ ] **Step 1: 定义类型 + 写失败测试**

在 `settings.rs` 找到 `AppSettings` struct 定义（grep `struct AppSettings`）。在其旁加：

```rust
/// 用户在全局设置里对某语言 LSP server 的显式覆盖（"用这个二进制 + 这些参数"）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct ServerOverride {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
}

/// 全局 LSP 设置：按 language id 覆盖 server 二进制路径。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct LspSettings {
    /// key = language id（"rust"/"typescript"/...），值 = 显式覆盖。
    #[serde(default)]
    pub servers: std::collections::HashMap<String, ServerOverride>,
}
```

在 `AppSettings` struct 加字段：

```rust
#[serde(default)]
pub lsp: LspSettings,
```

在 `workspace.rs`（顶部 `use` 后）加：

```rust
/// 单工作区的 LSP 配置（存 state JSON，按 workspace key 索引）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct WorkspaceLspConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub exclude_dirs: Vec<String>,
}

/// 读某工作区的 LSP 配置（不存在 → 默认：关闭、无排除）。
pub fn lsp_workspace_config(key: &str) -> WorkspaceLspConfig {
    let config = super::settings::load_state();
    config
        .get("lsp_workspaces")
        .and_then(|w| w.get(key))
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// 设某工作区 LSP 开关。写 state JSON 的 lsp_workspaces[key].enabled。
pub fn set_lsp_enabled(key: &str, enabled: bool) -> Result<(), String> {
    super::settings::with_state_mut(|config| {
        let entry = config
            .as_object_mut().ok_or("state not object")?
            .entry("lsp_workspaces")
            .or_insert(serde_json::json!({}));
        let obj = entry.as_object_mut().ok_or("lsp_workspaces not object")?;
        let mut cfg: WorkspaceLspConfig = obj
            .get(key)
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        cfg.enabled = enabled;
        obj.insert(key.to_string(), serde_json::to_value(&cfg).map_err(|e| e.to_string())?);
        Ok(())
    })
}

/// 设某工作区排除目录列表。写 state JSON 的 lsp_workspaces[key].exclude_dirs。
pub fn set_lsp_excludes(key: &str, dirs: Vec<String>) -> Result<(), String> {
    super::settings::with_state_mut(|config| {
        let entry = config
            .as_object_mut().ok_or("state not object")?
            .entry("lsp_workspaces")
            .or_insert(serde_json::json!({}));
        let obj = entry.as_object_mut().ok_or("lsp_workspaces not object")?;
        let mut cfg: WorkspaceLspConfig = obj
            .get(key)
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        cfg.exclude_dirs = dirs;
        obj.insert(key.to_string(), serde_json::to_value(&cfg).map_err(|e| e.to_string())?);
        Ok(())
    })
}
```

写测试（`workspace.rs` 的 `#[cfg(test)] mod tests`，若无则新建）：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lsp_workspace_config_defaults_when_absent() {
        // load_state 读真实配置文件，测试只验默认结构（不存在 key → 默认）。
        let cfg = lsp_workspace_config("aide_test_nonexistent_key_xyz");
        assert!(!cfg.enabled);
        assert!(cfg.exclude_dirs.is_empty());
    }

    #[test]
    fn set_lsp_enabled_round_trips() {
        let key = "aide_test_set_enabled_xyz";
        set_lsp_enabled(key, true).unwrap();
        let cfg = lsp_workspace_config(key);
        assert!(cfg.enabled);
        // 清理
        set_lsp_enabled(key, false).unwrap();
    }

    #[test]
    fn set_lsp_excludes_round_trips() {
        let key = "aide_test_set_excludes_xyz";
        set_lsp_excludes(key, vec!["generated".into(), "vendor".into()]).unwrap();
        let cfg = lsp_workspace_config(key);
        assert_eq!(cfg.exclude_dirs, vec!["generated".to_string(), "vendor".to_string()]);
        // 清理
        set_lsp_excludes(key, vec![]).unwrap();
    }
}
```

- [ ] **Step 2: 跑测试验失败**

Run: `cd src-tauri && cargo test --lib commands::workspace::tests::lsp`
Expected: FAIL（`lsp_workspace_config` 等未定义 / 编译错误）—— 若是编译错误先确认类型已加。

- [ ] **Step 3: 实现**

Step 1 的代码即实现。确认 `AppSettings` 加了 `lsp` 字段且 `LspSettings`/`ServerOverride`/`WorkspaceLspConfig` 已定义。

- [ ] **Step 4: 跑测试验通过**

Run: `cd src-tauri && cargo test --lib commands::workspace::tests::lsp`
Expected: PASS（3 条）。

Run: `cd src-tauri && cargo build`
Expected: 通过（`AppSettings` 新字段 `#[serde(default)]` 不破坏现有反序列化）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/settings.rs src-tauri/src/commands/workspace.rs
git commit -m "feat(lsp): settings 类型 — 全局 lsp.servers 覆盖 + per-workspace lsp 配置 helper"
```

---

## Task 3: lsp/detector.rs — LanguageId + ProjectDetector::languages() + detect_languages

**Files:**
- Create: `src-tauri/src/lsp/detector.rs`
- Modify: `src-tauri/src/commands/detectors.rs:17`（trait 加 `languages()` 默认空）+ relevant 探测器覆盖 + `detect_languages_from_markers`
- Modify: `src-tauri/src/lsp/mod.rs`（取消注释 `pub mod detector;`）
- Test: `lsp/detector.rs` `#[cfg(test)]`；`detectors.rs` 回归

**Interfaces:**
- Produces:
  - `crate::lsp::detector::LanguageId`（enum，`Rust/TypeScript/JavaScript/Vue/Go/Java/Python/Dart/CSharp/Ruby/Php/Elixir/Kotlin/...`，`fn from_ext(ext: &str) -> Option<Self>`、`fn id_str(&self) -> &'static str`、`fn server_binary(&self) -> Option<&'static str>`）
  - `crate::lsp::detector::detect_languages(root: &Path) -> Vec<LanguageId>`（markers ∪ file-ext fallback，去重）
  - `crate::commands::detectors::detect_languages_from_markers(root: &Path) -> Vec<&'static str>`（链上收集）
  - `ProjectDetector::languages(&self, _root: &Path) -> Vec<&'static str>`（trait 默认 `vec![]`）

- Consumes: `crate::commands::detectors::ProjectDetector`、`DetectorChain`（`detectors.rs:17,34`）

- [ ] **Step 1: 写失败测试**

写 `src-tauri/src/lsp/detector.rs`（含测试，但暂不写实现函数体——先写 `todo!()` 让测试 fail）：

```rust
use std::path::Path;

/// LSP 能服务的语言。新增语言时加 variant + from_ext/server_binary 映射。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LanguageId {
    Rust,
    TypeScript,
    JavaScript,
    Vue,
    Go,
    Java,
    Python,
    Dart,
    CSharp,
    Ruby,
    Php,
    Elixir,
    Kotlin,
}

impl LanguageId {
    /// 文件扩展名 → 语言（兜底探测器用）。小写。
    pub fn from_ext(ext: &str) -> Option<Self> {
        match ext {
            "rs" => Some(Self::Rust),
            "ts" | "mts" | "cts" => Some(Self::TypeScript),
            "js" | "mjs" | "cjs" => Some(Self::JavaScript),
            "vue" => Some(Self::Vue),
            "go" => Some(Self::Go),
            "java" => Some(Self::Java),
            "kt" | "kts" => Some(Self::Kotlin),
            "py" | "pyi" => Some(Self::Python),
            "dart" => Some(Self::Dart),
            "cs" => Some(Self::CSharp),
            "rb" => Some(Self::Ruby),
            "php" => Some(Self::Php),
            "ex" | "exs" => Some(Self::Elixir),
            _ => None,
        }
    }

    /// LSP protocol languageId 字符串（didOpen 传它）。
    pub fn id_str(&self) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::TypeScript => "typescript",
            Self::JavaScript => "javascript",
            Self::Vue => "vue",
            Self::Go => "go",
            Self::Java => "java",
            Self::Kotlin => "kotlin",
            Self::Python => "python",
            Self::Dart => "dart",
            Self::CSharp => "csharp",
            Self::Ruby => "ruby",
            Self::Php => "php",
            Self::Elixir => "elixir",
        }
    }

    /// 默认 server 二进制名（registry 的 which 兜底用）。None = v1 不捆绑也不 PATH 发现。
    pub fn server_binary(&self) -> Option<&'static str> {
        match self {
            Self::Rust => Some("rust-analyzer"),
            Self::TypeScript | Self::JavaScript => Some("typescript-language-server"),
            Self::Vue => Some("vue-language-server"), // Volar
            Self::Go => Some("gopls"),
            Self::Python => Some("pyright-langserver"),
            Self::Java => Some("jdtls"),
            Self::Kotlin => Some("kotlin-language-server"),
            Self::Dart => Some("dart"),
            Self::Ruby => Some("solargraph"),
            Self::Php => Some("intelephense"),
            Self::Elixir => Some("elixir-ls"),
            Self::CSharp => Some("omnisharp"),
        }
    }
}

/// 探测某工作区涉及的语言集合（去重，无序）。
/// 先用项目 marker 探测器链（Tauri→{rust,ts,vue} 等），再用一层目录扩展名频次兜底。
pub fn detect_languages(root: &Path) -> Vec<LanguageId> {
    todo!("Task 3 Step 3")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("aide_lsp_det_{}_{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn tauri_yields_three_languages() {
        let d = tmp_dir("tauri");
        fs::write(d.join("package.json"), "{}").unwrap();
        fs::create_dir_all(d.join("src-tauri")).unwrap();
        fs::write(d.join("src-tauri/Cargo.toml"), "").unwrap();
        let langs = detect_languages(&d);
        assert!(langs.contains(&LanguageId::Rust), "{:?}", langs);
        assert!(langs.contains(&LanguageId::TypeScript), "{:?}", langs);
        // Vue 不由 Tauri 探测器声明（marker 无 .vue 文件频次时不出）；仅断言 rust+ts。
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn cargo_yields_rust() {
        let d = tmp_dir("cargo");
        fs::write(d.join("Cargo.toml"), "").unwrap();
        let langs = detect_languages(&d);
        assert!(langs.contains(&LanguageId::Rust), "{:?}", langs);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn node_yields_ts_js() {
        let d = tmp_dir("node");
        fs::write(d.join("package.json"), "{}").unwrap();
        let langs = detect_languages(&d);
        // Node 探测器声明 typescript+javascript
        assert!(langs.contains(&LanguageId::TypeScript) || langs.contains(&LanguageId::JavaScript),
            "{:?}", langs);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn go_yields_go() {
        let d = tmp_dir("go");
        fs::write(d.join("go.mod"), "module x").unwrap();
        let langs = detect_languages(&d);
        assert!(langs.contains(&LanguageId::Go), "{:?}", langs);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn spring_boot_yields_java() {
        let d = tmp_dir("spring");
        fs::write(d.join("pom.xml"), "<project><artifactId>a</artifactId></project>").unwrap();
        let langs = detect_languages(&d);
        // 任何 pom.xml → Java（SpringBootMaven 或 JavaMaven 探测器）
        assert!(langs.contains(&LanguageId::Java), "{:?}", langs);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn file_ext_fallback_no_marker() {
        // 无任何项目 marker，但目录里有若干 .py 文件 → 兜底探测器给 python。
        let d = tmp_dir("extfb");
        fs::write(d.join("a.py"), "print(1)").unwrap();
        fs::write(d.join("b.py"), "print(2)").unwrap();
        fs::write(d.join("c.txt"), "x").unwrap(); // 非源码，不计数
        let langs = detect_languages(&d);
        assert!(langs.contains(&LanguageId::Python), "{:?}", langs);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn cross_language_union() {
        // Tauri 项目根 + 子目录一堆 .go 文件 → rust/ts(来自 marker) ∪ go(来自扩展名兜底)
        let d = tmp_dir("cross");
        fs::write(d.join("package.json"), "{}").unwrap();
        fs::create_dir_all(d.join("src-tauri")).unwrap();
        fs::write(d.join("src-tauri/Cargo.toml"), "").unwrap();
        fs::create_dir_all(d.join("srv")).unwrap();
        fs::write(d.join("srv/main.go"), "package main").unwrap();
        let langs = detect_languages(&d);
        assert!(langs.contains(&LanguageId::Rust), "{:?}", langs);
        assert!(langs.contains(&LanguageId::Go), "{:?}", langs);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn from_ext_maps_known() {
        assert_eq!(LanguageId::from_ext("rs"), Some(LanguageId::Rust));
        assert_eq!(LanguageId::from_ext("TS"), Some(LanguageId::TypeScript)); // 大小写不敏感在调用方 lower
        assert_eq!(LanguageId::from_ext("py"), Some(LanguageId::Python));
        assert_eq!(LanguageId::from_ext("md"), None);
    }
}
```

注：`from_ext` 接小写 ext；`file_ext_fallback` 调用时 `to_lowercase()`。`"TS"` 测试需调用方先 lower——改测试为 `LanguageId::from_ext("ts")`。**修正测试**：把 `from_ext("TS")` 那行改为：

```rust
        assert_eq!(LanguageId::from_ext("ts"), Some(LanguageId::TypeScript));
```

- [ ] **Step 2: 跑测试验失败**

Run: `cd src-tauri && cargo test --lib lsp::detector::tests`
Expected: FAIL（`detect_languages` `todo!()` panic；且 trait `languages()` 还没加 → 编译错）。

- [ ] **Step 3: 扩展 ProjectDetector trait + 探测器覆盖**

`src-tauri/src/commands/detectors.rs` 第 17-30 行 trait 加方法（默认空）：

```rust
pub(crate) trait ProjectDetector: Send + Sync {
    fn priority(&self) -> u8;
    fn matches(&self, root: &Path) -> bool;
    fn build_targets(&self, root: &Path) -> Vec<RunTarget>;

    /// 该探测器认领的项目涉及的 LSP 语言 id 字符串（"rust"/"typescript"/...）。
    /// 默认空——多数探测器不声明（v1 仅项目型探测器覆盖）。不影响 detect_run_targets。
    fn languages(&self, _root: &Path) -> Vec<&'static str> {
        Vec::new()
    }

    fn detect(&self, root: &Path) -> Option<Vec<RunTarget>> {
        if self.matches(root) {
            let targets = self.build_targets(root);
            if !targets.is_empty() { return Some(targets); }
        }
        None
    }
}
```

为 relevant 探测器加 `languages` 覆盖。在各自 `impl ProjectDetector for XxxDetector` 块内加：

```rust
// TauriDetector
fn languages(&self, _root: &Path) -> Vec<&'static str> { vec!["rust", "typescript", "vue"] }

// CargoDetector
fn languages(&self, _root: &Path) -> Vec<&'static str> { vec!["rust"] }

// NodeDetector
fn languages(&self, _root: &Path) -> Vec<&'static str> { vec!["typescript", "javascript"] }

// GoDetector
fn languages(&self, _root: &Path) -> Vec<&'static str> { vec!["go"] }

// SpringBootMavenDetector / SpringBootGradleDetector / JavaMavenDetector / JavaGradleDetector
fn languages(&self, _root: &Path) -> Vec<&'static str> { vec!["java"] }

// FlutterDetector / DartDetector
fn languages(&self, _root: &Path) -> Vec<&'static str> { vec!["dart"] }

// PythonDetector / DjangoDetector
fn languages(&self, _root: &Path) -> Vec<&'static str> { vec!["python"] }

// RailsDetector
fn languages(&self, _root: &Path) -> Vec<&'static str> { vec!["ruby"] }

// LaravelDetector
fn languages(&self, _root: &Path) -> Vec<&'static str> { vec!["php"] }

// ElixirDetector
fn languages(&self, _root: &Path) -> Vec<&'static str> { vec!["elixir"] }

// DotnetDetector
fn languages(&self, _root: &Path) -> Vec<&'static str> { vec!["csharp"] }
```

加 `detect_languages_from_markers` 公开函数（在 `detectors.rs` 末尾、`#[cfg(test)]` 前）：

```rust
/// 走探测器链收集所有 matching 探测器声明的 LSP 语言 id 字符串（去重）。
/// 供 lsp::detector::detect_languages 用。与 detect_run_targets 独立：不要求 targets 非空，
/// 只要 matches 即收 languages（一个无 dev 脚本的 Node 项目仍该起 ts server）。
pub(crate) fn detect_languages_from_markers(root: &Path) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    let chain = DetectorChain::default_chain();
    for det in &chain.detectors {
        if det.matches(root) {
            for lang in det.languages(root) {
                if !out.contains(&lang) {
                    out.push(lang);
                }
            }
        }
    }
    out
}
```

`DetectorChain.detectors` 字段是私有的——`detect_languages_from_markers` 在 `detectors.rs` 内部定义，可访问。`matches` 是公开 trait 方法，可调。

- [ ] **Step 4: 实现 detect_languages**

`src-tauri/src/lsp/detector.rs` 把 `todo!()` 换为：

```rust
pub fn detect_languages(root: &Path) -> Vec<LanguageId> {
    let mut out: Vec<LanguageId> = Vec::new();
    // 1. 项目 marker 探测器链
    for id_str in crate::commands::detectors::detect_languages_from_markers(root) {
        if let Some(lang) = parse_language_id(id_str) {
            if !out.contains(&lang) {
                out.push(lang);
            }
        }
    }
    // 2. 一层目录扩展名频次兜底（无 marker 或 marker 漏的语言）
    if let Ok(entries) = std::fs::read_dir(root) {
        let mut counts: std::collections::HashMap<LanguageId, usize> = std::collections::HashMap::new();
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                if let Some(ext) = entry.path().extension().and_then(|e| e.to_str()) {
                    if let Some(lang) = LanguageId::from_ext(&ext.to_lowercase()) {
                        *counts.entry(lang).or_insert(0) += 1;
                    }
                }
            }
        }
        // 频次 ≥2 才认（避免单个 .go 文件误触发；marker 已覆盖主流项目）
        for (lang, n) in counts {
            if n >= 2 && !out.contains(&lang) {
                out.push(lang);
            }
        }
    }
    out
}

/// "rust" → LanguageId::Rust。与 LanguageId::id_str 互逆。
fn parse_language_id(s: &str) -> Option<LanguageId> {
    match s {
        "rust" => Some(LanguageId::Rust),
        "typescript" => Some(LanguageId::TypeScript),
        "javascript" => Some(LanguageId::JavaScript),
        "vue" => Some(LanguageId::Vue),
        "go" => Some(LanguageId::Go),
        "java" => Some(LanguageId::Java),
        "kotlin" => Some(LanguageId::Kotlin),
        "python" => Some(LanguageId::Python),
        "dart" => Some(LanguageId::Dart),
        "csharp" => Some(LanguageId::CSharp),
        "ruby" => Some(LanguageId::Ruby),
        "php" => Some(LanguageId::Php),
        "elixir" => Some(LanguageId::Elixir),
        _ => None,
    }
}
```

注意 `file_ext_fallback_no_marker` 测试写了 2 个 .py 文件 → 频次 2 ≥2 → Python 进结果。`cross_language_union` 子目录 `srv/main.go` 是子目录文件不在 `read_dir(root)` 一层扫描内 → Go 不来自扩展名兜底。**这会让 `cross_language_union` 失败**。修正：扩展名兜底应扫一层**含子目录一层**？spec §6 说 "链末加 FileExtFallbackDetector（无项目 marker 时扫一层目录扩展名频次）"——一层目录。`cross_language_union` 的 .go 在子目录 `srv/`，一层扫不到。

**修正测试 `cross_language_union`**：把 .go 文件放根层：

```rust
    #[test]
    fn cross_language_union() {
        let d = tmp_dir("cross");
        fs::write(d.join("package.json"), "{}").unwrap();
        fs::create_dir_all(d.join("src-tauri")).unwrap();
        fs::write(d.join("src-tauri/Cargo.toml"), "").unwrap();
        // 根层两个 .go 文件 → 扩展名兜底加 Go
        fs::write(d.join("a.go"), "package main").unwrap();
        fs::write(d.join("b.go"), "package main").unwrap();
        let langs = detect_languages(&d);
        assert!(langs.contains(&LanguageId::Rust), "{:?}", langs);
        assert!(langs.contains(&LanguageId::Go), "{:?}", langs);
        fs::remove_dir_all(&d).ok();
    }
```

- [ ] **Step 5: 回归保护测试**

在 `detectors.rs` 的 `#[cfg(test)] mod tests` 加：

```rust
    #[test]
    fn languages_does_not_break_detect_run_targets() {
        // 加 languages() 后，detect_run_targets 语义不变：Tauri 项目仍给 pnpm/npm tauri dev。
        let tmp = std::env::temp_dir().join("aide_det_lang_regression");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("src-tauri")).unwrap();
        std::fs::write(tmp.join("package.json"), "{}").unwrap();
        std::fs::write(tmp.join("src-tauri/Cargo.toml"), "").unwrap();
        std::fs::write(tmp.join("pnpm-lock.yaml"), "").unwrap();
        let targets = detect_run_targets(&tmp);
        assert_eq!(targets.len(), 1);
        assert!(targets[0].command.contains("tauri dev"), "{}", targets[0].command);
        // languages 不影响 targets
        let langs = detect_languages_from_markers(&tmp);
        assert!(langs.contains(&"rust"));
        std::fs::remove_dir_all(&tmp).ok();
    }
```

- [ ] **Step 6: 取消注释 mod + 跑测试**

`lsp/mod.rs` 取消注释 `pub mod detector;`。

Run: `cd src-tauri && cargo test --lib lsp::detector`
Expected: PASS（7 条）。

Run: `cd src-tauri && cargo test --lib commands::detectors`
Expected: PASS（含新回归 + 既有全过）。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/lsp/detector.rs src-tauri/src/lsp/mod.rs \
        src-tauri/src/commands/detectors.rs
git commit -m "feat(lsp): detector — LanguageId + ProjectDetector.languages() + detect_languages"
```

---

## Task 4: lsp/registry.rs — ServerSource + resolve + to_command

**Files:**
- Create: `src-tauri/src/lsp/registry.rs`
- Modify: `src-tauri/src/lsp/mod.rs`（取消注释 `pub mod registry;`）
- Test: `lsp/registry.rs` `#[cfg(test)]`

**Interfaces:**
- Produces:
  - `crate::lsp::registry::ServerSource` enum：`Bundled { subdir: String, binary: String }` | `Which { binary: String }` | `Explicit { program: String, args: Vec<String> }`
  - `resolve(lang: LanguageId, settings: &AppSettings, app: &AppHandle) -> Option<ServerSource>`（优先级：settings.lsp.servers > bundled(resource_dir) > which）
  - `to_command(src: &ServerSource) -> (String program, Vec<String> args)`（含 `--stdio`）
  - `pick_source(override: Option<&ServerOverride>, bundled: Option<ServerSource>, which: Option<ServerSource>) -> Option<ServerSource>`（纯函数，单测核心）
- Consumes: `crate::commands::settings::{AppSettings, ServerOverride}`（Task 2）、`crate::lsp::detector::LanguageId`（Task 3）、`tauri::Manager` `app.path().resource_dir()`、`which::which`、`dunce::simplified`

- [ ] **Step 1: 写失败测试**

`src-tauri/src/lsp/registry.rs`：

```rust
use crate::commands::settings::{AppSettings, ServerOverride};
use crate::lsp::detector::LanguageId;

/// 已解析的 server 启动来源。
#[derive(Debug, Clone)]
pub enum ServerSource {
    /// 随 tauri resources 捆绑：resource_dir/lsp/<subdir>/<binary>。
    Bundled { subdir: String, binary: String },
    /// PATH 上 `which` 发现的二进制。
    Which { binary: String },
    /// 用户设置显式覆盖的 program + args。
    Explicit { program: String, args: Vec<String> },
}

impl ServerSource {
    /// 捆绑 server 的资源子目录 + 二进制名（v1 仅 rust-analyzer / typescript-language-server 捆绑）。
    fn bundled_for(lang: LanguageId) -> Option<(String, String)> {
        let bin = match lang {
            LanguageId::Rust => "rust-analyzer",
            LanguageId::TypeScript | LanguageId::JavaScript => "typescript-language-server",
            _ => return None, // 其余语言 v1 不捆绑，靠 which / 用户覆盖
        };
        let binary = if cfg!(windows) { format!("{bin}.exe") } else { bin.to_string() };
        Some((lang.id_str().to_string(), binary))
    }
}

/// 纯函数：按优先级选 source。无 IO，单测核心。
/// 优先级：用户覆盖 > 捆绑 > PATH 发现。三者皆 None → None（该语言无可用 server）。
pub fn pick_source(
    override_cfg: Option<&ServerOverride>,
    bundled: Option<ServerSource>,
    which: Option<ServerSource>,
) -> Option<ServerSource> {
    if let Some(o) = override_cfg {
        if !o.program.is_empty() {
            return Some(ServerSource::Explicit {
                program: o.program.clone(),
                args: o.args.clone(),
            });
        }
    }
    bundled.or(which)
}

/// 解析某语言的 server 启动来源。优先级：settings.lsp.servers[lang] > 捆绑(resource_dir) > which(binary)。
pub fn resolve(lang: LanguageId, settings: &AppSettings, app: &tauri::AppHandle) -> Option<ServerSource> {
    let override_cfg = settings.lsp.servers.get(lang.id_str());
    let bundled = bundled_source(lang, app);
    let which = which_source(lang);
    pick_source(override_cfg, bundled, which)
}

fn bundled_source(lang: LanguageId, app: &tauri::AppHandle) -> Option<ServerSource> {
    use tauri::Manager;
    let (subdir, binary) = ServerSource::bundled_for(lang)?;
    let res_dir = app.path().resource_dir().ok()?;
    let path = res_dir.join("lsp").join(&subdir).join(&binary);
    if path.exists() {
        Some(ServerSource::Bundled { subdir, binary })
    } else {
        None
    }
}

fn which_source(lang: LanguageId) -> Option<ServerSource> {
    let bin = lang.server_binary()?;
    which::which(bin).ok().map(|_| ServerSource::Which { binary: bin.to_string() })
}

/// 转 (program, args)。program 是要 spawn 的可执行文件路径/名；args 含 `--stdio`。
/// Bundled 的 program 是 dunce 剥前缀后的完整资源路径（调用方在 spawn 时剥，这里只给原路径，
/// 因为 resource_dir 在 resolve 时已是 verbatim；spawn 前由 manager 剥——见 to_spawn_command）。
pub fn to_command(src: &ServerSource) -> (String, Vec<String>) {
    match src {
        ServerSource::Bundled { subdir, binary } => {
            // 完整路径在 manager spawn 时拼 + dunce；这里只给相对定位 + 标准参数。
            // 简化：返回 (binary, [--stdio])，manager 用 resource_dir 拼完整路径。
            // 但 manager 需要知道是 bundled——故 to_command 仅对 Which/Explicit 给完整 program。
            // Bundled 的完整路径拼在 manager（它有 app handle）。
            (format!("lsp/{subdir}/{binary}"), vec!["--stdio".to_string()])
        }
        ServerSource::Which { binary } => (binary.clone(), vec!["--stdio".to_string()]),
        ServerSource::Explicit { program, args } => {
            let mut full = args.clone();
            if !full.iter().any(|a| a == "--stdio") {
                full.push("--stdio".to_string());
            }
            (program.clone(), full)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::settings::{LspSettings, ServerOverride};
    use std::collections::HashMap;

    fn override_for(lang: &str, program: &str) -> AppSettings {
        let mut servers = HashMap::new();
        servers.insert(lang.to_string(), ServerOverride {
            program: program.to_string(),
            args: vec![],
        });
        AppSettings {
            lsp: LspSettings { servers },
            ..Default::default()
        }
    }

    fn empty_settings() -> AppSettings {
        AppSettings::default()
    }

    #[test]
    fn precedence_settings_over_bundled_over_which() {
        let settings = override_for("rust", "/my/custom/rust-analyzer");
        let bundled = Some(ServerSource::Bundled {
            subdir: "rust".into(), binary: "rust-analyzer".into(),
        });
        let which = Some(ServerSource::Which { binary: "rust-analyzer".into() });
        let picked = pick_source(settings.lsp.servers.get("rust"), bundled, which);
        match picked {
            Some(ServerSource::Explicit { program, .. }) => {
                assert_eq!(program, "/my/custom/rust-analyzer");
            }
            other => panic!("expected Explicit, got {other:?}"),
        }
    }

    #[test]
    fn bundled_missing_falls_to_which() {
        let settings = empty_settings();
        let which = Some(ServerSource::Which { binary: "gopls".into() });
        let picked = pick_source(settings.lsp.servers.get("go"), None, which);
        assert!(matches!(picked, Some(ServerSource::Which { .. })));
    }

    #[test]
    fn all_missing_returns_none() {
        let settings = empty_settings();
        let picked = pick_source(settings.lsp.servers.get("rust"), None, None);
        assert!(picked.is_none());
    }

    #[test]
    fn settings_args_passed_through() {
        let mut servers = HashMap::new();
        servers.insert("rust".to_string(), ServerOverride {
            program: "/x/rust-analyzer".into(),
            args: vec!["--log-file".into(), "/tmp/ra.log".into()],
        });
        let settings = AppSettings { lsp: LspSettings { servers }, ..Default::default() };
        let picked = pick_source(settings.lsp.servers.get("rust"), None, None);
        match picked {
            Some(ServerSource::Explicit { program, args }) => {
                assert_eq!(program, "/x/rust-analyzer");
                assert!(args.contains(&"--stdio".to_string()), "{:?}", args);
                assert!(args.contains(&"--log-file".to_string()));
            }
            other => panic!("expected Explicit, got {other:?}"),
        }
    }

    #[test]
    fn empty_program_override_is_ignored() {
        // program 空串的 override 视作未配置 → 落 bundled/which。
        let mut servers = HashMap::new();
        servers.insert("rust".to_string(), ServerOverride { program: "".into(), args: vec![] });
        let settings = AppSettings { lsp: LspSettings { servers }, ..Default::default() };
        let bundled = Some(ServerSource::Bundled {
            subdir: "rust".into(), binary: "rust-analyzer".into(),
        });
        let picked = pick_source(settings.lsp.servers.get("rust"), bundled, None);
        assert!(matches!(picked, Some(ServerSource::Bundled { .. })));
    }
}
```

注：`AppSettings` 需 `Default` impl。**检查** `settings.rs` 的 `AppSettings` 是否已派生 `Default`；若无，本步加 `#[derive(Default)]`（或手写）。若 `AppSettings` 含非 `Default` 字段导致不能派生，则测试用构造器逐字段填——改测试 helper 用 `..Default::default()` 仅在 `Default` 可用时；否则把 `empty_settings()` 改为手动构造最小 `AppSettings`（仅填 `lsp`，其余字段按现有默认值）。**执行时先确认 `AppSettings` 的 `Default` 可用性再选路径。**

- [ ] **Step 2: 跑测试验失败**

Run: `cd src-tauri && cargo test --lib lsp::registry`
Expected: FAIL（编译错——`pub mod registry` 还注释着 / `AppSettings::default` 可能缺）。

- [ ] **Step 3: 取消注释 mod + 必要时给 AppSettings 加 Default**

`lsp/mod.rs` 取消注释 `pub mod registry;`。

若 `AppSettings` 无 `Default`：在 `settings.rs` 的 `AppSettings` 上加 `#[derive(Default)]`（如所有字段皆 `Default`）或为缺 `Default` 的字段加 `#[serde(default)]` + 手动 `Default` impl。优先 `#[derive(Default)]`。

- [ ] **Step 4: 跑测试验通过**

Run: `cd src-tauri && cargo test --lib lsp::registry`
Expected: PASS（5 条）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lsp/registry.rs src-tauri/src/lsp/mod.rs src-tauri/src/commands/settings.rs
git commit -m "feat(lsp): registry — ServerSource + resolve(settings>bundled>which) + to_command"
```

---

## Task 5: lsp/transport.rs — Content-Length 帧解析器 + 帧写入 + 请求/响应 oneshot 表

**Files:**
- Create: `src-tauri/src/lsp/transport.rs`
- Modify: `src-tauri/src/lsp/mod.rs`（取消注释 `pub mod transport;`）
- Test: `lsp/transport.rs` `#[cfg(test)]`（**最关键**——framer 是真新代码，无模板）

**Interfaces:**
- Produces:
  - `crate::lsp::transport::Framer`（`new()` + `feed(chunk: &[u8]) -> Vec<serde_json::Value>`）
  - `crate::lsp::transport::format_frame(value: &serde_json::Value) -> Vec<u8>`（`Content-Length: N\r\n\r\n{body}`）
  - `crate::lsp::transport::write_frame<W: AsyncWrite + Unpin>(w: &mut W, value: &Value) -> io::Result<()>`
  - `crate::lsp::transport::RequestTable`（`insert(id, oneshot::Sender<Value>)` + `take(id) -> Option<Sender>` + `reject_all()`）
  - `crate::lsp::transport::LspTransport`（stdin `Arc<TokioMutex<dyn AsyncWrite+Send+Unpin>>` + reader 任务句柄 + `RequestTable`；`from_streams(stdin, stdout)` 可注入，生产用 piped，测试用 duplex）
- Consumes: `tokio::io`、`serde_json`、`lsp_types`（仅类型，本 task 实际只用 `serde_json::Value`）

**Note:** runtime/mod.rs 用 `reader.next_line()`（换行分隔 JSON）——LSP 用 Content-Length 帧，**这里无模板可抄**。framer 是本 task 核心。

- [ ] **Step 1: 写 framer 失败测试**

`src-tauri/src/lsp/transport.rs`：

```rust
use std::collections::HashMap;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::oneshot;

// ── Framer：Content-Length 帧解析器（带缓冲状态机）──

pub struct Framer {
    buf: Vec<u8>,
}

impl Framer {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// 喂一段字节，返回缓冲区里已完整的所有 JSON 消息。
    /// 跨 read 的 partial header/body 在内部缓冲拼接；损坏 header/JSON 跳帧不崩。
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<serde_json::Value> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        loop {
            let Some(header_end) = find_header_end(&self.buf) else { break; };
            let header = &self.buf[..header_end];
            let Some(len) = parse_content_length(header) else {
                // 无 Content-Length 的损坏 header 块：跳过这组 \r\n\r\n，继续找下一条。
                self.buf.drain(..header_end + 4);
                continue;
            };
            let body_start = header_end + 4;
            if self.buf.len() < body_start + len {
                break; // body 未到齐，等下一段
            }
            let body_bytes = self.buf[body_start..body_start + len].to_vec();
            self.buf.drain(..body_start + len);
            match serde_json::from_slice::<serde_json::Value>(&body_bytes) {
                Ok(v) => out.push(v),
                Err(_) => continue, // 损坏 JSON body 跳帧
            }
        }
        out
    }
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn parse_content_length(header: &[u8]) -> Option<usize> {
    for line in header.split(|&b| b == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if let Some(rest) = line.strip_prefix(b"Content-Length:") {
            let n: usize = std::str::from_utf8(rest).ok()?.trim().parse().ok()?;
            return Some(n);
        }
    }
    None
}

/// 把一条 JSON-RPC 消息编成 `Content-Length: N\r\n\r\n{body}` 字节（纯函数，单测）。
pub fn format_frame(value: &serde_json::Value) -> Vec<u8> {
    let body = serde_json::to_vec(value).expect("JSON-RPC payload serializable");
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    let mut out = Vec::with_capacity(header.len() + body.len());
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(&body);
    out
}

/// 写一帧到异步 sink（生产用 ChildStdin，测试用 duplex 写端）。
pub async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, value: &serde_json::Value) -> std::io::Result<()> {
    w.write_all(&format_frame(value)).await?;
    w.flush().await?;
    Ok(())
}

// ── 请求/响应 oneshot 表（照 runtime/mod.rs image_probe_waiters 范式）──

pub struct RequestTable {
    waiters: HashMap<u64, oneshot::Sender<serde_json::Value>>,
}

impl RequestTable {
    pub fn new() -> Self {
        Self { waiters: HashMap::new() }
    }
    pub fn insert(&mut self, id: u64, tx: oneshot::Sender<serde_json::Value>) {
        self.waiters.insert(id, tx);
    }
    pub fn take(&mut self, id: u64) -> Option<oneshot::Sender<serde_json::Value>> {
        self.waiters.remove(&id)
    }
    /// server EOF / 进程退出：丢弃所有 sender，所有 await 的 receiver 收到 RecvError。
    pub fn reject_all(&mut self) {
        self.waiters.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn frame(body: &str) -> Vec<u8> {
        format!("Content-Length: {}\r\n\r\n{}", body.len(), body).into_bytes()
    }

    #[test]
    fn framer_single_message() {
        let mut f = Framer::new();
        let msgs = f.feed(&frame(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#));
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["id"], 1);
    }

    #[test]
    fn framer_split_across_chunks() {
        let mut f = Framer::new();
        let full = frame(r#"{"jsonrpc":"2.0","id":2,"result":42}"#);
        let at = full.len() / 2;
        let mut msgs = f.feed(&full[..at]);
        assert!(msgs.is_empty(), "half a frame should yield nothing");
        msgs.extend(f.feed(&full[at..]));
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["result"], 42);
    }

    #[test]
    fn framer_multiple_in_one_buffer() {
        let mut f = Framer::new();
        let mut buf = frame(r#"{"id":1}"#);
        buf.extend_from_slice(&frame(r#"{"id":2}"#));
        let msgs = f.feed(&buf);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["id"], 1);
        assert_eq!(msgs[1]["id"], 2);
    }

    #[test]
    fn framer_partial_header() {
        let mut f = Framer::new();
        // 只给了部分 header（无 \r\n\r\n）
        assert!(f.feed(b"Content-Length: 13\r\n").is_empty());
        // 补齐 header + body
        let msgs = f.feed(b"\r\n{\"id\":1,\"ok\":true}");
        assert_eq!(msgs.len(), 1);
    }

    #[test]
    fn framer_empty_body() {
        let mut f = Framer::new();
        // Content-Length: 0 → body 空 → from_slice(b"") Err → 跳帧，不崩、不出消息
        let msgs = f.feed(b"Content-Length: 0\r\n\r\n");
        assert!(msgs.is_empty());
    }

    #[test]
    fn framer_garbage_header_skipped() {
        let mut f = Framer::new();
        let mut buf = b"server stderr stray line\r\n\r\n".to_vec();
        // 损坏 header 块（无 Content-Length）跳过后，正常消息应仍能解析
        buf.extend_from_slice(&frame(r#"{"id":7,"result":{}}"#));
        let msgs = f.feed(&buf);
        assert_eq!(msgs.len(), 1, "garbage header should be skipped, got {msgs:?}");
        assert_eq!(msgs[0]["id"], 7);
    }

    #[test]
    fn format_frame_produces_valid_header() {
        let bytes = format_frame(&json!({"x": 1}));
        let expected = b"Content-Length: 7\r\n\r\n{\"x\":1}".to_vec();
        assert_eq!(bytes, expected);
    }

    #[tokio::test]
    async fn write_frame_writes_to_async_sink() {
        // duplex：写一端，读另一端，验字节 = format_frame 输出
        let (mut tx, mut rx) = tokio::io::duplex(1024);
        let payload = json!({"jsonrpc":"2.0","method":"foo"});
        write_frame(&mut tx, &payload).await.unwrap();
        let mut got = Vec::new();
        tx.flush().await.unwrap();
        // 读回所有字节（帧 + 可能的后续）
        use tokio::io::AsyncReadExt;
        let mut buf = [0u8; 1024];
        let n = rx.read(&mut buf).await.unwrap();
        got.extend_from_slice(&buf[..n]);
        assert_eq!(got, format_frame(&payload));
    }

    #[tokio::test]
    async fn request_table_reject_all_awaits_get_error() {
        let mut table = RequestTable::new();
        let (tx, rx) = oneshot::channel();
        table.insert(42, tx);
        table.reject_all();
        assert!(rx.await.is_err(), "receiver must get error after reject_all");
    }

    #[test]
    fn request_table_take_removes() {
        let mut table = RequestTable::new();
        let (tx, _rx) = oneshot::channel();
        table.insert(1, tx);
        assert!(table.take(1).is_some());
        assert!(table.take(1).is_none(), "second take must be None");
    }
}
```

- [ ] **Step 2: 跑测试验失败**

Run: `cd src-tauri && cargo test --lib lsp::transport`
Expected: FAIL（`pub mod transport` 注释着 → 编译错）。

- [ ] **Step 3: 取消注释 mod**

`lsp/mod.rs` 取消注释 `pub mod transport;`。

- [ ] **Step 4: 跑测试验通过**

Run: `cd src-tauri && cargo test --lib lsp::transport`
Expected: PASS（10 条——framer 7 + format/write 2 + table 2，含 `framer_empty_body`/`framer_garbage_header_skipped`）。

- [ ] **Step 5: 加 LspTransport（stdin 持有 + reader 任务启动钩子）**

`LspTransport` 把 `RequestTable` + stdin writer + reader 任务的启动绑在一起。reader 任务逻辑在 Task 6（rpc Router）完成后由 manager 编排；本步先放 `LspTransport` 的结构 + `from_streams` + `send`，reader 由 manager（Task 10）spawn（它持有 app handle 用于 emit）。

在 `transport.rs` 加：

```rust
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

/// 持有一个 server 的 stdin 写端 + 请求/响应关联表。
/// stdout reader 任务由 manager 在 spawn 后启动（需 app handle 做 emit），
/// reader 把 Framer 出来的消息交 rpc::Router::handle_incoming 路由。
pub struct LspTransport {
    stdin: Arc<TokioMutex<Box<dyn AsyncWrite + Send + Unpin>>>,
    pub table: Arc<TokioMutex<RequestTable>>,
}

impl LspTransport {
    /// 生产：传 ChildStdin（Box 化）。测试：传 duplex 写端。
    pub fn new(stdin: Box<dyn AsyncWrite + Send + Unpin>) -> Self {
        Self {
            stdin: Arc::new(TokioMutex::new(stdin)),
            table: Arc::new(TokioMutex::new(RequestTable::new())),
        }
    }

    /// 写一帧（request 或 notification）。调方负责编好消息体。
    pub async fn send(&self, value: &serde_json::Value) -> std::io::Result<()> {
        let mut w = self.stdin.lock().await;
        write_frame(&mut *w, value).await
    }

    /// 给 reader 任务用的 table 句柄（reject_all / take 在 router 侧）。
    pub fn table_handle(&self) -> Arc<TokioMutex<RequestTable>> {
        Arc::clone(&self.table)
    }
}
```

注：`ChildStdin` 满足 `AsyncWrite + Send + Unpin`，可 `Box::new(child.stdin.take().unwrap())` 传入。reader 任务（manager Task 10）用 `tokio::io::BufReader<ChildStdout>` + `Framer`，每段 `read` 喂 framer，对每条消息调 `router.handle_incoming(msg, &app)`。

- [ ] **Step 6: 验证编译**

Run: `cd src-tauri && cargo build`
Expected: 通过。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/lsp/transport.rs src-tauri/src/lsp/mod.rs
git commit -m "feat(lsp): transport — Content-Length 帧解析器 + 帧写入 + 请求/响应 oneshot 表"
```

---

## Task 6: lsp/rpc.rs — IdAllocator + Router + dispatch

**Files:**
- Create: `src-tauri/src/lsp/rpc.rs`
- Modify: `src-tauri/src/lsp/mod.rs`（取消注释 `pub mod rpc;`）
- Test: `lsp/rpc.rs` `#[cfg(test)]`

**Interfaces:**
- Produces:
  - `crate::lsp::rpc::IdAllocator`（`new()` + `next() -> u64`，AtomicU64）
  - `crate::lsp::rpc::Action` enum：`ResolveWaiter { id: u64, result: serde_json::Value }` | `EmitDiagnostics { uri, diagnostics, version }` | `Log(String)` | `ShowMessage(String)` | `ServerRequest { id, method, params }` | `Ignore`
  - `crate::lsp::rpc::dispatch(msg: &serde_json::Value) -> Action`（纯函数）
  - `crate::lsp::rpc::Router`：`new()` + `next_request(method, params) -> (u64, oneshot::Receiver<Value>)`（分配 id、注册 waiter、返要发的消息体 + receiver）+ `handle_incoming(msg, table) -> Action`（response → resolve waiter；notification/request → 返 Action）+ `reject_all(table)`
- Consumes: `crate::lsp::transport::RequestTable`、`lsp_types`（仅类型）、`AtomicU64`、`oneshot`

- [ ] **Step 1: 写失败测试 + 实现**

`src-tauri/src/lsp/rpc.rs`：

```rust
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{oneshot, Mutex as TokioMutex};
use crate::lsp::transport::RequestTable;

/// 进程内唯一 request id 分配器（不跨 server 持久化）。
pub struct IdAllocator(AtomicU64);
impl IdAllocator {
    pub fn new() -> Self { Self(AtomicU64::new(1)) }
    pub fn next(&self) -> u64 { self.0.fetch_add(1, Ordering::Relaxed) }
}

/// dispatch 一条 server→client 消息后的动作（manager/transport 据此 emit/resolve）。
#[derive(Debug)]
pub enum Action {
    /// 响应：关联到某 waiter。table 里无此 id → 调方静默丢（不崩）。
    ResolveWaiter { id: u64, result: serde_json::Value },
    /// server 推诊断 → manager emit("lsp-diagnostics")。
    EmitDiagnostics { uri: String, diagnostics: serde_json::Value, version: Option<i64> },
    /// window/logMessage → 日志。
    Log(String),
    /// window/showMessage → toast。
    ShowMessage(String),
    /// server→client request（罕见，如 workspace/configuration）→ v1 暂不处理，回空 response。
    ServerRequest { id: serde_json::Value, method: String, params: serde_json::Value },
    Ignore,
}

/// 纯函数：按消息字段判类型。无 IO，单测核心。
pub fn dispatch(msg: &serde_json::Value) -> Action {
    let obj = match msg.as_object() { Some(o) => o, None => return Action::Ignore };
    let has_id = obj.contains_key("id");
    let has_method = obj.contains_key("method");

    if has_method && !has_id {
        // notification
        let method = obj.get("method").and_then(|v| v.as_str()).unwrap_or("");
        let params = obj.get("params").cloned().unwrap_or(serde_json::Value::Null);
        return match method {
            "textDocument/publishDiagnostics" => {
                let uri = params.get("uri").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let diagnostics = params.get("diagnostics").cloned().unwrap_or(serde_json::json!([]));
                let version = params.get("version").and_then(|v| v.as_i64());
                Action::EmitDiagnostics { uri, diagnostics, version }
            }
            "window/logMessage" => {
                let msg = params.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string();
                Action::Log(msg)
            }
            "window/showMessage" => {
                let msg = params.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string();
                Action::ShowMessage(msg)
            }
            _ => Action::Ignore,
        };
    }

    if has_method && has_id {
        // server→client request
        let id = obj.get("id").cloned().unwrap_or(serde_json::Value::Null);
        let method = obj.get("method").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let params = obj.get("params").cloned().unwrap_or(serde_json::Value::Null);
        return Action::ServerRequest { id, method, params };
    }

    if has_id {
        // response（result 或 error）
        let id = msg_id_u64(obj.get("id"));
        let result = obj.get("result").cloned().unwrap_or(serde_json::Value::Null);
        return Action::ResolveWaiter { id, result };
    }

    Action::Ignore
}

fn msg_id_u64(id: Option<&serde_json::Value>) -> u64 {
    id.and_then(|v| v.as_u64()).unwrap_or(0)
}

/// Router = id 分配器 + waiter 表操作。transport/manager 用它编出站请求、路由入站消息。
pub struct Router {
    ids: IdAllocator,
}

impl Router {
    pub fn new() -> Self { Self { ids: IdAllocator::new() } }

    /// 编一条出站 request：分配 id、在 table 注册 waiter、返 (要发的完整消息体, receiver)。
    pub fn next_request(
        &self,
        method: &str,
        params: serde_json::Value,
        table: &Arc<TokioMutex<RequestTable>>,
    ) -> (serde_json::Value, oneshot::Receiver<serde_json::Value>) {
        let id = self.ids.next();
        let (tx, rx) = oneshot::channel();
        // 同步插入：table 用 TokioMutex，但本函数非 async——用 try_lock 或改 blocking。
        // 这里要求调用方在 async 上下文；为保持签名同步，改用 std::sync::Mutex 包一层 id→tx。
        // 简化：返回消息体与 receiver，table 插入由调用方在 async 上下文做（见 manager）。
        // 故本函数只分配 id + 建通道，不碰 table。
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        // tx 交给调用方注册（manager.ensure/handle 里 table.lock().await.insert(id, tx)）。
        // 为避免 tx 丢失，这里用 thread-local 暂存不现实——故改为：本函数返 (msg, id, rx)，
        // 调用方拿 id 去 insert。重签如下（见 Step 2 修订）。
        let _ = tx; // 占位；实际见 Step 2
        (msg, rx)
    }
}
```

**问题**：`next_request` 需把 `tx` 注册进 table，但 table 是 `TokioMutex`（async lock），而 `next_request` 想保持同步签名。最干净的做法：`next_request` 返回 `(msg, id, receiver)`，调用方（manager）在 async 上下文里 `table.lock().await.insert(id, tx)`。**重写 Step 1 的 `Router`**——把 `next_request` 改为：

```rust
impl Router {
    pub fn new() -> Self { Self { ids: IdAllocator::new() } }

    /// 分配 id + 建通道。返回 (要发的消息体, id, receiver)。
    /// 调用方（async 上下文）负责 `table.lock().await.insert(id, tx)` 后再 send 消息体。
    pub fn next_request(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> (serde_json::Value, u64, oneshot::Receiver<serde_json::Value>) {
        let id = self.ids.next();
        let (tx, rx) = oneshot::channel();
        let msg = serde_json::json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params,
        });
        // tx 通过通道机制交给调用方：用 oneshot 暂存——不行，receiver 已分出。
        // 解决：next_request 改返 (msg, id, tx, rx)——调用方 insert(tx) 后 await rx。
        // 但 tx 在 rx 之外要送出，签名得含 tx。重签见 Step 2。
        let _ = tx;
        (msg, id, rx)
    }
}
```

**仍卡在 tx 交付**。最终干净方案：`next_request` 返回 `(msg: Value, id: u64, tx: oneshot::Sender<Value>, rx: oneshot::Receiver<Value>)`，调用方 `table.insert(id, tx)` 后 `transport.send(&msg).await`。**采用此签名**。重写 `Router::next_request`：

```rust
    pub fn next_request(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> (
        serde_json::Value,                                  // 要发的消息体
        u64,                                                 // id（调用方 insert 用）
        oneshot::Sender<serde_json::Value>,                 // 注册进 table
        oneshot::Receiver<serde_json::Value>,               // 调用方 await
    ) {
        let id = self.ids.next();
        let (tx, rx) = oneshot::channel();
        let msg = serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        (msg, id, tx, rx)
    }
```

写测试（用纯 `dispatch` + 手建 table 验 resolve/reject，不依赖 `Router::next_request` 的签名纠结）：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn id_allocator_monotonic() {
        let a = IdAllocator::new();
        assert_eq!(a.next(), 1);
        assert_eq!(a.next(), 2);
        assert_eq!(a.next(), 3);
    }

    #[test]
    fn dispatch_routes_response() {
        let msg = json!({"jsonrpc":"2.0","id":5,"result":{"x":1}});
        match dispatch(&msg) {
            Action::ResolveWaiter { id, result } => {
                assert_eq!(id, 5);
                assert_eq!(result["x"], 1);
            }
            other => panic!("expected ResolveWaiter, got {other:?}"),
        }
    }

    #[test]
    fn dispatch_routes_notification() {
        let msg = json!({
            "jsonrpc":"2.0","method":"textDocument/publishDiagnostics",
            "params":{"uri":"file:///x.rs","diagnostics":[],"version":3}
        });
        match dispatch(&msg) {
            Action::EmitDiagnostics { uri, version, .. } => {
                assert_eq!(uri, "file:///x.rs");
                assert_eq!(version, Some(3));
            }
            other => panic!("expected EmitDiagnostics, got {other:?}"),
        }
    }

    #[test]
    fn dispatch_routes_log_and_show() {
        let log = json!({"method":"window/logMessage","params":{"message":"hi"}});
        assert!(matches!(dispatch(&log), Action::Log(m) if m == "hi"));
        let show = json!({"method":"window/showMessage","params":{"message":"warn"}});
        assert!(matches!(dispatch(&show), Action::ShowMessage(m) if m == "warn"));
    }

    #[test]
    fn dispatch_routes_server_request() {
        let msg = json!({"jsonrpc":"2.0","id":9,"method":"workspace/configuration","params":{}});
        match dispatch(&msg) {
            Action::ServerRequest { method, .. } => assert_eq!(method, "workspace/configuration"),
            other => panic!("expected ServerRequest, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn dispatch_unknown_id_response_dropped_silently() {
        // response id=99，table 里只有 id=1 的 waiter → 99 取不到 sender，静默丢，不崩。
        let mut table = RequestTable::new();
        let (tx1, rx1) = oneshot::channel();
        table.insert(1, tx1);
        let msg = json!({"jsonrpc":"2.0","id":99,"result":{}});
        match dispatch(&msg) {
            Action::ResolveWaiter { id, .. } => {
                assert_eq!(id, 99);
                let taken = table.take(99);
                assert!(taken.is_none(), "unknown id must not be in table");
            }
            other => panic!("expected ResolveWaiter, got {other:?}"),
        }
        // waiter 1 仍挂着，未被 99 误 resolve
        drop(rx1); // 不 await，仅验未误触
    }

    #[tokio::test]
    async fn router_next_request_round_trip_via_table() {
        let router = Router::new();
        let mut table = RequestTable::new();
        let (msg, id, tx, rx) = router.next_request("textDocument/definition", json!({}));
        assert_eq!(msg["method"], "textDocument/definition");
        table.insert(id, tx);
        // 模拟 server 回响应
        let resp = json!({"jsonrpc":"2.0","id":id,"result":[{"uri":"file:///x.rs","range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}}}]});
        match dispatch(&resp) {
            Action::ResolveWaiter { id: rid, result } => {
                assert_eq!(rid, id);
                if let Some(sender) = table.take(rid) {
                    sender.send(result).unwrap();
                }
            }
            other => panic!("got {other:?}"),
        }
        let got = rx.await.unwrap();
        assert!(got.as_array().unwrap().len() == 1);
    }
}
```

- [ ] **Step 2: 跑测试验失败**

Run: `cd src-tauri && cargo test --lib lsp::rpc`
Expected: FAIL（`pub mod rpc` 注释着 → 编译错）。

- [ ] **Step 3: 取消注释 mod + 清理实现**

`lsp/mod.rs` 取消注释 `pub mod rpc;`。

确认 `Router::next_request` 用 Step 1 末尾的 4-元组签名，删掉中间纠结的旧版本。

- [ ] **Step 4: 跑测试验通过**

Run: `cd src-tauri && cargo test --lib lsp::rpc`
Expected: PASS（6 条）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lsp/rpc.rs src-tauri/src/lsp/mod.rs
git commit -m "feat(lsp): rpc — IdAllocator + dispatch + Router(请求/响应关联 + 通知路由)"
```

---

## Task 7: lsp/docs.rs — OpenDocs（Full 同步 version 追踪）

**Files:**
- Create: `src-tauri/src/lsp/docs.rs`
- Modify: `src-tauri/src/lsp/mod.rs`（取消注释 `pub mod docs;`）
- Test: `lsp/docs.rs` `#[cfg(test)]`

**Interfaces:**
- Produces:
  - `crate::lsp::docs::OpenDocs`（`HashMap<String(uri), DocEntry{version:i64,text:String}>`）
  - 方法：`open(uri, text)`（version=1）、`change(uri, text) -> i64`（version++ 返新 version）、`close(uri)`、`synced_version(uri) -> Option<i64>`、`get_text(uri) -> Option<&str>`、`contains(uri) -> bool`

- [ ] **Step 1: 写实现 + 失败测试**

`src-tauri/src/lsp/docs.rs`：

```rust
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct DocEntry {
    pub version: i64,
    pub text: String,
}

/// per-server 打开文档追踪。Full 同步：每次 change 整份 text，version 单调递增。
/// didOpen/didChange 发送时带 version；server 推诊断带的 version 与之比对丢旧（防闪烁）。
#[derive(Debug, Default)]
pub struct OpenDocs(HashMap<String, DocEntry>);

impl OpenDocs {
    pub fn new() -> Self { Self::default() }

    pub fn open(&mut self, uri: String, text: String) {
        self.0.insert(uri, DocEntry { version: 1, text });
    }

    /// 整份替换 text，version++，返回新 version。调用前须已 open（panic 否则）。
    pub fn change(&mut self, uri: &str, text: String) -> i64 {
        let e = self.0.get_mut(uri).expect("change before open");
        e.version += 1;
        e.text = text;
        e.version
    }

    pub fn close(&mut self, uri: &str) {
        self.0.remove(uri);
    }

    pub fn synced_version(&self, uri: &str) -> Option<i64> {
        self.0.get(uri).map(|e| e.version)
    }

    pub fn get_text(&self, uri: &str) -> Option<&str> {
        self.0.get(uri).map(|e| e.text.as_str())
    }

    pub fn contains(&self, uri: &str) -> bool {
        self.0.contains_key(uri)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_sets_version_1() {
        let mut d = OpenDocs::new();
        d.open("file:///a.rs".into(), "fn main(){}".into());
        assert_eq!(d.synced_version("file:///a.rs"), Some(1));
        assert_eq!(d.get_text("file:///a.rs"), Some("fn main(){}"));
    }

    #[test]
    fn change_increments_version() {
        let mut d = OpenDocs::new();
        d.open("file:///a.rs".into(), "x".into());
        let v2 = d.change("file:///a.rs", "xy".into());
        assert_eq!(v2, 2);
        let v3 = d.change("file:///a.rs", "xyz".into());
        assert_eq!(v3, 3);
        assert_eq!(d.synced_version("file:///a.rs"), Some(3));
        assert_eq!(d.get_text("file:///a.rs"), Some("xyz"));
    }

    #[test]
    fn close_removes() {
        let mut d = OpenDocs::new();
        d.open("file:///a.rs".into(), "x".into());
        d.close("file:///a.rs");
        assert!(d.synced_version("file:///a.rs").is_none());
        assert!(!d.contains("file:///a.rs"));
    }

    #[test]
    fn synced_version_tracks_absent() {
        let d = OpenDocs::new();
        assert_eq!(d.synced_version("file:///none"), None);
    }
}
```

- [ ] **Step 2: 取消注释 mod + 跑测试**

`lsp/mod.rs` 取消注释 `pub mod docs;`。

Run: `cd src-tauri && cargo test --lib lsp::docs`
Expected: PASS（4 条）。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lsp/docs.rs src-tauri/src/lsp/mod.rs
git commit -m "feat(lsp): docs — OpenDocs Full 同步 version 追踪"
```

---

## Task 8: lsp/protocol.rs — LSP Location→QueryResult + Completion 映射 + path↔uri

**Files:**
- Create: `src-tauri/src/lsp/protocol.rs`
- Modify: `src-tauri/src/lsp/mod.rs`（取消注释 `pub mod protocol;`）
- Test: `lsp/protocol.rs` `#[cfg(test)]`

**Interfaces:**
- Produces:
  - `crate::lsp::protocol::location_to_query_result(loc: &lsp_types::Location, queried_word: &str) -> crate::codegraph::types::QueryResult`
  - `crate::lsp::protocol::locations_to_query_results(locs: &[lsp_types::Location], word: &str) -> Vec<QueryResult>`
  - `crate::lsp::protocol::completion_items_to_cm(items: &[lsp_types::CompletionItem]) -> Vec<CmCompletion>`（`CmCompletion { label, detail: Option<String>, documentation: Option<String>, kind: Option<u32>, insert_text: Option<String> }`）
  - `crate::lsp::protocol::path_to_uri(path: &str) -> String`、`uri_to_path(uri: &str) -> String`
- Consumes: `crate::codegraph::types::{QueryResult, SymbolDef, SymbolKind, Confidence}`（`types.rs:65,26,5,17`）、`lsp_types`、`percent_encoding`（已有依赖 `Cargo.toml:40`）

- [ ] **Step 1: 写实现 + 测试**

`src-tauri/src/lsp/protocol.rs`：

```rust
use crate::codegraph::types::{Confidence, QueryResult, SymbolDef, SymbolKind};
use lsp_types::{Location, CompletionItem};

/// 前端 CM Completion 需要的最小字段（cmLsp 再映射成 CM 的 Completion 对象）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct CmCompletion {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub documentation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub insert_text: Option<String>,
}

/// LSP Location（无符号名）+ 查询词 → QueryResult。
/// LSP 定义权威 → confidence=Structure；kind 无从得知 → 占位 Function（goto UI 走 name/file/line）。
pub fn location_to_query_result(loc: &Location, queried_word: &str) -> QueryResult {
    let start = loc.range.start;
    QueryResult {
        symbol: SymbolDef {
            name: queried_word.to_string(),
            kind: SymbolKind::Function, // 占位：LSP Location 不带 SymbolKind
            file: uri_to_path(&loc.uri.to_string()),
            line: (start.line + 1) as usize,    // LSP 0-based → 1-based
            column: (start.character + 1) as usize,
            parent: None,
            end_line: 0,
        },
        confidence: Confidence::Structure,
        score: None,
        snippet: None,
    }
}

pub fn locations_to_query_results(locs: &[Location], word: &str) -> Vec<QueryResult> {
    locs.iter().map(|l| location_to_query_result(l, word)).collect()
}

pub fn completion_items_to_cm(items: &[CompletionItem]) -> Vec<CmCompletion> {
    items.iter().map(|it| CmCompletion {
        label: it.label.clone(),
        detail: it.detail.clone(),
        documentation: it.documentation.as_ref().map(|d| match d {
            lsp_types::Documentation::String(s) => s.clone(),
            lsp_types::Documentation::MarkupContent(m) => m.value.clone(),
        }),
        kind: it.kind.map(|k| *k as u32),
        insert_text: it.insert_text.clone(),
    }).collect()
}

/// 本地路径 → file:// URI。统一用 `/`，Windows 盘符前 `/C:/`。
pub fn path_to_uri(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    if normalized.starts_with('/') {
        format!("file://{}", normalized)
    } else {
        // Windows "C:/foo" → "file:///C:/foo"
        format!("file:///{}", normalized)
    }
}

/// file:// URI → 本地路径（用 `/`，前端与 codegraph 都用正斜杠）。
pub fn uri_to_path(uri: &str) -> String {
    if let Some(rest) = uri.strip_prefix("file:///") {
        rest.to_string() // Windows: "C:/foo/bar"
    } else if let Some(rest) = uri.strip_prefix("file://") {
        rest.to_string() // Unix: "/foo/bar"
    } else {
        uri.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lsp_types::{Location, Position, Range, Url};

    #[test]
    fn lsp_location_to_query_result() {
        let loc = Location {
            uri: Url::parse("file:///C:/proj/src/main.rs").unwrap(),
            range: Range {
                start: Position { line: 5, character: 10 }, // 0-based
                end: Position { line: 5, character: 14 },
            },
        };
        let qr = location_to_query_result(&loc, "my_fn");
        assert_eq!(qr.symbol.name, "my_fn");
        assert_eq!(qr.symbol.file, "C:/proj/src/main.rs");
        assert_eq!(qr.symbol.line, 6);       // 1-based
        assert_eq!(qr.symbol.column, 11);    // 1-based
        assert_eq!(qr.confidence, Confidence::Structure);
        assert_eq!(qr.score, None);
    }

    #[test]
    fn path_uri_round_trip_windows() {
        let p = "C:/proj/src/main.rs";
        let uri = path_to_uri(p);
        assert_eq!(uri, "file:///C:/proj/src/main.rs");
        assert_eq!(uri_to_path(&uri), p);
    }

    #[test]
    fn path_uri_round_trip_unix() {
        let p = "/home/x/proj/main.rs";
        let uri = path_to_uri(p);
        assert_eq!(uri, "file:///home/x/proj/main.rs"); // strip "file://" → "/home/..."
        // 注意：path_to_uri 给绝对路径加 "file://"（两斜杠），uri_to_path strip "file://"
        assert_eq!(uri_to_path(&uri), p);
    }

    #[test]
    fn backslash_path_normalized_in_uri() {
        let uri = path_to_uri("C:\\proj\\src\\main.rs");
        assert_eq!(uri, "file:///C:/proj/src/main.rs");
    }

    #[test]
    fn completion_items_map_label_detail_doc() {
        let items = vec![
            CompletionItem {
                label: "foo".into(),
                detail: Some("fn foo()".into()),
                documentation: Some(lsp_types::Documentation::String("docs".into())),
                kind: Some(lsp_types::CompletionItemKind::FUNCTION),
                insert_text: Some("foo()".into()),
                ..Default::default()
            },
        ];
        let cm = completion_items_to_cm(&items);
        assert_eq!(cm.len(), 1);
        assert_eq!(cm[0].label, "foo");
        assert_eq!(cm[0].detail.as_deref(), Some("fn foo()"));
        assert_eq!(cm[0].documentation.as_deref(), Some("docs"));
        assert!(cm[0].insert_text.as_deref() == Some("foo()"));
    }
}
```

注：`lsp_types::Url` 在 0.97 可能是 `lsp_types::Uri`（无 `parse`/`Display` 同形）。**若 `Url::parse` 不可用**：改用 `lsp_types::Uri::from_str(...)` 或构造时用 `path_to_uri` helper（不依赖 Url）。Location 的 `loc.uri` 字段类型按 `lsp-types` 实际版调整：`&loc.uri.to_string()` 可能需 `loc.uri.as_str()`。**执行时按 `cargo doc --open -p lsp-types` 实际 API 调整**；测试若因 Url API 编译错，把 `Url::parse(...)` 换成 `lsp_types::Uri::from_file_path(std::path::Path::new("C:/proj/src/main.rs")).unwrap()`（如该方法存在）或直接构造 JSON 验 `uri_to_path`/`path_to_uri` 纯函数，Location 测试用 `serde_json::from_value` 反序列化一个 Location 避开 Url 构造。

- [ ] **Step 2: 取消注释 mod + 跑测试**

`lsp/mod.rs` 取消注释 `pub mod protocol;`。

Run: `cd src-tauri && cargo test --lib lsp::protocol`
Expected: PASS（5 条，或按 Url API 调整后的等价数）。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lsp/protocol.rs src-tauri/src/lsp/mod.rs
git commit -m "feat(lsp): protocol — Location→QueryResult / Completion→CM 映射 + path↔uri"
```

---

## Task 9: lsp/mock_server.rs — in-process async LSP responder（测试夹具）

**Files:**
- Create: `src-tauri/src/lsp/mock_server.rs`（`#[cfg(test)]`）
- Modify: `src-tauri/src/lsp/mod.rs`（取消注释 `#[cfg(test)] mod mock_server;`）
- Test: 无独立测试（被 Task 10 manager 测试用）

**Interfaces:**
- Produces:
  - `crate::lsp::mock_server::spawn_mock_lsp() -> (MockHandle, tokio::io::DuplexStream_read_end_for_transport)`
  - 实际签名：`spawn_mock_lsp() -> (Box<dyn AsyncWrite + Send + Unpin> /* transport stdin */, Box<dyn AsyncRead + Send + Unpin> /* transport stdout */, tokio::task::JoinHandle<()>)`
  - mock 行为：响应 `initialize`（返 capabilities）+ `initialized`（无应）+ `textDocument/definition`（返固定一个 `Location`）+ `shutdown`（返 null）+ 主动推一条 `textDocument/publishDiagnostics`

- Consumes: `tokio::io::duplex`、`crate::lsp::transport::{Framer, format_frame}`

**Note:** spec §9 说"极小 Rust 二进制"。本 task 实现为 **in-process async task over duplex**——满足"真 stdio 帧测试 + CI 可跑"意图（测的是真实 Content-Length 帧编解码 + 路由），且无需 `[[bin]]` 目标、`cargo test` 直接跑。这是对 spec 的实现选择，记于此。

- [ ] **Step 1: 实现 mock**

`src-tauri/src/lsp/mock_server.rs`：

```rust
//! 测试夹具：in-process 极小 LSP responder。
//! 走 tokio duplex 管道，说 Content-Length 帧 LSP 协议子集：
//! initialize → capabilities；initialized → 无应；textDocument/definition → 固定 Location；
//! shutdown → null；启动后主动推一条 publishDiagnostics。
//! 让 transport+rpc+manager 的端到端测试在 cargo test 里跑，无需外部二进制。

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use crate::lsp::transport::{Framer, format_frame};

pub struct MockLsp {
    /// transport 的 stdin 写端（manager 往这写）→ mock 的读端
    pub transport_stdin: Box<dyn AsyncWrite + Send + Unpin>,
    /// transport 的 stdout 读端（manager 从这读）← mock 的写端
    pub transport_stdout: Box<dyn AsyncRead + Send + Unpin>,
    pub join: tokio::task::JoinHandle<()>,
}

pub fn spawn_mock_lsp() -> MockLsp {
    // duplex A：manager 写 → mock 读（mock 的 stdin）
    let (a_write, a_read) = tokio::io::duplex(8 * 1024);
    // duplex B：mock 写 → manager 读（mock 的 stdout）
    let (b_write, b_read) = tokio::io::duplex(8 * 1024);

    let join = tokio::spawn(async move {
        mock_responder(a_read, b_write).await;
    });

    MockLsp {
        transport_stdin: Box::new(a_write),
        transport_stdout: Box::new(b_read),
        join,
    }
}

async fn mock_responder<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(mut reader: R, mut writer: W) {
    let mut framer = Framer::new();
    let mut buf = [0u8; 4096];

    // 启动即推一条 publishDiagnostics
    let diag = serde_json::json!({
        "jsonrpc":"2.0","method":"textDocument/publishDiagnostics",
        "params":{"uri":"file:///mock/main.rs","diagnostics":[
            {"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":3}},
             "severity":1,"message":"mock diagnostic"}
        ]}
    });
    let _ = writer.write_all(&format_frame(&diag)).await;

    loop {
        let n = match reader.read(&mut buf).await {
            Ok(0) => break, // transport 关闭
            Ok(n) => n,
            Err(_) => break,
        };
        for msg in framer.feed(&buf[..n]) {
            let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
            let id = msg.get("id").cloned();
            let resp = match method {
                "initialize" => Some(serde_json::json!({
                    "jsonrpc":"2.0","id":id,
                    "result":{"capabilities":{"definitionProvider":true,"completionProvider":{},"hoverProvider":true,"textDocumentSync":1}}
                })),
                "initialized" => None, // notification，无应
                "textDocument/definition" => Some(serde_json::json!({
                    "jsonrpc":"2.0","id":id,
                    "result":[{"uri":"file:///mock/def.rs","range":{"start":{"line":2,"character":4},"end":{"line":2,"character":8}}}]
                })),
                "shutdown" => Some(serde_json::json!({"jsonrpc":"2.0","id":id,"result":null})),
                _ => id.map(|i| serde_json::json!({"jsonrpc":"2.0","id":i,"result":null})),
            };
            if let Some(r) = resp {
                let _ = writer.write_all(&format_frame(&r)).await;
            }
            if method == "shutdown" {
                break; // 模拟 shutdown 后退出
            }
        }
    }
}
```

- [ ] **Step 2: 取消注释 mod + 验证编译**

`lsp/mod.rs` 取消注释 `#[cfg(test)] mod mock_server;`（注意保留 `#[cfg(test)]` 前缀）。

Run: `cd src-tauri && cargo build --tests`
Expected: 通过（mock 编译，尚无测试调用它）。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lsp/mock_server.rs src-tauri/src/lsp/mod.rs
git commit -m "feat(lsp): mock_server — in-process async LSP responder（测试夹具）"
```

---

## Task 10: lsp/manager.rs — LspManager + ensure/kill/restart + 排除集 + spawn+initialize 握手

**Files:**
- Create: `src-tauri/src/lsp/manager.rs`
- Modify: `src-tauri/src/lsp/mod.rs`（取消注释 `pub mod manager;`）
- Test: `lsp/manager.rs` `#[cfg(test)]`（纯逻辑 + mock_server 端到端）

**Interfaces:**
- Produces:
  - `crate::lsp::manager::LspManager`：`new()` + `ensure_server(workspace_key, lang, app, settings) -> Result<ServerHandle, EnsureError>` + `kill_workspace(workspace_key)` + `kill_server(workspace_key, lang)` + `restart_workspace(workspace_key, app, settings)` + `build_exclude_globs(exclude_dirs: &[String]) -> Vec<String>` + `is_excluded(path: &str, exclude_globs: &[String]) -> bool`
  - `crate::lsp::manager::ServerHandle`：`{ transport: LspTransport, docs: Arc<TokioMutex<OpenDocs>>, router: Arc<Router>, exclude_globs: Vec<String>, initialized: bool, dead: Arc<AtomicBool> }`
  - `crate::lsp::manager::EnsureError`：`ServerNotFound` | `HandshakeFailed(String)` | `SpawnFailed(String)`
- Consumes: `registry`（Task 4）、`transport`（Task 5）、`rpc`（Task 6）、`docs`（Task 7）、`detector::LanguageId`（Task 3）、`crate::ignore_dirs::ALWAYS_IGNORE_DIRS`（Task 1）、`mock_server`（Task 9，测试用）、`tauri::Manager`（resource_dir）、`CREATE_NO_WINDOW`+`dunce`、`commands::workspace::lsp_workspace_config`（Task 2，读 exclude_dirs）

- [ ] **Step 1: 写纯逻辑测试 + 实现 build_exclude_globs/is_excluded**

`src-tauri/src/lsp/manager.rs`：

```rust
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{oneshot, Mutex as TokioMutex};
use tokio::process::{Child, Command};
use tokio::io::{AsyncReadExt, BufReader};

use crate::ignore_dirs::ALWAYS_IGNORE_DIRS;
use crate::lsp::detector::LanguageId;
use crate::lsp::docs::OpenDocs;
use crate::lsp::registry::{self, ServerSource};
use crate::lsp::rpc::{Router, dispatch, Action};
use crate::lsp::transport::{Framer, LspTransport, write_frame};

#[derive(Debug)]
pub enum EnsureError {
    ServerNotFound,
    SpawnFailed(String),
    HandshakeFailed(String),
}

pub struct ServerHandle {
    pub transport: LspTransport,
    pub docs: Arc<TokioMutex<OpenDocs>>,
    pub router: Arc<Router>,
    pub exclude_globs: Vec<String>,
    pub initialized: AtomicBool,
    pub dead: Arc<AtomicBool>,
    _child: Option<Arc<TokioMutex<Child>>>, // mock 时 None
}

impl ServerHandle {
    pub fn is_alive(&self) -> bool {
        !self.dead.load(Ordering::Relaxed) && self.initialized.load(Ordering::Relaxed)
    }
}

/// key = (workspace_root_string, LanguageId)
pub struct LspManager {
    handles: TokioMutex<HashMap<(String, LanguageId), Arc<ServerHandle>>>,
    spawn_lock: TokioMutex<()>,
}

impl LspManager {
    pub fn new() -> Self {
        Self { handles: TokioMutex::new(HashMap::new()), spawn_lock: TokioMutex::new(()) }
    }

    /// 幂等：已 alive 直接返；dead → 重拉。
    pub async fn ensure_server(
        &self,
        workspace: &str,
        lang: LanguageId,
        app: &tauri::AppHandle,
        settings: &crate::commands::settings::AppSettings,
    ) -> Result<Arc<ServerHandle>, EnsureError> {
        let _g = self.spawn_lock.lock().await;
        {
            let map = self.handles.lock().await;
            if let Some(h) = map.get(&(workspace.to_string(), lang)) {
                if h.is_alive() { return Ok(Arc::clone(h)); }
            }
        }
        // dead 或不存在 → spawn 新的
        let src = registry::resolve(lang, settings, app).ok_or(EnsureError::ServerNotFound)?;
        let handle = spawn_and_init(workspace, lang, &src, app, settings).await?;
        self.handles.lock().await.insert((workspace.to_string(), lang), Arc::clone(&handle));
        Ok(handle)
    }

    pub async fn kill_workspace(&self, workspace: &str) {
        let removed: Vec<Arc<ServerHandle>> = {
            let mut map = self.handles.lock().await;
            let keys: Vec<_> = map.keys().filter(|(w, _)| w == workspace).cloned().collect();
            keys.into_iter().filter_map(|k| map.remove(&k)).collect()
        };
        for h in removed {
            shutdown_handle(&h).await;
        }
    }

    pub async fn kill_server(&self, workspace: &str, lang: LanguageId) {
        let removed = self.handles.lock().await.remove(&(workspace.to_string(), lang));
        if let Some(h) = removed { shutdown_handle(&h).await; }
    }

    /// 排除集变更后重拉该工作区全部 server（init exclude 不支持热改）。
    pub async fn restart_workspace(
        &self, workspace: &str, app: &tauri::AppHandle,
        settings: &crate::commands::settings::AppSettings,
    ) -> Result<(), EnsureError> {
        self.kill_workspace(workspace).await;
        // 重新 ensure 各 lang（调用方已知该工作区活跃 lang；这里由 mod.rs 逐个 did_open 时自然重拉）
        Ok(())
    }

    pub async fn get(&self, workspace: &str, lang: LanguageId) -> Option<Arc<ServerHandle>> {
        self.handles.lock().await.get(&(workspace.to_string(), lang)).filter(|h| h.is_alive()).cloned()
    }
}

/// 排除集 = ALWAYS_IGNORE_DIRS ∪ workspace.lsp_exclude_dirs，转 `**/{dir}/**` globs。
pub fn build_exclude_globs(workspace_exclude_dirs: &[String]) -> Vec<String> {
    let mut globs: Vec<String> = ALWAYS_IGNORE_DIRS
        .iter()
        .map(|d| format!("**/{d}/**"))
        .collect();
    for d in workspace_exclude_dirs {
        // 用户给的是相对工作区根的目录名/路径，取末段做 glob（IDEA 式 mark directory as excluded）
        let seg = d.split(|c| c == '/' || c == '\\').filter(|s| !s.is_empty()).last().unwrap_or(d);
        globs.push(format!("**/{seg}/**"));
    }
    globs
}

/// 路径是否落在排除集（didOpen 前置过滤）。path 用正斜杠。
pub fn is_excluded(path: &str, exclude_globs: &[String]) -> bool {
    let norm = path.replace('\\', "/");
    for g in exclude_globs {
        // glob `**/{dir}/**` → 路径含 /dir/ 即命中（简单 substring；v1 不引 glob 库）
        if let Some(dir) = g.strip_prefix("**/").and_then(|s| s.strip_suffix("/**")) {
            if norm.contains(&format!("/{dir}/")) { return true; }
        }
    }
    false
}

async fn shutdown_handle(h: &ServerHandle) {
    // 发 shutdown request → 给 500ms grace → exit notification → 标 dead
    let (msg, id, tx, _rx) = h.router.next_request("shutdown", serde_json::Value::Null);
    h.transport.table.lock().await.insert(id, tx);
    let _ = h.transport.send(&msg).await;
    // 不等响应（grace period），直接 exit + 标 dead
    let exit = serde_json::json!({"jsonrpc":"2.0","method":"exit"});
    let _ = h.transport.send(&exit).await;
    h.dead.store(true, Ordering::Relaxed);
    h.transport.table.lock().await.reject_all();
}

async fn spawn_and_init(
    workspace: &str,
    lang: LanguageId,
    src: &ServerSource,
    app: &tauri::AppHandle,
    settings: &crate::commands::settings::AppSettings,
) -> Result<Arc<ServerHandle>, EnsureError> {
    let exclude_dirs = crate::commands::workspace::lsp_workspace_config(
        &crate::commands::workspace::path_to_key(workspace)
    ).exclude_dirs;
    let exclude_globs = build_exclude_globs(&exclude_dirs);

    // —— 生产 spawn ——
    #[cfg(not(test))]
    let (transport, child) = spawn_real(src, app).await?;
    #[cfg(test)]
    let (transport, child) = spawn_test(src).await; // 用 mock_server

    let router = Arc::new(Router::new());
    let docs = Arc::new(TokioMutex::new(OpenDocs::new()));
    let dead = Arc::new(AtomicBool::new(false));
    let initialized = AtomicBool::new(false);

    let handle = Arc::new(ServerHandle {
        transport, docs, router: Arc::clone(&router),
        exclude_globs: exclude_globs.clone(),
        initialized, dead: Arc::clone(&dead),
        _child: child,
    });

    // —— reader 任务（生产用 child stdout；测试用 mock stdout）——
    // 注：spawn_test 把 mock stdout 装进 transport 的 reader 源；spawn_real 同理。
    // reader 在 transport 内部（见 Step 2 spawn_* 返回 reader 源 + 这里 spawn reader task）。
    start_reader(handle.clone(), app.clone());

    // —— initialize 握手 ——
    init_handshake(&handle, workspace, lang, &exclude_globs).await?;
    handle.initialized.store(true, Ordering::Relaxed);
    Ok(handle)
}

// Step 2 填 spawn_real / spawn_test / start_reader / init_handshake
```

写纯逻辑测试（不 spawn）：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclude_globs_union_with_workspace_excludes() {
        let globs = build_exclude_globs(&vec!["generated".into(), "vendor".into()]);
        // 硬编码黑名单
        assert!(globs.contains(&"**/node_modules/**".to_string()));
        assert!(globs.contains(&"**/target/**".to_string()));
        // 用户手动排除
        assert!(globs.contains(&"**/generated/**".to_string()));
        assert!(globs.contains(&"**/vendor/**".to_string()));
    }

    #[test]
    fn exclude_globs_format() {
        let g = build_exclude_globs(&[])[0].clone();
        assert!(g.starts_with("**/") && g.ends_with("/**"), "{}", g);
    }

    #[test]
    fn exclude_globs_takes_last_path_segment() {
        // 用户给 "src/generated" → glob 用末段 "generated"
        let globs = build_exclude_globs(&vec!["src/generated".into()]);
        assert!(globs.contains(&"**/generated/**".to_string()));
        assert!(!globs.contains(&"**/src/generated/**".to_string()));
    }

    #[test]
    fn is_excluded_matches_dir() {
        let globs = build_exclude_globs(&vec!["generated".into()]);
        assert!(is_excluded("C:/proj/generated/x.rs", &globs));
        assert!(is_excluded("C:/proj/sub/generated/y.ts", &globs));
        assert!(!is_excluded("C:/proj/src/main.rs", &globs));
    }

    #[test]
    fn is_excluded_normalizes_backslash() {
        let globs = build_exclude_globs(&vec!["target".into()]);
        assert!(is_excluded("C:\\proj\\target\\x.rs", &globs));
    }

    #[test]
    fn always_ignore_dirs_unchanged_after_extract() {
        // 回归：抽取后黑名单仍含核心项（与 walk.rs 共享同一常量）
        assert!(ALWAYS_IGNORE_DIRS.contains(&"node_modules"));
        assert!(ALWAYS_IGNORE_DIRS.contains(&"target"));
        assert!(ALWAYS_IGNORE_DIRS.contains(&".git"));
    }
}
```

- [ ] **Step 2: 实现 spawn_real / spawn_test / start_reader / init_handshake**

在 `manager.rs` 加：

```rust
#[cfg(not(test))]
async fn spawn_real(src: &ServerSource, app: &tauri::AppHandle)
    -> Result<(LspTransport, Option<Arc<TokioMutex<Child>>>), EnsureError>
{
    use tauri::Manager;
    let (program, args) = registry::to_command(src);
    // Bundled：拼完整资源路径 + dunce 剥前缀
    let program_path = match src {
        ServerSource::Bundled { subdir, binary } => {
            let res_dir = app.path().resource_dir().map_err(|e| EnsureError::SpawnFailed(e.to_string()))?;
            let p = res_dir.join("lsp").join(subdir).join(binary);
            dunce::simplified(&p).to_path_buf()
        }
        _ => std::path::PathBuf::from(&program),
    };
    let mut cmd = Command::new(&program_path);
    cmd.args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .current_dir(std::env::current_dir().unwrap_or_default());
    #[cfg(windows)]
    { cmd.creation_flags(0x08000000); } // CREATE_NO_WINDOW
    let mut child = cmd.spawn().map_err(|e| EnsureError::SpawnFailed(format!("{:?}: {}", program_path, e)))?;
    let stdin = child.stdin.take().ok_or(EnsureError::SpawnFailed("no stdin".into()))?;
    let stdout = child.stdout.take().ok_or(EnsureError::SpawnFailed("no stdout".into()))?;
    // stderr 尾部缓冲（照 runtime/mod.rs:209）
    let _stderr = child.stderr.take();
    let child = Arc::new(TokioMutex::new(child));
    // stdin + stdout 都装进 transport；stdout 通过 spawn_reader_source 注入 reader（见下）
    let transport = LspTransport::with_reader_source(Box::new(stdin), Box::new(stdout));
    Ok((transport, Some(child)))
}
```

`LspTransport` 需扩展持有 reader 源（`Box<dyn AsyncRead + Send + Unpin>`）。回 `transport.rs` 给 `LspTransport` 加字段 `pub reader_source: Option<Box<dyn AsyncRead + Send + Unpin>>` + 构造器 `with_reader_source(stdin, stdout)`。**回 Task 5 transport.rs 调整**：`LspTransport::new(stdin)` 改为 `with_reader_source(stdin, stdout)`，存 `reader_source`，供 manager `start_reader` 取出 spawn reader 任务。**本步先去 transport.rs 加该字段与构造器，并改测试中 `LspTransport::new(...)` 调用**。

`spawn_test`（用 mock）：

```rust
#[cfg(test)]
async fn spawn_test(_src: &ServerSource) -> (LspTransport, Option<Arc<TokioMutex<Child>>>) {
    let mock = crate::lsp::mock_server::spawn_mock_lsp();
    let transport = LspTransport::with_reader_source(mock.transport_stdin, mock.transport_stdout);
    (transport, None)
}
```

`start_reader`：

```rust
fn start_reader(handle: Arc<ServerHandle>, app: tauri::AppHandle) {
    let reader_source = handle.transport.take_reader_source(); // 取出 Box<AsyncRead>
    let table = handle.transport.table_handle();
    let dead = Arc::clone(&handle.dead);
    let docs = Arc::clone(&handle.docs);
    tokio::spawn(async move {
        let mut reader = BufReader::new(reader_source);
        let mut framer = Framer::new();
        let mut buf = [0u8; 8192];
        loop {
            let n = match reader.read(&mut buf).await { Ok(0) => break, Ok(n) => n, Err(_) => break };
            for msg in framer.feed(&buf[..n]) {
                match dispatch(&msg) {
                    Action::ResolveWaiter { id, result } => {
                        if let Some(tx) = table.lock().await.take(id) { let _ = tx.send(result); }
                    }
                    Action::EmitDiagnostics { uri, diagnostics, version } => {
                        let _ = app.emit("lsp-diagnostics", serde_json::json!({
                            "workspaceRoot": "", "uri": uri, "diagnostics": diagnostics, "version": version
                        }));
                    }
                    Action::Log(s) => tracing::info!("[lsp] {}", s),
                    Action::ShowMessage(s) => { let _ = app.emit("lsp-show-message", s); }
                    Action::ServerRequest { id, method: _, params: _ } => {
                        // v1：回空 response（不实现 workspace/configuration 等细节）
                        // 需 transport.send —— 简化：忽略，记日志
                        tracing::debug!("[lsp] server request ignored: id={:?}", id);
                    }
                    Action::Ignore => {}
                }
            }
        }
        // EOF：reject 所有 waiter + 标 dead
        table.lock().await.reject_all();
        dead.store(true, Ordering::Relaxed);
        let _ = app.emit("lsp-server-dead", ());
    });
}
```

`init_handshake`（注入排除集 globs 到 init options）：

```rust
async fn init_handshake(
    handle: &ServerHandle,
    workspace: &str,
    lang: LanguageId,
    exclude_globs: &[String],
) -> Result<(), EnsureError> {
    let root_uri = crate::lsp::protocol::path_to_uri(workspace);
    // 按语言注入 init exclude（rust-analyzer: excludeGlobs；gopls: directoryFilters）
    let init_options = match lang {
        LanguageId::Rust => serde_json::json!({"excludeGlobs": exclude_globs}),
        LanguageId::Go => serde_json::json!({"directoryFilters": exclude_globs.iter().map(|g| g.replace("**/", "-").replace("/**", "")).collect::<Vec<_>>()}),
        _ => serde_json::json!({}),
    };
    let params = serde_json::json!({
        "processId": std::process::id(),
        "rootUri": root_uri,
        "capabilities": {
            "textDocument": {"synchronization": {"didSave": false}},
            "workspace": {"workspaceEdit": false}
        },
        "workspaceFolders": [{"uri": root_uri, "name": workspace}],
        "initializationOptions": init_options,
    });
    let (msg, id, tx, rx) = handle.router.next_request("initialize", params);
    handle.transport.table.lock().await.insert(id, tx);
    handle.transport.send(&msg).await
        .map_err(|e| EnsureError::HandshakeFailed(e.to_string()))?;
    // 5s 握手判活（非请求超时——照 spec §8）
    let result = match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
        Ok(Ok(v)) => v,
        Ok(Err(_)) => return Err(EnsureError::HandshakeFailed("channel closed".into())),
        Err(_) => return Err(EnsureError::HandshakeFailed("initialize timeout (>5s, no capabilities)".into())),
    };
    let _ = result; // capabilities（v1 只验 server 回了响应）
    // initialized notification
    let initd = serde_json::json!({"jsonrpc":"2.0","method":"initialized","params":{}});
    handle.transport.send(&initd).await.map_err(|e| EnsureError::HandshakeFailed(e.to_string()))?;
    Ok(())
}
```

`app.emit` 需 `use tauri::Emitter;`——加在文件顶部。

- [ ] **Step 3: 回 transport.rs 加 reader_source 字段**

`transport.rs` 的 `LspTransport` 加：

```rust
pub struct LspTransport {
    stdin: Arc<TokioMutex<Box<dyn AsyncWrite + Send + Unpin>>>,
    pub table: Arc<TokioMutex<RequestTable>>,
    reader_source: tokio::sync::Mutex<Option<Box<dyn AsyncRead + Send + Unpin>>>,
}

impl LspTransport {
    pub fn with_reader_source(
        stdin: Box<dyn AsyncWrite + Send + Unpin>,
        stdout: Box<dyn AsyncRead + Send + Unpin>,
    ) -> Self {
        Self {
            stdin: Arc::new(TokioMutex::new(stdin)),
            table: Arc::new(TokioMutex::new(RequestTable::new())),
            reader_source: tokio::sync::Mutex::new(Some(stdout)),
        }
    }
    pub async fn take_reader_source(&self) -> Box<dyn AsyncRead + Send + Unpin> {
        self.reader_source.lock().await.take().expect("reader taken once")
    }
    pub async fn send(&self, value: &serde_json::Value) -> std::io::Result<()> {
        let mut w = self.stdin.lock().await;
        write_frame(&mut *w, value).await
    }
    pub fn table_handle(&self) -> Arc<TokioMutex<RequestTable>> { Arc::clone(&self.table) }
}
```

加 `use tokio::io::AsyncRead;`。原 `LspTransport::new(stdin)` 移除（被 `with_reader_source` 替代）。

- [ ] **Step 4: 取消注释 mod + mock_server 端到端测试**

`lsp/mod.rs` 取消注释 `pub mod manager;`。

在 `manager.rs` 的 `#[cfg(test)] mod tests` 加端到端（用 mock）：

```rust
    #[tokio::test]
    async fn ensure_server_idempotent() {
        // 用 mock：ensure 两次同 (workspace,lang) → 同一 handle（alive）
        let mgr = LspManager::new();
        // 注：ensure_server 生产走 spawn_real（#[cfg(not(test))]）；测试走 spawn_test。
        // 但 ensure_server 的 spawn 分支是 cfg(test) 选 spawn_test——故测试可直接调。
        // 此处需 app/settings —— 测试环境用最小桩。略：验证 handles map 同 key 复用。
        // 见 Step 5 说明：mock 端到端需 AppHandle 桩，挪到 mod.rs 集成测试（Task 11）。
    }
```

**注意**：`ensure_server` 需要 `&tauri::AppHandle` + `&AppSettings`，纯 mock 测试难造 AppHandle。故 mock 端到端测试（ensure_idempotent / kill / restart / dead_respawn）**移到 Task 11 `lsp/mod.rs` 的集成测试**，那里有更完整的桩。本 task 的 `manager.rs` 单测**只保留纯逻辑**（build_exclude_globs / is_excluded / always_ignore_dirs 回归，Step 1 已写）。删掉上面空的 `ensure_server_idempotent` 占位。

- [ ] **Step 5: 跑测试验通过**

Run: `cd src-tauri && cargo test --lib lsp::manager`
Expected: PASS（6 条纯逻辑）。

Run: `cd src-tauri && cargo build --tests`
Expected: 通过（mock + manager 编译）。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lsp/manager.rs src-tauri/src/lsp/transport.rs src-tauri/src/lsp/mod.rs
git commit -m "feat(lsp): manager — LspManager(ensure/kill/restart) + 排除集 globs + spawn+initialize 握手"
```

---

## Task 11: lsp/mod.rs — LspState + lsp_* 命令 + lib.rs 注册 + mock 端到端集成测试

**Files:**
- Create/Modify: `src-tauri/src/lsp/mod.rs`（LspState + 命令；此前只含 mod 声明）
- Modify: `src-tauri/src/lib.rs:116`（`.manage(...)`）+ `lib.rs:205`（`generate_handler!` 追加）
- Modify: `src-tauri/src/commands/workspace.rs`（加 `workspace_set_lsp_enabled` / `workspace_set_lsp_excludes` Tauri 命令，信任校验前置）
- Test: `lsp/mod.rs` `#[cfg(test)]`（QueryResult 映射 + did_open skip + mock 端到端 lifecycle）

**Interfaces:**
- Produces（Tauri 命令，全 `async fn` 返 `Result`）：
  - `lsp_detect_languages(workspace_root: String) -> Result<Vec<String /*id_str*/>, String>`
  - `lsp_ensure_server(workspace_root: String, lang: String) -> Result<EnsureOutcome, String>`（`{ ok: bool, kind: Option<"server_not_found"|"handshake_failed"> }`）
  - `lsp_did_open(workspace_root, filePath, lang, text) -> Result<(), String>`
  - `lsp_did_change(workspace_root, filePath, lang, text, version?) -> Result<(), String>`
  - `lsp_did_close(workspace_root, filePath, lang) -> Result<(), String>`
  - `lsp_definition(workspace_root, filePath, line, column, word) -> Result<Vec<QueryResult>, String>`
  - `lsp_completion(workspace_root, filePath, line, column) -> Result<Vec<CmCompletion>, String>`
  - `lsp_hover(workspace_root, filePath, line, column) -> Result<{ content: Option<String> }, String>`
  - `lsp_shutdown_workspace(workspace_root) -> Result<(), String>`
  - `workspace_set_lsp_enabled(workspace_root: String, enabled: bool) -> Result<(), String>`（信任校验前置）
  - `workspace_set_lsp_excludes(workspace_root: String, dirs: Vec<String>) -> Result<(), String>`（改排除集 → 触发 server 重拉）
- Consumes: `LspManager`（Task 10）、`detect_languages`（Task 3）、`protocol` 映射（Task 8）、`workspace::is_workspace_trusted`（`workspace.rs:314`）、`workspace::{path_to_key, set_lsp_enabled, set_lsp_excludes, lsp_workspace_config}`（Task 2）、`codegraph::types::QueryResult`

- [ ] **Step 1: 实现 LspState + 命令**

`src-tauri/src/lsp/mod.rs` 在 mod 声明后加：

```rust
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;
use serde::Serialize;

pub use crate::lsp::manager::{LspManager, EnsureError};
pub use crate::lsp::protocol::CmCompletion;

#[derive(Debug, Serialize)]
pub struct EnsureOutcome {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
}

pub struct LspState(pub Arc<TokioMutex<LspManager>>);
impl LspState {
    pub fn new() -> Self { Self(Arc::new(TokioMutex::new(LspManager::new()))) }
}

fn lang_from_id_str(s: &str) -> Option<crate::lsp::detector::LanguageId> {
    crate::lsp::detector::lang_from_id_str(s) // 在 detector.rs 加 pub fn（见 Step 2）
}

#[tauri::command]
pub async fn lsp_detect_languages(workspace_root: String) -> Result<Vec<String>, String> {
    let langs = crate::lsp::detector::detect_languages(std::path::Path::new(&workspace_root));
    Ok(langs.iter().map(|l| l.id_str().to_string()).collect())
}

#[tauri::command]
pub async fn lsp_ensure_server(
    workspace_root: String, lang: String,
    state: tauri::State<'_, Arc<LspState>>,
    settings_service: tauri::State<'_, Arc<crate::settings::SettingsService>>,
    app: tauri::AppHandle,
) -> Result<EnsureOutcome, String> {
    let Some(lang_id) = lang_from_id_str(&lang) else {
        return Ok(EnsureOutcome { ok: false, kind: Some("server_not_found") });
    };
    let settings = crate::commands::settings::public_settings(settings_service.inner())
        .map_err(|e| e.to_string())?;
    let mgr = state.0.lock().await;
    match mgr.ensure_server(&workspace_root, lang_id, &app, &settings).await {
        Ok(_) => Ok(EnsureOutcome { ok: true, kind: None }),
        Err(EnsureError::ServerNotFound) => Ok(EnsureOutcome { ok: false, kind: Some("server_not_found") }),
        Err(EnsureError::HandshakeFailed(e)) => Ok(EnsureOutcome { ok: false, kind: Some("handshake_failed") }),
        Err(EnsureError::SpawnFailed(e)) => Err(format!("spawn failed: {e}")),
    }
}

#[tauri::command]
pub async fn lsp_did_open(
    workspace_root: String, file_path: String, lang: String, text: String,
    state: tauri::State<'_, Arc<LspState>>,
    settings_service: tauri::State<'_, Arc<crate::settings::SettingsService>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let Some(lang_id) = lang_from_id_str(&lang) else { return Ok(()); };
    let settings = crate::commands::settings::public_settings(settings_service.inner()).map_err(|e| e.to_string())?;
    let mgr = state.0.lock().await;
    let h = match mgr.ensure_server(&workspace_root, lang_id, &app, &settings).await {
        Ok(h) => h, Err(_) => return Ok(()),
    };
    // §5.4 排除集跳过
    if crate::lsp::manager::is_excluded(&file_path, &h.exclude_globs) { return Ok(()); }
    let uri = crate::lsp::protocol::path_to_uri(&file_path);
    h.docs.lock().await.open(uri.clone(), text.clone());
    let notif = serde_json::json!({
        "jsonrpc":"2.0","method":"textDocument/didOpen",
        "params":{"textDocument":{"uri":uri,"languageId":lang,"version":1,"text":text}}
    });
    h.transport.send(&notif).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lsp_did_change(
    workspace_root: String, file_path: String, lang: String, text: String, version: Option<i64>,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<(), String> {
    let Some(lang_id) = lang_from_id_str(&lang) else { return Ok(()); };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else { return Ok(()); };
    let uri = crate::lsp::protocol::path_to_uri(&file_path);
    let v = match h.docs.lock().await.change(&uri, text.clone()) {
        v => v
    };
    let _ = version; // Full 同步：用 docs 内部 version
    let notif = serde_json::json!({
        "jsonrpc":"2.0","method":"textDocument/didChange",
        "params":{"textDocument":{"uri":uri,"version":v},
                  "contentChanges":[{"text":text}]}
    });
    h.transport.send(&notif).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lsp_did_close(
    workspace_root: String, file_path: String, lang: String,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<(), String> {
    let Some(lang_id) = lang_from_id_str(&lang) else { return Ok(()); };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else { return Ok(()); };
    let uri = crate::lsp::protocol::path_to_uri(&file_path);
    h.docs.lock().await.close(&uri);
    let notif = serde_json::json!({
        "jsonrpc":"2.0","method":"textDocument/didClose",
        "params":{"textDocument":{"uri":uri}}
    });
    h.transport.send(&notif).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lsp_definition(
    workspace_root: String, file_path: String, line: usize, column: usize, word: String,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<Vec<crate::codegraph::types::QueryResult>, String> {
    let lang = lang_from_ext_of(&file_path);
    let Some(lang_id) = lang else { return Ok(vec![]); };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else { return Ok(vec![]); };
    let uri = crate::lsp::protocol::path_to_uri(&file_path);
    let params = serde_json::json!({
        "textDocument":{"uri":uri},
        "position":{"line":(line as u64).saturating_sub(1),"character":(column as u64).saturating_sub(1)}
    });
    let (msg, id, tx, rx) = h.router.next_request("textDocument/definition", params);
    h.transport.table.lock().await.insert(id, tx);
    h.transport.send(&msg).await.map_err(|e| e.to_string())?;
    let result = rx.await.map_err(|_| "server closed".to_string())?;
    // result 是 null / Location / Location[]
    let locs = parse_locations(&result);
    Ok(crate::lsp::protocol::locations_to_query_results(&locs, &word))
}

#[tauri::command]
pub async fn lsp_completion(
    workspace_root: String, file_path: String, line: usize, column: usize,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<Vec<CmCompletion>, String> {
    let Some(lang_id) = lang_from_ext_of(&file_path) else { return Ok(vec![]); };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else { return Ok(vec![]); };
    let uri = crate::lsp::protocol::path_to_uri(&file_path);
    let params = serde_json::json!({
        "textDocument":{"uri":uri},
        "position":{"line":(line as u64).saturating_sub(1),"character":(column as u64).saturating_sub(1)}
    });
    let (msg, id, tx, rx) = h.router.next_request("textDocument/completion", params);
    h.transport.table.lock().await.insert(id, tx);
    h.transport.send(&msg).await.map_err(|e| e.to_string())?;
    let result = rx.await.map_err(|_| "server closed".to_string())?;
    let items = parse_completion_items(&result);
    Ok(crate::lsp::protocol::completion_items_to_cm(&items))
}

#[tauri::command]
pub async fn lsp_hover(
    workspace_root: String, file_path: String, line: usize, column: usize,
    state: tauri::State<'_, Arc<LspState>>,
) -> Result<serde_json::Value, String> {
    let Some(lang_id) = lang_from_ext_of(&file_path) else { return Ok(serde_json::json!({"content":null})); };
    let mgr = state.0.lock().await;
    let Some(h) = mgr.get(&workspace_root, lang_id).await else { return Ok(serde_json::json!({"content":null})); };
    let uri = crate::lsp::protocol::path_to_uri(&file_path);
    let params = serde_json::json!({
        "textDocument":{"uri":uri},
        "position":{"line":(line as u64).saturating_sub(1),"character":(column as u64).saturating_sub(1)}
    });
    let (msg, id, tx, rx) = h.router.next_request("textDocument/hover", params);
    h.transport.table.lock().await.insert(id, tx);
    h.transport.send(&msg).await.map_err(|e| e.to_string())?;
    let result = rx.await.map_err(|_| "server closed".to_string())?;
    let content = parse_hover_content(&result);
    Ok(serde_json::json!({"content":content}))
}

#[tauri::command]
pub async fn lsp_shutdown_workspace(
    workspace_root: String,
    state: tauri::State<'_, Arc<LspState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    state.0.lock().await.kill_workspace(&workspace_root).await;
    let _ = tauri::Emitter::emit(&app, "lsp-diagnostics", serde_json::json!({"workspaceRoot":workspace_root,"clear":true}));
    Ok(())
}
```

helper 函数（在 `mod.rs` 底部）：

```rust
fn lang_from_ext_of(file_path: &str) -> Option<crate::lsp::detector::LanguageId> {
    let ext = file_path.rsplit('.').next().map(|e| e.to_lowercase())?;
    crate::lsp::detector::LanguageId::from_ext(&ext)
}

fn parse_locations(result: &serde_json::Value) -> Vec<lsp_types::Location> {
    use lsp_types::Location;
    if result.is_null() { return vec![]; }
    if let Some(arr) = result.as_array() {
        arr.iter().filter_map(|v| serde_json::from_value::<Location>(v.clone()).ok()).collect()
    } else {
        serde_json::from_value::<Location>(result.clone()).ok().into_iter().collect()
    }
}

fn parse_completion_items(result: &serde_json::Value) -> Vec<lsp_types::CompletionItem> {
    if let Some(arr) = result.get("items").and_then(|v| v.as_array()) {
        arr.iter().filter_map(|v| serde_json::from_value::<lsp_types::CompletionItem>(v.clone()).ok()).collect()
    } else if let Some(arr) = result.as_array() {
        arr.iter().filter_map(|v| serde_json::from_value::<lsp_types::CompletionItem>(v.clone()).ok()).collect()
    } else { vec![] }
}

fn parse_hover_content(result: &serde_json::Value) -> Option<String> {
    let contents = result.get("contents")?;
    match contents {
        serde_json::Value::String(s) => Some(s.clone()),
        obj if obj.is_object() => obj.get("value").and_then(|v| v.as_str()).map(String::from),
        _ => None,
    }
}
```

- [ ] **Step 2: detector.rs 加 lang_from_id_str pub fn**

`lsp/detector.rs` 把 Task 3 的私有 `parse_language_id` 改为 `pub fn lang_from_id_str(s: &str) -> Option<LanguageId>`（同体）。`mod.rs` 的 `lang_from_id_str` 调用改为 `crate::lsp::detector::lang_from_id_str`。

- [ ] **Step 3: workspace_set_lsp_enabled / workspace_set_lsp_excludes 命令**

`src-tauri/src/commands/workspace.rs` 加：

```rust
#[tauri::command]
pub async fn workspace_set_lsp_enabled(workspace_root: String, enabled: bool) -> Result<(), String> {
    // 信任门：未信任工作区拒开 LSP（LSP 跑外部二进制 + 索引工作区，本就该走信任门）
    if enabled && !is_path_trusted(&workspace_root) {
        return Err("untrusted workspace".into());
    }
    let key = path_to_key(&workspace_root);
    set_lsp_enabled(&key, enabled)
}

#[tauri::command]
pub async fn workspace_set_lsp_excludes(workspace_root: String, dirs: Vec<String>) -> Result<(), String> {
    let key = path_to_key(&workspace_root);
    set_lsp_excludes(&key, dirs)?;
    // 改排除集 → 触发该工作区 server 重拉（init exclude 不支持热改）
    // 由前端调 lsp_shutdown_workspace 后下次 did_open 自然重拉；
    // 或在此 emit 信号。v1：返回 OK，前端 disable→enable LSP 完成重拉。
    Ok(())
}
```

- [ ] **Step 4: lib.rs 注册**

`lib.rs:116` 后加：

```rust
.manage(std::sync::Arc::new(lsp::LspState::new()))
```

`lib.rs:205` `generate_handler!` 列表末尾（在最后一个命令后）加：

```rust
            commands::workspace::workspace_set_lsp_enabled,
            commands::workspace::workspace_set_lsp_excludes,
            lsp::lsp_detect_languages,
            lsp::lsp_ensure_server,
            lsp::lsp_did_open,
            lsp::lsp_did_change,
            lsp::lsp_did_close,
            lsp::lsp_definition,
            lsp::lsp_completion,
            lsp::lsp_hover,
            lsp::lsp_shutdown_workspace,
```

- [ ] **Step 5: 集成测试（QueryResult 映射 + did_open skip + mock lifecycle）**

`lsp/mod.rs` 加 `#[cfg(test)] mod tests`：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::manager::{build_exclude_globs, is_excluded};

    #[test]
    fn lsp_location_to_query_result_via_protocol() {
        // 覆盖 spec lsp_location_to_query_result（在 protocol.rs 实测，这里验 mod 暴露）
        let locs = vec![lsp_types::Location {
            uri: lsp_types::Url::parse("file:///C:/p/x.rs").unwrap(),
            range: lsp_types::Range {
                start: lsp_types::Position { line: 3, character: 5 },
                end: lsp_types::Position { line: 3, character: 8 },
            },
        }];
        let r = crate::lsp::protocol::locations_to_query_results(&locs, "foo");
        assert_eq!(r[0].symbol.name, "foo");
        assert_eq!(r[0].symbol.line, 4);
        assert_eq!(r[0].symbol.column, 6);
    }

    #[test]
    fn did_open_skips_excluded_paths() {
        let globs = build_exclude_globs(&vec!["generated".into()]);
        assert!(is_excluded("C:/p/generated/x.rs", &globs));
        // 命令层 lsp_did_open 内部调 is_excluded → 跳过发 didOpen（这里验判定逻辑）
        assert!(!is_excluded("C:/p/src/main.rs", &globs));
    }

    #[tokio::test]
    async fn mock_end_to_end_definition() {
        // 用 mock_server：spawn → initialize 握手 → definition 请求 → 收 Location → 映射 QueryResult
        // 因 ensure_server 需 AppHandle，此处直接用 mock 构 transport + router 走 definition 流。
        let mock = crate::lsp::mock_server::spawn_mock_lsp();
        let transport = crate::lsp::transport::LspTransport::with_reader_source(
            mock.transport_stdin, mock.transport_stdout,
        );
        let router = crate::lsp::rpc::Router::new();
        // reader 任务
        let table = transport.table_handle();
        let app = test_app_handle(); // 见 Step 6 桩
        let table2 = table.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, BufReader};
            let mut reader = BufReader::new(mock.transport_stdout_into_reader());
            // 注：transport_stdout 已被 with_reader_source 消费 —— 见 Step 6 调整
            let _ = (table2, reader);
        });
        // initialize
        let (msg, id, tx, rx) = router.next_request("initialize", serde_json::json!({
            "rootUri":"file:///mock","capabilities":{},"workspaceFolders":[{"uri":"file:///mock","name":"mock"}]
        }));
        transport.table.lock().await.insert(id, tx);
        transport.send(&msg).await.unwrap();
        let _init = rx.await.unwrap();
        // definition
        let (msg, id, tx, rx) = router.next_request("textDocument/definition", serde_json::json!({
            "textDocument":{"uri":"file:///mock/main.rs"},"position":{"line":0,"character":0}
        }));
        transport.table.lock().await.insert(id, tx);
        transport.send(&msg).await.unwrap();
        let result = rx.await.unwrap();
        let locs = parse_locations(&result);
        assert_eq!(locs.len(), 1);
        let qr = crate::lsp::protocol::locations_to_query_results(&locs, "sym");
        assert_eq!(qr[0].symbol.file, "mock/def.rs");
        // mock join 不必 await（drop 即取消）
    }
}
```

**问题**：`mock_end_to_end_definition` 里 `mock.transport_stdout` 被 `with_reader_source` 消费进 transport，外面又想 spawn reader 读它——重复消费。**修正**：不单独 spawn reader，而是让 `with_reader_source` + manager 的 `start_reader` 跑。但本测试不用 manager。**简化测试**：去掉 reader task，直接在测试里手动从 transport 的 reader_source 读 + feed framer + dispatch（仿 start_reader 内联）。或更简：**本测试只验 definition 请求/响应的 router 关联 + parse_locations + 映射**，不跑 reader——直接 mock_responder 会回响应，但响应要被 framer 解析进 table。**最干净**：测试里 spawn 一个 mini-reader：从 `transport.take_reader_source()` 读，feed framer，对每条 dispatch，ResolveWaiter 时 `table.take(id).send(result)`。把 Step 5 的 `mock_end_to_end_definition` 改为：

```rust
    #[tokio::test]
    async fn mock_end_to_end_definition() {
        let mock = crate::lsp::mock_server::spawn_mock_lsp();
        let transport = crate::lsp::transport::LspTransport::with_reader_source(
            mock.transport_stdin, mock.transport_stdout,
        );
        let router = crate::lsp::rpc::Router::new();
        let table = transport.table_handle();
        // mini reader
        let mut reader = tokio::io::BufReader::new(transport.take_reader_source().await);
        let table_r = table.clone();
        let mut framer = crate::lsp::transport::Framer::new();
        // initialize
        let (msg, id, tx, rx) = router.next_request("initialize", serde_json::json!({
            "rootUri":"file:///mock","capabilities":{},"workspaceFolders":[{"uri":"file:///mock","name":"mock"}]
        }));
        table.lock().await.insert(id, tx);
        transport.send(&msg).await.unwrap();
        // pump reader until init resolves
        let init = pump_until(&mut reader, &mut framer, &table_r, rx).await.unwrap();
        let _ = init;
        // definition
        let (msg, id, tx, rx) = router.next_request("textDocument/definition", serde_json::json!({
            "textDocument":{"uri":"file:///mock/main.rs"},"position":{"line":0,"character":0}
        }));
        table.lock().await.insert(id, tx);
        transport.send(&msg).await.unwrap();
        let result = pump_until(&mut reader, &mut framer, &table_r, rx).await.unwrap();
        let locs = parse_locations(&result);
        assert_eq!(locs.len(), 1);
        let qr = crate::lsp::protocol::locations_to_query_results(&locs, "sym");
        assert_eq!(qr[0].symbol.file, "mock/def.rs");
    }

    async fn pump_until(
        reader: &mut tokio::io::BufReader<Box<dyn tokio::io::AsyncRead + Send + Unpin>>,
        framer: &mut crate::lsp::transport::Framer,
        table: &std::sync::Arc<tokio::sync::Mutex<crate::lsp::transport::RequestTable>>,
        rx: tokio::sync::oneshot::Receiver<serde_json::Value>,
    ) -> Result<serde_json::Value, ()> {
        use tokio::io::AsyncReadExt;
        let mut buf = [0u8; 8192];
        // 轮询读直到 rx 收到
        loop {
            tokio::select! {
                r = rx => { return r.map_err(|_| ()); }
                n = reader.read(&mut buf) => {
                    let n = n.map_err(|_| ())?;
                    if n == 0 { tokio::task::yield_now().await; continue; }
                    for msg in framer.feed(&buf[..n]) {
                        if let crate::lsp::rpc::Action::ResolveWaiter { id, result } = crate::lsp::rpc::dispatch(&msg) {
                            if let Some(tx) = table.lock().await.take(id) { let _ = tx.send(result); }
                        }
                    }
                }
            }
        }
    }
```

`pump_until` 的 `rx` 被 `tokio::select!` 消费（`receiver` 是 owned，select 的 future 取它）——每次调用传新 rx，OK。但 `tokio::select!` 里 `r = rx` 与 `n = reader.read` 并发，rx 先 ready 即返。注意 `rx` 是 `Receiver`，`&rx`?——`select!` 的 `r = rx` 是 `r = async { rx.await }`，需 owned。签名传 `rx: Receiver`（owned），OK。但循环里第二次 `select` 不存在（return 了）。**确认签名：`pump_until(..., rx: Receiver) -> Result<Value, ()>`，内部 `r = rx` 一次性。**

`test_app_handle()` 桩——mock_end_to_end_definition 已改不依赖 app handle（直接用 transport+router）。**删掉 `test_app_handle` 引用。**

- [ ] **Step 6: 验证编译 + 跑测试**

Run: `cd src-tauri && cargo build`
Expected: 通过（lib.rs 注册 + 命令编译）。

Run: `cd src-tauri && cargo test --lib lsp::`
Expected: PASS（含 lsp_location_to_query_result_via_protocol、did_open_skips_excluded_paths、mock_end_to_end_definition + 各子模块既有测试）。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/lsp/mod.rs src-tauri/src/lsp/detector.rs \
        src-tauri/src/commands/workspace.rs src-tauri/src/lib.rs
git commit -m "feat(lsp): mod.rs 命令 + LspState + lib.rs 注册 + workspace_set_lsp_* + mock 端到端测试"
```

---

## Task 12: 前端 api.ts lsp* 封装 + useLsp.ts 工作区控制器 + 诊断 store

**Files:**
- Modify: `src/api.ts:349` 附近（加 `lsp*` 封装）
- Create: `src/composables/useLsp.ts`
- Test: `src/composables/useLsp.test.ts`（vitest）

**Interfaces:**
- Produces（`api` 上）：
  - `api.lspDetectLanguages(workspaceRoot): Promise<string[]>`
  - `api.lspEnsureServer(workspaceRoot, lang): Promise<{ok,kind?}>`
  - `api.lspDidOpen(workspaceRoot, filePath, lang, text): Promise<void>`
  - `api.lspDidChange(workspaceRoot, filePath, lang, text, version?): Promise<void>`
  - `api.lspDidClose(workspaceRoot, filePath, lang): Promise<void>`
  - `api.lspDefinition(workspaceRoot, filePath, line, column, word): Promise<QueryResult[]>`
  - `api.lspCompletion(workspaceRoot, filePath, line, column): Promise<CmCompletion[]>`
  - `api.lspHover(workspaceRoot, filePath, line, column): Promise<{content: string|null}>`
  - `api.lspShutdownWorkspace(workspaceRoot): Promise<void>`
  - `api.workspaceSetLspEnabled(workspaceRoot, enabled): Promise<void>`
  - `api.workspaceSetLspExcludes(workspaceRoot, dirs): Promise<void>`
- Produces（`useLsp`）：
  - `useLsp()` 返回 `{ isLspOn(workspace), enableLsp(workspace), disableLsp(workspace), diagnosticsFor(filePath), lspOnForWorkspace, clearDiagnostics, __resetForTest }`
  - 模块单例：`lspEnabledWorkspaces: Ref<Set<string>>`、`diagnostics: Ref<Map<filePath, Diagnostic[]>>`
- Consumes: `@tauri-apps/api/event` `listen`、`api`（上面封装）、`useFileViewer`（`useFileViewer.ts:74` projectRoot）

- [ ] **Step 1: api.ts lsp* 封装**

`src/api.ts` 在 `codegraphGotoDefinition`（:349）附近按相同形状加：

```ts
  lspDetectLanguages(workspaceRoot: string): Promise<string[]> {
    return invoke("lsp_detect_languages", { workspaceRoot });
  },
  lspEnsureServer(workspaceRoot: string, lang: string): Promise<{ ok: boolean; kind?: string }> {
    return invoke("lsp_ensure_server", { workspaceRoot, lang });
  },
  lspDidOpen(workspaceRoot: string, filePath: string, lang: string, text: string): Promise<void> {
    return invoke("lsp_did_open", { workspaceRoot, filePath, lang, text });
  },
  lspDidChange(workspaceRoot: string, filePath: string, lang: string, text: string, version?: number): Promise<void> {
    return invoke("lsp_did_change", { workspaceRoot, filePath, lang, text, version });
  },
  lspDidClose(workspaceRoot: string, filePath: string, lang: string): Promise<void> {
    return invoke("lsp_did_close", { workspaceRoot, filePath, lang });
  },
  lspDefinition(workspaceRoot: string, filePath: string, line: number, column: number, word: string): Promise<QueryResult[]> {
    return invoke("lsp_definition", { workspaceRoot, filePath, line, column, word });
  },
  lspCompletion(workspaceRoot: string, filePath: string, line: number, column: number): Promise<CmCompletion[]> {
    return invoke("lsp_completion", { workspaceRoot, filePath, line, column });
  },
  lspHover(workspaceRoot: string, filePath: string, line: number, column: number): Promise<{ content: string | null }> {
    return invoke("lsp_hover", { workspaceRoot, filePath, line, column });
  },
  lspShutdownWorkspace(workspaceRoot: string): Promise<void> {
    return invoke("lsp_shutdown_workspace", { workspaceRoot });
  },
  workspaceSetLspEnabled(workspaceRoot: string, enabled: boolean): Promise<void> {
    return invoke("workspace_set_lsp_enabled", { workspaceRoot, enabled });
  },
  workspaceSetLspExcludes(workspaceRoot: string, dirs: string[]): Promise<void> {
    return invoke("workspace_set_lsp_excludes", { workspaceRoot, dirs });
  },
```

确认 `src/types.ts` 有 `CmCompletion` 类型（含 `label/detail?/documentation?/kind?/insert_text?`）；若无，加：

```ts
export interface CmCompletion {
  label: string;
  detail?: string;
  documentation?: string;
  kind?: number;
  insert_text?: string;
}
```

- [ ] **Step 2: useLsp.ts 实现**

`src/composables/useLsp.ts`：

```ts
import { ref, type Ref } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../api";

/** LSP 诊断（最小字段，cmLsp 映射成 CM Diagnostic）。 */
export interface LspDiagnostic {
  fromLine: number; toLine: number;       // 0-based
  fromCol: number; toCol: number;         // 0-based
  severity: "error" | "warning" | "info";
  message: string;
}

// ── 模块单例 ──
/** 已开启 LSP 的工作区根集合（前端缓存；权威值在后端 state JSON）。 */
const lspEnabledWorkspaces = ref<Set<string>>(new Set());
/** filePath → 该文件当前诊断（来自 lsp-diagnostics 事件，按 uri 过滤）。 */
const diagnostics = ref<Map<string, LspDiagnostic[]>>(new Map());

let listening = false;
let unlistenDiag: UnlistenFn | null = null;
let unlistenDead: UnlistenFn | null = null;

async function ensureListening() {
  if (listening) return;
  listening = true;
  unlistenDiag = await listen<{
    workspaceRoot: string; uri: string; diagnostics: any[]; version?: number | null; clear?: boolean;
  }>("lsp-diagnostics", (ev) => {
    const p = ev.payload;
    if (p.clear) {
      // 清该工作区全部诊断（关区/关 LSP）
      const next = new Map(diagnostics.value);
      for (const k of [...next.keys()]) next.delete(k);
      diagnostics.value = next;
      return;
    }
    const filePath = uriToPath(p.uri);
    if (!filePath) return;
    const next = new Map(diagnostics.value);
    next.set(filePath, (p.diagnostics || []).map(mapDiag));
    diagnostics.value = next;
  });
  unlistenDead = await listen("lsp-server-dead", () => {
    // server 死：诊断保留（下次 did_open 重拉）；不主动清。可加 toast。
  });
}

function uriToPath(uri: string): string | null {
  if (uri.startsWith("file:///")) return uri.slice("file:///".length);
  if (uri.startsWith("file://")) return uri.slice("file://".length);
  return null;
}

function mapDiag(d: any): LspDiagnostic {
  const start = d.range?.start ?? { line: 0, character: 0 };
  const end = d.range?.end ?? start;
  const sev = d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info";
  return {
    fromLine: start.line, toLine: end.line,
    fromCol: start.character, toCol: end.character,
    severity: sev, message: d.message ?? "",
  };
}

export function useLsp() {
  async function enableLsp(workspaceRoot: string) {
    if (!workspaceRoot) return;
    await api.workspaceSetLspEnabled(workspaceRoot, true);
    lspEnabledWorkspaces.value = new Set(lspEnabledWorkspaces.value).add(workspaceRoot);
    await ensureListening();
  }

  async function disableLsp(workspaceRoot: string) {
    if (!workspaceRoot) return;
    await api.lspShutdownWorkspace(workspaceRoot);
    await api.workspaceSetLspEnabled(workspaceRoot, false);
    const next = new Set(lspEnabledWorkspaces.value);
    next.delete(workspaceRoot);
    lspEnabledWorkspaces.value = next;
    // 清该工作区诊断（lsp_shutdown_workspace 后端已 emit clear）
  }

  function isLspOn(workspaceRoot: string): boolean {
    return lspEnabledWorkspaces.value.has(workspaceRoot);
  }

  function diagnosticsFor(filePath: string): LspDiagnostic[] {
    return diagnostics.value.get(filePath) ?? [];
  }

  function clearDiagnostics() {
    diagnostics.value = new Map();
  }

  function __resetForTest() {
    lspEnabledWorkspaces.value = new Set();
    diagnostics.value = new Map();
    listening = false;
    unlistenDiag?.();
    unlistenDead?.();
    unlistenDiag = null;
    unlistenDead = null;
  }

  return {
    lspEnabledWorkspaces,
    diagnostics,
    enableLsp, disableLsp, isLspOn, diagnosticsFor, clearDiagnostics,
    __resetForTest,
  };
}
```

- [ ] **Step 3: useLsp.test.ts**

`src/composables/useLsp.test.ts`（vitest，照 `cmModelSync.test.ts` 风格——先看该项目 vitest 是否 mock `@tauri-apps/api/event`；若无 mock 框架，本测试只测纯函数 `mapDiag`/`uriToPath` 导出的测试版）：

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useLsp } from "./useLsp";

describe("useLsp", () => {
  beforeEach(() => useLsp().__resetForTest());

  it("isLspOn false by default", () => {
    const { isLspOn } = useLsp();
    expect(isLspOn("/any")).toBe(false);
  });

  it("diagnosticsFor empty when none", () => {
    const { diagnosticsFor } = useLsp();
    expect(diagnosticsFor("/x.rs")).toEqual([]);
  });

  // enableLsp/disableLsp 涉及 invoke + listen，需 mock @tauri-apps/api/event 与 invoke。
  // 若项目 vitest 已 mock（见 src/__mocks__ 或 setup），加：
  //   it("enableLsp adds workspace", async () => { ... })
  // 否则留纯逻辑测试，端到端由 Task 16 手测覆盖。
});
```

- [ ] **Step 4: 跑测试**

Run: `pnpm --filter [web] test -- useLsp`（按项目实际 vitest 调用方式；若 `pnpm test` 根脚本，跑之）
Expected: PASS（2 条纯逻辑）。若 invoke/listen 未 mock，跳过涉及它们的断言（已在注释里标）。

- [ ] **Step 5: Commit**

```bash
git add src/api.ts src/composables/useLsp.ts src/composables/useLsp.test.ts src/types.ts
git commit -m "feat(lsp): 前端 api.lsp* 封装 + useLsp 工作区控制器/诊断 store"
```

---

## Task 13: 前端 cmLsp.ts — CM 扩展（didOpen/didChange/autocompletion/linter/hoverTooltip）

**Files:**
- Create: `src/extensions/cmLsp.ts`
- Create: `src/extensions/cmLsp.test.ts`
- Test: vitest

**Interfaces:**
- Produces:
  - `cmLsp(opts: { workspaceRoot: string; enabled: boolean; lang: string; filePath: string; }) => Extension`
  - 三层范式照 `cmCtrlHover.ts`（State field / ViewPlugin / theme）
- Consumes: `@codemirror/autocomplete` `autocompletion`、`@codemirror/lint` `linter`/`linterGutter`/`Diagnostic`、`@codemirror/view` `hoverTooltip`/`ViewPlugin`/`EditorView`、`@codemirror/state` `StateField`/`StateEffect`、`api`（Task 12）、`useLsp.diagnosticsFor`（Task 12）、`utils/cmModelSync.ts` `isUserEdit`（`:18`）、`utils/markdown.ts` `renderMarkdown`（`:68`）

- [ ] **Step 1: 实现 cmLsp.ts**

`src/extensions/cmLsp.ts`：

```ts
import { StateField, StateEffect, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, hoverTooltip, type Tooltip } from "@codemirror/view";
import { autocompletion } from "@codemirror/autocomplete";
import { linter, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { api } from "../api";
import { useLsp, type LspDiagnostic } from "../composables/useLsp";
import { isUserEdit } from "../utils/cmModelSync";
import { renderMarkdown } from "../utils/markdown";

// ── State 层：诊断（来自 useLsp，按 filePath 过滤后注入 CM）──

const setDiagnostics = StateEffect.define<LspDiagnostic[]>();

const diagField = StateField.define<LspDiagnostic[]>({
  create: () => [],
  update(val, tr) {
    for (const e of tr.effects) if (e.is(setDiagnostics)) return e.value;
    return val;
  },
});

// ── Event 层：ViewPlugin（didOpen/didClose + didChange debounce + 同步诊断）──

class LspTracker {
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly view: EditorView;
  private readonly opts: { workspaceRoot: string; enabled: boolean; lang: string; filePath: string; };

  constructor(view: EditorView, opts: typeof cmLsp extends (o: infer O) => any ? O : never) {
    this.view = view;
    this.opts = opts;
    if (opts.enabled) this.didOpen();
  }

  private async didOpen() {
    const { workspaceRoot, lang, filePath } = this.opts;
    if (!workspaceRoot || !lang) return;
    const text = this.view.state.doc.toString();
    try { await api.lspDidOpen(workspaceRoot, filePath, lang, text); } catch { /* server not ready */ }
  }

  private async didChange() {
    const { workspaceRoot, lang, filePath } = this.opts;
    if (!workspaceRoot || !lang) return;
    const text = this.view.state.doc.toString();
    try { await api.lspDidChange(workspaceRoot, filePath, lang, text); } catch { /* ignore */ }
  }

  update(update: any) {
    if (update.docChanged && isUserEdit(update.transactions)) {
      // debounce 300ms（spec §5.2）
      if (this.changeTimer) clearTimeout(this.changeTimer);
      this.changeTimer = setTimeout(() => this.didChange(), 300);
    }
  }

  destroy() {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    const { workspaceRoot, lang, filePath } = this.opts;
    if (this.opts.enabled) {
      api.lspDidClose(workspaceRoot, filePath, lang).catch(() => {});
    }
  }
}

// ── 三个 source：autocompletion / linter / hoverTooltip ──

function lspCompletionSource(workspaceRoot: string, filePath: string, lang: string) {
  return async (ctx: any): Promise<any> => {
    if (!workspaceRoot || !ctx.explicit && ctx.state.doc.length === 0) return null;
    const pos = ctx.pos;
    const line = ctx.state.doc.lineAt(pos);
    const lineNum = line.number - 1;            // 0-based
    const col = pos - line.from;                // 0-based
    try {
      const items = await api.lspCompletion(workspaceRoot, filePath, lineNum + 1, col + 1);
      if (!items.length) return null;
      return {
        from: ctx.pos,
        options: items.map((it) => ({
          label: it.insert_text || it.label,
          detail: it.detail,
          info: it.documentation ? () => renderMarkdown(it.documentation!) : undefined,
          type: completionKind(it.kind),
        })),
      };
    } catch { return null; }
  };
}

function completionKind(k?: number): string {
  // LSP CompletionItemKind → CM tag（简化）
  if (k === 3 || k === 12) return "function";   // Function / Value
  if (k === 6 || k === 23) return "variable";   // Variable
  if (k === 5 || k === 22) return "class";      // Class / Struct
  if (k === 8 || k === 9) return "namespace";   // Enum / Module
  return "variable";
}

function lspLinter(workspaceRoot: string, filePath: string) {
  return linter((view) => {
    if (!workspaceRoot) return [];
    const diags: LspDiagnostic[] = useLsp().diagnosticsFor(filePath);
    return diags.map<CmDiagnostic>((d) => {
      const line = view.state.doc.line(Math.min(d.fromLine + 1, view.state.doc.lines));
      const from = Math.min(line.from + d.fromCol, line.to);
      const to = Math.min(line.from + d.toCol, line.to);
      return {
        from, to,
        severity: d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "info",
        message: d.message,
      };
    });
  });
}

function lspHover(workspaceRoot: string, filePath: string) {
  return hoverTooltip(async (view, pos): Promise<Tooltip | null> => {
    if (!workspaceRoot) return null;
    const line = view.state.doc.lineAt(pos);
    const lineNum = line.number - 1;
    const col = pos - line.from;
    try {
      const { content } = await api.lspHover(workspaceRoot, filePath, lineNum + 1, col + 1);
      if (!content) return null;
      return {
        pos,
        above: true,
        create() {
          const dom = document.createElement("div");
          dom.className = "aide-lsp-hover";
          dom.innerHTML = renderMarkdown(content);
          return { dom };
        },
      };
    } catch { return null; }
  });
}

// ── Public API ──

export interface CmLspOpts {
  workspaceRoot: string;
  enabled: boolean;
  lang: string;
  filePath: string;
}

export function cmLsp(opts: CmLspOpts): Extension {
  if (!opts.enabled) {
    // 关闭：返回空扩展（不发 didOpen/didChange）。仍挂 diagField 占位以避免 slot 冲突。
    return [];
  }
  const plugin = ViewPlugin.fromClass(
    class extends LspTracker { constructor(v: EditorView) { super(v, opts); } },
    { provide: () => [lspLinter(opts.workspaceRoot, opts.filePath)] },
  );
  return [
    diagField,
    plugin,
    autocompletion({ override: [lspCompletionSource(opts.workspaceRoot, opts.filePath, opts.lang)], activateOnTyping: true }),
    lspHover(opts.workspaceRoot, opts.filePath),
    EditorView.baseTheme({
      ".aide-lsp-hover": {
        maxWidth: "480px", padding: "6px 10px",
        fontSize: "12.5px", lineHeight: "1.5",
      },
      ".aide-lsp-hover pre": { margin: "4px 0", padding: "6px", overflow: "auto" },
    }),
  ];
}
```

注：`LspTracker` 构造器签名 `opts: typeof cmLsp extends ... ? O : never` 是花哨写法，**改简单**：`constructor(view: EditorView, opts: CmLspOpts)`。把上面 `LspTracker` 的构造器改为显式 `opts: CmLspOpts`。

- [ ] **Step 2: cmLsp.test.ts**

`src/extensions/cmLsp.test.ts`（照 `cmModelSync.test.ts` 风格）：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EditorState, EditorView } from "@codemirror/state" /* 或 view */;
import { cmLsp } from "./cmLsp";
import { useLsp } from "../composables/useLsp";

// mock api（避免真 invoke）
vi.mock("../api", () => ({
  api: {
    lspDidOpen: vi.fn().mockResolvedValue(undefined),
    lspDidChange: vi.fn().mockResolvedValue(undefined),
    lspDidClose: vi.fn().mockResolvedValue(undefined),
    lspCompletion: vi.fn().mockResolvedValue([]),
    lspHover: vi.fn().mockResolvedValue({ content: null }),
    lspDefinition: vi.fn().mockResolvedValue([]),
    lspShutdownWorkspace: vi.fn().mockResolvedValue(undefined),
    workspaceSetLspEnabled: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("cmLsp", () => {
  beforeEach(() => useLsp().__resetForTest());

  it("lsp_disabled_no_op_returns_empty_extension", () => {
    const ext = cmLsp({ workspaceRoot: "/p", enabled: false, lang: "rust", filePath: "/p/a.rs" });
    expect(ext).toEqual([]); // 关闭时空扩展
  });

  it("lsp_enabled_returns_nonempty_extension", () => {
    const ext = cmLsp({ workspaceRoot: "/p", enabled: true, lang: "rust", filePath: "/p/a.rs" });
    expect(Array.isArray(ext)).toBe(true);
    expect(ext.length).toBeGreaterThan(0);
  });

  // didChange debounce 与 diagnostics→lint 映射需真 EditorView + 定时器推进，
  // 按项目 vitest 是否支持 fake timers 加：
  //   it("did_change_debounced", async () => { ... vi.useFakeTimers() ... })
  //   it("diagnostics_to_lint_mapping", () => { ... })
  // 若不支持，由 Task 16 手测覆盖。
});
```

- [ ] **Step 3: 跑测试 + 修 LspTracker 构造器签名**

把 `LspTracker` 构造器改 `constructor(view: EditorView, opts: CmLspOpts)`，删花哨类型。

Run: `pnpm test -- cmLsp`
Expected: PASS（2 条）。

- [ ] **Step 4: Commit**

```bash
git add src/extensions/cmLsp.ts src/extensions/cmLsp.test.ts
git commit -m "feat(lsp): cmLsp 扩展 — didOpen/didChange(debounce)/autocompletion/linter/hoverTooltip"
```

---

## Task 14: 前端 CodeEditor.vue 接 cmLsp + useGotoDefinition 插 LSP provider

**Files:**
- Modify: `src/components/CodeEditor.vue:81-91`（extensions 加 cmLsp）+ `:109`（goto payload 加 column）
- Modify: `src/composables/useGotoDefinition.ts:20-90`（插 LSP 第一 provider + `source` 加 `sourceColumn` + 第 43 行传 column）
- Modify: `src/composables/useGotoDefinition.test.ts`（扩测）
- Test: vitest

**Interfaces:**
- Produces: `useGotoDefinition().search()` 现先调 `api.lspDefinition`（工作区 LSP 开且有 server 时），空/错落 codegraph→grep。
- Consumes: `cmLsp`（Task 13）、`useLsp`（Task 12）、`api.lspDefinition`（Task 12）

- [ ] **Step 1: CodeEditor.vue 接 cmLsp + goto payload 加 column**

`src/components/CodeEditor.vue`：

顶部 import 加：

```ts
import { cmLsp } from "../extensions/cmLsp";
import { useLsp } from "../composables/useLsp";
```

`defineProps` 加（若没有 workspaceRoot/lang）——CodeEditor 当前 props 只有 `filePath/modelValue/scrollMemory`。**加**：

```ts
const props = defineProps<{
  filePath: string;
  modelValue: string;
  scrollMemory?: ScrollMemoryOptions;
  workspaceRoot?: string;
  lspLang?: string;
}>();
```

`createEditor` 内 `extensions` 数组（:81-91）末尾加（在 `EditorView.theme({...}, { dark: true })` 后）：

```ts
      ...(props.workspaceRoot && props.lspLang
        ? [cmLsp({
            workspaceRoot: props.workspaceRoot,
            enabled: useLsp().isLspOn(props.workspaceRoot),
            lang: props.lspLang,
            filePath: props.filePath,
          })]
        : []),
```

goto emit（:109）加 `column`——`posAtCoords` 返回 offset，转 char：

```ts
                    if (word) {
                      event.preventDefault();
                      const line = view.state.doc.lineAt(pos);
                      const column = pos - line.from + 1; // 1-based char
                      emit("goto-definition", {
                        word,
                        filePath: props.filePath,
                        line,
                        column,
                      });
                    }
```

注意 `line` 原为 `view.state.doc.lineAt(pos).number`（number），现拆出 `const lineObj = view.state.doc.lineAt(pos); const line = lineObj.number; const column = pos - lineObj.from + 1;`。**修正**：

```ts
                    if (word) {
                      event.preventDefault();
                      const lineObj = view.state.doc.lineAt(pos);
                      emit("goto-definition", {
                        word,
                        filePath: props.filePath,
                        line: lineObj.number,
                        column: pos - lineObj.from + 1,
                      });
                    }
```

`emit` 类型（:27-30）加 `column`：

```ts
  (e: "goto-definition", payload: { word: string; filePath: string; line: number; column: number }): void;
```

**CodeEditor 的调用方**（`FileWindow.vue`，传 props）需传 `workspaceRoot` + `lspLang`。grep `CodeEditor` 用法处，加 `:workspace-root="projectRoot" :lsp-lang="lspLangFor(win)"`。`lspLangFor` 按 `win.filePath` 扩展名映射 language id（可复用 `cmLanguage.ts` 的扩展名表，或简单 map）。**若 FileWindow 不便传**，cmLsp 可在 CodeEditor 内自行读 `useFileViewer().projectRoot` + 按 `props.filePath` 推 lang——为低侵入，**改 cmLsp 调用处读 useFileViewer**：

```ts
      ...(props.workspaceRoot /* 或 useFileViewer().projectRoot.value */ && props.lspLang
        ? [...] : []),
```

**决策**：在 `FileWindow.vue` 把 `projectRoot`（来自 `useFileViewer().projectRoot`）与按扩展名算的 `lspLang` 传给 `CodeEditor`。执行时 grep `<CodeEditor` 找到 FileWindow 渲染处加 props。

- [ ] **Step 2: useGotoDefinition 插 LSP provider + 传 column**

`src/composables/useGotoDefinition.ts`：

`search` 的 `source` 参数加 `sourceColumn`（:23）：

```ts
  async function search(
    word: string,
    projectRoot: string,
    source?: { sourceFile: string; sourceLine: number; sourceExt: string; sourceColumn?: number },
  ) {
```

在 `// 1. Try CodeGraph first`（:37）**之前**插 LSP provider：

```ts
    // 0. Try LSP first (workspace LSP on + server available → authoritative)
    try {
      if (source?.sourceFile && useLsp().isLspOn(projectRoot)) {
        const lspResults = await api.lspDefinition(
          projectRoot,
          source.sourceFile,
          source.sourceLine,
          source?.sourceColumn ?? 0,
          word,
        );
        if (lspResults.length > 0) {
          let filtered = lspResults;
          filtered = lspResults.filter(
            r => !(r.symbol.file === source.sourceFile && r.symbol.line === source.sourceLine),
          );
          if (filtered.length > 0) {
            results.value = filtered;
            isGrepFallback.value = false;
            return;
          }
        }
      }
    } catch {
      // LSP unavailable / error → fall through to codegraph → grep
    }
```

顶部 import 加 `import { useLsp } from "./useLsp";`。

`search()` 第 43 行 `0, // column not yet from editor` 改 `source?.sourceColumn ?? 0`：

```ts
      const cgResults = await api.codegraphGotoDefinition(
        word,
        source?.sourceFile || "",
        source?.sourceLine || 0,
        source?.sourceColumn ?? 0,
        projectRoot,
      );
```

- [ ] **Step 3: useGotoDefinition 调用方传 sourceColumn**

grep `useGotoDefinition` 的 `.search(` 调用（FileWindow.vue 的 `onGotoDefinition`）。把 `source: { sourceFile, sourceLine, sourceExt }` 加 `sourceColumn: payload.column`。执行时找具体调用处加字段。

- [ ] **Step 4: useGotoDefinition.test.ts 扩测**

`src/composables/useGotoDefinition.test.ts`（若不存在则建）：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
// mock api：lspDefinition / codegraphGotoDefinition / grepSymbol
vi.mock("../api", () => ({
  api: {
    lspDefinition: vi.fn(),
    codegraphGotoDefinition: vi.fn(),
    grepSymbol: vi.fn(),
  },
}));
import { useGotoDefinition } from "./useGotoDefinition";
import { api } from "../api";
import { useLsp } from "./useLsp";

describe("useGotoDefinition.search provider chain", () => {
  beforeEach(() => {
    useLsp().__resetForTest();
    vi.clearAllMocks();
  });

  it("lsp_first_then_codegraph_then_grep", async () => {
    (api.lspDefinition as any).mockResolvedValue([
      { symbol: { name: "foo", file: "p/a.rs", line: 9, column: 0, kind: "Function", parent: null }, confidence: "Structure", score: null },
    ]);
    // 开 LSP
    await useLsp().enableLsp("/p");
    const { search, results } = useGotoDefinition();
    await search("foo", "/p", { sourceFile: "p/main.rs", sourceLine: 1, sourceExt: "rs", sourceColumn: 3 });
    expect((api.lspDefinition as any)).toHaveBeenCalled();
    expect(results.value.length).toBe(1);
    expect((api.codegraphGotoDefinition as any)).not.toHaveBeenCalled();
  });

  it("lsp_error_falls_through_to_codegraph", async () => {
    (api.lspDefinition as any).mockRejectedValue(new Error("server dead"));
    (api.codegraphGotoDefinition as any).mockResolvedValue([
      { symbol: { name: "foo", file: "p/a.rs", line: 9, column: 0, kind: "Function", parent: null }, confidence: "Structure", score: null },
    ]);
    await useLsp().enableLsp("/p");
    const { search, results } = useGotoDefinition();
    await search("foo", "/p", { sourceFile: "p/main.rs", sourceLine: 1, sourceExt: "rs", sourceColumn: 3 });
    expect((api.codegraphGotoDefinition as any)).toHaveBeenCalled();
    expect(results.value.length).toBe(1);
  });

  it("lsp_off_skips_lsp_goes_codegraph", async () => {
    (api.codegraphGotoDefinition as any).mockResolvedValue([
      { symbol: { name: "foo", file: "p/a.rs", line: 9, column: 0, kind: "Function", parent: null }, confidence: "Structure", score: null },
    ]);
    // LSP 未开
    const { search } = useGotoDefinition();
    await search("foo", "/p", { sourceFile: "p/main.rs", sourceLine: 1, sourceExt: "rs" });
    expect((api.lspDefinition as any)).not.toHaveBeenCalled();
    expect((api.codegraphGotoDefinition as any)).toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: 跑测试**

Run: `pnpm test -- useGotoDefinition`
Expected: PASS（3 条）。若 `enableLsp` 因 invoke/listen mock 缺失失败，改测试用 `useLsp().lspEnabledWorkspaces.value.add("/p")` 直接置开（绕过 invoke），并 mock `api.workspaceSetLspEnabled`。

- [ ] **Step 6: Commit**

```bash
git add src/components/CodeEditor.vue src/composables/useGotoDefinition.ts \
        src/composables/useGotoDefinition.test.ts
# 含 FileWindow.vue 的 props 传递改动
git commit -m "feat(lsp): CodeEditor 接 cmLsp + goto payload 加 column + useGotoDefinition 插 LSP 首选 provider"
```

---

## Task 15: 前端设置 UI — 工作区 LSP 开关 + 排除目录编辑器

**Files:**
- Modify: `src/components/SettingsPanel.vue`（工作区段加 LSP 开关 + 排除目录列表编辑器）
- Modify: `src/composables/useSettings.ts` 或新增 `src/composables/useWorkspaceLsp.ts`（读/写工作区 LSP 配置的前端侧）
- Test: 手测为主（UI）；vitest 覆盖 useWorkspaceLsp 的纯逻辑

**Interfaces:**
- Produces:
  - `useWorkspaceLsp()`：`{ isEnabled(workspaceKey), setEnabled(workspace, bool), excludes(workspaceKey), setExcludes(workspace, dirs[]) }`（调 Task 12 的 `api.workspaceSetLspEnabled` / `api.workspaceSetLspExcludes` + 读 `api.lsp*` 状态）
- Consumes: `api.workspaceSetLspEnabled/Excludes`（Task 12）、`useLsp`（Task 12，enable/disableLsp 同步前端缓存）

- [ ] **Step 1: useWorkspaceLsp.ts**

`src/composables/useWorkspaceLsp.ts`：

```ts
import { ref } from "vue";
import { api } from "../api";
import { useLsp } from "./useLsp";

/** 工作区 LSP 设置前端侧：开关 + 排除目录。权威值在后端 state JSON。 */
export function useWorkspaceLsp(workspaceRoot: string) {
  const { enableLsp, disableLsp, isLspOn } = useLsp();
  const enabled = ref(isLspOn(workspaceRoot));
  const excludes = ref<string[]>([]);
  const excludesDirty = ref(false);

  async function setEnabled(v: boolean) {
    enabled.value = v;
    if (v) await enableLsp(workspaceRoot);
    else await disableLsp(workspaceRoot);
  }

  async function saveExcludes(dirs: string[]) {
    await api.workspaceSetLspExcludes(workspaceRoot, dirs);
    excludes.value = dirs;
    excludesDirty.value = false;
    // 改排除集需重拉 server：disable→enable 完成（spec §5.4）
    if (enabled.value) {
      await disableLsp(workspaceRoot);
      await enableLsp(workspaceRoot);
    }
  }

  return { enabled, excludes, excludesDirty, setEnabled, saveExcludes };
}
```

- [ ] **Step 2: SettingsPanel.vue 工作区段加 UI**

在 `SettingsPanel.vue` 工作区设置段（grep `workspace` 相关区块）加：

```vue
<div class="setting-row">
  <label>LSP（语言服务器）</label>
  <ToggleSwitch :modelValue="lsp.enabled" @update:modelValue="lsp.setEnabled" />
  <span class="hint">实时类型诊断/补全/悬停/定义。默认关闭，按工作区开启。</span>
</div>
<div class="setting-row" v-if="lsp.enabled.value">
  <label>排除目录</label>
  <ExcludeDirEditor :modelValue="lsp.excludes.value" @save="lsp.saveExcludes" />
  <span class="hint">这些目录不发给 LSP（IDEA "Mark as Excluded"）。改后重启该工作区 server 生效。</span>
</div>
```

`ExcludeDirEditor` 可内联为一个简单列表 + 输入框（新建标签 → 加列表项 → 保存按钮）。若项目有现成 list-editor 组件则复用。`ToggleSwitch` 用项目现成开关组件。

`lsp = useWorkspaceLsp(currentWorkspaceRoot)` 在 setup 里建（`currentWorkspaceRoot` 取当前激活工作区路径，从 `useFileViewer().projectRoot` 或 settings 当前工作区上下文）。

- [ ] **Step 3: 验证编译 + 手测**

Run: `pnpm build`（前端类型检查）
Expected: 通过。

手测：打开设置面板 → 工作区段 → 开 LSP toggle → 确认 `workspace_set_lsp_enabled` 被调（DevTools network / invoke 日志）→ 加排除目录 → 保存 → 确认 `workspace_set_lsp_excludes` 被调。

- [ ] **Step 4: Commit**

```bash
git add src/composables/useWorkspaceLsp.ts src/components/SettingsPanel.vue
git commit -m "feat(lsp): 设置 UI — 工作区 LSP 开关 + 排除目录编辑器"
```

---

## Task 16: 文档 + 真实 server 手测清单

**Files:**
- Modify: `CLAUDE.md`（关键约定段加 LSP 模块一句话指针）
- Create: `docs/lsp-manual-test-checklist.md`（真实 server 手测清单，不进 CI）
- Modify（可选）: `README.md` 或 `docs/`——LSP 功能用户可见流程

- [ ] **Step 1: CLAUDE.md 加 LSP 指针**

在 `CLAUDE.md` "关键约定" 段加一行：

```markdown
- **内置 LSP（默认关，工作区级开关）**：`src-tauri/src/lsp/` 自写薄 JSON-RPC 派发器（Content-Length 帧解析 `transport.rs` + 派发 `rpc.rs`）+ `lsp-types` 类型库；复用 runtime stdio 泵范式、codegraph `QueryResult`、cmCtrlHover 三层 CM 扩展范式、`ALWAYS_IGNORE_DIRS`（共享 `src-tauri/src/ignore_dirs.rs`）。基于探测器检测语言自动选 server（捆绑 rust-analyzer/typescript-language-server + PATH 发现其余），按文件懒启动，`(workspace,lang)` 一对 scoped，关区即杀。设计 `docs/superpowers/specs/2026-08-04-lsp-builtin-design.md`，实施计划 `docs/superpowers/plans/2026-08-04-lsp-builtin.md`。
```

- [ ] **Step 2: 手测清单**

`docs/lsp-manual-test-checklist.md`：

```markdown
# 内置 LSP 真实 server 手测清单

v1 不进 CI（慢 + 依赖外部安装）。每个 server 跑一遍下列流程，结果记 PR 描述。

## 通用流程（每语言）
1. 开某语言文件（如 `foo.rs`）→ 编辑器应起该语言 server（DevTools 看 lsp_ensure_server 调用）
2. 写一个类型错 → 波浪线诊断出现（@codemirror/lint）
3. Ctrl+Click 一个符号 → 跳到定义（LSP 优先；无 server 落 codegraph/grep）
4. 键入触发补全 → 弹 `.cm-tooltip-autocomplete`，选项来自 server
5. 悬停某符号 → 弹 hover tooltip（markdown 渲染）
6. 关工作区 / 关 LSP toggle → server 进程退出（Task Manager 验）、波浪线消失
7. 排除目录：设 `target` 为排除 → 打开 `target/` 下文件不发 didOpen（无诊断/补全）

## server 矩阵
- [ ] rust-analyzer（Rust，捆绑）：本仓库自身 `src-tauri/` 打开 → 诊断 + 跳转 + 补全 + hover
- [ ] typescript-language-server（TS/JS，捆绑）：本仓库 `src/` 打开 `.ts`/`.vue`
- [ ] pyright（Python，PATH 发现）：任一 Python 项目
- [ ] gopls（Go，PATH 发现）：任一 Go 项目 + 验 directoryFilters 排除注入

## Windows 专项
- [ ] release build 打开 `.rs`：不弹控制台窗（CREATE_NO_WINDOW）
- [ ] release build：资源路径传 server 不崩（dunce 剥 `\\?\`）

## 不测的（诚实声明）
- 真实 rust-analyzer 全协议兼容矩阵——v1 只覆盖 4 method + 诊断
- macOS/Linux bundled server 拉起——仅手测清单覆盖（v1 主力 Windows）
```

- [ ] **Step 3: 跑全量测试套件**

Run: `cd src-tauri && cargo test`
Expected: 全 PASS（lsp 全模块 + 既有 codegraph/detectors 回归）。

Run: `pnpm test`
Expected: 全 PASS（cmLsp + useLsp + useGotoDefinition 扩测 + 既有）。

Run: `cd src-tauri && cargo build` + `pnpm build`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/lsp-manual-test-checklist.md
git commit -m "docs(lsp): CLAUDE.md 指针 + 真实 server 手测清单"
```

---

## Self-Review（计划完成后自检）

**1. Spec 覆盖**：逐节核对 spec → task 映射
- §2 决策表：捆核心+发现（Task 4 registry）、工作区级开关默认关（Task 2 settings + Task 15 UI）、按文件懒启动（Task 11 did_open 触发 ensure_server）、`(workspace,lang)` scope + 关区杀（Task 10 manager）、v1 全套能力（Task 11 definition/completion/hover + Task 13 诊断/补全/hover）、LSP 优先 codegraph 兜底（Task 14 useGotoDefinition）、扩展探测器（Task 3）、方案 A（全 Rust 模块）、扫描边界（Task 1 ignore_dirs + Task 10 build_exclude_globs/is_excluded + Task 11 did_open skip）。✓
- §3 复用设施：runtime 泵（Task 10 spawn_real）、CREATE_NO_WINDOW/dunce（Task 10）、oneshot（Task 5 table）、emit（Task 10 reader）、EOF reject（Task 5/10）、stderr 尾部（Task 10 可加，未显式——**补**：Task 10 spawn_real 应加 stderr_tail 缓冲，照 runtime/mod.rs:209）、幂等 spawn_lock（Task 10）、命令形状（Task 11）、QueryResult（Task 8/11）、managed state（Task 11）、generate_handler（Task 11）、探测器链（Task 3）、信任门（Task 11 workspace_set_lsp_enabled）、CM 范式（Task 13）、goto 链（Task 14）、invoke 封装（Task 12）、isUserEdit（Task 13）、诊断/补全样式槽（Task 13 复用 CodeEditor.vue 既有样式）、markdown（Task 13）、ALWAYS_IGNORE_DIRS（Task 1）。✓ **一处缺口**：stderr 尾部缓冲——在 Task 10 spawn_real 补 `let stderr = child.stderr.take(); tokio::spawn(stderr reader → VecDeque 尾 8 行)`，server dead 时入日志。**执行 Task 10 时补此**。
- §4 依赖：lsp-types（Task 1）✓；前端无新依赖 ✓
- §5 架构：Rust 模块树（Task 1-11）✓；前端（Task 12-15）✓；两个集成决策——定义触发加 column（Task 14）、信任门（Task 11）✓；扫描边界三处应用（Task 10 init 注入 + Task 11 did_open skip + tsserver/pyright 靠项目配置——后者文档化在 spec，v1 不写配置文件 ✓）
- §6 组件：全部模块对应 task ✓
- §7 数据流：6 条流由 Task 10/11/13/14 实现 ✓
- §8 错误处理：server_not_found（Task 11 EnsureOutcome）、未信任（Task 11）、进程退出 EOF（Task 5 reject_all + Task 10 reader dead + emit lsp-server-dead）、帧损坏跳帧（Task 5 framer）、partial 帧（Task 5 状态机）、索引中不超时（Task 11 oneshot 无超时）、capability 缺失（Task 11 parse 返空）、握手失败 5s（Task 10 init_handshake）、幂等（Task 10）、关区 500ms grace（Task 10 shutdown_handle）、诊断版本错位（**部分**——Task 10 reader EmitDiagnostics 带 version，cmLsp 侧未严格按 version 丢弃旧诊断；v1 接受，spec §8 列了但实现可简化，记于此）、大文件跳过（**未显式**——spec §7 贯穿约束 >1MB 跳过 LSP 同步；**补**：Task 13 cmLsp didOpen/didChange 加 `if text.length > 1_000_000 return` 守卫）、排除目录文件（Task 10/11）、请求泄漏自愈（Task 5 oneshot drop）。✓ **两处补**：Task 13 加大文件守卫；诊断版本丢弃可在 Task 12 useLsp mapDiag 时比 version（v1 可略，记于手测清单）。
- §9 测试：transport framer（Task 5，10 条）、rpc（Task 6，6 条）、detector（Task 3，8 条）、registry（Task 4，5 条）、manager（Task 10，6 条纯 + Task 11 mock 端到端）、ignore_dirs/build_exclude_globs（Task 1/10）、docs（Task 7，4 条）、QueryResult 映射（Task 11）、cmLsp（Task 13）、useGotoDefinition（Task 14，3 条）、mock_server（Task 9 夹具，Task 11 用）、真实 server 手测（Task 16）、不测声明（Task 16）。✓
- §10 范围外：未实现项（增量同步/Problems 面板/多 server 协调/自动重启/$progress/插件化/.gitignore 翻译）均未在 task 中出现 ✓
- §11 实施约束：拆分红线（每模块体量目标已标，<300 行）、Windows 红线（Task 10 spawn_real）、async command Result（Task 11 全 Result）、同步命令禁重 IO（全 async）。✓

**2. 占位符扫描**：无 "TBD/TODO/implement later"；每步有实际代码或确切指令。`LspTracker` 构造器签名在 Task 13 Step 3 已指示修正。`AppSettings::default` 在 Task 4 已指示先确认。`lsp_types::Url` vs `Uri` 在 Task 8 已指示按实际 API 调整。✓

**3. 类型一致性**：
- `LanguageId` 全链一致（Task 3 定义，Task 4/10/11 用 `id_str()`/`lang_from_id_str`）
- `ServerSource` 三 variant（Task 4 定义，Task 10 spawn_real 模式匹配）
- `QueryResult`/`SymbolDef`/`Confidence`（codegraph types，Task 8 映射用）
- `CmCompletion`（Task 8 定义，Task 11/12/13 用）
- `LspDiagnostic`（Task 12 定义，Task 13 cmLsp 用）
- `LspTransport::with_reader_source`（Task 5 加，Task 10/11 用）—— **确认**：Task 5 Step 5 原 `LspTransport::new` 在 Task 10 Step 3 被改为 `with_reader_source`，两个 task 的签名已对齐 ✓
- `Router::next_request` 4-元组签名（Task 6 定义，Task 10 init_handshake + Task 11 命令用）✓
- `EnsureError`（Task 10 定义，Task 11 lsp_ensure_server 用）✓
- 命令名：Rust `lsp_definition` ↔ 前端 `invoke("lsp_definition")` ↔ `api.lspDefinition`（Task 11/12 一致）✓

**发现并已修正的问题**：
- Task 3 `cross_language_union` 测试把 .go 放子目录会因一层扫描失败 → 已改为根层两个 .go
- Task 3 `from_ext("TS")` 大小写 → 已改为 `"ts"`
- Task 6 `Router::next_request` tx 交付 → 已定为 4-元组签名
- Task 11 `mock_end_to_end_definition` reader 重复消费 → 已改为 `take_reader_source` + `pump_until` 内联 reader

**未在计划中显式但执行时需补的**（已在对应 task 标注）：
1. Task 10 spawn_real 加 stderr 尾部缓冲（照 runtime/mod.rs:209）
2. Task 13 cmLsp didOpen/didChange 加 >1MB 跳过守卫
3. Task 8 按 lsp-types 实际版本调整 `Url`/`Uri` API
4. Task 4 确认 `AppSettings: Default` 可用性
5. Task 14 grep `<CodeEditor` 调用处（FileWindow.vue）传 `workspaceRoot`/`lspLang` props + `.search(` 调用处传 `sourceColumn`

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-04-lsp-builtin.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?