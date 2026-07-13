# 插件市场扩展 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Aide 能从 Anthropic 官方/社区固定市场源发现并安装插件，装后在会话里真正加载其 skills/agents/hooks/MCP，并支持启用/禁用/更新/卸载。

**Architecture:** 把 `commands/marketplace.rs` 重构为 `commands/marketplace/` 模块（mod/sources/install/manifest），补全官方 `marketplace.json` schema 解析，安装落 CLI 兼容的 `~/.claude/plugins/cache/<市场>/<插件>/<版本>/` 三级目录，启用表存 `AppSettings`，Rust 维护 `enabled-plugins.json` 桥接清单，sidecar 读它并向 SDK `options.plugins` 注入本地路径，前端重写为多源 + 源开关条 + 严格按 mockup 视觉（`--aide-*` token）。

**Tech Stack:** Rust + Tauri v2 + serde + tokio (spawn_blocking) / Vue 3 Composition API + TS / Node sidecar (@anthropic-ai/claude-agent-sdk) / vitest + cargo test --lib。

## Global Constraints

- 所有 spawn `git`/外部进程的 `Command` 必须 `CREATE_NO_WINDOW (0x08000000)`（Windows），非 Windows 用 `#[cfg(windows)]` 隔离。
- 重 IO/子进程命令一律 `async fn` + `spawn_blocking`，`State` 用 `Arc<T>`，闭包内 `state.inner().clone()`；带引用参数的 async 命令必须返回 `Result<_,_>`。
- 前端颜色/圆角/间距/阴影一律 `var(--aide-*)` token，禁止硬编码 hex；tailwind.config.js 不定义颜色工具类。
- 跨平台：路径用 `PathBuf`/`path.join`，不硬编码 `\\`。
- 测试：Rust 用 `cargo test --lib`（绕杀软锁测试 exe）；前端用根目录 `npx vitest run`；sidecar 改源码后必须在 `agent-sidecar/` 跑 `pnpm build` 重建 `dist/sidecar.js`（已追踪产物，随源码提交）。
- 提交规约：每个 Task 末尾提交；commit message 中文，结尾带 `Co-Authored-By: Claude <noreply@anthropic.com>`。
- 当前分支：`feat/marketplace-extension`（已含设计文档 commit `1eef1fb`）。
- 真实 token 名（`src/themes/warm-dark.ts`，经 `apply.ts` 写为 `--aide-<kebab>`）：`bgDeep/bgBase/bgRaised/bgOverlay`、`surfaceDefault/surfaceHover/surfaceActive`、`textPrimary/textSecondary/textMuted/textOnAccent`、`accent/accentHover/accentSubtle`、`success/warning/danger/info`、`border/borderSubtle`、`shadowSm/shadowMd/shadowLg`、`radiusSm/radiusMd/radiusLg`、`spaceUnit`。

## File Structure

**Rust（src-tauri/src/）**
- `commands/marketplace/mod.rs`（新建，组织层）— 公开类型 + Tauri 命令 + 路径 helpers + 固定源目录 const + `enabled_plugins_manifest_path()`
- `commands/marketplace/sources.rs`（新建）— `marketplace.json` 全 schema 解析 + 固定源
- `commands/marketplace/install.rs`（新建）— 安装/卸载/更新/版本解析/7 天 GC
- `commands/marketplace/manifest.rs`（新建）— `plugin.json` 读取 + 组件可用性判断
- 删除：`commands/marketplace.rs`（内容迁入上述模块）
- 改：`commands/settings.rs` — `AppSettings` 加 `enabled_marketplaces` / `enabled_plugins`
- 改：`commands/mod.rs` — 确保 `our_config_dir()` 为 `pub`（供 sidecar.rs 调用）
- 改：`lib.rs` — 命令注册表新增 7 个命令
- 改：`sidecar.rs` — spawn 时注入 `AIDE_ENABLED_PLUGINS_FILE` env
- 不改：`skills.rs`（`scan_plugins` 已匹配 `cache/{reg}/{plugin}/{ver}/skills/*` 三级布局，新安装路径天然兼容）

**Sidecar（agent-sidecar/src/）**
- 改：`index.ts` — 读 `enabled-plugins.json` → 构建 `options.plugins` 传入 `query()`
- 重建：`agent-sidecar/dist/sidecar.js`

**前端（src/）**
- 改：`types/marketplace.ts` — 多源 + 启用 + 可用性 + 更新 类型
- 改：`api/marketplace.ts` — 新 IPC 包装
- 改：`composables/useMarketplace.ts` — 多源 fetch / setEnabled / refreshSource / updatePlugin / 可用性过滤
- 改：`components/marketplace/MarketplaceTab.vue` — 源开关条 + 列表 + 隐藏行（按 mockup，`--aide-*` token）
- 改：`components/marketplace/MarketplacePluginCard.vue` — 五状态按钮 + caveat + npm 灰
- 新建：`components/marketplace/PluginDetail.vue` — 懒拉 plugin.json 的详情/可用性
- 改：`utils/errors.ts` — 新错误码 `NPM_UNSUPPORTED` / `SOURCE_TYPE_UNSUPPORTED`
- 改：`App.vue` — onMounted 启动后台更新检查 + 通知

**视觉基准**：`docs/superpowers/specs/2026-07-13-marketplace-mockup.html`（DOM/CSS/交互的精确来源；实现时按下方映射表把 hex 换成 `--aide-*` token）。

### Mockup 角色 → 真实 token 映射表

| Mockup 角色 / 用途 | 真实 `--aide-*` token |
|---|---|
| 窗口/标题栏/左侧 nav 底 | `--aide-bg-deep` |
| 主面板底 | `--aide-bg-base` |
| 卡片面 / 源芯片面 | `--aide-surface-default` |
| 卡片 hover / 芯片 hover | `--aide-surface-hover` |
| 输入框/详情底 | `--aide-bg-raised` |
| 主文本 / 插件名 | `--aide-text-primary` |
| 次要文本 / 描述 | `--aide-text-secondary` |
| 暗淡文本 / 占位 / 计数 | `--aide-text-muted` |
| accent（安装按钮、源芯片开、状态点开、focus） | `--aide-accent` |
| accent 按钮 hover | `--aide-accent-hover` |
| accent 按钮文字 | `--aide-text-on-accent` |
| 芯片开/焦点半透明填充 | `--aide-accent-subtle` |
| 半透明 accent 边框（芯片开、focus 环、官方徽标） | `color-mix(in srgb, var(--aide-accent) 45%, transparent)` |
| 成功（启用状态点） | `--aide-success` |
| 警告（caveat 标） | `--aide-warning` |
| 危险（卸载按钮） | `--aide-danger` |
| 危险软底 | `color-mix(in srgb, var(--aide-danger) 12%, transparent)` |
| 信息（社区徽标） | `--aide-info` |
| 分割线 / 卡片边 | `--aide-border` |
| 浅分割线 | `--aide-border-subtle` |
| 圆角 | `--aide-radius-sm` / `-md` / `-lg` |
| 阴影 | `--aide-shadow-sm` / `-md` / `-lg` |

> Mockup 里自造的 `--aide-bg/--aide-surface/--aide-text/--aide-text-muted/--aide-text-faint/--aide-surface-raised/--aide-border-strong/--aide-accent-soft/--aide-accent-line` **不是真实 token**，必须按上表替换。等宽字体沿用项目既有 mono（Cascadia Code），三角箭头 `font-size: 14px`。

---

## Task 1: 重构 marketplace.rs 为 marketplace/ 模块（行为不变基线）

**Files:**
- Create: `src-tauri/src/commands/marketplace/mod.rs`, `sources.rs`, `install.rs`, `manifest.rs`
- Delete: `src-tauri/src/commands/marketplace.rs`
- Modify: `src-tauri/src/commands/mod.rs:9`（`pub mod marketplace;` 不变，模块从文件变目录自动生效）

**Interfaces:**
- Produces: 模块 `commands::marketplace`，公开原有 4 个命令签名不变（`fetch_marketplace(url:String)->Result<Vec<PluginEntry>,String>` 等），保持 `lib.rs:245-248` 注册不破。新增 `pub fn enabled_plugins_manifest_path() -> PathBuf`（后续 Task 用）。

- [ ] **Step 1: 建模块骨架**

`src-tauri/src/commands/marketplace/mod.rs`（先原样搬移现有代码 + 新增 manifest path helper，不改行为）：

```rust
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub mod sources;
pub mod install;
pub mod manifest;

use super::claude_home;

// ── Types (API response) ──
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PluginEntry {
    pub name: String,
    #[serde(default)] pub description: String,
    #[serde(default)] pub repo: String,
    #[serde(default)] pub homepage: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InstalledPlugin {
    pub name: String,
    #[serde(default)] pub title: String,
    #[serde(default)] pub description: String,
    #[serde(default)] pub author: String,
    #[serde(default)] pub repo_url: String,
    pub path: String,
    pub installed_at: u64,
}

/// 桥接清单路径：sidecar 经 env `AIDE_ENABLED_PLUGINS_FILE` 读它。
pub fn enabled_plugins_manifest_path() -> PathBuf {
    super::our_config_dir().join("enabled-plugins.json")
}

pub fn plugins_dir() -> PathBuf { claude_home().join("plugins") }
pub fn marketplace_cache_dir() -> PathBuf { super::our_config_dir().join("marketplace-cache") }

// ── Tauri commands（本 Task 保持旧签名/旧行为，仅迁位置）──
// fetch_marketplace / install_plugin / uninstall_plugin / list_installed_plugins
// 代码原样从旧 marketplace.rs 搬入 install.rs，git_clone/git_err/get_remote_url
// 搬入 install.rs。本 Task 不改解析、不改安装路径。
```

`sources.rs`：先放旧 `RawSource/RawPluginEntry/RegistryManifest/From<RawPluginEntry> for PluginEntry` 原样搬入（Task 2 再补全 schema）。

`install.rs`：搬入 `git_err`/`git_clone`/`fetch_marketplace`/`install_plugin`/`uninstall_plugin`/`list_installed_plugins`/`get_remote_url` 原样（注意 `#[cfg(windows)] use std::os::windows::process::CommandExt;` 与 `CREATE_NO_WINDOW` 一并搬入）。

`manifest.rs`：搬入旧 `PluginManifest`。

- [ ] **Step 2: 删旧文件**

删除 `src-tauri/src/commands/marketplace.rs`（内容已全搬入模块）。

- [ ] **Step 3: 确保 `our_config_dir` 可见**

`src-tauri/src/commands/mod.rs` 中 `our_config_dir` 改为 `pub fn our_config_dir(...)`（若已是 pub 跳过；sidecar.rs 后续 Task 7 要跨模块调用，必须 pub）。`claude_home` 同理保持可被 `commands/marketplace/mod.rs` 经 `super::claude_home()` 访问。

- [ ] **Step 4: 编译 + 跑现有测试，确认行为不变**

Run: `cd src-tauri && cargo build`  → 期望编译通过（命令注册表不变）。
Run: `cd src-tauri && cargo test --lib` → 期望现有测试全绿。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/commands/marketplace/ src-tauri/src/commands/mod.rs
git rm src-tauri/src/commands/marketplace.rs
git commit -m "refactor(marketplace): 拆分为 marketplace/ 模块，行为不变

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: 全 schema 解析（sources.rs）

**Files:**
- Modify: `src-tauri/src/commands/marketplace/sources.rs`（重写解析类型）
- Test: `src-tauri/src/commands/marketplace/sources.rs` 末尾 `#[cfg(test)] mod tests`

**Interfaces:**
- Produces: `RawSource`（5 分支）、`RawPluginEntry`（含元数据 + 内联组件字段）、`MarketplaceManifest`（含 `metadata.pluginRoot`）、`fn parse_marketplace_json(&str) -> Result<MarketplaceManifest,String>`、`fn resolve_relative(source:&str, plugin_root:Option<&str>) -> String`（拼 pluginRoot 前缀）。

- [ ] **Step 1: 写失败测试**

在 `sources.rs` 末尾加：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_five_source_types() {
        let j = r#"{
          "name":"m","owner":{"name":"o"},
          "metadata":{"pluginRoot":"./plugins"},
          "plugins":[
            {"name":"a","source":"./plugins/a"},
            {"name":"b","source":{"source":"github","repo":"o/r","ref":"v1","sha":"0123456789abcdef0123456789abcdef01234567"}},
            {"name":"c","source":{"source":"url","url":"https://gitlab.com/x/y.git"}},
            {"name":"d","source":{"source":"git-subdir","url":"o/r","path":"p/d","sha":"0123456789abcdef0123456789abcdef01234567"}},
            {"name":"e","source":{"source":"npm","package":"@o/e","version":"^1.0"}}
          ]
        }"#;
        let m = parse_marketplace_json(j).unwrap();
        assert_eq!(m.name, "m");
        assert_eq!(m.plugins.len(), 5);
        assert!(matches!(m.plugins[0].source.as_ref().unwrap(), RawSource::Relative(s) if s=="./plugins/a"));
        assert!(matches!(m.plugins[1].source.as_ref().unwrap(), RawSource::Github{repo,..} if repo=="o/r"));
        assert!(matches!(m.plugins[2].source.as_ref().unwrap(), RawSource::Url{url,..} if url.contains("gitlab")));
        assert!(matches!(m.plugins[3].source.as_ref().unwrap(), RawSource::GitSubdir{path,..} if path=="p/d"));
        assert!(matches!(m.plugins[4].source.as_ref().unwrap(), RawSource::Npm{package,..} if package=="@o/e"));
        assert_eq!(m.metadata.as_ref().unwrap().plugin_root.as_deref(), Some("./plugins"));
    }

    #[test]
    fn plugin_root_prepended_to_relative_short_source() {
        assert_eq!(resolve_relative("a", Some("./plugins")), "./plugins/a");
        assert_eq!(resolve_relative("./plugins/a", Some("./plugins")), "./plugins/a");
        assert_eq!(resolve_relative("a", None), "a");
    }

    #[test]
    fn reads_inlined_component_fields() {
        let j = r#"{"name":"m","owner":{"name":"o"},"plugins":[
          {"name":"lsp","source":{"source":"github","repo":"o/l"},"lspServers":{"go":{"command":"gopls","extensionToLanguage":{".go":"go"}}}},
          {"name":"mix","source":{"source":"github","repo":"o/x"},"skills":["./s/"],"lspServers":{"x":{"command":"x","extensionToLanguage":{".x":"x"}}}}
        ]}"#;
        let m = parse_marketplace_json(j).unwrap();
        assert!(m.plugins[0].lsp_servers.is_some());
        assert!(m.plugins[0].skills.is_none());
        assert!(m.plugins[1].skills.is_some() && m.plugins[1].lsp_servers.is_some());
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test --lib marketplace::sources` → 期望 FAIL（类型不存在）。

- [ ] **Step 3: 实现解析类型**

`sources.rs` 顶部替换为：

```rust
use serde::Deserialize;
use serde_json::Value;

/// 5 种 plugin source（官方 marketplace.json schema）
#[derive(Debug, Deserialize)]
#[serde(tag = "source", rename_all = "kebab-case")]
pub enum RawSource {
    #[serde(rename = "relative")] // 字符串形式 "./x" 走 unagged，见下
    RelativePlaceholder,
    Github { repo: String, #[serde(default)] r#ref: Option<String>, #[serde(default)] sha: Option<String> },
    Url { url: String, #[serde(default)] r#ref: Option<String>, #[serde(default)] sha: Option<String> },
    #[serde(rename = "git-subdir")]
    GitSubdir { url: String, path: String, #[serde(default)] r#ref: Option<String>, #[serde(default)] sha: Option<String> },
    Npm { package: String, #[serde(default)] version: Option<String> },
}
```

> `source` 字段在官方 schema 里既可以是字符串（`"./plugins/a"`）也可以是对象（`{"source":"github",...}`）。用单个 enum 难以同时覆盖。改用「先 serde_json::Value 手判」：字符串 → Relative；对象 → 按 `source` 字段分发。

替换为手判实现：

```rust
use serde_json::Value;

#[derive(Debug)]
pub enum RawSource {
    Relative(String),
    Github { repo: String, r#ref: Option<String>, sha: Option<String> },
    Url { url: String, r#ref: Option<String>, sha: Option<String> },
    GitSubdir { url: String, path: String, r#ref: Option<String>, sha: Option<String> },
    Npm { package: String, version: Option<String> },
}

#[derive(Debug, Default)]
pub struct RawPluginEntry {
    pub name: String,
    pub source: Option<RawSource>,
    // 元数据
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub version: Option<String>,
    pub author: Option<Value>,
    pub homepage: Option<String>,
    pub repository: Option<String>,
    pub category: Option<String>,
    pub tags: Option<Vec<String>>,
    pub default_enabled: Option<bool>,
    // 内联组件字段（仅判断有无，内容透传给详情页）
    pub skills: Option<Value>,
    pub commands: Option<Value>,
    pub agents: Option<Value>,
    pub hooks: Option<Value>,
    pub mcp_servers: Option<Value>,
    pub lsp_servers: Option<Value>,
    pub output_styles: Option<Value>,
    pub themes: Option<Value>,
    pub monitors: Option<Value>,
}

#[derive(Debug, Default)]
pub struct MarketplaceMetadata {
    pub plugin_root: Option<String>,
}

#[derive(Debug, Default)]
pub struct MarketplaceManifest {
    pub name: String,
    pub owner: Option<Value>,
    pub plugins: Vec<RawPluginEntry>,
    pub metadata: Option<MarketplaceMetadata>,
}

pub fn parse_marketplace_json(content: &str) -> Result<MarketplaceManifest, String> {
    let v: Value = serde_json::from_str(content).map_err(|e| format!("Failed to parse marketplace JSON: {e}"))?;
    let name = v["name"].as_str().unwrap_or("").to_string();
    let owner = v.get("owner").cloned();
    let metadata = v.get("metadata").map(|m| MarketplaceMetadata {
        plugin_root: m["pluginRoot"].as_str().map(|s| s.to_string()),
    });
    let mut plugins = Vec::new();
    if let Some(arr) = v["plugins"].as_array() {
        for p in arr {
            plugins.push(parse_entry(p));
        }
    }
    Ok(MarketplaceManifest { name, owner, plugins, metadata })
}

fn parse_entry(p: &Value) -> RawPluginEntry {
    let src = p.get("source").map(|s| parse_source(s));
    RawPluginEntry {
        name: p["name"].as_str().unwrap_or("").to_string(),
        source: src,
        display_name: p.get("displayName").and_then(|v| v.as_str()).map(|s| s.to_string()),
        description: p.get("description").and_then(|v| v.as_str()).map(|s| s.to_string()),
        version: p.get("version").and_then(|v| v.as_str()).map(|s| s.to_string()),
        author: p.get("author").cloned(),
        homepage: p.get("homepage").and_then(|v| v.as_str()).map(|s| s.to_string()),
        repository: p.get("repository").and_then(|v| v.as_str()).map(|s| s.to_string()),
        category: p.get("category").and_then(|v| v.as_str()).map(|s| s.to_string()),
        tags: p.get("tags").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()),
        default_enabled: p.get("defaultEnabled").and_then(|v| v.as_bool()),
        skills: p.get("skills").cloned(),
        commands: p.get("commands").cloned(),
        agents: p.get("agents").cloned(),
        hooks: p.get("hooks").cloned(),
        mcp_servers: p.get("mcpServers").cloned(),
        lsp_servers: p.get("lspServers").cloned(),
        output_styles: p.get("outputStyles").cloned(),
        themes: p.get("themes").cloned(),
        monitors: p.get("monitors").cloned(),
    }
}

fn parse_source(s: &Value) -> RawSource {
    if let Some(str_path) = s.as_str() {
        return RawSource::Relative(str_path.to_string());
    }
    let kind = s["source"].as_str().unwrap_or("");
    match kind {
        "github" => RawSource::Github {
            repo: s["repo"].as_str().unwrap_or("").to_string(),
            r#ref: s["ref"].as_str().map(String::from),
            sha: s["sha"].as_str().map(String::from),
        },
        "url" => RawSource::Url {
            url: s["url"].as_str().unwrap_or("").to_string(),
            r#ref: s["ref"].as_str().map(String::from),
            sha: s["sha"].as_str().map(String::from),
        },
        "git-subdir" => RawSource::GitSubdir {
            url: s["url"].as_str().unwrap_or("").to_string(),
            path: s["path"].as_str().unwrap_or("").to_string(),
            r#ref: s["ref"].as_str().map(String::from),
            sha: s["sha"].as_str().map(String::from),
        },
        "npm" => RawSource::Npm {
            package: s["package"].as_str().unwrap_or("").to_string(),
            version: s["version"].as_str().map(String::from),
        },
        _ => RawSource::Relative(String::new()), // 未知：留空相对路径，安装时报 SOURCE_TYPE_UNSUPPORTED
    }
}

/// 相对源拼 pluginRoot 前缀（已是 ./x 则原样返回）
pub fn resolve_relative(source: &str, plugin_root: Option<&str>) -> String {
    if source.starts_with("./") || source.is_empty() {
        return source.to_string();
    }
    match plugin_root {
        Some(root) => {
            let root = root.trim_end_matches('/');
            format!("{}/{}", root, source)
        }
        None => source.to_string(),
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test --lib marketplace::sources` → 期望 PASS。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/commands/marketplace/sources.rs
git commit -m "feat(marketplace): 全 schema 解析（5 source + pluginRoot + 内联组件）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 固定源目录 + 启用表设置字段

**Files:**
- Modify: `src-tauri/src/commands/marketplace/sources.rs`（加 `FIXED_SOURCES` const + `SourceInfo`）
- Modify: `src-tauri/src/commands/marketplace/mod.rs`（加 `list_marketplace_sources` / `set_marketplace_enabled` 命令 + per-source cache dir helper）
- Modify: `src-tauri/src/commands/settings.rs`（`AppSettings` 加两字段）
- Modify: `src-tauri/src/lib.rs`（注册 2 命令）
- Test: settings.rs 末尾测试

**Interfaces:**
- Produces: `SourceInfo { id:String, name:String, repo:String, enabled:bool }`；命令 `list_marketplace_sources() -> Vec<SourceInfo>`、`set_marketplace_enabled(source_id:String, enabled:bool) -> Result<(),String>`；`AppSettings.enabled_marketplaces: Vec<String>`、`AppSettings.enabled_plugins: BTreeMap<String,bool>`；`fn source_cache_dir(source_id:&str) -> PathBuf`。

- [ ] **Step 1: 写失败测试（settings round-trip）**

`settings.rs` 测试模块加：

```rust
#[test]
fn marketplace_enabled_fields_round_trip() {
    let json = r#"{"fontSize":14,"enabledMarketplaces":["claude-plugins-official"],"enabledPlugins":{"github@claude-plugins-official":true}}"#;
    let s: AppSettings = serde_json::from_str(json).unwrap();
    assert_eq!(s.enabled_marketplaces, vec!["claude-plugins-official"]);
    assert_eq!(s.enabled_plugins.get("github@claude-plugins-official"), Some(&true));
    let out = serde_json::to_string(&s).unwrap();
    assert!(out.contains("\"enabledMarketplaces\""), "{out}");
    assert!(out.contains("\"enabledPlugins\""), "{out}");
    // 缺字段回填默认
    let s2: AppSettings = serde_json::from_str(r#"{"fontSize":14}"#).unwrap();
    assert!(s2.enabled_marketplaces.is_empty());
    assert!(s2.enabled_plugins.is_empty());
}
```

- [ ] **Step 2: 跑确认失败**

Run: `cd src-tauri && cargo test --lib app_settings` → 期望 FAIL（字段不存在）。

- [ ] **Step 3: 加 AppSettings 字段**

`settings.rs` `AppSettings` struct 内加（紧随 `codegraph_embedder` 之后）：

```rust
    /// 已启用的固定市场源 source_id 列表（默认空；前端首次进入可写默认两条）。
    #[serde(default)]
    pub enabled_marketplaces: Vec<String>,
    /// 已装插件的启用开关：key = "<plugin>@<market>"。
    #[serde(default)]
    pub enabled_plugins: std::collections::BTreeMap<String, bool>,
```

`impl Default for AppSettings` 内加：
```rust
            enabled_marketplaces: Vec::new(),
            enabled_plugins: std::collections::BTreeMap::new(),
```

顶部 `use` 加 `use std::collections::BTreeMap;`（或用全路径如上，避免别名冲突）。

- [ ] **Step 4: 加固定源 const + SourceInfo + per-source cache**

`sources.rs` 加：

```rust
use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct SourceInfo {
    pub id: String,
    pub name: String,
    pub repo: String,
    pub enabled: bool,
}

/// 固定预置市场源（不可自加）。(source_id, owner/repo, 默认市场名, 默认启用)
pub const FIXED_SOURCES: &[(&str, &str, &str, bool)] = &[
    ("claude-plugins-official", "anthropics/claude-plugins-official", "claude-plugins-official", true),
    ("claude-community", "anthropics/claude-plugins-community", "claude-community", true),
];

pub fn default_market_name(source_id: &str) -> Option<&'static str> {
    FIXED_SOURCES.iter().find(|(id, _, _, _)| *id == source_id).map(|(_, _, n, _)| *n)
}
pub fn fixed_repo(source_id: &str) -> Option<&'static str> {
    FIXED_SOURCES.iter().find(|(id, _, _, _)| *id == source_id).map(|(_, r, _, _)| *r)
}
```

`mod.rs` 加 per-source cache 与命令：

```rust
pub fn source_cache_dir(source_id: &str) -> PathBuf {
    marketplace_cache_dir().join(source_id)
}

#[tauri::command]
pub fn list_marketplace_sources() -> Result<Vec<sources::SourceInfo>, String> {
    let s = crate::commands::settings::load_config();
    let enabled: Vec<String> = s.get("settings").and_then(|x| x["enabledMarketplaces"].as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let list = sources::FIXED_SOURCES.iter().map(|(id, repo, name, def)| {
        let on = enabled.iter().any(|e| e == id) || (def && !enabled.iter().any(|e| sources::FIXED_SOURCES.iter().any(|(fid,_,_,_)| fid==e)));
        sources::SourceInfo { id: id.to_string(), name: name.to_string(), repo: repo.to_string(), enabled: on }
    }).collect();
    Ok(list)
}
```

> 说明：`enabled` 语义——若用户从未设置过 `enabledMarketplaces`（数组为空），取默认值（官方+社区都开）；一旦设置过，以数组为准。上面 `on` 表达式：当 enabled 列表里没有该源时，若 `def && enabled列表为空` 则开。简化为：`let never_set = enabled.is_empty(); let on = enabled.iter().any(|e| e==id) || (never_set && def);`（实现时用这个清晰版）。

`set_marketplace_enabled`：

```rust
#[tauri::command]
pub fn set_marketplace_enabled(source_id: String, enabled: bool) -> Result<(), String> {
    crate::commands::settings::with_config_mut(|cfg| {
        let settings = cfg["settings"].as_object_mut().ok_or("settings missing")?;
        let arr = settings.entry("enabledMarketplaces").or_insert(serde_json::json!([]));
        let a = arr.as_array_mut().ok_or("enabledMarketplaces not array")?;
        let has = a.iter().any(|v| v.as_str() == Some(&source_id));
        if enabled && !has { a.push(serde_json::json!(source_id)); }
        if !enabled { a.retain(|v| v.as_str() != Some(&source_id)); }
        Ok(())
    })
}
```

- [ ] **Step 5: 注册命令**

`lib.rs` 在 `// Marketplace commands` 区块加：
```rust
            commands::marketplace::list_marketplace_sources,
            commands::marketplace::set_marketplace_enabled,
```

- [ ] **Step 6: 跑测试**

Run: `cd src-tauri && cargo test --lib` → 期望全绿。
Run: `cd src-tauri && cargo build` → 通过。

- [ ] **Step 7: 提交**

```bash
git add src-tauri/src/commands/marketplace/sources.rs src-tauri/src/commands/marketplace/mod.rs src-tauri/src/commands/settings.rs src-tauri/src/lib.rs
git commit -m "feat(marketplace): 固定源目录 + 启用表设置字段

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: fetch_marketplace 改为按源 + 全 schema + 可用性

**Files:**
- Modify: `src-tauri/src/commands/marketplace/install.rs`（重写 `fetch_marketplace`）
- Modify: `src-tauri/src/commands/marketplace/mod.rs`（`PluginEntry` 扩字段）
- Modify: `src-tauri/src/lib.rs`（签名不变，不改注册）

**Interfaces:**
- 改 `fetch_marketplace` 签名为 `async fn fetch_marketplace(source_id: String) -> Result<Vec<PluginEntry>, String>`。
- `PluginEntry` 扩为：`{ name, display_name, description, version, source_id, market_name, category, homepage, repository, availability: String /* "available"|"mixed"|"unavailable"|"unknown" */, unsupported: Vec<String> }`。
- 产 helper `fn classify_availability(entry:&RawPluginEntry) -> (String, Vec<String>)`（在 `manifest.rs`）。

- [ ] **Step 1: 扩 PluginEntry + 可用性分类**

`mod.rs` 替换 `PluginEntry`：

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]   // 序列化为 camelCase 匹配前端 TS
pub struct PluginEntry {
    pub name: String,
    #[serde(default)] pub display_name: String,
    #[serde(default)] pub description: String,
    #[serde(default)] pub version: String,
    #[serde(default)] pub source_id: String,
    #[serde(default)] pub market_name: String,
    #[serde(default)] pub category: String,
    #[serde(default)] pub homepage: String,
    #[serde(default)] pub repository: String,
    /// available | mixed | unavailable | unknown
    pub availability: String,
    #[serde(default)] pub unsupported: Vec<String>,
}
```

> ⚠️ 必须加 `#[serde(rename_all = "camelCase")]`——新字段 `display_name`/`source_id`/`market_name` 是多词，不加会序列化成 snake_case，前端 TS 的 `displayName`/`sourceId`/`marketName` 拿不到。`InstalledPlugin`、`PluginComponent` 同理（见 Task 5/13）。

`manifest.rs` 加分类：

```rust
use crate::commands::marketplace::sources::RawPluginEntry;

const UNSUPPORTED: &[&str] = &["lsp_servers", "output_styles", "themes", "monitors"];
const SUPPORTED: &[&str] = &["skills", "commands", "agents", "hooks", "mcp_servers"];

fn has(entry: &RawPluginEntry, field: &str) -> bool {
    match field {
        "skills" => entry.skills.is_some(),
        "commands" => entry.commands.is_some(),
        "agents" => entry.agents.is_some(),
        "hooks" => entry.hooks.is_some(),
        "mcp_servers" => entry.mcp_servers.is_some(),
        "lsp_servers" => entry.lsp_servers.is_some(),
        "output_styles" => entry.output_styles.is_some(),
        "themes" => entry.themes.is_some(),
        "monitors" => entry.monitors.is_some(),
        _ => false,
    }
}

/// 列表阶段可用性：仅基于条目内联组件字段。
pub fn classify_availability(entry: &RawPluginEntry) -> (String, Vec<String>) {
    let any_supported = SUPPORTED.iter().any(|f| has(entry, f));
    let unsupported_present: Vec<String> = UNSUPPORTED.iter().filter(|f| has(entry, f)).map(|s| s.to_string()).collect();
    if unsupported_present.is_empty() {
        return ("available".into(), vec![]); // 无不可用组件声明（可能完全未声明→未知，但无不可用则按可用显示）
    }
    if any_supported {
        return ("mixed".into(), unsupported_present);
    }
    ("unavailable".into(), unsupported_present)
}
```

- [ ] **Step 2: 重写 fetch_marketplace（async + 按源）**

`install.rs` 删除旧 `fetch_marketplace`，替换为：

```rust
use crate::commands::marketplace::{sources, manifest, source_cache_dir, PluginEntry};
use crate::commands::marketplace::sources::{parse_marketplace_json, resolve_relative, RawSource};

#[tauri::command]
pub async fn fetch_marketplace(source_id: String) -> Result<Vec<PluginEntry>, String> {
    // async 命令不埋 trace_command（按 CLAUDE.md：async 的 spawn_blocking 任务不在主线程，trace guard 在 dispatch 后立刻 drop，埋了也抓不到）
    tokio::task::spawn_blocking(move || -> Result<Vec<PluginEntry>, String> {
        let repo = sources::fixed_repo(&source_id).ok_or("未知市场源")?.to_string();
        let market_name = sources::default_market_name(&source_id).unwrap_or(&source_id).to_string();
        let cache = source_cache_dir(&source_id);
        // 克隆或拉取
        if cache.exists() {
            // 已缓存：直接解析（刷新由 refresh_marketplace 负责 git pull）
        } else {
            std::fs::create_dir_all(cache.parent().unwrap_or(&cache)).map_err(|e| e.to_string())?;
            let url = format!("https://github.com/{}.git", repo);
            git_clone(&url, &cache).map_err(|e| format!("git clone 失败: {e}"))?;
        }
        let mjson = cache.join(".claude-plugin").join("marketplace.json");
        let content = std::fs::read_to_string(&mjson)
            .or_else(|_| std::fs::read_to_string(cache.join("registry.json")))
            .or_else(|_| std::fs::read_to_string(cache.join("plugins.json")))
            .map_err(|e| format!("读 marketplace.json 失败: {e}"))?;
        let m = parse_marketplace_json(&content)?;
        let plugin_root = m.metadata.as_ref().and_then(|md| md.plugin_root.as_deref());
        let plugins = m.plugins.into_iter().map(|raw| {
            let (avail, unsup) = manifest::classify_availability(&raw);
            let version = raw.version.clone().unwrap_or_else(|| resolved_version_from_source(&raw.source));
            PluginEntry {
                name: raw.name.clone(),
                display_name: raw.display_name.clone().unwrap_or_else(|| raw.name.clone()),
                description: raw.description.clone().unwrap_or_default(),
                version,
                source_id: source_id.clone(),
                market_name: market_name.clone(),
                category: raw.category.clone().unwrap_or_default(),
                homepage: raw.homepage.clone().unwrap_or_default(),
                repository: raw.repository.clone().unwrap_or_default(),
                availability: avail,
                unsupported: unsup,
            }
        }).collect();
        Ok(plugins)
    }).await.map_err(|e| e.to_string())?
}

/// 仅凭条目 source 能确定的版本（有 sha 用 short sha；否则空，等安装时再定）
fn resolved_version_from_source(src: &Option<RawSource>) -> String {
    match src {
        Some(RawSource::Github{sha:Some(s),..})|Some(RawSource::Url{sha:Some(s),..})|Some(RawSource::GitSubdir{sha:Some(s),..}) => short_sha(s),
        _ => String::new(),
    }
}
fn short_sha(s: &str) -> String { s.chars().take(12).collect() }
```

> 注意：旧 `fetch_marketplace(url)` 被前端以 `{url}` 调用。Task 9/10 会把前端改为 `{sourceId}`。本 Task 改签名后，前端旧调用会暂时报错——属预期，前端 Task 完成前不联调。Rust 侧编译要过：`lib.rs` 注册名不变（`fetch_marketplace`），Tauri 自动 snake_case→camelCase，前端 invoke 传 `sourceId`。

- [ ] **Step 3: 删去旧 `From<RawPluginEntry> for PluginEntry`**（`sources.rs` 里旧的 Into 转换已无意义，字段已变；删除以免编译冲突）。

- [ ] **Step 4: 编译**

Run: `cd src-tauri && cargo build` → 期望通过（`list_installed_plugins` 等仍引用旧 `PluginEntry` 字段如 `repo`，下一步 Task 5 一并改；若此处编译报 `repo` 字段缺失，先在 `list_installed_plugins` 临时用 `repo: String::new()` 占位，Task 5 重写）。

- [ ] **Step 5: 单测——解析官方真实片段**

`sources.rs` 测试模块补一条用真实官方片段（含 git-subdir + sha + category）确认字段抽取：

```rust
#[test]
fn parses_real_official_entry_shape() {
    let j = r#"{"name":"claude-plugins-official","owner":{"name":"Anthropic"},"plugins":[
      {"name":"agent-sdk-dev","source":"./plugins/agent-sdk-dev","category":"development","homepage":"x"}]}"#;
    let m = parse_marketplace_json(j).unwrap();
    assert_eq!(m.plugins[0].category.as_deref(), Some("development"));
    assert!(matches!(m.plugins[0].source.as_ref().unwrap(), RawSource::Relative(s) if s=="./plugins/agent-sdk-dev"));
}
```

Run: `cd src-tauri && cargo test --lib marketplace` → PASS。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/commands/marketplace/
git commit -m "feat(marketplace): fetch_marketplace 按源 + 全 schema + 可用性分类

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: 安装/卸载/列表 改 cache 三级目录 + 版本解析

**Files:**
- Modify: `src-tauri/src/commands/marketplace/install.rs`（重写 `install_plugin`/`uninstall_plugin`/`list_installed_plugins` + 新增 `update_plugin`/`refresh_marketplace` + 版本解析 + 7 天 GC）
- Modify: `src-tauri/src/commands/marketplace/mod.rs`（`InstalledPlugin` 扩 `market`/`version`/`enabled`/`has_update`，删 `repo_url`→保留兼容或改名）
- Modify: `src-tauri/src/lib.rs`（注册 `update_plugin`/`refresh_marketplace`）

**Interfaces:**
- `async fn install_plugin(source_id:String, plugin_name:String) -> Result<(),String>`
- `async fn uninstall_plugin(marketplace:String, plugin_name:String) -> Result<(),String>`
- `async fn update_plugin(source_id:String, plugin_name:String) -> Result<(),String>`
- `async fn refresh_marketplace(source_id:String) -> Result<(),String>`
- `async fn list_installed_plugins() -> Result<Vec<InstalledPlugin>,String>`
- `InstalledPlugin { name, market, version, display_name, description, author, path, installed_at, enabled }`
- 安装路径：`plugins_dir().join("cache").join(market).join(plugin).join(version)`

- [ ] **Step 1: 写失败测试——安装路径布局**

`install.rs` 末尾测试模块：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    #[test]
    fn cache_path_layout() {
        let p = cache_install_path("/home/u/.claude/plugins", "claude-plugins-official", "github", "1.2.0");
        assert_eq!(p, PathBuf::from("/home/u/.claude/plugins/cache/claude-plugins-official/github/1.2.0"));
    }
    #[test]
    fn relative_source_resolved_with_plugin_root() {
        assert_eq!(resolve_relative("agent-sdk-dev", Some("./plugins")), "./plugins/agent-sdk-dev");
    }
}
```

- [ ] **Step 2: 跑确认失败**

Run: `cd src-tauri && cargo test --lib marketplace::install` → FAIL（`cache_install_path` 不存在）。

- [ ] **Step 3: 实现安装核心**

`install.rs` 加：

```rust
fn cache_install_path(plugins_root: &str, market: &str, plugin: &str, version: &str) -> PathBuf {
    PathBuf::from(plugins_root).join("cache").join(market).join(plugin).join(version)
}

fn plugins_cache_root() -> PathBuf { crate::commands::marketplace::plugins_dir().join("cache") }

/// 从已缓存的源 marketplace.json 里按 plugin 名查条目
fn lookup_entry(source_id: &str, plugin_name: &str) -> Result<(String, crate::commands::marketplace::sources::RawPluginEntry), String> {
    let cache = crate::commands::marketplace::source_cache_dir(source_id);
    let mjson = cache.join(".claude-plugin").join("marketplace.json");
    let content = std::fs::read_to_string(&mjson).map_err(|e| format!("源未拉取或读取失败: {e}"))?;
    let m = crate::commands::marketplace::sources::parse_marketplace_json(&content)?;
    let market_name = if m.name.is_empty() { crate::commands::marketplace::sources::default_market_name(source_id).unwrap_or(source_id).to_string() } else { m.name };
    let entry = m.plugins.into_iter().find(|p| p.name == plugin_name).ok_or("插件不在此源中")?;
    Ok((market_name, entry))
}
```

`install_plugin` 重写：

```rust
#[tauri::command]
pub async fn install_plugin(source_id: String, plugin_name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let (market, entry) = lookup_entry(&source_id, &plugin_name)?;
        let plugin_root = read_marketplace_plugin_root(&source_id);
        let target = resolve_and_install(&source_id, &market, &plugin_name, &entry, plugin_root.as_deref())?;
        // 官方规则：plugin.json 可选，SDK 按目录布局自动发现组件，故不强制校验其存在。
        // 仅检查安装结果目录非空（ref/sha 错误会得到空目录）。
        if std::fs::read_dir(&target).map(|mut i| i.next().is_none()).unwrap_or(true) {
            let _ = std::fs::remove_dir_all(&target);
            return Err("安装结果为空目录：插件源 ref/sha 可能无效".into());
        }
        // 默认启用状态：defaultEnabled（entry > 无→true）
        let enable = entry.default_enabled.unwrap_or(true);
        set_enabled_in_settings(&market, &plugin_name, enable);
        rewrite_enabled_manifest()?;
        Ok(())
    }).await.map_err(|e| e.to_string())?
}
```

> 官方规则下 `plugin.json` 清单可选，SDK 按目录布局自动发现组件，故安装不强制校验其存在；只校验结果目录非空（ref/sha 错误 → 空目录 → 报错并清理）。

`resolve_and_install`：

```rust
fn resolve_and_install(source_id: &str, market: &str, plugin: &str, entry: &crate::commands::marketplace::sources::RawPluginEntry, plugin_root: Option<&str>) -> Result<PathBuf, String> {
    let src = entry.source.as_ref().ok_or("插件缺少 source")?;
    let version = entry.version.clone().unwrap_or_default();
    let target_root = plugins_cache_root().join(market).join(plugin);
    std::fs::create_dir_all(&target_root).map_err(|e| e.to_string())?;
    match src {
        crate::commands::marketplace::sources::RawSource::Npm { .. } => {
            return Err("NPM_UNSUPPORTED: npm 源插件暂不支持安装".into());
        }
        crate::commands::marketplace::sources::RawSource::Relative(rel) => {
            let rel = resolve_relative(rel, plugin_root);
            let from = crate::commands::marketplace::source_cache_dir(source_id)
                .join(rel.trim_start_matches("./"));
            let ver = if version.is_empty() { read_plugin_json_version(&from).unwrap_or_else(|| "local".into()) } else { version };
            let target = target_root.join(&ver);
            if target.exists() { return Ok(target); }
            copy_dir_recursive(&from, &target)?;
            Ok(target)
        }
        crate::commands::marketplace::sources::RawSource::Github { repo, r#ref, sha } => {
            let url = format!("https://github.com/{}.git", repo);
            let ver = if !version.is_empty() { version } else { sha.as_ref().map(|s| short_sha(s)).unwrap_or_default() };
            install_git(&target_root, &url, r#ref.as_deref(), sha.as_deref(), ver)
        }
        crate::commands::marketplace::sources::RawSource::Url { url, r#ref, sha } => {
            let ver = if !version.is_empty() { version } else { sha.as_ref().map(|s| short_sha(s)).unwrap_or_default() };
            install_git(&target_root, &url, r#ref.as_deref(), sha.as_deref(), ver)
        }
        crate::commands::marketplace::sources::RawSource::GitSubdir{url,path,r#ref,sha} => {
            // 稀疏克隆后取子目录
            let tmp = target_root.join(".__tmp__");
            let _ = std::fs::remove_dir_all(&tmp);
            clone_subdir(url, r#ref.as_deref(), sha.as_deref(), path, &tmp)?;
            let ver = if !version.is_empty() { version } else { sha.as_ref().map(|s| short_sha(s)).unwrap_or_else(|| git_short_sha(&tmp).unwrap_or("unknown".into())) };
            let target = target_root.join(&ver);
            let from = tmp.join(path);
            if !target.exists() { copy_dir_recursive(&from,&target)?; }
            let _ = std::fs::remove_dir_all(&tmp);
            Ok(target)
        }
    }
}
```

辅助函数（`install.rs` 内）：

```rust
fn read_marketplace_plugin_root(source_id: &str) -> Option<String> {
    let cache = crate::commands::marketplace::source_cache_dir(source_id);
    let mjson = cache.join(".claude-plugin").join("marketplace.json");
    let content = std::fs::read_to_string(&mjson).ok()?;
    let m = crate::commands::marketplace::sources::parse_marketplace_json(&content).ok()?;
    m.metadata.and_then(|md| md.plugin_root)
}
fn read_plugin_json_version(dir: &PathBuf) -> Option<String> {
    let p = dir.join(".claude-plugin").join("plugin.json");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()?;
    v["version"].as_str().map(String::from)
}
fn copy_dir_recursive(src: &PathBuf, dst: &PathBuf) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for e in std::fs::read_dir(src).map_err(|x| x.to_string())?.flatten() {
        let from = e.path(); let to = dst.join(e.file_name());
        if from.is_dir() { copy_dir_recursive(&from, &to)?; } else { std::fs::copy(&from, &to).map_err(|x| x.to_string())?; }
    }
    Ok(())
}
fn clone_ref_sha(url: &str, r#ref: Option<&str>, sha: Option<&str>, target: &PathBuf) -> Result<(), String> {
    let mut a = vec!["clone".into(), "--depth".into(), "1".into()];
    if let Some(r) = r#ref { a.push("--branch".into()); a.push(r.into()); }
    a.push(url.into()); a.push(target.to_string_lossy().to_string());
    run_git(&a)?;
    if let Some(s) = sha { run_git(&["fetch".into(),"--depth".into(),"1".into(),"origin".into(),s.into()], target)?; run_git(&["checkout".into(),s.into()], target)?; }
    Ok(())
}

/// github / url 源通用：浅克隆（带 ref/sha）→ 解析最终版本 → 落 cache 版本目录
fn install_git(target_root: &PathBuf, url: &str, r#ref: Option<&str>, sha: Option<&str>, version: String) -> Result<PathBuf, String> {
    let tmp = target_root.join(".__tmp__");
    let _ = std::fs::remove_dir_all(&tmp);
    clone_ref_sha(url, r#ref, sha, &tmp)?;
    let final_ver = if version.is_empty() { git_short_sha(&tmp).unwrap_or("unknown".into()) } else { version };
    let target = target_root.join(&final_ver);
    if !target.exists() {
        // rename 失败（跨卷）回退到拷贝
        if std::fs::rename(&tmp, &target).is_err() {
            copy_dir_recursive(&tmp, &target)?;
            let _ = std::fs::remove_dir_all(&tmp);
        }
    } else {
        let _ = std::fs::remove_dir_all(&tmp);
    }
    Ok(target)
}
fn clone_subdir(url: &str, r#ref: Option<&str>, sha: Option<&str>, path: &str, target: &PathBuf) -> Result<(), String> {
    run_git(&["clone".into(),"--filter=blob:none".into(),"--sparse".into(),"--no-checkout".into(),url.into(),target.to_string_lossy().to_string()])?;
    run_git(&["sparse-checkout".into(),"set".into(),path.into()], target)?;
    run_git(&["checkout".into(), r#ref.unwrap_or("HEAD").into()], target)?;
    if let Some(s) = sha { run_git(&["fetch".into(),"--depth".into(),"1".into(),"origin".into(),s.into()], target)?; run_git(&["checkout".into(),s.into()], target)?; }
    Ok(())
}
fn run_git(args: &[String], cwd: &PathBuf) -> Result<(), String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args).current_dir(cwd);
    #[cfg(windows)] { cmd.creation_flags(0x08000000); }
    let out = cmd.output().map_err(|e| e.to_string())?;
    if !out.status.success() { return Err(format!("git {:?} 失败: {}", args, String::from_utf8_lossy(&out.stderr))); }
    Ok(())
}
fn git_short_sha(dir: &PathBuf) -> Option<String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(["rev-parse","--short","HEAD"]).current_dir(dir);
    #[cfg(windows)] { cmd.creation_flags(0x08000000); }
    let out = cmd.output().ok()?;
    if out.status.success() { Some(String::from_utf8_lossy(&out.stdout).trim().to_string()) } else { None }
}
```

`uninstall_plugin` 重写：

```rust
#[tauri::command]
pub async fn uninstall_plugin(marketplace: String, plugin_name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let root = plugins_cache_root().join(&marketplace).join(&plugin_name);
        if !root.exists() { return Err(format!("插件 '{}' 未找到", plugin_name)); }
        std::fs::remove_dir_all(&root).map_err(|e| e.to_string())?;
        remove_enabled_in_settings(&marketplace, &plugin_name);
        rewrite_enabled_manifest()?;
        Ok(())
    }).await.map_err(|e| e.to_string())?
}
```

`refresh_marketplace`：

```rust
#[tauri::command]
pub async fn refresh_marketplace(source_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let repo = crate::commands::marketplace::sources::fixed_repo(&source_id).ok_or("未知源")?;
        let cache = crate::commands::marketplace::source_cache_dir(&source_id);
        if cache.exists() {
            run_git(&["pull".into(),"--ff-only".into()], &cache)?;
        } else {
            std::fs::create_dir_all(cache.parent().unwrap_or(&cache)).map_err(|e| e.to_string())?;
            let url = format!("https://github.com/{}.git", repo);
            git_clone(&url, &cache).map_err(|e| format!("git clone 失败: {e}"))?;
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}
```

`update_plugin`：

```rust
#[tauri::command]
pub async fn update_plugin(source_id: String, plugin_name: String) -> Result<(), String> {
    // 更新 = 用最新条目重装到新版本目录；旧版本目录保留 7 天 GC
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let (market, entry) = lookup_entry(&source_id, &plugin_name)?;
        let plugin_root = read_marketplace_plugin_root(&source_id);
        resolve_and_install(&source_id, &market, &plugin_name, &entry, plugin_root.as_deref())?;
        gc_old_versions(&market, &plugin_name);
        rewrite_enabled_manifest()?;
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

fn gc_old_versions(market: &str, plugin: &str) {
    // 保留最新版本，其余标记孤立；7 天后删除。简化：保留最新，超过 7 天的旧目录直接删。
    let root = plugins_cache_root().join(market).join(plugin);
    let Ok(mut vers) = std::fs::read_dir(&root) else { return };
    let mut v: Vec<_> = vers.flatten().filter(|e| e.path().is_dir() && e.file_name() != ".__tmp__").collect();
    v.sort_by_key(|e| e.metadata().modified().ok());
    if v.len() <= 1 { return; }
    let keep = v.last().unwrap().path();
    for e in v { if e.path()!=keep { if let Ok(m)=e.metadata() { if let Ok(t)=m.modified() { if t.elapsed().map(|d| d.as_secs()>604800).unwrap_or(false) { let _=std::fs::remove_dir_all(e.path()); } } } } }
}
```

`list_installed_plugins` 重写（扫 cache 树 + 合并 enabled）：

```rust
#[tauri::command]
pub async fn list_installed_plugins() -> Result<Vec<crate::commands::marketplace::InstalledPlugin>, String> {
    tokio::task::spawn_blocking(|| -> Result<Vec<crate::commands::marketplace::InstalledPlugin>, String> {
        let cfg = crate::commands::settings::load_config();
        let enabled_map: std::collections::BTreeMap<String,bool> = cfg.get("settings")
            .and_then(|s| s["enabledPlugins"].as_object())
            .map(|o| o.iter().filter_map(|(k,v)| v.as_bool().map(|b|(k.clone(),b))).collect())
            .unwrap_or_default();
        let root = plugins_cache_root();
        let mut out = Vec::new();
        let Ok(markets) = std::fs::read_dir(&root) else { return Ok(out) };
        for mk in markets.flatten() {
            let market = mk.file_name().to_string_lossy().to_string();
            let Ok(plugins) = std::fs::read_dir(mk.path()) else { continue };
            for p in plugins.flatten() {
                let plugin = p.file_name().to_string_lossy().to_string();
                let Ok(versions) = std::fs::read_dir(p.path()) else { continue };
                let mut vs: Vec<_> = versions.flatten().filter(|e| e.path().is_dir() && e.file_name()!=".__tmp__").collect();
                vs.sort(); // 字符串排序，最新在末
                let Some(latest) = vs.last() else { continue };
                let path = latest.path();
                let (display,desc,author,ver) = read_manifest(&path).unwrap_or((plugin.clone(),String::new(),String::new(),latest.file_name().to_string_lossy().to_string()));
                let key = format!("{plugin}@{market}");
                let installed_at = std::fs::metadata(&path).ok().and_then(|m|m.modified().ok()).and_then(|t|t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d|d.as_secs()).unwrap_or(0);
                out.push(crate::commands::marketplace::InstalledPlugin {
                    name: plugin.clone(), market: market.clone(), version: ver, display_name: display, description: desc, author, path: path.to_string_lossy().to_string(), installed_at, enabled: *enabled_map.get(&key).unwrap_or(&false),
                });
            }
        }
        Ok(out)
    }).await.map_err(|e| e.to_string())?
}

fn read_manifest(path: &PathBuf) -> Option<(String,String,String,String)> {
    let p = path.join(".claude-plugin").join("plugin.json");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()?;
    let name = v["displayName"].as_str().or(v["name"].as_str()).unwrap_or("").to_string();
    let desc = v["description"].as_str().unwrap_or("").to_string();
    let author = v["author"].get("name").and_then(|a|a.as_str()).or(v["author"].as_str()).unwrap_or("").to_string();
    let ver = v["version"].as_str().unwrap_or("").to_string();
    Some((name,desc,author,ver))
}
```

`mod.rs` 替换 `InstalledPlugin`：

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]   // display_name→displayName, installed_at→installedAt
pub struct InstalledPlugin {
    pub name: String,
    pub market: String,
    pub version: String,
    pub display_name: String,
    #[serde(default)] pub description: String,
    #[serde(default)] pub author: String,
    pub path: String,
    pub installed_at: u64,
    pub enabled: bool,
}
```

启用键读写 helpers（`install.rs`）：

```rust
fn enabled_key(market: &str, plugin: &str) -> String { format!("{plugin}@{market}") }
fn set_enabled_in_settings(market: &str, plugin: &str, on: bool) {
    let key = enabled_key(market, plugin);
    let _ = crate::commands::settings::with_config_mut(|cfg| {
        let s = cfg["settings"].as_object_mut().ok_or("settings missing")?;
        let m = s.entry("enabledPlugins").or_insert(serde_json::json!({}));
        if on { m[&key] = serde_json::json!(true); } else { m[&key] = serde_json::json!(false); }
        Ok::<_,String>(())
    });
}
fn remove_enabled_in_settings(market: &str, plugin: &str) {
    let key = enabled_key(market, plugin);
    let _ = crate::commands::settings::with_config_mut(|cfg| {
        if let Some(m) = cfg["settings"]["enabledPlugins"].as_object_mut() { m.remove(&key); }
        Ok::<_,String>(())
    });
}
```

`rewrite_enabled_manifest`（Task 6 主体；本 Task 先放占位实现，Task 6 完善）：

```rust
fn rewrite_enabled_manifest() -> Result<(), String> {
    // Task 6 实现：扫 cache 最新版本 + 过滤 enabled=true → 写 enabled-plugins.json
    crate::commands::marketplace::write_enabled_plugins_manifest()
}
```

`mod.rs` 加 `pub fn write_enabled_plugins_manifest() -> Result<(),String>`（Task 6 实现）；本 Task 先放空实现 `Ok(())` 保证编译。

- [ ] **Step 4: 注册新命令**

`lib.rs` Marketplace 区块加：
```rust
            commands::marketplace::refresh_marketplace,
            commands::marketplace::update_plugin,
```

- [ ] **Step 5: 跑测试 + 编译**

Run: `cd src-tauri && cargo test --lib marketplace` → 期望 PASS。
Run: `cd src-tauri && cargo build` → 通过。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/commands/marketplace/ src-tauri/src/lib.rs
git commit -m "feat(marketplace): cache 三级目录安装 + 版本解析 + 刷新/更新/卸载

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: 启用/禁用命令 + 桥接清单 enabled-plugins.json

**Files:**
- Modify: `src-tauri/src/commands/marketplace/mod.rs`（`set_plugin_enabled` 命令 + `write_enabled_plugins_manifest` 实现）
- Modify: `src-tauri/src/commands/marketplace/install.rs`（`rewrite_enabled_manifest` 调真实现）
- Modify: `src-tauri/src/lib.rs`（注册 `set_plugin_enabled`）
- Test: mod.rs 测试

**Interfaces:**
- `fn set_plugin_enabled(marketplace:String, plugin:String, enabled:bool) -> Result<(),String>`（同步）
- `pub fn write_enabled_plugins_manifest() -> Result<(),String>`：扫 `cache/<market>/<plugin>/<最新version>/`，过滤 `enabledPlugins` 里为 true 的 key，原子写 `enabled_plugins_manifest_path()` 为 `[{name,marketplace,path}]`。

- [ ] **Step 1: 写失败测试**

`mod.rs` 测试模块：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manifest_path_under_config_dir() {
        let p = enabled_plugins_manifest_path();
        assert!(p.to_string_lossy().contains("enabled-plugins.json"));
    }
}
```

- [ ] **Step 2: 跑确认失败/通过（路径 helper 已存在，应直接通过；若通过则跳过此步作为回归基线）**

Run: `cd src-tauri && cargo test --lib marketplace::tests` → 期望 PASS（回归）。

- [ ] **Step 3: 实现 write_enabled_plugins_manifest + set_plugin_enabled**

`mod.rs` 加：

```rust
use serde::Serialize;

#[derive(Serialize)]
struct EnabledPluginEntry { name: String, marketplace: String, path: String }

pub fn write_enabled_plugins_manifest() -> Result<(), String> {
    let cfg = crate::commands::settings::load_config();
    let enabled: std::collections::BTreeMap<String,bool> = cfg.get("settings")
        .and_then(|s| s["enabledPlugins"].as_object())
        .map(|o| o.iter().filter_map(|(k,v)| v.as_bool().map(|b|(k.clone(),b))).collect())
        .unwrap_or_default();
    let cache = plugins_dir().join("cache");
    let mut entries = Vec::new();
    if let Ok(markets) = std::fs::read_dir(&cache) {
        for mk in markets.flatten() {
            let market = mk.file_name().to_string_lossy().to_string();
            if let Ok(plugins) = std::fs::read_dir(mk.path()) {
                for p in plugins.flatten() {
                    let plugin = p.file_name().to_string_lossy().to_string();
                    let key = format!("{plugin}@{market}");
                    if enabled.get(&key) != Some(&true) { continue; }
                    if let Ok(mut vers) = std::fs::read_dir(p.path()) {
                        let mut vs: Vec<_> = vers.flatten().filter(|e| e.path().is_dir() && e.file_name()!=".__tmp__").collect();
                        vs.sort();
                        if let Some(latest) = vs.last() {
                            entries.push(EnabledPluginEntry { name: plugin.clone(), marketplace: market.clone(), path: latest.path().to_string_lossy().to_string() });
                        }
                    }
                }
            }
        }
    }
    let json = serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())?;
    atomic_write(&enabled_plugins_manifest_path(), &json)
}

fn atomic_write(path: &std::path::Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_plugin_enabled(marketplace: String, plugin: String, enabled: bool) -> Result<(), String> {
    let key = format!("{plugin}@{marketplace}");
    with_config_mut_settings(|s| {
        let m = s.entry("enabledPlugins").or_insert(serde_json::json!({}));
        if let Some(obj) = m.as_object_mut() { if enabled { obj.insert(key.clone(), serde_json::json!(true)); } else { obj.insert(key.clone(), serde_json::json!(false)); } }
        Ok::<_,String>(())
    })?;
    write_enabled_plugins_manifest()
}

fn with_config_mut_settings<F: FnOnce(&mut serde_json::Map<String,serde_json::Value>) -> Result<(),String>>(f: F) -> Result<(),String> {
    crate::commands::settings::with_config_mut(|cfg| {
        if cfg["settings"].is_null() { cfg["settings"] = serde_json::json!({}); }
        let s = cfg["settings"].as_object_mut().ok_or("settings not object")?;
        f(s)
    })
}
```

`install.rs` 里 `rewrite_enabled_manifest` 改为直接调：

```rust
fn rewrite_enabled_manifest() -> Result<(), String> {
    crate::commands::marketplace::write_enabled_plugins_manifest()
}
```

- [ ] **Step 4: 注册命令**

`lib.rs` Marketplace 区块加：
```rust
            commands::marketplace::set_plugin_enabled,
```

- [ ] **Step 5: 跑测试 + 编译**

Run: `cd src-tauri && cargo test --lib` → PASS。
Run: `cd src-tauri && cargo build` → 通过。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/commands/marketplace/ src-tauri/src/lib.rs
git commit -m "feat(marketplace): 启用/禁用命令 + enabled-plugins.json 桥接清单

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: sidecar 注入 AIDE_ENABLED_PLUGINS_FILE env

**Files:**
- Modify: `src-tauri/src/sidecar.rs:73-92`（env 注入块）

**Interfaces:**
- spawn 时设 `cmd.env("AIDE_ENABLED_PLUGINS_FILE", <enabled-plugins.json 绝对路径>)`，dev/release 均设。

- [ ] **Step 1: 加 env 注入**

`sidecar.rs` 在 `for (k,v) in &env_vars { cmd.env(k,v); }` 之后、`#[cfg(not(debug_assertions))]` 块之前插入：

```rust
        // 插件桥接清单：sidecar 读它构建 SDK options.plugins
        let manifest = crate::commands::marketplace::enabled_plugins_manifest_path();
        cmd.env("AIDE_ENABLED_PLUGINS_FILE", dunce::simplified(&manifest));
```

> `dunce::simplified` 剥 `\\?\` 前缀（同 AIDE_CLAUDE_EXE 的处理）；node 侧 fs.existsSync 能吃普通路径。`enabled_plugins_manifest_path()` 在 Task 1 已为 `pub`。

- [ ] **Step 2: 编译**

Run: `cd src-tauri && cargo build` → 通过。

- [ ] **Step 3: 提交**

```bash
git add src-tauri/src/sidecar.rs
git commit -m "feat(sidecar): 注入 AIDE_ENABLED_PLUGINS_FILE env

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: sidecar 读清单并传 options.plugins

**Files:**
- Modify: `agent-sidecar/src/index.ts`（顶部加读清单 helper；`query()` options 加 `plugins`）
- Rebuild: `agent-sidecar/dist/sidecar.js`

**Interfaces:**
- 读 `process.env.AIDE_ENABLED_PLUGINS_FILE` → 解析 JSON 数组 → 过滤 `fs.existsSync(path)` → 返回 `[{type:"local", path}]`。
- 注入 `options.plugins`（与现有 `skills:"all"` 并存）。

- [ ] **Step 1: 加 helper（文件顶部，proxy 块之后）**

`index.ts` 在 `const queue = new MessageQueue();` 之前插入：

```typescript
import { existsSync, readFileSync } from "node:fs";

/** 读 Rust 维护的 enabled-plugins.json，构建 SDK options.plugins。每次 query()
 *  构造前重读——启用/禁用/更新在下一次消息往返生效。 */
function buildPluginsOption(): { type: "local"; path: string }[] {
  const file = process.env.AIDE_ENABLED_PLUGINS_FILE;
  if (!file) return [];
  try {
    const arr = JSON.parse(readFileSync(file, "utf8")) as { path: string }[];
    return arr
      .filter((e) => e.path && existsSync(e.path))
      .map((e) => ({ type: "local" as const, path: e.path }));
  } catch {
    return []; // 文件不存在/解析失败：不阻塞会话
  }
}
```

> `existsSync`/`readFileSync` 顶部 `import { existsSync, readFileSync } from "node:fs";` 与现有 import 合并（index.ts 已 import `readline`，再加 fs）。

- [ ] **Step 2: 注入 options.plugins**

`index.ts` `query({ ... options: { ... skills: "all", ... } })` 内，在 `skills: "all",` 之后加：

```typescript
            skills: "all",
            plugins: buildPluginsOption(),
```

- [ ] **Step 3: 重建 dist**

Run: `cd agent-sidecar && pnpm build` → 生成 `dist/sidecar.js`，无报错。

- [ ] **Step 4: 类型检查**

Run: 根目录 `npx vue-tsc --noEmit` 若覆盖 sidecar；或 `cd agent-sidecar && npx tsc --noEmit`（按项目既有方式）→ 通过。

- [ ] **Step 5: 提交**

```bash
git add agent-sidecar/src/index.ts agent-sidecar/dist/sidecar.js
git commit -m "feat(sidecar): 读 enabled-plugins 清单传 SDK options.plugins

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: 前端类型 + API 层

**Files:**
- Modify: `src/types/marketplace.ts`
- Modify: `src/api/marketplace.ts`

**Interfaces:**
- 类型：`PluginEntry`（多源+可用性）、`InstalledPlugin`（market/version/enabled）、`SourceInfo`、`PluginDetails`。
- API：`fetchMarketplace(sourceId)`、`refreshMarketplace(sourceId)`、`installPlugin(sourceId,pluginName)`、`uninstallPlugin(marketplace,pluginName)`、`updatePlugin(sourceId,pluginName)`、`listInstalledPlugins()`、`setPluginEnabled(marketplace,plugin,enabled)`、`listMarketplaceSources()`、`setMarketplaceEnabled(sourceId,enabled)`、`getPluginDetails(sourceId,pluginName)`。

- [ ] **Step 1: 改类型**

`src/types/marketplace.ts` 整体替换为：

```typescript
export interface PluginEntry {
  name: string;
  displayName: string;
  description: string;
  version: string;
  sourceId: string;
  marketName: string;
  category: string;
  homepage: string;
  repository: string;
  availability: "available" | "mixed" | "unavailable" | "unknown";
  unsupported: string[];
}

export interface InstalledPlugin {
  name: string;
  market: string;
  version: string;
  displayName: string;
  description: string;
  author: string;
  path: string;
  installedAt: number;
  enabled: boolean;
}

export interface SourceInfo {
  id: string;
  name: string;
  repo: string;
  enabled: boolean;
}

export interface PluginComponentInfo {
  type: string;
  available: boolean;
}

export interface PluginDetails {
  name: string;
  components: PluginComponentInfo[];
}
```

- [ ] **Step 2: 改 API**

`src/api/marketplace.ts` 整体替换为：

```typescript
import { invoke } from "@tauri-apps/api/core";
import type { PluginEntry, InstalledPlugin, SourceInfo, PluginDetails } from "../types/marketplace";

export const marketplaceApi = {
  listMarketplaceSources(): Promise<SourceInfo[]> { return invoke("list_marketplace_sources"); },
  setMarketplaceEnabled(sourceId: string, enabled: boolean): Promise<void> {
    return invoke("set_marketplace_enabled", { sourceId, enabled });
  },
  fetchMarketplace(sourceId: string): Promise<PluginEntry[]> { return invoke("fetch_marketplace", { sourceId }); },
  refreshMarketplace(sourceId: string): Promise<void> { return invoke("refresh_marketplace", { sourceId }); },
  installPlugin(sourceId: string, pluginName: string): Promise<void> {
    return invoke("install_plugin", { sourceId, pluginName });
  },
  uninstallPlugin(marketplace: string, pluginName: string): Promise<void> {
    return invoke("uninstall_plugin", { marketplace, pluginName });
  },
  updatePlugin(sourceId: string, pluginName: string): Promise<void> {
    return invoke("update_plugin", { sourceId, pluginName });
  },
  listInstalledPlugins(): Promise<InstalledPlugin[]> { return invoke("list_installed_plugins"); },
  setPluginEnabled(marketplace: string, plugin: string, enabled: boolean): Promise<void> {
    return invoke("set_plugin_enabled", { marketplace, plugin, enabled });
  },
  getPluginDetails(sourceId: string, pluginName: string): Promise<PluginDetails> {
    return invoke("get_plugin_details", { sourceId, pluginName });
  },
};
```

> `get_plugin_details` 对应 Rust 命令在 Task 13 实装；本 Task 先在前端定义，Rust 侧 Task 13 补命令并注册。

- [ ] **Step 3: 类型检查**

Run: 根目录 `npx vue-tsc --noEmit` → 应仅报 `MarketplaceTab/useMarketplace` 引用旧字段的错误（后续 Task 修），类型/api 本身通过。

- [ ] **Step 4: 提交**

```bash
git add src/types/marketplace.ts src/api/marketplace.ts
git commit -m "feat(marketplace): 前端多源类型与 API 层

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: useMarketplace 重写（多源 + 启用 + 可用性过滤）

**Files:**
- Modify: `src/composables/useMarketplace.ts`

**Interfaces:**
- 状态：`sources:Ref<SourceInfo[]>`、`plugins`（合并多源、已过滤 unavailable）、`hiddenCount`、`installedPlugins:Map<key,InstalledPlugin>`、`loading`、`installing`、`updating`、`error`。
- 行为：`fetchSources()`、`fetchPlugins()`（按 enabled 源逐个拉、合并、过滤 `availability!=="unavailable"`、统计 hiddenCount）、`installPlugin`、`uninstallPlugin`、`updatePlugin`、`setEnabled`、`refreshSource`、`setSourceEnabled`、`hasUpdate(entry)`（前端比对 installed.version vs entry.version）。

- [ ] **Step 1: 重写 composable**

`src/composables/useMarketplace.ts` 整体替换为：

```typescript
import { ref, computed } from "vue";
import type { PluginEntry, InstalledPlugin, SourceInfo } from "../types/marketplace";
import { marketplaceApi } from "../api/marketplace";
import { parseGitError } from "../utils/errors";
import type { ErrorAction } from "../utils/errors";

const sources = ref<SourceInfo[]>([]);
const plugins = ref<PluginEntry[]>([]);
const installedPlugins = ref<Map<string, InstalledPlugin>>(new Map());
const loading = ref(false);
const installing = ref<Set<string>>(new Set());
const updating = ref<Set<string>>(new Set());
const error = ref<string | null>(null);
const errorActions = ref<ErrorAction[]>([]);
const searchQuery = ref("");
const hiddenCount = ref(0);

const keyOf = (market: string, name: string) => `${name}@${market}`;

const filteredPlugins = computed(() => {
  const q = searchQuery.value.toLowerCase().trim();
  if (!q) return plugins.value;
  return plugins.value.filter((p) =>
    p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
  );
});

async function fetchSources() {
  try { sources.value = await marketplaceApi.listMarketplaceSources(); } catch (_) { /* best effort */ }
}

async function fetchPlugins() {
  loading.value = true; error.value = null; plugins.value = []; hiddenCount.value = 0;
  const enabledSources = sources.value.length ? sources.value.filter((s) => s.enabled) : [];
  try {
    let all: PluginEntry[] = []; let hidden = 0;
    for (const s of enabledSources) {
      try {
        const list = await marketplaceApi.fetchMarketplace(s.id);
        for (const p of list) { if (p.availability === "unavailable") { hidden++; } else { all.push(p); } }
      } catch (e) { /* 单源失败不阻断其他源；错误经 error 展示最后一次 */ setError(e); }
    }
    plugins.value = all; hiddenCount.value = hidden;
  } finally { loading.value = false; }
}

function setError(e: unknown) {
  const raw = typeof e === "string" ? e : (e as Error).message || "UNKNOWN_ERROR";
  const parsed = parseGitError(raw);
  error.value = parsed.message; errorActions.value = parsed.actions;
}

async function refreshInstalled() {
  try {
    const list = await marketplaceApi.listInstalledPlugins();
    const map = new Map<string, InstalledPlugin>();
    for (const p of list) map.set(keyOf(p.market, p.name), p);
    installedPlugins.value = map;
  } catch (_) { /* best effort */ }
}

function isInstalled(market: string, name: string) { return installedPlugins.value.has(keyOf(market, name)); }
function isInstalling(name: string) { return installing.value.has(name); }
function getInstalled(market: string, name: string) { return installedPlugins.value.get(keyOf(market, name)); }
function hasUpdate(entry: PluginEntry) {
  const inst = getInstalled(entry.marketName, entry.name);
  return !!inst && !!entry.version && inst.version !== entry.version;
}

async function installPlugin(entry: PluginEntry) {
  if (installing.value.has(entry.name)) return;
  installing.value = new Set([...installing.value, entry.name]); error.value = null;
  try { await marketplaceApi.installPlugin(entry.sourceId, entry.name); await refreshInstalled(); }
  catch (e) { setError(e); } finally { del(installing, entry.name); }
}
async function uninstallPlugin(entry: { market: string; name: string }) {
  if (installing.value.has(entry.name)) return;
  installing.value = new Set([...installing.value, entry.name]); error.value = null;
  try { await marketplaceApi.uninstallPlugin(entry.market, entry.name); await refreshInstalled(); }
  catch (e) { setError(e); } finally { del(installing, entry.name); }
}
async function updatePlugin(entry: PluginEntry) {
  if (updating.value.has(entry.name)) return;
  updating.value = new Set([...updating.value, entry.name]); error.value = null;
  try { await marketplaceApi.updatePlugin(entry.sourceId, entry.name); await refreshInstalled(); }
  catch (e) { setError(e); } finally { del(updating, entry.name); }
}
async function setEnabled(entry: { market: string; name: string }, enabled: boolean) {
  try { await marketplaceApi.setPluginEnabled(entry.market, entry.name, enabled); await refreshInstalled(); }
  catch (e) { setError(e); }
}
async function refreshSource(sourceId: string) {
  try { await marketplaceApi.refreshMarketplace(sourceId); await fetchPlugins(); }
  catch (e) { setError(e); }
}
async function setSourceEnabled(sourceId: string, enabled: boolean) {
  try { await marketplaceApi.setMarketplaceEnabled(sourceId, enabled); await fetchSources(); await fetchPlugins(); }
  catch (e) { setError(e); }
}
function del(set: Ref<Set<string>>, name: string) {
  const n = new Set(set.value); n.delete(name); set.value = n;
}
import type { Ref } from "vue";

export function useMarketplace() {
  return {
    sources, plugins, installedPlugins, loading, installing, updating,
    error, errorActions, searchQuery, hiddenCount, filteredPlugins,
    isInstalled, isInstalling, getInstalled, hasUpdate,
    fetchSources, fetchPlugins, refreshInstalled,
    installPlugin, uninstallPlugin, updatePlugin, setEnabled, refreshSource, setSourceEnabled,
  };
}
```

> `Ref` import 移到文件顶部与 `ref,computed` 同一行（实现时合并，勿重复声明）。

- [ ] **Step 2: 类型检查**

Run: `npx vue-tsc --noEmit` → 剩余错误只在 MarketplaceTab/PluginCard（Task 11/12 修）。

- [ ] **Step 3: 提交**

```bash
git add src/composables/useMarketplace.ts
git commit -m "feat(marketplace): useMarketplace 多源 + 启用 + 可用性过滤

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 11: MarketplaceTab 源开关条 + 列表（严格按 mockup，--aide-* token）

**Files:**
- Modify: `src/components/marketplace/MarketplaceTab.vue`
- Modify: `src/components/SettingsPanel.vue`（若引用旧 prop 则适配）

**视觉基准**：`docs/superpowers/specs/2026-07-13-marketplace-mockup.html` 的 `.sources`（源开关条）、`.main-head`、`.filter-row`、`.list`、`.foot`。token 按本计划「Mockup 角色 → 真实 token 映射表」替换。

- [ ] **Step 1: 重写 MarketplaceTab 模板与样式**

按 mockup 的窗口内结构（不含 `.window`/`.titlebar`/`.nav`——那些是 Aide 已有的设置外壳）移植：
- `.main-head`：标题「插件市场」+ 副标题 + 搜索框（`--aide-surface-default` 底，focus 环 `color-mix(... --aide-accent 45%, transparent)`）。
- `.sources`：遍历 `sources`，每条 `.chip`（on 态 `--aide-accent-subtle` 底 + accent 边框 + `--aide-success` 圆点；off 态 `--aide-surface-default` 底 + `--aide-text-muted` 圆点）。含插件计数（取 `plugins` 中该 sourceId 的数量）、刷新按钮（⟳，hover `--aide-accent`）、开关 `.switch`（on `--aide-accent`，圆点白）。点芯片体切换 `setSourceEnabled`；点 ⟳ 调 `refreshSource`。右侧 hint「固定源，不可自加 · `<repo>`」用 `--aide-text-muted`。
- `.filter-row`：类别标签由 `plugins` 的 `category` 动态聚合（去重 + 计数），active 用 accent。
- `.list`：`filteredPlugins` 渲染 `MarketplacePluginCard`（Task 12）。
- 隐藏行：「已隐藏 {{ hiddenCount }} 个 Aide 不可用的插件」，`--aide-text-muted`，可点展开（v-if 折叠态，本 Task 先只显示文字，展开列表复用同一 card 但传 `unavailable` 标记灰显——简化：本 Task 实现文字 + 一个展开开关控制一个额外 `showHidden` ref，展开时渲染 `availability==='unavailable'` 的条目，仍走 PluginCard 但禁用安装）。
- `.foot`：`{{ installedPlugins.size }} 已 installed · {{ enabledCount }} 已启用 · 启用变更在下一次消息往返生效`。
- `<style>` 全部用映射表的 `--aide-*` token；`font-size: 14px` 的三角箭头（▾/⟳）。
- `onMounted`：`fetchSources()` → `fetchPlugins()` + `refreshInstalled()`。

完整模板较长，**以 mockup HTML 为精确蓝本**逐段移植（DOM 结构与 class 名与 mockup 一致，仅把内联 CSS 的 hex 换成 token、把静态示例数据换成 `v-for` 绑定）。关键绑定片段：

```vue
<div class="sources">
  <span class="lbl">源</span>
  <div v-for="s in sources" :key="s.id" class="chip" :class="{ on: s.enabled }" @click="setSourceEnabled(s.id, !s.enabled)">
    <span class="dot"></span><span class="nm">{{ sourceLabel(s.id) }}</span>
    <span class="cnt">{{ countOf(s.id) }}</span>
    <span class="refr" @click.stop="refreshSource(s.id)">⟳</span>
    <span class="switch" @click.stop="setSourceEnabled(s.id, !s.enabled)"></span>
  </div>
  <span class="src-hint">固定源，不可自加 · <code>{{ activeRepo }}</code></span>
</div>
```

`sourceLabel`：官方→「Anthropic 官方」、社区→「社区」（按 `s.id` 映射）。`countOf`：`plugins.filter(p=>p.sourceId===s.id).length`。`activeRepo`：选中源或第一个启用源的 repo。

- [ ] **Step 2: 适配 SettingsPanel**

检查 `SettingsPanel.vue:290-297,521-523` 对 `MarketplaceTab` 的引用，若传旧 prop（如 url）则删除，改用 composable 内部状态。

- [ ] **Step 3: 类型检查 + 启动 dev 看视觉**

Run: `npx vue-tsc --noEmit` → 无 MarketplaceTab 报错（PluginCard 报错留 Task 12）。
Run: `pnpm tauri dev`（用户侧）→ 打开设置→市场，对照 mockup 视觉（token 已替换，色调应是真实 warm-dark）。

- [ ] **Step 4: 提交**

```bash
git add src/components/marketplace/MarketplaceTab.vue src/components/SettingsPanel.vue
git commit -m "feat(marketplace): 源开关条 + 多源列表（按 mockup，--aide-* token）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 12: PluginCard 五状态 + caveat + npm 灰

**Files:**
- Modify: `src/components/marketplace/MarketplacePluginCard.vue`

**视觉基准**：mockup 的 `.card`。token 按映射表。

- [ ] **Step 1: 重写卡片**

props：`entry: PluginEntry`。用 composable 的 `isInstalled/getInstalled/hasUpdate/isInstalling`。状态分支：
- 未安装 + 可用 → `安装`（primary `--aide-accent`）；npm 源（`entry` 标记：若 `entry.availability` 非 unavailable 但需判 npm——后端 `PluginEntry` 未带 sourceKind；简化：npm 判定移到后端，本 Task 不处理 npm 灰，由 Task 4 的 `install_plugin` 返回 `NPM_UNSUPPORTED` 错误经 `setError` 展示；卡片层不灰）。**修正**：按设计 §3.4，npm 在列表层不灰，安装时报错。故卡片只处理四态 + 更新 + caveat。
- 已启用 → 状态点 `--aide-success` + 「已启用」+ `禁用` + `卸载`（`--aide-danger`）。
- 已禁用 → 状态点 `--aide-text-muted` + 「已禁用」+ `启用`(primary) + `卸载`。
- 有更新 → 「有更新」徽标(`--aide-warning`) + `更新` 按钮。
- `availability==='mixed'` → caveat 标：`unsupported` 映射成中文（lsp_servers→LSP、output_styles→输出样式、themes→主题、monitors→后台监控），「{X} 在 Aide 中不可用」，`--aide-warning`。
- `availability==='unavailable'`（隐藏行展开时）→ 灰显 + 「在 Aide 中不可用」+ 安装禁用。

社区源安装前确认：`installPlugin` 前若 `entry.sourceId==='claude-community'` 弹 `useModal().confirm('此插件将执行代码，请确认信任来源')`，确认后才调。

绑定骨架（完整 DOM/style 按 mockup `.card`，token 替换）：

```vue
<div class="card" :class="{ npm: entry.availability==='unavailable' }">
  <div>
    <div class="top">
      <span class="name">{{ entry.displayName || entry.name }}</span>
      <span class="ver">v{{ entry.version || '—' }}</span>
      <span class="badge" :class="entry.sourceId==='claude-plugins-official'?'official':'community'">{{ sourceLabel }}</span>
      <span class="cat" v-if="entry.category">{{ entry.category }}</span>
    </div>
    <div class="desc">{{ entry.description }}</div>
    <span class="caveat" v-if="entry.availability==='mixed'">{{ caveatText }}</span>
    <span class="caveat" v-else-if="entry.availability==='unavailable'">在 Aide 中不可用</span>
  </div>
  <div class="actions">
    <div class="status" :class="statusClass"><span class="d"></span>{{ statusText }}</div>
    <div class="btns">
      <button v-if="hasUpdate(entry)" class="btn" @click="updatePlugin(entry)">更新</button>
      <button v-if="!installed" class="btn primary" @click="onInstall" :disabled="entry.availability==='unavailable'">安装</button>
      <button v-else-if="installed.enabled" class="btn" @click="setEnabled(entry,false)">禁用</button>
      <button v-else class="btn primary" @click="setEnabled(entry,true)">启用</button>
      <button v-if="installed" class="btn danger" @click="uninstallPlugin(entry)">卸载</button>
    </div>
  </div>
</div>
```

`caveatText`：`entry.unsupported.map(mapComp).join('、') + ' 在 Aide 中不可用'`。

- [ ] **Step 2: 类型检查 + dev 视觉**

Run: `npx vue-tsc --noEmit` → 通过。
Run: `pnpm tauri dev` → 卡片各状态对照 mockup。

- [ ] **Step 3: 提交**

```bash
git add src/components/marketplace/MarketplacePluginCard.vue
git commit -m "feat(marketplace): 插件卡片五状态 + caveat + 信任确认

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 13: 插件详情视图 + 后端 get_plugin_details 命令

**Files:**
- Create: `src/components/marketplace/PluginDetail.vue`
- Modify: `src-tauri/src/commands/marketplace/manifest.rs` + `mod.rs`（`get_plugin_details` 命令）
- Modify: `src-tauri/src/lib.rs`（注册）
- Modify: `MarketplaceTab.vue` / `MarketplacePluginCard.vue`（点击卡片名打开详情）

**Interfaces:**
- Rust `async fn get_plugin_details(source_id:String, plugin_name:String) -> Result<PluginDetails,String>`：克隆该插件到临时目录（或读源 cache 内联字段）→ 读 plugin.json + 条目内联字段 → 返回 `{name, components:[{type, available}]}`（available = type 在 skills/commands/agents/hooks/mcp_servers 内）。

- [ ] **Step 1: Rust 命令**

`manifest.rs` 加：

```rust
use serde::Serialize;
#[derive(Serialize)] pub struct PluginComponent {
    #[serde(rename = "type")] pub r#type: String,   // r#type 是 Rust 关键字转义；序列化键必须是 "type"
    pub available: bool,
}
#[derive(Serialize)] pub struct PluginDetails { pub name: String, pub components: Vec<PluginComponent> }

pub fn build_details_from_entry(entry: &crate::commands::marketplace::sources::RawPluginEntry) -> PluginDetails {
    let comps = vec![
        ("skills", entry.skills.is_some()), ("commands", entry.commands.is_some()),
        ("agents", entry.agents.is_some()), ("hooks", entry.hooks.is_some()),
        ("mcpServers", entry.mcp_servers.is_some()),
        ("lspServers", entry.lsp_servers.is_some()), ("outputStyles", entry.output_styles.is_some()),
        ("themes", entry.themes.is_some()), ("monitors", entry.monitors.is_some()),
    ];
    let supported = ["skills","commands","agents","hooks","mcpServers"];
    PluginDetails {
        name: entry.name.clone(),
        components: comps.into_iter().filter(|(_,has)|*has).map(|(t,_)| PluginComponent {
            r#type: t.to_string(), available: supported.contains(&t),
        }).collect(),
    }
}
```

`mod.rs` 命令：

```rust
#[tauri::command]
pub async fn get_plugin_details(source_id: String, plugin_name: String) -> Result<manifest::PluginDetails, String> {
    tokio::task::spawn_blocking(move || -> Result<manifest::PluginDetails, String> {
        let (_market, entry) = install::lookup_entry(&source_id, &plugin_name)?;
        // 若条目内联了组件字段，直接用；否则需克隆 plugin 读 plugin.json（简化：先返回内联的；无内联则 components 为空，提示"点安装后可知"）
        Ok(manifest::build_details_from_entry(&entry))
    }).await.map_err(|e| e.to_string())?
}
```

> 说明：v1 详情基于 marketplace 条目内联字段；不内联的插件详情为空（前端提示「组件清单在安装后由 SDK 自动发现」）。完整拉 plugin.json 的详情留作后续——避免列表外逐个 clone。

`lib.rs` 注册：`commands::marketplace::get_plugin_details,`

- [ ] **Step 2: 前端 PluginDetail.vue**

新建组件：用 `useModal` 弹窗展示 `getPluginDetails` 结果，逐组件 `available?可用:在 Aide 中不可用`（可用 `--aide-success`，不可用 `--aide-warning`）。全部不可用 → 顶部红字「此插件在 Aide 中不可用」+ 安装按钮禁用。token 走映射表。

- [ ] **Step 3: 卡片点击打开详情**

`MarketplacePluginCard.vue` 给 `.name` 加 `@click="openDetail"`，调 `marketplaceApi.getPluginDetails(entry.sourceId, entry.name)` → `useModal().notice(...)` 或自定义弹窗渲染 `PluginDetail`。

- [ ] **Step 4: 类型检查 + 编译**

Run: `cd src-tauri && cargo build` → 通过。
Run: `npx vue-tsc --noEmit` → 通过。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/commands/marketplace/ src-tauri/src/lib.rs src/components/marketplace/PluginDetail.vue src/components/marketplace/MarketplacePluginCard.vue
git commit -m "feat(marketplace): 插件详情视图 + 组件可用性清单

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 14: 启动后台更新检查 + 通知

**Files:**
- Modify: `src/App.vue:434`（onMounted 内加检查）

**Interfaces:**
- App ready 后：对每个 `enabled` 源 `refreshMarketplace`（不阻塞 UI，try/catch）→ 重新 `fetchMarketplace` → 与 `listInstalledPlugins` 比对，统计 `hasUpdate` 数与失败源数 → `api.notifySend`。

- [ ] **Step 1: 加启动检查**

`App.vue` onMounted 内（现有逻辑之后）加：

```typescript
// 启动后台静默检查插件市场更新（方案 B：只通知，不自动应用）
void (async () => {
  try {
    const sources = await marketplaceApi.listMarketplaceSources();
    let failed = 0;
    for (const s of sources.filter((x) => x.enabled)) {
      try { await marketplaceApi.refreshMarketplace(s.id); }
      catch { failed++; }
    }
    if (failed === sources.filter((x)=>x.enabled).length && sources.some((x)=>x.enabled)) {
      await api.notifySend("市场更新拉取失败", "无法连接市场源，请检查网络或代理。");
      return;
    }
    // 比对已装插件版本
    const installed = await marketplaceApi.listInstalledPlugins();
    let updates = 0;
    for (const s of sources.filter((x)=>x.enabled)) {
      try {
        const list = await marketplaceApi.fetchMarketplace(s.id);
        for (const p of list) {
          if (installed.some((i) => i.market === p.marketName && i.name === p.name && p.version && i.version !== p.version)) updates++;
        }
      } catch { /* 单源失败已在上方统计 */ }
    }
    if (updates > 0) await api.notifySend(`${updates} 个插件有更新`, "打开设置 → 市场查看并更新。");
  } catch { /* 静默：启动检查不应影响主流程 */ }
})();
```

> `marketplaceApi` 与 `api`（含 `notifySend`）从既有 import 路径引入（`src/api/marketplace`、`src/api`）。确保 onMounted 顶部已 import。

- [ ] **Step 2: 类型检查**

Run: `npx vue-tsc --noEmit` → 通过。

- [ ] **Step 3: 提交**

```bash
git add src/App.vue
git commit -m "feat(marketplace): 启动后台更新检查 + 通知

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 15: 错误码 + go-marketplace-settings 接线

**Files:**
- Modify: `src/utils/errors.ts`
- Modify: `src/components/marketplace/MarketplaceTab.vue`（处理 `go-marketplace-settings` action → 滚动/聚焦源开关条）

- [ ] **Step 1: 加错误码**

`errors.ts` `ERROR_MAP` 加：

```typescript
  NPM_UNSUPPORTED: { message: "npm 源插件暂不支持安装。", actions: ["retry"] },
  SOURCE_TYPE_UNSUPPORTED: { message: "未知的插件源类型。", actions: ["retry"] },
```

`actionLabel` 无需新增（`go-marketplace-settings` 已有）。

- [ ] **Step 2: 接线 go-marketplace-settings**

`MarketplaceTab.vue` 错误条渲染 `errorActions`：`go-marketplace-settings` kind → 滚动到 `.sources` 顶栏并高亮（加临时 class 触发 accent 边框 1s）。其余 kind（retry/go-proxy-settings）保持现有处理。

- [ ] **Step 3: 类型检查**

Run: `npx vue-tsc --noEmit` → 通过。

- [ ] **Step 4: 提交**

```bash
git add src/utils/errors.ts src/components/marketplace/MarketplaceTab.vue
git commit -m "feat(marketplace): npm/未知源错误码 + 源切换动作接线

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 16: 端到端验证 + 全量测试 + dist 重建

**Files:** 无新文件，仅验证。

- [ ] **Step 1: Rust 全测**

Run: `cd src-tauri && cargo test --lib` → 全绿。

- [ ] **Step 2: 前端全测**

Run: 根目录 `npx vitest run` → 全绿（覆盖 src/ 与 agent-sidecar/src/）。

- [ ] **Step 3: 类型检查**

Run: `npx vue-tsc --noEmit` → 无错。

- [ ] **Step 4: sidecar dist 已最新**

确认 `agent-sidecar/dist/sidecar.js` 已随 Task 8 重建并提交；若后续改过 sidecar 源码，再 `cd agent-sidecar && pnpm build` 并提交。

- [ ] **Step 5: 手测 E2E**

Run: `pnpm tauri dev` →
1. 设置→市场：见官方+社区两条源芯片，均开。
2. 搜 `commit-commands` → 点安装 → 完成后卡变「已启用 / 禁用 / 卸载」。
3. 聊天框打 `/` → 出现 `commit-commands:commit` skill。
4. 装一个社区插件 → 弹信任确认。
5. 卸载某插件 → `/` 下拉消失。
6. 官方源 12 个 LSP 插件不在列表，底部「已隐藏 12 个」可见。
7. 断网重启 → 收到「市场更新拉取失败」通知。

- [ ] **Step 6: 最终提交（若有验证修整）**

```bash
git add -A
git commit -m "test(marketplace): 端到端验证通过

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 实现期需验证的风险（来自设计 §9）

1. `skills:"all"` × `options.plugins` 是否双重计数插件 skills → Task 8 完成后实测 `/` 下拉与 SDK 自主调用是否重复；若重复，Task 8 改为不传 `skills:"all"` 或仅传 `options.plugins`。
2. 真实源 `category` 值分布 → Task 11 类别筛选改为动态聚合（已按此设计）。
3. GitSubdir 稀疏克隆在 Windows + 代理下 → Task 5 手测验证；失败则退化为全 clone + 取子目录。
4. 启动检查与手动刷新并发 → Task 14 与 Task 10 的 `refreshSource` 复用按 source_id 串行（fetchPlugins 顺序 await，天然不并发；启动检查独立，若同时刷新同一源可能重复 git pull——可接受，git pull 幂等）。