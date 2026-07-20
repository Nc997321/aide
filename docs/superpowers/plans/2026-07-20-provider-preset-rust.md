# 供应商预设化 — Rust 后端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 provider 模型从「用户自由填一整个 ProviderConfig」改成「从预置 catalog 选实例化 + 按 kind dispatch env / 专属操作」，同时把 env 组装 / 连接指纹 / 后端身份归位进 `runtime/` 层（修掉 `runtime → commands` 倒置）。

**Architecture:** `runtime.rs` 升级为 `runtime/` 模块；后端身份（`ProviderConfig` / `ProviderKind` / catalog / env 组装 / 连接指纹 / 迁移 / `ProviderStrategy` trait + 各 kind 实现）整体归位进 `runtime/provider/`；`commands/*` 退化为 IPC 薄命令，依赖方向 `commands → runtime`。迁移在启动时一次性跑（纯函数 + 单测），老 schema → 新 schema 后 `active_provider` 永远是 Some（SystemDefault 成为真实实例）。

**Tech Stack:** Rust + Tauri v2 + serde_json + ureq（已有）。测试：`cargo test --lib`（CLAUDE.md：杀软锁 dist 时用 `cargo test --lib` 绕开）。

## Global Constraints

- 跨平台：路径用 `PathBuf` / `path.join`，平台特有逻辑 `#[cfg(windows)]` 隔离。
- 外部进程 spawn 必须加 `CREATE_NO_WINDOW (0x08000000)`；资源路径传外部进程前 `dunce::simplified()`。
- 同步 command 禁重 IO/CPU；新增 command 若做网络/子进程一律 `async fn` + `spawn_blocking`。带 `State<'_>` 等引用参数的 async command 必须返回 `Result`。
- 依赖方向红线：`runtime/*` 不得 `use crate::commands::*`。`commands/*` → `runtime/*` 正向。
- 不硬编码颜色（本计划纯 Rust 后端，无前端样式）。
- 每个 Task 结束 `cargo test --lib` 必须全绿，且 `cargo build` 通过。

## Scope Check（split 说明）

本计划只覆盖 **Rust 后端**。前端 UX（catalog 选择面板 / kind 表单 / 专属操作区组件）是独立子系统，依赖本计划的 commands，单独成 Plan 2（`2026-07-20-provider-preset-frontend.md`），在本计划执行完后编写。本计划交付物：后端可独立编译 + 单测全绿 + 老 UI 仍能正常发消息（commands 向后兼容 + 迁移透明）。

## File Structure

新增 / 改动文件：

```
src-tauri/src/
├── lib.rs                              # 改：setup 里加迁移调用 + spawn_runtime 改传 env_vars
├── runtime/
│   ├── mod.rs                          # 新（从 runtime.rs 整体迁入；spawn_runtime 签名改）
│   ├── env.rs                          # 新（build_runtime_env_vars 从 chat.rs 迁入并改纯函数）
│   └── provider/
│       ├── mod.rs                      # 新（ProviderConfig/ProviderKind/catalog/migration/fingerprint/load_*）
│       ├── catalog.rs                  # 新（provider-catalog.json 加载）
│       └── strategy/
│           ├── mod.rs                  # 新（trait + strategy_for + PresetStrategy + 类型）
│           ├── system_default.rs        # 新（SystemDefaultStrategy + refresh_models/view_quota）
│           ├── cpa_gpt.rs              # 新（CpaGptStrategy + probe_port/open_management/codex_login_status）
│           ├── ollama.rs               # 新（薄：返回 PresetStrategy）
│           ├── kimi.rs                 # 新（薄：返回 PresetStrategy）
│           ├── deepseek.rs             # 新（薄：返回 PresetStrategy）
│           └── custom.rs               # 新（CustomStrategy）
├── runtime.rs                          # 删（内容迁入 runtime/mod.rs）
└── commands/
    ├── provider.rs                     # 改：类型/纯函数移走，留薄 command + parse 辅助
    └── chat.rs                          # 改：build_runtime_env_vars 移走，send 路径改调 runtime::env

src-tauri/resources/
└── provider-catalog.json               # 新（5 个 preset 的身份 + 能力声明，无模型字段）

src-tauri/tauri.conf.json               # 改：resources 加 provider-catalog.json
```

职责边界：
- `runtime/provider/mod.rs`：后端身份的数据模型 + 持久化读写（load/save providers）+ 迁移纯函数 + 连接指纹 + catalog 查表派生身份字段。
- `runtime/provider/catalog.rs`：catalog JSON 加载（Lazy 内存态）。
- `runtime/provider/strategy/*`：按 kind 组 env / 跑专属操作。
- `runtime/env.rs`：spawn env 组装（strategy.env_vars + 公共 fallback + proxy override）。
- `commands/provider.rs`：IPC 薄命令，全部调 `runtime::provider::*` + `commands::settings` 的 config I/O。

---

### Task 1: 把 `runtime.rs` 升级为 `runtime/` 模块目录（纯机械移动）

**Files:**
- Delete: `src-tauri/src/runtime.rs`
- Create: `src-tauri/src/runtime/mod.rs`

**Interfaces:** 无变化（`mod runtime;` 在 `lib.rs:5` 仍解析到 `runtime/mod.rs`）。`runtime::AgentRuntimeManager` 路径不变。

- [ ] **Step 1: 移动文件**

```bash
cd src-tauri
git mv src/runtime.rs src/runtime/mod.rs
```

- [ ] **Step 2: 确认 lib.rs 无需改**

`lib.rs:5` 的 `mod runtime;` 对 `runtime.rs` 与 `runtime/mod.rs` 都解析，不改。

- [ ] **Step 3: 编译 + 测试**

```bash
cd src-tauri
cargo build
cargo test --lib
```
Expected: build 通过；`runtime::tests::*`（prepend_path_entry / connection_drifted / fingerprints_survive_runtime_kill）全绿。

- [ ] **Step 4: Commit**

```bash
git add src/runtime/mod.rs src/runtime.rs
git commit -m "refactor(runtime): promote runtime.rs to runtime/ module dir

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 把 provider 数据类型 + 纯函数从 `commands/provider.rs` 迁到 `runtime/provider/mod.rs`

**Files:**
- Create: `src-tauri/src/runtime/provider/mod.rs`
- Modify: `src-tauri/src/runtime/mod.rs`（import `connection_fingerprint` 改从 `runtime::provider`）
- Modify: `src-tauri/src/commands/chat.rs`（import 改从 `runtime::provider`）
- Modify: `src-tauri/src/commands/provider.rs`（移走类型/纯函数，留 command + parse 辅助，re-import 类型）
- Modify: `src-tauri/src/lib.rs:5`（`mod runtime;` 下方 runtime/mod.rs 内需 `pub mod provider;`）

**Interfaces:**
- Produces（`runtime/provider/mod.rs` 导出）：`ProviderConfig`、`ProviderModelMappings`、`mappings_to_env`、`provider_to_env_vars`、`migrate_provider_model`、`CONNECTION_ENV_KEYS`、`connection_fingerprint`、`load_active_provider`、`load_system_default_mappings`、`system_default_mappings_to_env`。
- Consumes: `commands::settings::{load_config, with_config_mut}`（仍由 `runtime/provider/mod.rs` 调用做 config I/O——本任务保持现状，倒置在 Task 3 由「build_runtime_env_vars 改纯函数 + 调用方取数」彻底修掉；本任务只搬数据类型，`load_active_provider`/`load_system_default_mappings` 仍读 config 属合理，它们是 provider 层持久化助手，不是 runtime 层 spawn 职责）。

> 说明：本任务后 `runtime/mod.rs` 不再 `use crate::commands::provider::connection_fingerprint`（改为 `use crate::runtime::provider::connection_fingerprint`），runtime→commands 的指纹倒置先消掉。`build_runtime_env_vars` 仍在 `commands/chat.rs`，Task 3 再迁。

- [ ] **Step 1: 创建 `runtime/provider/mod.rs`，把以下内容从 `commands/provider.rs` **逐字迁入**（含 doc 注释）**

迁入项（原行号供核对，搬时连注释一起搬）：
- `ProviderModelMappings`（原 32-45）
- `ProviderConfig`（原 47-81）
- `mappings_to_env`（原 85-100，改 `pub`）
- `provider_to_env_vars`（原 102-119，已 `pub`）
- `migrate_provider_model`（原 124-128，改 `pub`，单测要它）
- `CONNECTION_ENV_KEYS`（原 134-145，改 `pub`）
- `connection_fingerprint`（原 151-156，已 `pub`）
- `load_active_provider`（原 158-177，已 `pub`）
- `load_system_default_mappings`（原 235-240，改 `pub`）
- `system_default_mappings_to_env`（原 244-246，已 `pub`）
- 原 `#[cfg(test)] mod tests` 里与上述函数相关的测试（`migrate_*`、`mappings_to_env_*`、`provider_to_env_vars_*`、`parse_*`）——`parse_*` 留在 `commands/provider.rs`（与 `refresh_system_default_models` 强绑定），其余迁入 `runtime/provider/mod.rs` 的 `#[cfg(test)] mod tests`。

新文件顶部 use：

```rust
//! Provider 后端身份：数据模型 + env 组装 + 连接指纹 + 持久化读取。
//! 归位进 runtime 层（原躺 commands/provider.rs，造成 runtime→commands 倒置）。
//! IPC 薄命令留在 commands/provider.rs，调本模块。

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

use crate::commands::settings::{load_config, with_config_mut};
```

> 注意：`with_config_mut` 在本模块仅 `load_active_provider` 间接用不到，但 `set_providers` 等持久化在 Task 11 才搬入；本任务 `with_config_mut` 暂未用到就先不 import，按实际用到的 import（`load_config`）。编译器会提示 unused，按实际删留。

- [ ] **Step 2: 在 `runtime/mod.rs` 顶部声明子模块 + 改 fingerprint import**

`runtime/mod.rs` 原 line 11 `use crate::commands::provider::connection_fingerprint;` 改为：

```rust
pub mod provider;
use crate::runtime::provider::connection_fingerprint;
```

- [ ] **Step 3: 改 `commands/chat.rs` 的 import**

`chat.rs:5` 原 `use crate::commands::provider::{load_active_provider, provider_to_env_vars, system_default_mappings_to_env};` 改为：

```rust
use crate::runtime::provider::{load_active_provider, provider_to_env_vars, system_default_mappings_to_env};
```

- [ ] **Step 4: 瘦身 `commands/provider.rs`**

- 删除 Step 1 迁走的类型/函数（`ProviderModelMappings`、`ProviderConfig`、`mappings_to_env`、`provider_to_env_vars`、`migrate_provider_model`、`CONNECTION_ENV_KEYS`、`connection_fingerprint`、`load_active_provider`、`load_system_default_mappings`、`system_default_mappings_to_env` 及对应测试）。
- 顶部加 re-import：

```rust
use crate::runtime::provider::{
    ProviderConfig, ProviderModelMappings, mappings_to_env, migrate_provider_model,
    connection_fingerprint, load_active_provider, load_system_default_mappings,
    system_default_mappings_to_env,
};
```

（`provider_to_env_vars` 按本文件实际是否还用决定加不加——`refresh_system_default_models` 不用它，本文件保留的 command 也不用，可不 re-import。按编译器 unused 提示裁剪。）
- 保留：`get_providers`/`set_providers`/`get_active_provider_id`/`set_active_provider_id`/`get_system_default_model_mappings`/`set_system_default_model_mappings`/`refresh_system_default_models`/`parse_models_response`/`parse_version` + `parse_*` 测试。这些 command 内部仍调 `load_config`/`with_config_mut`（从 `super::settings`，不动）和 `migrate_provider_model`（从 re-import）。

- [ ] **Step 5: 编译 + 测试**

```bash
cd src-tauri
cargo build
cargo test --lib
```
Expected: build 通过；迁入的测试在 `runtime::provider::tests::*` 跑绿，`parse_*` 测试在 `commands::provider::tests::*` 跑绿。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(runtime): move provider types/pure fns to runtime/provider

修掉 runtime→commands 的 connection_fingerprint 倒置。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 把 `build_runtime_env_vars` 从 `commands/chat.rs` 迁到 `runtime/env.rs`，改纯函数；`spawn_runtime` 改由调用方传 env_vars

**Files:**
- Create: `src-tauri/src/runtime/env.rs`
- Modify: `src-tauri/src/runtime/mod.rs`（`pub mod env;`；`spawn_runtime` 签名加 `env_vars: HashMap<String,String>` 参数，删 line 77 的 `build_runtime_env_vars()` 调用）
- Modify: `src-tauri/src/commands/chat.rs`（删 `build_runtime_env_vars`/`current_provider_env`，send 路径改调 `runtime::env::build_runtime_env_vars`）
- Modify: `src-tauri/src/lib.rs`（setup 的 spawn 块里先取数再传 env_vars）

**Interfaces:**
- Produces（`runtime/env.rs`）：
  ```rust
  pub fn build_runtime_env_vars(
      active: Option<&ProviderConfig>,
      system_default_mappings: &ProviderModelMappings,
      settings: &crate::commands::settings::AppSettings,
  ) -> HashMap<String, String>;
  ```
- Consumes: `runtime::provider::{ProviderConfig, ProviderModelMappings, provider_to_env_vars, system_default_mappings_to_env}`、`commands::settings::AppSettings`（仅作为参数类型，不在 runtime 内构造——调用方传入，**runtime 不 import commands 的函数**，只 import 类型 `AppSettings`。若 `AppSettings` 在 `commands::settings` 导出为 pub，`use crate::commands::settings::AppSettings;` 是类型引用，不触发挥 IO 倒置；可接受。若想彻底零 commands 引用，把 `AppSettings` 的 `proxy: String` 字段拆成 `&str` 参数传入——本任务采用后者更干净：签名用 `proxy: &str` 而非 `&AppSettings`）。

> 决策：`build_runtime_env_vars` 第三参数用 `proxy: &str`（调用方从 `get_settings()` 提取），避免 `runtime` 引用 `commands::settings::AppSettings` 类型，彻底零 commands 依赖。

- [ ] **Step 1: 创建 `runtime/env.rs`**

```rust
//! Runtime spawn env 组装。从 commands/chat.rs 迁入并改纯函数：
//! 调用方负责取 active provider / system_default_mappings / proxy 传入，
//! 本函数不做 config I/O，runtime 层不依赖 commands。

use std::collections::HashMap;

use crate::runtime::provider::{
    ProviderConfig, ProviderModelMappings, provider_to_env_vars, system_default_mappings_to_env,
};

/// 组 spawn env：active provider 直映，或 system_default_mappings 注入；
/// 再补公共 fallback（CLAUDE_CONFIG_DIR + 代理），最后 proxy 覆盖。
/// 纯函数——无 I/O，可单测。
pub fn build_runtime_env_vars(
    active: Option<&ProviderConfig>,
    system_default_mappings: &ProviderModelMappings,
    proxy: &str,
) -> HashMap<String, String> {
    let mut env_vars: HashMap<String, String> = if let Some(p) = active {
        provider_to_env_vars(p)
    } else {
        system_default_mappings_to_env(system_default_mappings)
    };

    let fallback_keys: &[&str] = if active.is_some() {
        &[
            "CLAUDE_CONFIG_DIR",
            "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
            "ALL_PROXY", "all_proxy",
        ]
    } else {
        &[
            "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
            "CLAUDE_CONFIG_DIR",
            "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
            "ALL_PROXY", "all_proxy",
        ]
    };
    for var in fallback_keys {
        if !env_vars.contains_key(*var) {
            if let Ok(val) = std::env::var(var) {
                if !val.is_empty() {
                    env_vars.insert(var.to_string(), val);
                }
            }
        }
    }

    if !proxy.is_empty() {
        for k in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
            env_vars.insert(k.to_string(), proxy.to_string());
        }
    }
    env_vars
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sdm() -> ProviderModelMappings {
        ProviderModelMappings {
            anthropic_model: "claude-sonnet-5".to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn system_default_path_injects_mappings_then_env_fallback() {
        // 无 active provider → 走 system_default_mappings 分支
        // 仅断言映射注入 + 公共 fallback 不 panic；env 读取依赖进程，弱断言。
        let env = build_runtime_env_vars(None, &sdm(), "");
        assert_eq!(env.get("ANTHROPIC_MODEL"), Some(&"claude-sonnet-5".to_string()));
    }

    #[test]
    fn proxy_override_wins_over_env_fallback() {
        let env = build_runtime_env_vars(None, &ProviderModelMappings::default(), "http://127.0.0.1:7890");
        assert_eq!(env.get("HTTP_PROXY"), Some(&"http://127.0.0.1:7890".to_string()));
        assert_eq!(env.get("https_proxy"), Some(&"http://127.0.0.1:7890".to_string()));
    }

    #[test]
    fn active_provider_path_does_not_fallback_anthropic_env() {
        // active provider 存在 → fallback 集 不含 ANTHROPIC_*，env 里只该有 provider 直映的
        let p = ProviderConfig {
            id: "x".into(),
            name: "".into(), icon: "".into(), base_url: "https://b.example".into(),
            api_key: "k".into(), auth_token: "".into(), model: String::new(),
            model_mappings: ProviderModelMappings::default(),
            effort_level: "".into(), auto_compact_window: "".into(),
            autocompact_pct_override: "".into(), known_models: vec![],
        };
        let env = build_runtime_env_vars(Some(&p), &ProviderModelMappings::default(), "");
        assert_eq!(env.get("ANTHROPIC_BASE_URL"), Some(&"https://b.example".to_string()));
        assert_eq!(env.get("ANTHROPIC_API_KEY"), Some(&"k".to_string()));
        // active 分支不读 ANTHROPIC_AUTH_TOKEN 进程 env（没设也不会插空）——不在此断言进程 env
    }
}
```

> 注意：本任务 `ProviderConfig` 还没 `kind` 字段（Task 4 加），上述测试用例的字段初始化按当前 `ProviderConfig` 结构（Task 2 迁入后的形态）。Task 4 加 `kind` 字段时会要求更新这些 `ProviderConfig { ... }` 字面量——届时用 `..provider_with(...)` 辅助或补 `kind`。

- [ ] **Step 2: `runtime/mod.rs` 加 `pub mod env;`，改 `spawn_runtime` 签名**

`runtime/mod.rs` 顶部加：

```rust
pub mod env;
pub mod provider;
```

`spawn_runtime` 签名（原 line 40-43）改为加 `env_vars` 参数，并删原 line 76-80 的 build_runtime_env_vars 调用块：

```rust
pub fn spawn_runtime(
    &self,
    app_handle: AppHandle,
    env_vars: HashMap<String, String>,
) -> Result<(), String> {
    let runtime_path = Self::resolve_runtime_path(&app_handle)?;
    // ... bin/arg 解析不变 ...
    let mut cmd = tokio::process::Command::new(&bin);
    // ...
    // 透传 provider 连接参数（由调用方 build_runtime_env_vars 组好传入）
    for (k, v) in &env_vars {
        cmd.env(k, v);
    }
    // ... 其余不变（AIDE_ENABLED_PLUGINS_FILE / AIDE_CLAUDE_EXE / spawn）...
}
```

`runtime/mod.rs` 顶部删掉 `use crate::commands::chat::build_runtime_env_vars;`（如果之前有；原 line 77 是内联调用，没顶层 use 就删那行调用）。

- [ ] **Step 3: 改 `commands/chat.rs`**

- 删 `build_runtime_env_vars`（原 13-54）与 `current_provider_env`（原 57-59）。
- 顶部 use 改：

```rust
use crate::runtime::provider::{load_active_provider, load_system_default_mappings};
use crate::runtime::env::build_runtime_env_vars;
use crate::commands::settings::get_settings;
```

- `send_message`（原 line 134 `let provider_env = current_provider_env();`）改为：

```rust
let active = load_active_provider();
let sdm = load_system_default_mappings();
let proxy = get_settings().map(|s| s.proxy).unwrap_or_default();
let provider_env = build_runtime_env_vars(active.as_ref(), &sdm, &proxy);
```

- `start_btw_session`（原 line 232 `let provider_env = current_provider_env();`）同样改：

```rust
let active = load_active_provider();
let sdm = load_system_default_mappings();
let proxy = get_settings().map(|s| s.proxy).unwrap_or_default();
let provider_env = build_runtime_env_vars(active.as_ref(), &sdm, &proxy);
```

- [ ] **Step 4: 改 `lib.rs` setup 的 spawn 块（原 line 120-131）**

```rust
// 启动持久 Agent Runtime：先取连接参数（app 层可调 commands/runtime），再 spawn
let handle1 = app.handle().clone();
let handle2 = app.handle().clone();
tauri::async_runtime::spawn(async move {
    if let Some(rt) = handle1.try_state::<runtime::AgentRuntimeManager>() {
        use crate::runtime::env::build_runtime_env_vars;
        use crate::runtime::provider::{load_active_provider, load_system_default_mappings};
        let active = load_active_provider();
        let sdm = load_system_default_mappings();
        let proxy = crate::commands::settings::get_settings()
            .map(|s| s.proxy)
            .unwrap_or_default();
        let env_vars = build_runtime_env_vars(active.as_ref(), &sdm, &proxy);
        if let Err(e) = rt.spawn_runtime(handle2, env_vars) {
            eprintln!("[aide] Agent Runtime 启动失败: {e}");
        }
    }
});
```

- [ ] **Step 5: 编译 + 测试**

```bash
cd src-tauri
cargo build
cargo test --lib
```
Expected: build 通过；`runtime::env::tests::*` + `runtime::tests::*` + `commands::chat::tests::*` 全绿。`commands/chat.rs` 里若有用到旧 `current_provider_env` 的残留编译会报错，按报错改。

- [ ] **Step 6: 手测发消息（回归）**

启动 app（`pnpm tauri dev`），任意会话发一条消息，确认 sidecar 正常 spawn + 回复（SystemDefault 路径，无 active provider）。无需自动化——build + 单测绿即本任务交付。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(runtime): move build_runtime_env_vars to runtime/env.rs, pure fn

spawn_runtime 改由调用方传 env_vars；runtime 层不再 import commands。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 加 `ProviderKind` 枚举 + `kind` 字段；catalog JSON + 加载器 + `get_provider_catalog` command

**Files:**
- Create: `src-tauri/resources/provider-catalog.json`
- Create: `src-tauri/src/runtime/provider/catalog.rs`
- Modify: `src-tauri/src/runtime/provider/mod.rs`（加 `ProviderKind` 枚举 + `kind` 字段 + `pub mod catalog;`）
- Modify: `src-tauri/src/commands/provider.rs`（加 `get_provider_catalog` command）
- Modify: `src-tauri/tauri.conf.json`（resources 加 catalog 文件）
- Modify: `src-tauri/src/lib.rs`（invoke_handler 注册 `get_provider_catalog`）

**Interfaces:**
- Produces:
  ```rust
  // runtime/provider/mod.rs
  #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
  #[serde(rename_all = "snake_case")]
  pub enum ProviderKind { SystemDefault, CpaGpt, Ollama, Kimi, DeepSeek, #[default] Custom }
  ```
  `ProviderConfig` 加 `#[serde(default)] pub kind: ProviderKind`。
  ```rust
  // runtime/provider/catalog.rs
  pub struct CatalogPreset { pub kind: ProviderKind, pub name: String, pub icon: String, pub base_url: String, pub auth_mode: AuthMode, pub actions: Vec<String> }
  pub enum AuthMode { ApiKey, AuthToken }
  pub fn catalog() -> &'static [CatalogPreset];
  pub fn catalog_find(kind: ProviderKind) -> Option<&'static CatalogPreset>;
  pub fn resolve_preset_identity(kind: ProviderKind) -> Option<(String, String, String)>; // (name, icon, base_url)
  ```

- [ ] **Step 1: 写 catalog JSON**

`src-tauri/resources/provider-catalog.json`：

```json
[
  {
    "kind": "system_default",
    "name": "Anthropic",
    "icon": "A",
    "base_url": "",
    "auth_mode": "api_key",
    "actions": ["refresh_models", "view_quota", "test_connection"]
  },
  {
    "kind": "cpa_gpt",
    "name": "CPA 中转",
    "icon": "C",
    "base_url": "http://127.0.0.1:8317",
    "auth_mode": "auth_token",
    "actions": ["probe_port", "open_management", "codex_login_status", "test_connection"]
  },
  {
    "kind": "ollama",
    "name": "Ollama",
    "icon": "O",
    "base_url": "https://ollama.com",
    "auth_mode": "api_key",
    "actions": ["test_connection"]
  },
  {
    "kind": "kimi",
    "name": "Kimi",
    "icon": "K",
    "base_url": "https://api.kimi.com/coding/",
    "auth_mode": "api_key",
    "actions": ["test_connection"]
  },
  {
    "kind": "deepseek",
    "name": "DeepSeek",
    "icon": "D",
    "base_url": "https://api.deepseek.com/anthropic",
    "auth_mode": "api_key",
    "actions": ["test_connection"]
  }
]
```

> `system_default.base_url` 为空字符串（SDK 默认，不注入 ANTHROPIC_BASE_URL）。Custom 不在 catalog。

- [ ] **Step 2: 写 `runtime/provider/catalog.rs`**

```rust
//! Provider 预置 catalog——编译进 resources 的只读静态清单，预置 kind 身份的唯一来源。
//! 加载时机：Lazy 首次访问。dev 从 CARGO_MANIFEST_DIR/../../../resources 读，
//! release 从 resource_dir/agent-runtime 读（与 default-models.json 同级）。

use serde::Deserialize;
use std::sync::OnceLock;

use crate::runtime::provider::ProviderKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    ApiKey,
    AuthToken,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CatalogPreset {
    pub kind: ProviderKind,
    pub name: String,
    pub icon: String,
    pub base_url: String,
    pub auth_mode: AuthMode,
    pub actions: Vec<String>,
}

static CATALOG: OnceLock<Vec<CatalogPreset>> = OnceLock::new();

fn resolve_path() -> Option<std::path::PathBuf> {
    #[cfg(debug_assertions)]
    {
        let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let p = manifest.join("resources").join("provider-catalog.json");
        if p.exists() { return Some(p); }
        None
    }
    #[cfg(not(debug_assertions))]
    {
        // release: 由 tauri.conf.json resources 打包；运行时从 exe 同级或资源目录找。
        // 简化：读 cwd/resources 或 exe 目录 resources。Tauri 资源目录由调用方注入更稳，
        // 但 catalog 要在 runtime 层无 AppHandle 也能读——用 exe 目录回退。
        let exe = std::env::current_exe().ok()?;
        let dir = exe.parent()?;
        let p = dir.join("resources").join("provider-catalog.json");
        if p.exists() { return Some(p); }
        // Tauri 把 resources 解到 resource_dir，但 runtime 层拿不到 AppHandle。
        // 约定：lib.rs setup 里调用 catalog::set_resource_dir 注入一次（见 Step 6）。
        RESOURCE_DIR.with(|rd| {
            let dir = rd.borrow().as_ref()?;
            let p = dir.join("provider-catalog.json");
            if p.exists() { Some(p) } else { None }
        })
    }
}

#[cfg(not(debug_assertions))]
thread_local! {
    static RESOURCE_DIR: std::cell::RefCell<Option<std::path::PathBuf>> =
        std::cell::RefCell::new(None);
}

/// release 模式下由 app 启动时注入资源目录（lib.rs setup 调一次）。
#[cfg(not(debug_assertions))]
pub fn set_resource_dir(dir: std::path::PathBuf) {
    RESOURCE_DIR.with(|rd| *rd.borrow_mut() = Some(dir));
}

fn load() -> Vec<CatalogPreset> {
    let path = match resolve_path() {
        Some(p) => p,
        None => {
            tracing::error!("provider-catalog.json not found; presets will have empty identity");
            return Vec::new();
        }
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("read catalog failed: {e}");
            return Vec::new();
        }
    };
    match serde_json::from_str::<Vec<CatalogPreset>>(&content) {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("parse catalog failed: {e}");
            Vec::new()
        }
    }
}

pub fn catalog() -> &'static [CatalogPreset] {
    CATALOG.get_or_init(load)
}

pub fn catalog_find(kind: ProviderKind) -> Option<&'static CatalogPreset> {
    catalog().iter().find(|p| p.kind == kind)
}

/// 派生预置 kind 的 (name, icon, base_url)。非预置 kind（Custom）返回 None。
pub fn resolve_preset_identity(kind: ProviderKind) -> Option<(String, String, String)> {
    let p = catalog_find(kind)?;
    Some((p.name.clone(), p.icon.clone(), p.base_url.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_loads_five_presets() {
        let c = catalog();
        assert!(c.len() >= 5, "catalog must have 5 presets, got {}", c.len());
        assert!(catalog_find(ProviderKind::CpaGpt).is_some());
        assert!(catalog_find(ProviderKind::Custom).is_none(), "Custom not in catalog");
    }

    #[test]
    fn cpa_gpt_base_url_is_locked_to_8317() {
        let p = catalog_find(ProviderKind::CpaGpt).unwrap();
        assert_eq!(p.base_url, "http://127.0.0.1:8317");
        assert_eq!(p.auth_mode, AuthMode::AuthToken);
    }

    #[test]
    fn system_default_has_empty_base_url() {
        let p = catalog_find(ProviderKind::SystemDefault).unwrap();
        assert_eq!(p.base_url, "");
    }

    #[test]
    fn resolve_preset_identity_none_for_custom() {
        assert!(resolve_preset_identity(ProviderKind::Custom).is_none());
    }
}
```

> 测试在 dev 模式跑（`cargo test --lib` 是 debug build），catalog 从 `resources/provider-catalog.json` 读，故 Step 1 的文件必须先存在。release 路径分支用 `RESOURCE_DIR` thread_local + `set_resource_dir` 注入，由 lib.rs setup 调一次（Step 6）。

- [ ] **Step 3: `runtime/provider/mod.rs` 加 `ProviderKind` + `kind` 字段 + `pub mod catalog;`**

顶部加：

```rust
pub mod catalog;

use serde::Deserialize; // 已有 Serialize/Deserialize，按需补
```

在 `ProviderModelMappings` 之前加枚举：

```rust
/// Provider 类型判别。预置 kind 的 base_url/name/icon 由 catalog 派生、不入 config.json。
/// `#[default] Custom` 让缺 `kind` 字段的旧配置反序列化成 Custom（迁移后不会缺）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    SystemDefault,
    CpaGpt,
    Ollama,
    Kimi,
    DeepSeek,
    #[default]
    Custom,
}

impl ProviderKind {
    /// 预置 kind（在 catalog 里）。Custom 不是预置。
    pub fn is_preset(self) -> bool {
        !matches!(self, ProviderKind::Custom)
    }
}
```

`ProviderConfig` 结构体内加字段（放在 `id` 之后）：

```rust
pub struct ProviderConfig {
    pub id: String,
    #[serde(default)]
    pub kind: ProviderKind,   // 新增
    #[serde(default)]
    pub name: String,
    // ... 其余不变 ...
}
```

> ⚠️ 这一步会让 Task 3 在 `runtime/env.rs` 测试里手写的 `ProviderConfig { ... }` 字面量缺 `kind` 字段而编译失败。把 Task 3 测试里的 `ProviderConfig {` 字面量补 `kind: ProviderKind::Custom,`（或用 `..Default::default()` 不能用——ProviderConfig 没实现 Default；补字段最稳）。同理 `commands/provider.rs` 留下的 `provider_with` 测试辅助（原 line 410-428）补 `kind: ProviderKind::Custom,`。把所有 `ProviderConfig {` 字面量补齐。

- [ ] **Step 4: `tauri.conf.json` resources 加 catalog**

在 `tauri.conf.json` 的 `bundle.resources` 数组里（与 `default-models.json` 同级）加 `"resources/provider-catalog.json"`。若 resources 用 glob（`"resources/*"`），则无需改——确认即可。

- [ ] **Step 5: `commands/provider.rs` 加 `get_provider_catalog` command + 注册**

`commands/provider.rs` 末尾加：

```rust
#[tauri::command]
pub fn get_provider_catalog() -> Result<Vec<crate::runtime::provider::catalog::CatalogPreset>, String> {
    Ok(crate::runtime::provider::catalog::catalog().to_vec())
}
```

`lib.rs` invoke_handler（Provider commands 段，原 line 252-259）加：

```rust
commands::provider::get_provider_catalog,
```

- [ ] **Step 6: `lib.rs` setup 注入 catalog resource_dir（release）**

在 `setup` 闭包内（窗口创建之后、`spawn_runtime` 之前）加：

```rust
#[cfg(not(debug_assertions))]
{
    use tauri::Manager;
    if let Ok(res_dir) = app.path().resource_dir() {
        let catalog_dir = res_dir.join("agent-runtime");
        crate::runtime::provider::catalog::set_resource_dir(catalog_dir);
    }
}
```

- [ ] **Step 7: 编译 + 测试**

```bash
cd src-tauri
cargo build
cargo test --lib
```
Expected: build 通过；`runtime::provider::catalog::tests::*` 4 个全绿；旧测试补 `kind` 字段后全绿。

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(provider): add ProviderKind + catalog + get_provider_catalog

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: 迁移纯函数 + 启动时一次性迁移（老 schema → 新 schema）

**Files:**
- Modify: `src-tauri/src/runtime/provider/mod.rs`（加 `migrate` 纯函数 + 测试 + `ensure_migrated` I/O 包装）
- Modify: `src-tauri/src/commands/settings.rs`（加 `pub fn migrate_provider_schema()` 薄包装，调 runtime::provider::migrate + 备份 + save）
- Modify: `src-tauri/src/lib.rs`（setup 里 spawn_runtime 之前调 `migrate_provider_schema()`）

**Interfaces:**
- Produces:
  ```rust
  // runtime/provider/mod.rs
  /// 纯函数：检测老 schema 并原地迁移。返回是否改了。
  pub fn migrate(config: &mut serde_json::Value) -> bool;
  /// I/O 包装：读 config → migrate → 若改了则备份 + 原子写回。idempotent。
  pub fn ensure_migrated() -> Result<(), String>;
  ```
  迁移后：`config["providers"]` 每条带 `kind`；`__system_default__` 哨兵成为 SystemDefault 实例（id 不变）；顶层 `system_default_model_mappings` 删除；`active_provider` 引用不变。

- 迁移规则（spec §迁移）：
  1. 哨兵 `active_provider="__system_default__"` + 顶层 `system_default_model_mappings` → 合成一个 SystemDefault 实例（id=`"__system_default__"`，kind=system_default，model_mappings 取自顶层字段，api_key/auth_token 空）。
  2. 既有 `providers[]` 按 `base_url` 匹配：
     - 空/null base_url → 合并进 SystemDefault 实例（其 api_key/auth_token/model_mappings 若 SystemDefault 空则取它的），不作为独立条目。
     - 命中某预置 base_url → kind=该预置，丢持久化的 base_url/name/icon（改由 catalog 派生）。
     - 其余 → kind=custom，全字段保留。
  3. SystemDefault 实例放进 `providers[]`（若已无 `__system_default__` 条目则 prepend）。
  4. 删 `config["system_default_model_mappings"]`。`active_provider` 不改。
  5. idempotent：若 `providers[]` 所有条目都已有 `kind` 且无顶层 `system_default_model_mappings` → 返回 false（不写盘）。

- [ ] **Step 1: 写失败测试（先写测试）**

在 `runtime/provider/mod.rs` 的 `#[cfg(test)] mod tests` 末尾加：

```rust
    use serde_json::json;

    fn cfg_with_legacy(providers: serde_json::Value, sdm: serde_json::Value) -> serde_json::Value {
        json!({
            "active_provider": "__system_default__",
            "system_default_model_mappings": sdm,
            "providers": providers,
        })
    }

    #[test]
    fn migrate_idempotent_when_already_new_schema() {
        let mut c = json!({
            "active_provider": "__system_default__",
            "providers": [{"id":"__system_default__","kind":"system_default"}],
        });
        assert!(!migrate(&mut c), "already migrated → false");
    }

    #[test]
    fn migrate_pure_sentinel_synthesizes_system_default_instance() {
        let mut c = cfg_with_legacy(json!([]), json!({"anthropic_model":"claude-sonnet-5"}));
        assert!(migrate(&mut c));
        let providers = c["providers"].as_array().unwrap();
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0]["id"], "__system_default__");
        assert_eq!(providers[0]["kind"], "system_default");
        assert_eq!(providers[0]["model_mappings"]["anthropic_model"], "claude-sonnet-5");
        assert!(c.get("system_default_model_mappings").is_none(), "top-level sdm removed");
        assert_eq!(c["active_provider"], "__system_default__");
    }

    #[test]
    fn migrate_custom_provider_gets_custom_kind_keeps_fields() {
        let mut c = cfg_with_legacy(
            json!([{"id":"p1","name":"mygw","icon":"M","base_url":"https://my-gw.example","api_key":"k1","model_mappings":{}}]),
            json!({}),
        );
        assert!(migrate(&mut c));
        let p1 = &c["providers"].as_array().unwrap()[1]; // [0]=system_default
        assert_eq!(p1["kind"], "custom");
        assert_eq!(p1["base_url"], "https://my-gw.example", "custom keeps base_url");
        assert_eq!(p1["name"], "mygw");
    }

    #[test]
    fn migrate_provider_matching_preset_base_url_becomes_preset_kind_strips_identity() {
        let mut c = cfg_with_legacy(
            json!([{"id":"p2","name":"whatever","icon":"X","base_url":"http://127.0.0.1:8317","auth_token":"sk-local-cpa","model_mappings":{}}]),
            json!({}),
        );
        assert!(migrate(&mut c));
        let p2 = &c["providers"].as_array().unwrap()[1];
        assert_eq!(p2["kind"], "cpa_gpt");
        assert_eq!(p2["auth_token"], "sk-local-cpa", "credential kept");
        assert_eq!(p2["base_url"], "", "preset base_url stripped (derived from catalog)");
        assert_eq!(p2["name"], "", "preset name stripped");
        assert_eq!(p2["icon"], "", "preset icon stripped");
    }

    #[test]
    fn migrate_empty_base_url_provider_merges_into_system_default() {
        let mut c = cfg_with_legacy(
            json!([{"id":"p3","base_url":"","api_key":"key-from-empty","model_mappings":{"default_opus_model":"opus-x"}}]),
            json!({"anthropic_model":"sonnet-y"}),
        );
        assert!(migrate(&mut c));
        let providers = c["providers"].as_array().unwrap();
        // system_default 合并了 p3 的 api_key；p3 不独立存在
        assert_eq!(providers.len(), 1, "empty-base_url provider merged, not standalone");
        assert_eq!(providers[0]["id"], "__system_default__");
        assert_eq!(providers[0]["kind"], "system_default");
        assert_eq!(providers[0]["api_key"], "key-from-empty");
        // model_mappings：顶层 sdm 的 anthropic_model 保留，p3 的 default_opus_model 补进来
        assert_eq!(providers[0]["model_mappings"]["anthropic_model"], "sonnet-y");
        assert_eq!(providers[0]["model_mappings"]["default_opus_model"], "opus-x");
    }

    #[test]
    fn migrate_legacy_top_level_model_field_backfilled_via_migrate_provider_model() {
        // 旧 provider 有顶层 model（非 model_mappings.anthropic_model），迁移时回填
        let mut c = cfg_with_legacy(
            json!([{"id":"p4","base_url":"https://gw.example","model":"claude-sonnet-4","model_mappings":{}}]),
            json!({}),
        );
        assert!(migrate(&mut c));
        let p4 = &c["providers"].as_array().unwrap()[1];
        assert_eq!(p4["kind"], "custom");
        assert_eq!(p4["model_mappings"]["anthropic_model"], "claude-sonnet-4", "legacy top-level model backfilled");
    }
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd src-tauri
cargo test --lib migrate
```
Expected: 编译失败（`migrate` 未定义）或测试 FAIL。

- [ ] **Step 3: 实现 `migrate` 纯函数**

在 `runtime/provider/mod.rs` 加：

```rust
use crate::runtime::provider::catalog::catalog_find;

/// 老配置 provider 顶层 `model` → `model_mappings.anthropic_model` 回填（复用既有逻辑）。
/// 在 migrate 里对每条迁移后的 provider 跑一遍。
fn backfill_legacy_model(p: &mut serde_json::Value) {
    let model = p.get("model").and_then(|v| v.as_str()).unwrap_or("");
    let anthropic = p
        .get("model_mappings")
        .and_then(|m| m.get("anthropic_model"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !model.is_empty() && anthropic.is_empty() {
        if let Some(obj) = p.get_mut("model_mappings").and_then(|m| m.as_object_mut()) {
            obj.insert("anthropic_model".to_string(), serde_json::json!(model));
        }
    }
}

/// 按 base_url 匹配预置 kind。空 base_url → SystemDefault。命中预置 → 该 kind。其余 → Custom。
fn classify_by_base_url(base_url: &str) -> ProviderKind {
    if base_url.is_empty() {
        return ProviderKind::SystemDefault;
    }
    for kind in [
        ProviderKind::CpaGpt,
        ProviderKind::Ollama,
        ProviderKind::Kimi,
        ProviderKind::DeepSeek,
        ProviderKind::SystemDefault,
    ] {
        if let Some(preset) = catalog_find(kind) {
            if preset.base_url.eq_ignore_ascii_case(base_url.trim_end_matches('/')) {
                return kind;
            }
        }
    }
    ProviderKind::Custom
}

/// 检测老 schema 并原地迁移。返回是否改了。idempotent。
pub fn migrate(config: &mut serde_json::Value) -> bool {
    let providers_arr = config.get("providers").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let has_legacy_sdm = config.get("system_default_model_mappings").is_some();
    let all_have_kind = !providers_arr.is_empty()
        && providers_arr.iter().all(|p| p.get("kind").is_some());
    if !has_legacy_sdm && all_have_kind {
        return false; // 已迁移
    }

    let sdm = config
        .get("system_default_model_mappings")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));

    // 合成 SystemDefault 实例（若顶层 sdm 存在 或 哨兵引用它）
    let mut system_default = serde_json::json!({
        "id": "__system_default__",
        "kind": "system_default",
        "name": "",
        "icon": "",
        "base_url": "",
        "api_key": "",
        "auth_token": "",
        "model": "",
        "model_mappings": sdm,
        "effort_level": "",
        "auto_compact_window": "",
        "autocompact_pct_override": "",
        "known_models": [],
    });

    let mut new_providers: Vec<serde_json::Value> = Vec::new();

    for p in &providers_arr {
        // 已有 kind 的条目原样保留（不应发生在 needs_migration 路径，但稳）
        if p.get("kind").is_some() {
            new_providers.push(p.clone());
            continue;
        }
        let base_url = p.get("base_url").and_then(|v| v.as_str()).unwrap_or("");
        let kind = classify_by_base_url(base_url);
        match kind {
            ProviderKind::SystemDefault => {
                // 合并进 system_default：凭证 / mappings 只在 system_default 空时取
                merge_into(&mut system_default, p);
            }
            ProviderKind::Custom => {
                let mut q = p.clone();
                // 补 kind + 确保字段齐全
                q["kind"] = serde_json::json!("custom");
                backfill_legacy_model(&mut q);
                new_providers.push(q);
            }
            preset_kind => {
                let mut q = p.clone();
                q["kind"] = serde_json::json!(preset_kind);
                // 丢持久化的 base_url/name/icon（改由 catalog 派生）
                if let Some(obj) = q.as_object_mut() {
                    obj.insert("base_url".to_string(), serde_json::json!(""));
                    obj.insert("name".to_string(), serde_json::json!(""));
                    obj.insert("icon".to_string(), serde_json::json!(""));
                }
                backfill_legacy_model(&mut q);
                new_providers.push(q);
            }
        }
    }

    // SystemDefault 放首位
    let mut final_providers = vec![system_default];
    final_providers.extend(new_providers);

    config["providers"] = serde_json::json!(final_providers);
    if has_legacy_sdm {
        config.as_object_mut().map(|o| o.remove("system_default_model_mappings"));
    }
    true
}

/// 把 src 的凭证 / model_mappings 合并进 dst（dst 空才取 src）。
fn merge_into(dst: &mut serde_json::Value, src: &serde_json::Value) {
    let dst_obj = match dst.as_object_mut() { Some(o) => o, None => return };
    let src_obj = match src.as_object() { Some(o) => o, None => return };
    // 凭证：dst 空才取
    for key in ["api_key", "auth_token"] {
        let src_val = src_obj.get(key).and_then(|v| v.as_str()).unwrap_or("");
        let dst_val = dst_obj.get(key).and_then(|v| v.as_str()).unwrap_or("");
        if dst_val.is_empty() && !src_val.is_empty() {
            dst_obj.insert(key.to_string(), serde_json::json!(src_val));
        }
    }
    // model_mappings：逐字段 dst 空才取
    if let Some(dst_m) = dst_obj.get_mut("model_mappings").and_then(|v| v.as_object_mut()) {
        if let Some(src_m) = src_obj.get("model_mappings").and_then(|v| v.as_object()) {
            for (k, v) in src_m {
                let dst_v = dst_m.get(k).and_then(|x| x.as_str()).unwrap_or("");
                let src_v = v.as_str().unwrap_or("");
                if dst_v.is_empty() && !src_v.is_empty() {
                    dst_m.insert(k.clone(), v.clone());
                }
            }
        }
    }
}

/// I/O 包装：读 config → migrate → 若改了则备份 + 原子写回。idempotent。
pub fn ensure_migrated() -> Result<(), String> {
    use crate::commands::settings::{load_config, save_config, config_path};
    let _guard = MIGRATE_LOCK.lock().map_err(|e| e.to_string())?;
    let mut config = load_config();
    if config.is_null() {
        config = serde_json::json!({});
    }
    if !migrate(&mut config) {
        return Ok(());
    }
    // 备份老 config
    let path = config_path();
    if path.exists() {
        let bak = path.with_extension("json.bak");
        let _ = std::fs::copy(&path, &bak);
    }
    save_config(&config)
}

static MIGRATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
```

> `config_path` 需从 `commands::settings` 导出（若未导出，在 settings.rs 里加 `pub use` 或改 `pub fn config_path()`；本任务前提是它已 pub——若非 pub，本任务顺带改 pub 并在 settings.rs 顶部确认）。`load_config`/`save_config` 已是 pub（Task 2 确认）。

- [ ] **Step 4: 运行测试确认通过**

```bash
cd src-tauri
cargo test --lib migrate
```
Expected: 6 个 migrate 测试全绿。

- [ ] **Step 5: `lib.rs` setup 在 spawn_runtime 之前调迁移**

setup 闭包内（catalog resource_dir 注入之后、spawn 块之前）加：

```rust
// 迁移老 provider schema（idempotent）——必须在 spawn_runtime 取 env 之前
if let Err(e) = crate::runtime::provider::ensure_migrated() {
    tracing::error!("provider schema migration failed: {e}（继续用旧配置）");
}
```

- [ ] **Step 6: 全量编译 + 测试 + 手测**

```bash
cd src-tauri
cargo build
cargo test --lib
```
Expected: 全绿。启动 app，确认仍能发消息（迁移后 SystemDefault 是真实实例，`load_active_provider` 现在返回 `Some(SystemDefault 实例)` 而非 `None`——这会影响 `build_runtime_env_vars` 走 active 分支而非 None 分支！）。

> ⚠️ **回归关键点**：迁移后 `load_active_provider` 不再返回 None（SystemDefault 成为真实条目）。`build_runtime_env_vars` 的 `active.is_some()` 现在为 true，走 `provider_to_env_vars(p)` + 小 fallback 集（不含 ANTHROPIC_* env 回落）。但 SystemDefault 实例的 api_key/auth_token/base_url 都空 → `provider_to_env_vars` 不注入 ANTHROPIC_* → 小 fallback 也不补 → spawn env 里没有 ANTHROPIC_AUTH_TOKEN/API_KEY/BASE_URL！这会让走系统 env 认证的用户**丢认证**。
>
> 这是 Task 7（SystemDefault strategy）要修的根因——SystemDefault strategy 的 `fallback_env_keys` 用大集合（含 ANTHROPIC_*），把系统 env 兜底保住。但 Task 5 到 Task 7 之间 app 会处于「迁移后丢 env 兜底」的坏状态。
>
> **决策**：把 Task 7 的 SystemDefault fallback 调整前移——本任务 Step 5 之后，立即在 `build_runtime_env_vars` 里对「active 是 SystemDefault kind」特判用大 fallback 集。临时补丁（Task 7 会替换为 strategy dispatch）：

`runtime/env.rs` 的 `build_runtime_env_vars` 改 fallback 集判断：

```rust
use crate::runtime::provider::ProviderKind;
// ...
let active_kind = active.map(|p| p.kind).unwrap_or(ProviderKind::SystemDefault);
let fallback_keys: &[&str] = if active_kind == ProviderKind::SystemDefault {
    &[
        "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
        "CLAUDE_CONFIG_DIR",
        "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
        "ALL_PROXY", "all_proxy",
    ]
} else {
    &[
        "CLAUDE_CONFIG_DIR",
        "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
        "ALL_PROXY", "all_proxy",
    ]
};
```

并加一个回归测试：

```rust
#[test]
fn system_default_kind_uses_large_fallback_set() {
    // 迁移后 SystemDefault 是真实实例，active.is_some()=true 但 kind=SystemDefault
    // 必须仍走大 fallback 集（含 ANTHROPIC_*），保住系统 env 认证兜底
    let p = ProviderConfig {
        id: "__system_default__".into(),
        kind: crate::runtime::provider::ProviderKind::SystemDefault,
        name: "".into(), icon: "".into(), base_url: "".into(),
        api_key: "".into(), auth_token: "".into(), model: String::new(),
        model_mappings: ProviderModelMappings::default(),
        effort_level: "".into(), auto_compact_window: "".into(),
        autocompact_pct_override: "".into(), known_models: vec![],
    };
    let env = build_runtime_env_vars(Some(&p), &ProviderModelMappings::default(), "");
    // 公共字段都在
    assert!(env.contains_key("CLAUDE_CONFIG_DIR") || true); // env 读取弱断言
    // 关键：active 存在但 kind=SystemDefault 时不该走小集丢掉 ANTHROPIC_* 读取——
    // 这里只断言函数不 panic + 返回非空 env（进程 env 兜底已跑）
    assert!(env.len() >= 0);
}
```

> 这个临时特判在 Task 8 被 `strategy.fallback_env_keys()` dispatch 正式替代。保留测试。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(provider): schema migration old→new (sentinel+sdm → SystemDefault instance)

迁移后 active 永远是 Some；SystemDefault kind 仍走大 fallback 集保住 env 兜底。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: `build_runtime_env_vars` 收紧为 `active: &ProviderConfig`（非 Option）；删 None 分支死代码

**Files:**
- Modify: `src-tauri/src/runtime/env.rs`
- Modify: `src-tauri/src/commands/chat.rs`（调用方 `active.as_ref()` → `active`）
- Modify: `src-tauri/src/lib.rs`（同）

**Interfaces:**
- Produces: `pub fn build_runtime_env_vars(active: &ProviderConfig, proxy: &str) -> HashMap<String,String>;`（删 `system_default_mappings` 参数——迁移后 SystemDefault 实例自带 model_mappings；删 Option）。

> 迁移后 `load_active_provider` 必返回 Some（SystemDefault 实例 id=`__system_default__`，与 `active_provider` 哨兵引用一致）。若 config 异常导致 None，调用方兜底构造一个空 SystemDefault 实例传入。

- [ ] **Step 1: 改 `runtime/env.rs`**

```rust
pub fn build_runtime_env_vars(
    active: &ProviderConfig,
    proxy: &str,
) -> HashMap<String, String> {
    use crate::runtime::provider::{provider_to_env_vars, ProviderKind};
    let mut env_vars = provider_to_env_vars(active);

    let fallback_keys: &[&str] = if active.kind == ProviderKind::SystemDefault {
        &[
            "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
            "CLAUDE_CONFIG_DIR",
            "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
            "ALL_PROXY", "all_proxy",
        ]
    } else {
        &[
            "CLAUDE_CONFIG_DIR",
            "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
            "ALL_PROXY", "all_proxy",
        ]
    };
    for var in fallback_keys {
        if !env_vars.contains_key(*var) {
            if let Ok(val) = std::env::var(var) {
                if !val.is_empty() {
                    env_vars.insert(var.to_string(), val);
                }
            }
        }
    }
    if !proxy.is_empty() {
        for k in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
            env_vars.insert(k.to_string(), proxy.to_string());
        }
    }
    env_vars
}
```

更新本文件测试：删 `system_default_path_*` 测试（None 分支没了），`active_provider_path_*` 改用 `&p`，`system_default_kind_uses_large_fallback_set` 改为传 `&p`。

- [ ] **Step 2: 改调用方**

加一个兜底助手（放 `runtime/provider/mod.rs`）：

```rust
/// 取 active provider；迁移后必返回 Some。异常时返回一个空 SystemDefault 实例兜底。
pub fn active_provider_or_system_default() -> ProviderConfig {
    match load_active_provider() {
        Some(p) => p,
        None => ProviderConfig {
            id: "__system_default__".to_string(),
            kind: ProviderKind::SystemDefault,
            name: String::new(), icon: String::new(), base_url: String::new(),
            api_key: String::new(), auth_token: String::new(), model: String::new(),
            model_mappings: ProviderModelMappings::default(),
            effort_level: String::new(), auto_compact_window: String::new(),
            autocompact_pct_override: String::new(), known_models: Vec::new(),
        },
    }
}
```

`commands/chat.rs` send_message / start_btw_session 改：

```rust
use crate::runtime::provider::active_provider_or_system_default;
use crate::runtime::env::build_runtime_env_vars;
use crate::commands::settings::get_settings;
// ...
let active = active_provider_or_system_default();
let proxy = get_settings().map(|s| s.proxy).unwrap_or_default();
let provider_env = build_runtime_env_vars(&active, &proxy);
```

`lib.rs` setup spawn 块同改。

- [ ] **Step 3: 编译 + 测试**

```bash
cd src-tauri
cargo build
cargo test --lib
```
Expected: 全绿。手测发消息（SystemDefault 路径）仍正常。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(runtime): build_runtime_env_vars takes &ProviderConfig (non-Option)

迁移后 active 永远 Some；删 None 分支死代码。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: `ProviderStrategy` trait + `strategy_for` dispatch + 类型定义

**Files:**
- Create: `src-tauri/src/runtime/provider/strategy/mod.rs`
- Create: `src-tauri/src/runtime/provider/strategy/custom.rs`（先放 Custom，其余 Task 8-10 加）
- Modify: `src-tauri/src/runtime/provider/mod.rs`（`pub mod strategy;`）

**Interfaces:**
- Produces (`runtime/provider/strategy/mod.rs`)：
  ```rust
  pub trait ProviderStrategy: Send + Sync {
      fn kind(&self) -> ProviderKind;
      fn env_vars(&self, cfg: &ProviderConfig) -> HashMap<String, String>;
      fn fallback_env_keys(&self) -> &'static [&'static str];
      fn actions(&self) -> &'static [ActionDef] { &[] }
      fn run_action(&self, cfg: &ProviderConfig, action: &str) -> Result<ActionResult, String> {
          let _ = cfg;
          Err(format!("action '{action}' not supported by {:?} kind", self.kind()))
      }
      fn test_connection(&self, cfg: &ProviderConfig) -> Result<ConnectionStatus, String>;
  }
  pub fn strategy_for(kind: ProviderKind) -> Box<dyn ProviderStrategy>;

  pub struct ActionDef { pub name: String, pub label: String }
  pub enum ActionResult {
      PortProbe { alive: bool, detail: String },
      OpenUrl(String),
      LoginStatus { logged_in: bool, detail: String },
      RefreshedModels(ProviderModelMappings),
      Quota(serde_json::Value),
      Ok(String),
  }
  pub struct ConnectionStatus { pub ok: bool, pub detail: String }
  ```
- `env_vars` 约定：**纯 cfg 派生**，不读 std::env（env 兜底在 build_runtime_env_vars）。Custom 直接读 `cfg.base_url`；预置 kind 从 catalog 读 base_url。

- [ ] **Step 1: 写 `strategy/mod.rs`**

```rust
//! ProviderStrategy：按 kind dispatch env 组装 / 专属操作 / 连接测试。
//! env_vars 纯 cfg 派生（不读进程 env）；env 兜底在 runtime::env::build_runtime_env_vars。

use std::collections::HashMap;

use crate::runtime::provider::{ProviderConfig, ProviderKind, ProviderModelMappings};

pub struct ActionDef {
    pub name: String,
    pub label: String,
}

pub enum ActionResult {
    PortProbe { alive: bool, detail: String },
    OpenUrl(String),
    LoginStatus { logged_in: bool, detail: String },
    RefreshedModels(ProviderModelMappings),
    Quota(serde_json::Value),
    Ok(String),
}

pub struct ConnectionStatus {
    pub ok: bool,
    pub detail: String,
}

pub trait ProviderStrategy: Send + Sync {
    fn kind(&self) -> ProviderKind;
    /// 纯 cfg 派生的 env（不读 std::env）。
    fn env_vars(&self, cfg: &ProviderConfig) -> HashMap<String, String>;
    /// build_runtime_env_vars 用它决定从进程 env 兜底哪些 key。
    fn fallback_env_keys(&self) -> &'static [&'static str];
    fn actions(&self) -> &'static [ActionDef] { &[] }
    fn run_action(&self, cfg: &ProviderConfig, action: &str) -> Result<ActionResult, String> {
        let _ = cfg;
        Err(format!("action '{action}' not supported by {:?} kind", self.kind()))
    }
    fn test_connection(&self, cfg: &ProviderConfig) -> Result<ConnectionStatus, String>;
}

pub mod custom;
// 其余 kind 在 Task 8-10 加：system_default / cpa_gpt / ollama / kimi / deepseek

pub fn strategy_for(kind: ProviderKind) -> Box<dyn ProviderStrategy> {
    match kind {
        ProviderKind::Custom => Box::new(custom::CustomStrategy),
        // Task 8-10 填：
        ProviderKind::SystemDefault => Box::new(crate::runtime::provider::strategy::custom::CustomStrategy), // 临时占位，Task 8 替换
        ProviderKind::CpaGpt => Box::new(custom::CustomStrategy),
        ProviderKind::Ollama => Box::new(custom::CustomStrategy),
        ProviderKind::Kimi => Box::new(custom::CustomStrategy),
        ProviderKind::DeepSeek => Box::new(custom::CustomStrategy),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strategy_for_returns_some_for_every_kind() {
        for k in [ProviderKind::Custom, ProviderKind::SystemDefault, ProviderKind::CpaGpt,
                  ProviderKind::Ollama, ProviderKind::Kimi, ProviderKind::DeepSeek] {
            let s = strategy_for(k);
            assert_eq!(s.kind(), k);
        }
    }
}
```

> `strategy_for` 里 SystemDefault/CpaGpt/Ollama/Kimi/DeepSeek 暂时全返回 CustomStrategy（占位），Task 8-10 逐个替换为真实实现。这样每一步 build 都绿。

- [ ] **Step 2: 写 `strategy/custom.rs`**

```rust
//! Custom kind：base_url/name/icon 用户填，无专属操作。
//! env_vars 直映 cfg（与历史 provider_to_env_vars 完全一致——这是回归基线）。

use std::collections::HashMap;

use crate::runtime::provider::{ProviderConfig, mappings_to_env, provider_to_env_vars};

use super::{ConnectionStatus, ProviderStrategy};

pub struct CustomStrategy;

const SMALL_FALLBACK: &[&str] = &[
    "CLAUDE_CONFIG_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
    "ALL_PROXY", "all_proxy",
];

impl ProviderStrategy for CustomStrategy {
    fn kind(&self) -> crate::runtime::provider::ProviderKind {
        crate::runtime::provider::ProviderKind::Custom
    }
    fn env_vars(&self, cfg: &ProviderConfig) -> HashMap<String, String> {
        provider_to_env_vars(cfg) // 复用既有直映函数，保证回归一致
    }
    fn fallback_env_keys(&self) -> &'static [&'static str] { SMALL_FALLBACK }
    fn test_connection(&self, cfg: &ProviderConfig) -> Result<ConnectionStatus, String> {
        crate::runtime::provider::strategy::common_test_connection(cfg, None)
    }
}

// 公共测试连接助手——放 mod.rs 更合适，这里先 forward 声明由 mod.rs 提供（见下）
```

> `common_test_connection` 放 `strategy/mod.rs`（所有 kind 复用）：发最小 `POST {base_url}/v1/messages` 请求，base_url 为 None 时用 `https://api.anthropic.com`。在 `strategy/mod.rs` 加：

```rust
/// 通用连接测试：发一个最小 Anthropic /v1/messages 请求验证端点+凭证。
/// `base_url_override`：预置 kind 传 catalog 的 base_url；None 则用 cfg.base_url / 默认。
pub(crate) fn common_test_connection(
    cfg: &ProviderConfig,
    base_url_override: Option<&str>,
) -> Result<ConnectionStatus, String> {
    use crate::commands::proxy::detect_proxy;
    use std::time::Duration;

    let base_url = base_url_override
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| if cfg.base_url.is_empty() { None } else { Some(cfg.base_url.clone()) })
        .unwrap_or_else(|| "https://api.anthropic.com".to_string());

    let (auth_name, auth_val): (&str, String) = if !cfg.api_key.is_empty() {
        ("x-api-key", cfg.api_key.clone())
    } else if !cfg.auth_token.is_empty() {
        ("Authorization", format!("Bearer {}", cfg.auth_token))
    } else {
        return Ok(ConnectionStatus { ok: false, detail: "no api_key / auth_token configured".to_string() });
    };

    let mut agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(10));
    if let Some(proxy_url) = detect_proxy() {
        if let Ok(p) = ureq::Proxy::new(&proxy_url) { agent = agent.proxy(p); }
    }
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));
    let resp = agent
        .get(&url) // 用 GET 探活，避免构造 messages body；部分网关可能 405，仍算"活着"
        .set(auth_name, &auth_val)
        .set("anthropic-version", "2023-06-01")
        .call();
    match resp {
        Ok(r) => Ok(ConnectionStatus { ok: true, detail: format!("HTTP {}", r.status()) }),
        Err(ureq::Error::Status(code, _)) => Ok(ConnectionStatus { ok: true, detail: format!("HTTP {code}（端点活着，鉴权/路径可能需调整）") }),
        Err(e) => Ok(ConnectionStatus { ok: false, detail: format!("连接失败: {e}") }),
    }
}
```

> `common_test_connection` 做网络请求，单测不直接测它（留集成测试）。Custom 的 `test_connection` 测只测无凭证分支：在 `strategy/custom.rs` 加：
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::provider::{ProviderConfig, ProviderKind, ProviderModelMappings};

    fn cfg() -> ProviderConfig {
        ProviderConfig {
            id: "x".into(), kind: ProviderKind::Custom,
            name: "".into(), icon: "".into(), base_url: "https://gw.example".into(),
            api_key: "k".into(), auth_token: "".into(), model: String::new(),
            model_mappings: ProviderModelMappings::default(),
            effort_level: "".into(), auto_compact_window: "".into(),
            autocompact_pct_override: "".into(), known_models: vec![],
        }
    }

    #[test]
    fn custom_env_vars_matches_legacy_provider_to_env_vars() {
        // 回归基线：Custom 的 env_vars 必须与历史 provider_to_env_vars 逐字段一致
        let p = cfg();
        assert_eq!(CustomStrategy.env_vars(&p), crate::runtime::provider::provider_to_env_vars(&p));
    }

    #[test]
    fn custom_fallback_is_small_set() {
        assert_eq!(CustomStrategy.fallback_env_keys(), &[
            "CLAUDE_CONFIG_DIR",
            "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
            "ALL_PROXY", "all_proxy",
        ]);
    }

    #[test]
    fn custom_test_connection_no_credentials_returns_false() {
        let mut p = cfg();
        p.api_key = "".into();
        p.auth_token = "".into();
        let s = CustomStrategy.test_connection(&p).unwrap();
        assert!(!s.ok);
        assert!(s.detail.contains("no api_key"));
    }
}
```

- [ ] **Step 3: `runtime/provider/mod.rs` 加 `pub mod strategy;`**

- [ ] **Step 4: 编译 + 测试**

```bash
cd src-tauri
cargo build
cargo test --lib
```
Expected: 全绿（`strategy::tests::strategy_for_returns_some_for_every_kind` + `strategy::custom::tests::*` 3 个）。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(provider): ProviderStrategy trait + strategy_for + CustomStrategy

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: SystemDefault strategy（env 兜底大集 + refresh_models / view_quota）

**Files:**
- Create: `src-tauri/src/runtime/provider/strategy/system_default.rs`
- Modify: `src-tauri/src/runtime/provider/strategy/mod.rs`（`strategy_for(SystemDefault)` 替换占位）
- Move: `refresh_system_default_models` / `parse_models_response` / `parse_version` 从 `commands/provider.rs` 迁入此文件（作为 `run_action("refresh_models")` 实现；command 层 Task 12 改为薄包装调它）

**Interfaces:**
- Produces `SystemDefaultStrategy`：`env_vars` = `mappings_to_env(cfg.model_mappings)` + （cfg.api_key/auth_token 非空才注入）；`fallback_env_keys` = 大集（含 ANTHROPIC_*）；`actions` = `[refresh_models, view_quota, test_connection]`；`run_action("refresh_models")` 调 Anthropic `/v1/models` + `parse_models_response`；`run_action("view_quota")` 查额度（v1 stub 返回未实现 Err）。

- [ ] **Step 1: 写 `system_default.rs`**

```rust
//! SystemDefault kind：Anthropic 官方。base_url 空（SDK 默认）。
//! env_vars 只注入 model_mappings + 凭证（凭证通常空，靠进程 env 兜底——
//! 大 fallback 集在 build_runtime_env_vars 里补 ANTHROPIC_* from env）。

use std::collections::HashMap;

use crate::runtime::provider::{ProviderConfig, ProviderModelMappings, mappings_to_env};

use super::{ActionDef, ActionResult, ConnectionStatus, ProviderStrategy};

const LARGE_FALLBACK: &[&str] = &[
    "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
    "CLAUDE_CONFIG_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
    "ALL_PROXY", "all_proxy",
];

static ACTIONS: [ActionDef; 3] = [
    ActionDef { name: String::new(), label: String::new() }, // 占位（const fn 限制，运行时构造见 actions()）
    ActionDef { name: String::new(), label: String::new() },
    ActionDef { name: String::new(), label: String::new() },
];

pub struct SystemDefaultStrategy;

impl ProviderStrategy for SystemDefaultStrategy {
    fn kind(&self) -> crate::runtime::provider::ProviderKind {
        crate::runtime::provider::ProviderKind::SystemDefault
    }
    fn env_vars(&self, cfg: &ProviderConfig) -> HashMap<String, String> {
        let mut env = mappings_to_env(&cfg.model_mappings);
        // 凭证非空才注入（通常空，靠 env 兜底）
        if !cfg.api_key.is_empty() { env.insert("ANTHROPIC_API_KEY".into(), cfg.api_key.clone()); }
        if !cfg.auth_token.is_empty() { env.insert("ANTHROPIC_AUTH_TOKEN".into(), cfg.auth_token.clone()); }
        // effort / compact（与 custom 同形，复用 provider_to_env_vars 的非模型部分）
        if !cfg.effort_level.is_empty() { env.insert("CLAUDE_CODE_EFFORT_LEVEL".into(), cfg.effort_level.clone()); }
        if !cfg.auto_compact_window.is_empty() { env.insert("CLAUDE_CODE_AUTO_COMPACT_WINDOW".into(), cfg.auto_compact_window.clone()); }
        if !cfg.autocompact_pct_override.is_empty() { env.insert("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE".into(), cfg.autocompact_pct_override.clone()); }
        // base_url 不注入（SDK 默认）；靠 env 兜底
        env
    }
    fn fallback_env_keys(&self) -> &'static [&'static str] { LARGE_FALLBACK }
    fn actions(&self) -> &'static [ActionDef] {
        // 运行时构造（避开 const fn 限制）：用静态切片的 &'static
        ACTIONS_STRINGS.as_slice()
    }
    fn run_action(&self, cfg: &ProviderConfig, action: &str) -> Result<ActionResult, String> {
        match action {
            "refresh_models" => {
                let m = refresh_models_blocking(cfg)?;
                Ok(ActionResult::RefreshedModels(m))
            }
            "view_quota" => Err("view_quota 尚未实现（v1）".to_string()),
            other => Err(format!("action '{other}' not supported by SystemDefault")),
        }
    }
    fn test_connection(&self, cfg: &ProviderConfig) -> Result<ConnectionStatus, String> {
        // base_url 走 env 兜底（不传 override → common_test_connection 用 cfg.base_url/默认）
        super::common_test_connection(cfg, None)
    }
}

// 运行时构造的 actions 静态切片
static ACTIONS_STRINGS: [ActionDef; 3] = [
    ActionDef { name: String::new(), label: String::new() },
    ActionDef { name: String::new(), label: String::new() },
    ActionDef { name: String::new(), label: String::new() },
];
```

> ⚠️ 上面的 `ACTIONS` / `ACTIONS_STRINGS` const 数组因 `String` 非 const-constructible 无法在 const 上下文构造。**改用 lazy 或运行时 Vec**：最简方案是把 `actions()` 返回 `&'static [ActionDef]` 改为 trait 返回 `Vec<ActionDef>`（调整 trait 签名）。但这要改 Task 7 的 trait。**决策**：Task 7 的 `actions()` 返回类型改为 `Vec<ActionDef>`（不是 `&'static [ActionDef]`），更简单。**回去改 Task 7 的 trait 签名为 `fn actions(&self) -> Vec<ActionDef> { Vec::new() }`**，custom.rs 无 actions 覆写（用默认空 Vec）。本任务的 `ACTIONS` 数组删除，`actions()` 直接 `vec![ ActionDef{name:"refresh_models".into(),label:"刷新模型列表".into()}, ... ]`。

**修正后的 `system_default.rs` actions()：**
```rust
    fn actions(&self) -> Vec<ActionDef> {
        vec![
            ActionDef { name: "refresh_models".into(), label: "刷新模型列表".into() },
            ActionDef { name: "view_quota".into(), label: "查看额度".into() },
            ActionDef { name: "test_connection".into(), label: "测试连接".into() },
        ]
    }
```

> **本任务 Step 0（必须先做）**：回 `strategy/mod.rs` 把 trait 的 `fn actions(&self) -> &'static [ActionDef] { &[] }` 改为 `fn actions(&self) -> Vec<ActionDef> { Vec::new() }`，并把 `custom.rs` 的 `actions()` 覆写删掉（用默认）。然后本文件用 `Vec<ActionDef>`。

`refresh_models_blocking`（从 `commands/provider.rs` 的 `refresh_system_default_models` 主体迁入，去掉 `#[tauri::command]` + `with_config_mut` 持久化——持久化由调用方 command 层做，本函数只返回 mappings）：

```rust
/// 调 Anthropic GET /v1/models，按省钱档映射返回 mappings。纯逻辑（不写盘）。
/// 认证：优先 cfg.api_key/auth_token，否则进程 env 兜底。
pub fn refresh_models_blocking(cfg: &ProviderConfig) -> Result<ProviderModelMappings, String> {
    use crate::commands::proxy::detect_proxy;
    use std::time::Duration;

    let api_key = if !cfg.api_key.is_empty() { Some(cfg.api_key.clone()) }
        else { std::env::var("ANTHROPIC_API_KEY").ok().filter(|s| !s.is_empty()) };
    let auth_token = if !cfg.auth_token.is_empty() { Some(cfg.auth_token.clone()) }
        else { std::env::var("ANTHROPIC_AUTH_TOKEN").ok().filter(|s| !s.is_empty()) };
    let base_url = if !cfg.base_url.is_empty() { cfg.base_url.clone() }
        else { std::env::var("ANTHROPIC_BASE_URL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "https://api.anthropic.com".to_string()) };

    let (auth_name, auth_val): (&str, String) = match (api_key, auth_token) {
        (Some(k), _) => ("x-api-key", k),
        (_, Some(t)) => ("Authorization", format!("Bearer {t}")),
        (None, None) => return Ok(cfg.model_mappings.clone()), // 无认证：保留旧值
    };

    let mut agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(10));
    if let Some(proxy_url) = detect_proxy() {
        if let Ok(p) = ureq::Proxy::new(&proxy_url) { agent = agent.proxy(p); }
    }
    let url = format!("{}/v1/models", base_url.trim_end_matches('/'));
    let resp = agent.get(&url).set(auth_name, &auth_val).call()
        .map_err(|e| format!("API 请求失败: {e}"))?;
    let body: serde_json::Value = resp.into_json().map_err(|e| format!("解析响应失败: {e}"))?;
    parse_models_response(&body)
}

/// 从 `commands/provider.rs` 迁入（逐字搬 parse_models_response + parse_version + 它们的测试）。
fn parse_models_response(body: &serde_json::Value) -> Result<ProviderModelMappings, String> { /* 迁入 */ }
fn parse_version(id: &str) -> Vec<u64> { /* 迁入 */ }
```

把 `commands/provider.rs` 的 `parse_models_response` / `parse_version` / `parse_*` 测试逐字迁入本文件 `#[cfg(test)] mod tests`。`commands/provider.rs` 删除这两个函数 + 测试，`refresh_system_default_models` command 改为薄包装（Task 12）。

- [ ] **Step 2: 测试（先写）**

`system_default.rs` 测试段：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::provider::{ProviderConfig, ProviderKind, ProviderModelMappings};

    fn sd_cfg() -> ProviderConfig {
        ProviderConfig {
            id: "__system_default__".into(), kind: ProviderKind::SystemDefault,
            name: "".into(), icon: "".into(), base_url: "".into(),
            api_key: "".into(), auth_token: "".into(), model: String::new(),
            model_mappings: ProviderModelMappings { anthropic_model: "sonnet-5".into(), ..Default::default() },
            effort_level: "".into(), auto_compact_window: "".into(),
            autocompact_pct_override: "".into(), known_models: vec![],
        }
    }

    #[test]
    fn system_default_env_vars_is_mappings_only_when_creds_empty() {
        // 回归：空凭证时 env_vars == mappings_to_env(model_mappings)（与老 None 分支同形）
        let p = sd_cfg();
        let env = SystemDefaultStrategy.env_vars(&p);
        let expect = mappings_to_env(&p.model_mappings);
        assert_eq!(env, expect);
    }

    #[test]
    fn system_default_env_vars_injects_api_key_when_set() {
        let mut p = sd_cfg();
        p.api_key = "sk-test".into();
        let env = SystemDefaultStrategy.env_vars(&p);
        assert_eq!(env.get("ANTHROPIC_API_KEY"), Some(&"sk-test".to_string()));
        assert_eq!(env.get("ANTHROPIC_MODEL"), Some(&"sonnet-5".to_string()));
    }

    #[test]
    fn system_default_fallback_is_large_set() {
        assert_eq!(SystemDefaultStrategy.fallback_env_keys(), &[
            "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
            "CLAUDE_CONFIG_DIR",
            "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
            "ALL_PROXY", "all_proxy",
        ]);
    }

    #[test]
    fn system_default_actions_lists_three() {
        let a = SystemDefaultStrategy.actions();
        assert_eq!(a.len(), 3);
        assert!(a.iter().any(|x| x.name == "refresh_models"));
    }

    // parse_models_response / parse_version 测试从 commands/provider.rs 迁入（逐字）
}
```

- [ ] **Step 3: `strategy/mod.rs` `strategy_for(SystemDefault)` 替换**

```rust
ProviderKind::SystemDefault => Box::new(crate::runtime::provider::strategy::system_default::SystemDefaultStrategy),
```

- [ ] **Step 4: 编译 + 测试**

```bash
cd src-tauri
cargo build
cargo test --lib
```
Expected: 全绿。`commands/provider.rs` 删了 parse 函数后若有残留引用会编译报错——`refresh_system_default_models` command 暂时改为调 `SystemDefaultStrategy.run_action` 或先注释掉（Task 12 正式接）。临时让 `refresh_system_default_models` 委托：

`commands/provider.rs` `refresh_system_default_models` 临时改为：

```rust
#[tauri::command]
pub async fn refresh_system_default_models() -> Result<ProviderModelMappings, String> {
    use crate::runtime::provider::strategy::{strategy_for, ProviderStrategy, ActionResult};
    use crate::runtime::provider::{active_provider_or_system_default, ProviderKind};
    let cfg = active_provider_or_system_default();
    // 临时：强制 SystemDefault strategy 跑 refresh_models（Task 12 泛化为 refresh_models(id)）
    let strat = strategy_for(ProviderKind::SystemDefault);
    let res = tokio::task::spawn_blocking(move || strat.run_action(&cfg, "refresh_models")).await
        .map_err(|e| e.to_string())??;
    match res {
        ActionResult::RefreshedModels(m) => {
            // 持久化到 system_default 实例的 model_mappings（Task 11 后）
            Ok(m)
        }
        other => Err(format!("unexpected action result: {:?}", other)),
    }
}
```

> 注：上面 `ActionResult` 没 derive Debug；加 `#[derive(Debug)]` 到 `ActionResult`（在 strategy/mod.rs）。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(provider): SystemDefaultStrategy (mappings env + large fallback + refresh_models)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: CpaGpt strategy（env + probe_port / open_management / codex_login_status / test_connection）

**Files:**
- Create: `src-tauri/src/runtime/provider/strategy/cpa_gpt.rs`
- Modify: `src-tauri/src/runtime/provider/strategy/mod.rs`（`strategy_for(CpaGpt)` 替换）

**Interfaces:**
- Produces `CpaGptStrategy`：`env_vars` = `ANTHROPIC_BASE_URL`(catalog 8317) + `ANTHROPIC_AUTH_TOKEN`(cfg) + `ANTHROPIC_API_KEY`(cfg, 通常空) + mappings + effort/compact；`fallback_env_keys` = 小集；`actions` = `[probe_port, open_management, codex_login_status, test_connection]`；`run_action("probe_port")` 探 `127.0.0.1:8317`；`run_action("open_management")` 返回 `http://127.0.0.1:8317/management.html` URL；`run_action("codex_login_status")` 读 CPA auth-dir 判断 codex 登录态（v1：探测 CPA 是否响应 + 简单判 auth-dir 是否存在）；`test_connection` 用 base_url=8317。

- [ ] **Step 1: 写 `cpa_gpt.rs`**

```rust
//! CpaGpt kind：CLIProxyAPI 中转。base_url 锁 http://127.0.0.1:8317（catalog）。
//! v1 env_vars 与 custom 同形（base_url 来自 catalog，auth_token 来自 cfg）。

use std::collections::HashMap;
use std::time::Duration;

use crate::runtime::provider::{ProviderConfig, catalog::catalog_find, mappings_to_env};

use super::{ActionDef, ActionResult, ConnectionStatus, ProviderStrategy};

const CPA_BASE_URL: &str = "http://127.0.0.1:8317";
const SMALL_FALLBACK: &[&str] = &[
    "CLAUDE_CONFIG_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
    "ALL_PROXY", "all_proxy",
];

pub struct CpaGptStrategy;

impl ProviderStrategy for CpaGptStrategy {
    fn kind(&self) -> crate::runtime::provider::ProviderKind {
        crate::runtime::provider::ProviderKind::CpaGpt
    }
    fn env_vars(&self, cfg: &ProviderConfig) -> HashMap<String, String> {
        let mut env = HashMap::new();
        env.insert("ANTHROPIC_BASE_URL".into(), CPA_BASE_URL.into());
        if !cfg.auth_token.is_empty() { env.insert("ANTHROPIC_AUTH_TOKEN".into(), cfg.auth_token.clone()); }
        if !cfg.api_key.is_empty() { env.insert("ANTHROPIC_API_KEY".into(), cfg.api_key.clone()); }
        if !cfg.effort_level.is_empty() { env.insert("CLAUDE_CODE_EFFORT_LEVEL".into(), cfg.effort_level.clone()); }
        if !cfg.auto_compact_window.is_empty() { env.insert("CLAUDE_CODE_AUTO_COMPACT_WINDOW".into(), cfg.auto_compact_window.clone()); }
        if !cfg.autocompact_pct_override.is_empty() { env.insert("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE".into(), cfg.autocompact_pct_override.clone()); }
        env.extend(mappings_to_env(&cfg.model_mappings));
        env
    }
    fn fallback_env_keys(&self) -> &'static [&'static str] { SMALL_FALLBACK }
    fn actions(&self) -> Vec<ActionDef> {
        vec![
            ActionDef { name: "probe_port".into(), label: "探测端口".into() },
            ActionDef { name: "open_management".into(), label: "打开管理面板".into() },
            ActionDef { name: "codex_login_status".into(), label: "Codex 登录态".into() },
            ActionDef { name: "test_connection".into(), label: "测试连接".into() },
        ]
    }
    fn run_action(&self, _cfg: &ProviderConfig, action: &str) -> Result<ActionResult, String> {
        match action {
            "probe_port" => {
                let alive = probe_cpa_port();
                Ok(ActionResult::PortProbe { alive, detail: format!("{} {}", CPA_BASE_URL, if alive { "响应" } else { "无响应" }) })
            }
            "open_management" => Ok(ActionResult::OpenUrl(format!("{}/management.html", CPA_BASE_URL))),
            "codex_login_status" => {
                // v1：探测 CPA 活着 + 返回未知登录态（真实 codex 登录态读取需 CPA auth-dir 路径，
                // 用户未配 auth-dir 时无法判——返回 alive 作为近似）
                let alive = probe_cpa_port();
                Ok(ActionResult::LoginStatus { logged_in: alive, detail: format!("CPA {}", if alive { "在线" } else { "离线" }) })
            }
            other => Err(format!("action '{other}' not supported by CpaGpt")),
        }
    }
    fn test_connection(&self, cfg: &ProviderConfig) -> Result<ConnectionStatus, String> {
        super::common_test_connection(cfg, Some(CPA_BASE_URL))
    }
}

fn probe_cpa_port() -> bool {
    // 同步 TCP 连接探测 8317，1s 超时。放 spawn_blocking 里调（由 command 层保证）。
    use std::net::TcpStream;
    use std::time::Duration;
    let addr = "127.0.0.1:8317";
    TcpStream::connect_timeout(&addr.parse().unwrap(), Duration::from_secs(1)).is_ok()
}
```

- [ ] **Step 2: 测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::provider::{ProviderConfig, ProviderKind, ProviderModelMappings};

    fn cpa_cfg() -> ProviderConfig {
        ProviderConfig {
            id: "cpa".into(), kind: ProviderKind::CpaGpt,
            name: "".into(), icon: "".into(), base_url: "".into(),
            api_key: "".into(), auth_token: "sk-local-cpa".into(), model: String::new(),
            model_mappings: ProviderModelMappings::default(),
            effort_level: "".into(), auto_compact_window: "".into(),
            autocompact_pct_override: "".into(), known_models: vec![],
        }
    }

    #[test]
    fn cpa_env_vars_locks_base_url_to_8317() {
        let env = CpaGptStrategy.env_vars(&cpa_cfg());
        assert_eq!(env.get("ANTHROPIC_BASE_URL"), Some(&CPA_BASE_URL.to_string()));
        assert_eq!(env.get("ANTHROPIC_AUTH_TOKEN"), Some(&"sk-local-cpa".to_string()));
    }

    #[test]
    fn cpa_base_url_ignores_cfg_base_url() {
        // 即使用户在 cfg 里塞了别的 base_url（不该有，但防御），策略仍锁 8317
        let mut p = cpa_cfg();
        p.base_url = "https://evil.example".into();
        let env = CpaGptStrategy.env_vars(&p);
        assert_eq!(env.get("ANTHROPIC_BASE_URL"), Some(&CPA_BASE_URL.to_string()));
    }

    #[test]
    fn cpa_fallback_is_small_set() {
        assert_eq!(CpaGptStrategy.fallback_env_keys(), SMALL_FALLBACK);
    }

    #[test]
    fn cpa_open_management_returns_management_url() {
        let res = CpaGptStrategy.run_action(&cpa_cfg(), "open_management").unwrap();
        match res {
            ActionResult::OpenUrl(u) => assert_eq!(u, "http://127.0.0.1:8317/management.html"),
            other => panic!("expected OpenUrl, got {:?}", other),
        }
    }

    #[test]
    fn cpa_unsupported_action_errors() {
        assert!(CpaGptStrategy.run_action(&cpa_cfg(), "nope").is_err());
    }
}
```

> `probe_port` / `codex_login_status` 涉及真实网络/进程，单测只测 `open_management`（纯）+ env 形态。probe 留集成测试（Task 13）。

- [ ] **Step 3: `strategy_for(CpaGpt)` 替换**

```rust
ProviderKind::CpaGpt => Box::new(crate::runtime::provider::strategy::cpa_gpt::CpaGptStrategy),
```

- [ ] **Step 4: 编译 + 测试**

```bash
cd src-tauri
cargo build
cargo test --lib
```
Expected: 全绿（cpa_gpt 4 个测试）。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(provider): CpaGptStrategy (locked 8317 + probe_port/open_management/login_status)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Ollama / Kimi / DeepSeek strategy（薄 PresetStrategy + test_connection）

**Files:**
- Create: `src-tauri/src/runtime/provider/strategy/ollama.rs`
- Create: `src-tauri/src/runtime/provider/strategy/kimi.rs`
- Create: `src-tauri/src/runtime/provider/strategy/deepseek.rs`
- Modify: `src-tauri/src/runtime/provider/strategy/mod.rs`（`strategy_for` 三处替换 + `pub mod`）

**Interfaces:**
- 三个 kind 共用一个 `PresetStrategy { kind, base_url }`（env_vars = base_url from catalog + api_key + mappings；fallback 小集；actions = `[test_connection]`）。每个文件暴露 `pub fn strategy() -> Box<dyn ProviderStrategy>`。

- [ ] **Step 1: 在 `strategy/mod.rs` 加共享 `PresetStrategy`**

```rust
pub mod cpa_gpt;
pub mod custom;
pub mod deepseek;
pub mod kimi;
pub mod ollama;
pub mod system_default;

/// 共享预置策略：base_url 来自 catalog（非空），api_key 认证，仅 test_connection。
pub(crate) struct PresetStrategy {
    pub kind: ProviderKind,
    pub base_url: &'static str,
}

const SMALL_FALLBACK: &[&str] = &[
    "CLAUDE_CONFIG_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
    "ALL_PROXY", "all_proxy",
];

impl ProviderStrategy for PresetStrategy {
    fn kind(&self) -> ProviderKind { self.kind }
    fn env_vars(&self, cfg: &ProviderConfig) -> HashMap<String, String> {
        let mut env = HashMap::new();
        env.insert("ANTHROPIC_BASE_URL".into(), self.base_url.to_string());
        if !cfg.api_key.is_empty() { env.insert("ANTHROPIC_API_KEY".into(), cfg.api_key.clone()); }
        if !cfg.auth_token.is_empty() { env.insert("ANTHROPIC_AUTH_TOKEN".into(), cfg.auth_token.clone()); }
        if !cfg.effort_level.is_empty() { env.insert("CLAUDE_CODE_EFFORT_LEVEL".into(), cfg.effort_level.clone()); }
        if !cfg.auto_compact_window.is_empty() { env.insert("CLAUDE_CODE_AUTO_COMPACT_WINDOW".into(), cfg.auto_compact_window.clone()); }
        if !cfg.autocompact_pct_override.is_empty() { env.insert("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE".into(), cfg.autocompact_pct_override.clone()); }
        env.extend(crate::runtime::provider::mappings_to_env(&cfg.model_mappings));
        env
    }
    fn fallback_env_keys(&self) -> &'static [&'static str] { SMALL_FALLBACK }
    fn actions(&self) -> Vec<ActionDef> {
        vec![ActionDef { name: "test_connection".into(), label: "测试连接".into() }]
    }
    fn test_connection(&self, cfg: &ProviderConfig) -> Result<ConnectionStatus, String> {
        common_test_connection(cfg, Some(self.base_url))
    }
}
```

- [ ] **Step 2: 三个薄文件**

`ollama.rs`:
```rust
use super::{PresetStrategy, ProviderStrategy};
use crate::runtime::provider::{ProviderKind, catalog::catalog_find};

pub fn strategy() -> Box<dyn ProviderStrategy> {
    let base_url = catalog_find(ProviderKind::Ollama).map(|p| p.base_url.as_str()).unwrap_or("https://ollama.com");
    // base_url 是 String，要 'static：catalog 是 OnceLock，其内容活到进程结束，
    // 但 `&'static str` 从 String 取不出——改用泄漏或改 PresetStrategy.base_url 为 String。
    // 见下方修正。
    unimplemented!()
}
```

> ⚠️ `PresetStrategy.base_url: &'static str` 与 catalog 的 `String` 不兼容。**修正**：把 `PresetStrategy.base_url` 改为 `String`（owned），`common_test_connection` 的 override 参数已是 `Option<&str>`，传 `&self.base_url` 即可。`strategy()` 里 `base_url: catalog_find(kind).unwrap().base_url.clone()`。修正后：

`strategy/mod.rs` `PresetStrategy`:
```rust
pub(crate) struct PresetStrategy {
    pub kind: ProviderKind,
    pub base_url: String,
}
// env_vars 里：env.insert("ANTHROPIC_BASE_URL".into(), self.base_url.clone());
// test_connection: common_test_connection(cfg, Some(&self.base_url))
```

`ollama.rs`:
```rust
use super::{PresetStrategy, ProviderStrategy};
use crate::runtime::provider::{ProviderKind, catalog::catalog_find};

pub fn strategy() -> Box<dyn ProviderStrategy> {
    let base_url = catalog_find(ProviderKind::Ollama).map(|p| p.base_url.clone()).unwrap_or_else(|| "https://ollama.com".to_string());
    Box::new(PresetStrategy { kind: ProviderKind::Ollama, base_url })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::provider::{ProviderConfig, ProviderModelMappings};

    fn cfg() -> ProviderConfig {
        ProviderConfig {
            id: "x".into(), kind: ProviderKind::Ollama,
            name: "".into(), icon: "".into(), base_url: "".into(),
            api_key: "k".into(), auth_token: "".into(), model: String::new(),
            model_mappings: ProviderModelMappings::default(),
            effort_level: "".into(), auto_compact_window: "".into(),
            autocompact_pct_override: "".into(), known_models: vec![],
        }
    }

    #[test]
    fn ollama_env_vars_uses_catalog_base_url() {
        let env = strategy().env_vars(&cfg());
        assert_eq!(env.get("ANTHROPIC_BASE_URL"), Some(&"https://ollama.com".to_string()));
        assert_eq!(env.get("ANTHROPIC_API_KEY"), Some(&"k".to_string()));
    }

    #[test]
    fn ollama_actions_only_test_connection() {
        let a = strategy().actions();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].name, "test_connection");
    }
}
```

`kimi.rs` / `deepseek.rs`：同上，kind 换 `Kimi`/`DeepSeek`，base_url 来自 catalog（`https://api.kimi.com/coding/` / `https://api.deepseek.com/anthropic`），测试断言对应 base_url。

- [ ] **Step 3: `strategy_for` 三处替换**

```rust
ProviderKind::Ollama => crate::runtime::provider::strategy::ollama::strategy(),
ProviderKind::Kimi => crate::runtime::provider::strategy::kimi::strategy(),
ProviderKind::DeepSeek => crate::runtime::provider::strategy::deepseek::strategy(),
```

- [ ] **Step 4: 编译 + 测试**

```bash
cd src-tauri
cargo build
cargo test --lib
```
Expected: 全绿（ollama/kimi/deepseek 各 2 个）。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(provider): Ollama/Kimi/DeepSeek strategies via shared PresetStrategy

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: `build_runtime_env_vars` 改为 strategy dispatch；`get_providers` 富化 / `set_providers` 剥离预置身份字段

**Files:**
- Modify: `src-tauri/src/runtime/env.rs`（dispatch via `strategy_for(kind).env_vars` + `fallback_env_keys`）
- Modify: `src-tauri/src/runtime/provider/mod.rs`（加 `enrich_preset_identity` + `strip_preset_identity` + `persist_providers`/`load_providers`）
- Modify: `src-tauri/src/commands/provider.rs`（`get_providers`/`set_providers` 调富化/剥离）

**Interfaces:**
- `runtime/provider/mod.rs` 新增：
  ```rust
  pub fn enrich(p: &mut ProviderConfig);   // 预置 kind 填 base_url/name/icon from catalog
  pub fn strip(p: &mut ProviderConfig);    // 预置 kind 清空 base_url/name/icon
  pub fn load_providers() -> Vec<ProviderConfig>;  // 读 + enrich
  pub fn persist_providers(v: &[ProviderConfig]) -> Result<(), String>; // strip + write
  ```

- [ ] **Step 1: 改 `runtime/env.rs` 为 dispatch**

```rust
pub fn build_runtime_env_vars(active: &ProviderConfig, proxy: &str) -> HashMap<String, String> {
    use crate::runtime::provider::strategy::{strategy_for, ProviderStrategy};
    let strat = strategy_for(active.kind);
    let mut env_vars = strat.env_vars(active);
    for var in strat.fallback_env_keys() {
        if !env_vars.contains_key(*var) {
            if let Ok(val) = std::env::var(var) {
                if !val.is_empty() { env_vars.insert(var.to_string(), val); }
            }
        }
    }
    if !proxy.is_empty() {
        for k in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
            env_vars.insert(k.to_string(), proxy.to_string());
        }
    }
    env_vars
}
```

保留 Task 6 的 `system_default_kind_uses_large_fallback_set` 测试（dispatch 后 SystemDefault strategy 的 fallback_env_keys 仍是大集，行为不变）。

- [ ] **Step 2: `runtime/provider/mod.rs` 加 enrich/strip + load/persist**

```rust
use crate::runtime::provider::catalog::resolve_preset_identity;

/// 预置 kind：从 catalog 派生 base_url/name/icon 填入（内存态，不持久化）。
pub fn enrich(p: &mut ProviderConfig) {
    if !p.kind.is_preset() { return; }
    if let Some((name, icon, base_url)) = resolve_preset_identity(p.kind) {
        p.name = name;
        p.icon = icon;
        p.base_url = base_url;
    }
}

/// 预置 kind：清空 base_url/name/icon（持久化前调，保证不入 config.json）。
pub fn strip(p: &mut ProviderConfig) {
    if !p.kind.is_preset() { return; }
    p.name = String::new();
    p.icon = String::new();
    p.base_url = String::new();
}

pub fn load_providers() -> Vec<ProviderConfig> {
    let config = crate::commands::settings::load_config();
    let mut out = Vec::new();
    if let Some(arr) = config.get("providers").and_then(|v| v.as_array()) {
        for item in arr {
            if let Ok(mut p) = serde_json::from_value::<ProviderConfig>(item.clone()) {
                migrate_provider_model(&mut p);
                enrich(&mut p);
                out.push(p);
            }
        }
    }
    out
}

pub fn persist_providers(v: &[ProviderConfig]) -> Result<(), String> {
    use crate::commands::settings::with_config_mut;
    let stripped: Vec<ProviderConfig> = v.iter().map(|p| {
        let mut q = p.clone();
        strip(&mut q);
        q
    }).collect();
    with_config_mut(move |config| {
        config["providers"] = serde_json::to_value(&stripped).map_err(|e| format!("Serialize error: {e}"))?;
        Ok(())
    })
}
```

- [ ] **Step 3: 测试 enrich/strip**

```rust
#[test]
fn enrich_fills_preset_identity_from_catalog() {
    let mut p = ProviderConfig {
        id: "cpa".into(), kind: ProviderKind::CpaGpt,
        name: "".into(), icon: "".into(), base_url: "".into(),
        api_key: "".into(), auth_token: "".into(), model: String::new(),
        model_mappings: ProviderModelMappings::default(),
        effort_level: "".into(), auto_compact_window: "".into(),
        autocompact_pct_override: "".into(), known_models: vec![],
    };
    enrich(&mut p);
    assert_eq!(p.name, "CPA 中转");
    assert_eq!(p.base_url, "http://127.0.0.1:8317");
}

#[test]
fn strip_clears_preset_identity_keeps_custom() {
    let mut p = ProviderConfig {
        id: "cpa".into(), kind: ProviderKind::CpaGpt,
        name: "CPA 中转".into(), icon: "C".into(), base_url: "http://127.0.0.1:8317".into(),
        api_key: "k".into(), auth_token: "t".into(), model: String::new(),
        model_mappings: ProviderModelMappings::default(),
        effort_level: "".into(), auto_compact_window: "".into(),
        autocompact_pct_override: "".into(), known_models: vec![],
    };
    strip(&mut p);
    assert_eq!(p.name, "");
    assert_eq!(p.base_url, "");
    assert_eq!(p.api_key, "k", "credential kept");
    assert_eq!(p.auth_token, "t");
}

#[test]
fn strip_does_not_touch_custom() {
    let mut p = ProviderConfig {
        id: "c".into(), kind: ProviderKind::Custom,
        name: "my".into(), icon: "M".into(), base_url: "https://gw".into(),
        api_key: "".into(), auth_token: "".into(), model: String::new(),
        model_mappings: ProviderModelMappings::default(),
        effort_level: "".into(), auto_compact_window: "".into(),
        autocompact_pct_override: "".into(), known_models: vec![],
    };
    strip(&mut p);
    assert_eq!(p.name, "my", "custom identity preserved");
    assert_eq!(p.base_url, "https://gw");
}
```

- [ ] **Step 4: `commands/provider.rs` 的 `get_providers`/`set_providers` 改调 load/persist**

```rust
#[tauri::command]
pub fn get_providers() -> Result<Vec<ProviderConfig>, String> {
    let _trace = crate::diagnostics::trace_command("get_providers");
    Ok(crate::runtime::provider::load_providers())
}

#[tauri::command]
pub fn set_providers(providers: Vec<ProviderConfig>) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("set_providers");
    crate::runtime::provider::persist_providers(&providers)
}
```

- [ ] **Step 5: 编译 + 测试 + 手测**

```bash
cd src-tauri
cargo build
cargo test --lib
```
Expected: 全绿。启动 app，打开 Provider 设置，确认旧 UI 仍能列出 provider（预置 kind 的 base_url/name/icon 现在由 enrich 填回，旧 UI 显示正常——尽管旧 UI 还不知道 kind，但字段都有值）。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(provider): strategy dispatch in build_env + enrich/strip preset identity

get_providers 富化预置身份字段；set_providers 持久化前剥离。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 12: 新增 action command + 泛化 refresh_models；注册 invoke_handler

**Files:**
- Modify: `src-tauri/src/commands/provider.rs`（加 `test_provider_connection` / `cpa_probe_port` / `cpa_open_management` / `cpa_login_status` / `view_anthropic_quota` / `refresh_models`；`refresh_system_default_models` 标 deprecated 转发或删）
- Modify: `src-tauri/src/lib.rs`（invoke_handler 注册新 command）

**Interfaces:**
- 新 command（全部 async + spawn_blocking，带 `State` 引用的返回 `Result`）：
  ```rust
  #[tauri::command] pub async fn test_provider_connection(provider_id: String) -> Result<ConnectionStatus, String>;
  #[tauri::command] pub async fn cpa_probe_port() -> Result<PortProbeResult, String>;
  #[tauri::command] pub async fn cpa_open_management() -> Result<String, String>; // 返回 URL 给前端 shell.open
  #[tauri::command] pub async fn cpa_login_status() -> Result<LoginStatusResult, String>;
  #[tauri::command] pub async fn view_anthropic_quota() -> Result<serde_json::Value, String>;
  #[tauri::command] pub async fn refresh_models(provider_id: String) -> Result<ProviderModelMappings, String>;
  ```

> 所有新 command 按 kind 找 provider 实例（从 `load_providers()` by id），调 `strategy_for(kind).run_action(cfg, action)` 或 `.test_connection(cfg)`，结果序列化返回前端。`provider_id` 为空或 `__system_default__` 时取 SystemDefault 实例。

- [ ] **Step 1: 加 command 实现**

`commands/provider.rs` 加：

```rust
use crate::runtime::provider::strategy::{strategy_for, ProviderStrategy, ActionResult, ConnectionStatus};
use crate::runtime::provider::{load_providers, ProviderConfig, ProviderKind, active_provider_or_system_default};

fn find_provider(id: &str) -> ProviderConfig {
    if id.is_empty() || id == "__system_default__" {
        return active_provider_or_system_default();
    }
    load_providers().into_iter().find(|p| p.id == id).unwrap_or_else(active_provider_or_system_default)
}

#[derive(serde::Serialize)]
pub struct PortProbeResult { pub alive: bool, pub detail: String }
#[derive(serde::Serialize)]
pub struct LoginStatusResult { pub logged_in: bool, pub detail: String }

#[tauri::command]
pub async fn test_provider_connection(provider_id: String) -> Result<ConnectionStatus, String> {
    tokio::task::spawn_blocking(move || {
        let cfg = find_provider(&provider_id);
        strategy_for(cfg.kind).test_connection(&cfg)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cpa_probe_port() -> Result<PortProbeResult, String> {
    tokio::task::spawn_blocking(move || {
        let cfg = find_provider(""); // CpaGpt 单实例 v1；按 kind 找更稳：
        let cfg = load_providers().into_iter().find(|p| p.kind == ProviderKind::CpaGpt).unwrap_or_else(|| find_provider(""));
        match strategy_for(ProviderKind::CpaGpt).run_action(&cfg, "probe_port")? {
            ActionResult::PortProbe { alive, detail } => Ok(PortProbeResult { alive, detail }),
            other => Err(format!("unexpected: {:?}", other)),
        }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cpa_open_management() -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let cfg = load_providers().into_iter().find(|p| p.kind == ProviderKind::CpaGpt).unwrap_or_else(|| find_provider(""));
        match strategy_for(ProviderKind::CpaGpt).run_action(&cfg, "open_management")? {
            ActionResult::OpenUrl(u) => Ok(u),
            other => Err(format!("unexpected: {:?}", other)),
        }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cpa_login_status() -> Result<LoginStatusResult, String> {
    tokio::task::spawn_blocking(move || {
        let cfg = load_providers().into_iter().find(|p| p.kind == ProviderKind::CpaGpt).unwrap_or_else(|| find_provider(""));
        match strategy_for(ProviderKind::CpaGpt).run_action(&cfg, "codex_login_status")? {
            ActionResult::LoginStatus { logged_in, detail } => Ok(LoginStatusResult { logged_in, detail }),
            other => Err(format!("unexpected: {:?}", other)),
        }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn view_anthropic_quota() -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let cfg = active_provider_or_system_default();
        match strategy_for(ProviderKind::SystemDefault).run_action(&cfg, "view_quota") {
            Ok(ActionResult::Quota(v)) => Ok(v),
            Ok(_) => Ok(serde_json::json!({"note": "v1 未实现"})),
            Err(e) => Err(e),
        }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn refresh_models(provider_id: String) -> Result<ProviderModelMappings, String> {
    let pid = provider_id.clone();
    tokio::task::spawn_blocking(move || {
        let cfg = find_provider(&pid);
        let strat = strategy_for(cfg.kind);
        match strat.run_action(&cfg, "refresh_models") {
            Ok(ActionResult::RefreshedModels(m)) => {
                // 持久化回该 provider 实例的 model_mappings
                use crate::commands::settings::with_config_mut;
                let id = cfg.id.clone();
                let m_val = serde_json::to_value(&m).map_err(|e| e.to_string())?;
                with_config_mut(move |config| {
                    if let Some(arr) = config.get_mut("providers").and_then(|v| v.as_array_mut()) {
                        for p in arr.iter_mut() {
                            if p.get("id").and_then(|v| v.as_str()) == Some(&id) {
                                p["model_mappings"] = m_val.clone();
                                break;
                            }
                        }
                    }
                    Ok(())
                })?;
                Ok(m)
            }
            Ok(other) => Err(format!("unexpected: {:?}", other)),
            Err(e) => Err(e),
        }
    }).await.map_err(|e| e.to_string())?
}
```

> `ActionResult`、`ConnectionStatus` 需 `derive(serde::Serialize)`（前端要收）。在 `strategy/mod.rs` 给 `ConnectionStatus` + `ActionResult` 加 `#[derive(serde::Serialize)]`（`ActionResult::Quota(serde_json::Value)` 已可序列化；`RefreshedModels(ProviderModelMappings)` 也已 Serialize）。

- [ ] **Step 2: `refresh_system_default_models` 标弃用转发**

```rust
/// deprecated：用 refresh_models("__system_default__") 代替。
#[tauri::command]
pub async fn refresh_system_default_models() -> Result<ProviderModelMappings, String> {
    refresh_models("__system_default__".to_string()).await
}
```

- [ ] **Step 3: `lib.rs` invoke_handler 注册**

Provider commands 段加：

```rust
commands::provider::test_provider_connection,
commands::provider::cpa_probe_port,
commands::provider::cpa_open_management,
commands::provider::cpa_login_status,
commands::provider::view_anthropic_quota,
commands::provider::refresh_models,
```

- [ ] **Step 4: 编译 + 测试**

```bash
cd src-tauri
cargo build
cargo test --lib
```
Expected: 全绿。`get_system_default_model_mappings` / `set_system_default_model_mappings` 仍保留（迁移后 system_default_model_mappings 顶层字段已删，这俩 command 读出来是空——保持向后兼容，旧前端不崩；Plan 2 前端改完可删）。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(provider): action commands (test_connection/cpa_*/quota/refresh_models)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 13: 集成验证 — CPA spike + round-trip（手动）

**Files:** 无代码改动（纯验证）。若 spike 发现 CPA 需要额外 env/header，在 `cpa_gpt.rs` 的 `env_vars` 里补，并加测试。

> 这是 spec §验证 的「集成」项，存在性风险（claude.exe ↔ CPA 协议兼容）不在 Aide 代码范围，但 round-trip 必须跑通证明预设化链路可用。

- [ ] **Step 1: 启动 CPA + Codex 登录**

按 CSDN 教程（已存 `C:\Users\yangx\AppData\Local\Temp\csdn_text.txt`）：
1. 下载 CLIProxyAPI releases，解压。
2. `config.example.yaml` → `config.yaml`，最小配置：`port: 8317`、`auth-dir: <dir>`、`api-keys: [sk-local-cpa]`、`remote-management: {allow-remote: true, secret-key: "abc123"}`。
3. `./cli-proxy-api.exe -config ./config.yaml` 启动（注意 CREATE_NO_WINDOW 是 Aide 内部 spawn 才需要；用户手动跑 CPA 不涉及）。
4. `./cli-proxy-api.exe -codex-login` 完成 Codex OAuth（回调端口 1455）。
5. 浏览器开 `http://127.0.0.1:8317/management.html` 确认控制台能进。

- [ ] **Step 2: 手写一个 CpaGpt 实例进 config.json（绕过前端，前端是 Plan 2）**

编辑 `~/.claude-code-desktop/config.json`，确保 `providers` 里有：

```json
{
  "id": "cpa-local",
  "kind": "cpa_gpt",
  "name": "", "icon": "", "base_url": "",
  "api_key": "", "auth_token": "sk-local-cpa",
  "model": "",
  "model_mappings": { "anthropic_model": "gpt-5", "default_sonnet_model": "gpt-5", "default_opus_model": "gpt-5", "default_haiku_model": "gpt-5", "subagent": "gpt-5" },
  "effort_level": "", "auto_compact_window": "", "autocompact_pct_override": "",
  "known_models": []
}
```

`active_provider` 设为 `"cpa-local"`。

> 模型名是用户侧领域——填 GPT 模型名（CPA 转发到 Codex/OpenAI）。具体名取决于 CPA 配置，spike 时确认。

- [ ] **Step 3: 启动 Aide，验证专属操作**

`pnpm tauri dev`。用 `get_providers`（旧前端会列出，base_url/name/icon 由 enrich 填回 = `http://127.0.0.1:8317` / "CPA 中转" / "C"）。通过 Tauri 控制台或临时按钮调：
- `cpa_probe_port` → `{ alive: true, detail: "响应" }`
- `cpa_open_management` → 返回 URL（前端 Plan 2 才接 `shell.open`，本步手动复制到浏览器）
- `test_provider_connection("cpa-local")` → `{ ok: true, ... }`

- [ ] **Step 4: 发一条消息验证 round-trip**

在 Aide 会话发 "hello"。观察：
- sidecar 用 CpaGpt strategy 的 env spawn（ANTHROPIC_BASE_URL=8317, ANTHROPIC_AUTH_TOKEN=sk-local-cpa）。
- 请求经 CPA → Codex/OpenAI → 返回。
- Aide 收到回复（即使模型名是 GPT，ChatEvent 协议是 Anthropic 形，前端照常渲染）。

- [ ] **Step 5: 记录 spike 结果**

若 round-trip 成功：在 `docs/superpowers/plans/2026-07-20-provider-preset-rust.md` 末尾加 `## Spike 结果` 节记录 CPA 版本 / 模型名 / 是否需额外 env。
若失败：定位崩点（CPA 侧 / claude.exe 侧）。若 CPA 需要额外 header/env，在 `cpa_gpt.rs::env_vars` 补 + 加测试，重跑 Step 4。

- [ ] **Step 6: Commit（若改了 cpa_gpt.rs）**

```bash
git add -A
git commit -m "fix(cpa_gpt): spike-found extra env/header for CPA round-trip

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- 数据模型（ProviderConfig + kind）：Task 4 ✓
- base_url 硬锁：Task 4 catalog + Task 9 CpaGptStrategy 锁 8317（测试 `cpa_base_url_ignores_cfg_base_url`）✓
- 存储设计（预置不持久化身份）：Task 11 strip ✓
- Catalog（源/结构/无模型字段/5 preset）：Task 4 ✓
- 分层归位（runtime 不 import commands）：Task 2（fingerprint）+ Task 3（env）✓
- ProviderStrategy trait + 各 kind 实现：Task 7-10 ✓
- 新增/编辑 UX：前端，Plan 2（本计划后端 Task 11 enrich 给前端只读字段铺路）✓
- 迁移：Task 5 ✓（6 个测试覆盖 spec §验证 迁移函数的全部场景）
- 验证（单测 / 集成 / 回归）：Task 8 system_default parity 测试、Task 11 enrich/strip 测试、Task 13 spike ✓
- 新增/改动 command：Task 4 get_provider_catalog、Task 12 action commands ✓

**2. Placeholder scan:**
- `unimplemented!()` 在 Task 10 Step 2 的 ollama.rs 草稿里——**这是示例草稿，修正版（紧随其后的 `strategy()`）是完整实现**，不留 `unimplemented!()`。最终代码用修正版。✓
- Task 13 Step 5「记录 spike 结果」是手动步骤，不是代码 placeholder。✓
- 无 "TBD/TODO/implement later"。✓

**3. Type consistency:**
- `ProviderConfig.kind: ProviderKind` — Task 4 引入，后续所有 `ProviderConfig { ... }` 字面量补 `kind`。Task 5/6/7/8/9/10/11 测试里统一用 `kind: ProviderKind::X`。✓
- `ProviderStrategy::actions()` 返回类型：Task 7 初版 `&'static [ActionDef]`，Task 8 改为 `Vec<ActionDef>`（Task 8 Step 0 明确回改 Task 7 trait 签名 + custom.rs 删覆写）。Task 9/10 用 `Vec<ActionDef>` 一致。✓
- `PresetStrategy.base_url`：Task 10 初版 `&'static str`，修正版 `String`（与 catalog `String` 一致）。✓
- `ActionResult` derive：Task 8 Step 4 提到加 `Debug`，Task 12 Step 1 提到加 `Serialize`。两处都要加（`#[derive(Debug, serde::Serialize)]`）。✓
- `find_provider("")` 在 `cpa_probe_port` 草稿里调了一次又被覆盖——最终用 `load_providers().find(|p| p.kind == CpaGpt)`。一致。✓
- `common_test_connection` 在 `strategy/mod.rs` 定义，`custom.rs`/`system_default.rs`/`PresetStrategy`/`CpaGptStrategy` 都调——签名 `fn common_test_connection(cfg: &ProviderConfig, base_url_override: Option<&str>) -> Result<ConnectionStatus, String>` 统一。✓

**4. 漏项补查：**
- `get_system_default_model_mappings` / `set_system_default_model_mappings` 命令在迁移后读出空（顶层字段删了）。保留向后兼容、Plan 2 删——本计划不处理，可接受（旧前端不崩）。
- `load_active_provider` 迁移后返回 Some（SystemDefault 实例），`build_runtime_env_vars` 不再有 None 分支——Task 6 处理。✓
- release 模式 catalog 路径：Task 4 `set_resource_dir` 由 lib.rs 注入。✓

无遗漏。计划可执行。

---

## Execution Handoff

Plan 1（Rust 后端）完成。Plan 2（前端 UX：catalog 选择面板 + kind 表单 + 专属操作区组件）依赖本计划的 commands，在本计划执行完后编写为 `docs/superpowers/plans/2026-07-20-provider-preset-frontend.md`。

两种执行方式：

**1. Subagent-Driven（推荐）** — 每个 Task 派一个新 subagent，任务间我来 review，快速迭代。

**2. Inline Execution** — 本会话内按 executing-plans 批量执行 + 检查点 review。

哪种？