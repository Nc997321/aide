# Aide 独立设置与工具权限体系 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Aide 从依赖 Claude Code `.claude/settings.json` 的设置与工具授权迁移为自己的分层、可迁移、可解释、即时生效且不在 JSON 中保存秘密的设置体系，并交付主题化的权限管理页面。

**Architecture:** 在 Rust 根模块建立 `settings/` 与 `policy/` 两个独立领域：前者负责 schema、描述符、分层文件、原子迁移和 OS 凭据库，后者负责 provider-agnostic 的规则校验、合并、解释和策略快照。Tauri command 仅是异步边界；活动会话的策略快照经既有 Rust→sidecar stdin 协议下发。`agent-sidecar/` 只实现通用快照匹配和 Claude Agent SDK hook/permission adapter，Vue 通过独立 API、composable、表单模块展示和编辑规则，不把业务堆进 `SettingsPanel.vue`。

**Tech Stack:** Rust 2021、Tauri v2、Serde、OS credential-store crate（`keyring`）、TypeScript、Vue 3 Composition API、Vitest + `@vue/test-utils`/jsdom、Claude Agent SDK 0.3.197。

## Global Constraints

- Aide 设置文件固定为：受管策略（Windows `%ProgramData%/Aide/settings.json`、macOS `/Library/Application Support/Aide/settings.json`、Linux `/etc/aide/settings.json`）、`~/.aide/settings.json`、`<project>/.aide/settings.json`、`<project>/.aide/settings.local.json`；会话临时层只在内存中。
- 不读取、写入或解释 Claude Code `.claude/settings.json`、`.claude/settings.local.json` 的权限规则；不要实现其格式兼容层。
- `settingSources` 必须改为 `[]`，同时由 sidecar 自己加载 `~/.aide/claude/CLAUDE.md` 和项目根 `CLAUDE.md` 并追加到 SDK preset system prompt；不得因此丢失 Aide 指令。
- `allow | ask | deny`、工具名、命令/路径/经审核字段条件是核心 provider-agnostic 协议；Rust、Vue 和通用 sidecar 模块中不得出现 `PermissionUpdate`、`updatedPermissions`、Claude destination 或 Claude permission-mode 语义。
- 任何上层 scope 命中的 `deny` 都不能被下层 `allow` 放宽；同一 scope 先按具体度、再按稳定数组顺序决定该 scope 的候选规则；没有匹配规则时完整回退现有 provider permission mode。
- Bash 前缀 allow 不能因 `&&`、`;`、管道、重定向、命令替换等未引用 shell 控制语法而放宽；Bash `contains` 只允许作为 `ask`/`deny` 条件，禁止作为 `allow` 条件。
- 文件夹规则必须按归一化路径组件比较，不能做字符串前缀匹配；sidecar 执行时还要解析最深存在祖先以防 symlink 从已允许目录逃逸。
- API Key、auth token、CodeGraph key 和任何未来标为 sensitive 的描述符值绝不写入任何 `settings*.json`、不会从 Rust 返回 Vue、不会写入日志、测试快照或错误字符串。只返回 `configured` 状态和 opaque reference。
- 所有会触碰磁盘、序列化或 keychain 的 Tauri command 必须是 `async fn + spawn_blocking`；`State<T>` 不跨越 `spawn_blocking`，服务以 `Arc<T>` 注册并 clone 后 move 进闭包。
- Rust/Vue 保持 provider-agnostic；Claude SDK hook、`canUseTool`、`AskUserQuestion` 输入重组和 SDK system prompt 只允许在 `agent-sidecar/`。
- Windows 上新增的外部 Rust `Command` 必须设置 `CREATE_NO_WINDOW`；本计划不应新增外部进程。把 release resource path 传给外部程序时始终用 `dunce::simplified()`。
- 权限页、表单和 toast 只能使用既有 `--aide-*` token、`ThemedSelect`、`Icon`、`v-tooltip`、`useModal` 与 `useToast`；禁止硬编码颜色/圆角/间距/阴影，禁止 `title`、`window.alert`、`window.confirm`、`window.prompt`。
- 现有 PermissionDialog 的 `ExitPlanMode`、`AskUserQuestion`、中断取消、子代理来源、队列顺序、模型/permission-mode 控件都必须保留；只移除 SDK 设置持久化副作用。
- 保持 sidecar stdout 经 `deltaCoalescer` 的唯一出口；不要为策略更新绕过现有 runtime transport。
- 不自动执行 `git commit` 或 `git push`。每个任务结束只检查 diff 和测试；只有用户另行明确要求时才提交。
- 如果安装 `keyring`、`@vue/test-utils` 或 `jsdom` 的网络请求失败，不重试；按用户全局规则询问是否启动 `http://127.0.0.1:7890` 代理后再继续。

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `src-tauri/src/settings/mod.rs` | `SettingsService`、路径入口、异步服务装配和公共 re-export。 |
| `src-tauri/src/settings/schema.rs` | 统一 settings document、scope、公开/敏感设置值及 serde schema。 |
| `src-tauri/src/settings/descriptors.rs` | 所有持久化字段的 descriptor catalog、scope/sensitivity/UI-owner 校验。 |
| `src-tauri/src/settings/store.rs` | 分层文档读取、未知安全字段保留、临时文件+rename 原子写入。 |
| `src-tauri/src/settings/secrets.rs` | `SecretStore` trait、keyring 实现、内存测试 fake、opaque secret references。 |
| `src-tauri/src/settings/migration.rs` | `config.json` 一次性迁移、秘密抽取、已脱敏备份和幂等恢复。 |
| `src-tauri/src/policy/{mod.rs,model.rs,matchers.rs,evaluate.rs}` | provider-agnostic 规则模型、验证、路径/Bash/字段匹配、解释链和有效快照。 |
| `src-tauri/src/policy/fixtures/permission-policy.json` | Rust 与 TypeScript 共用的 precedence/安全匹配 fixture。 |
| `src-tauri/src/commands/settings.rs` | 现有普通设置 command 的薄异步 facade；不再直接读写 `config.json`。 |
| `src-tauri/src/commands/permissions.rs` | 权限 scope、规则 CRUD、决策解释 command；写成功后广播新快照。 |
| `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs` | 注册 settings/policy 服务及 permissions command。 |
| `src-tauri/src/runtime/mod.rs`, `src-tauri/src/commands/chat.rs` | 活动 session→workspace 路由表；send 初始快照及保存后的即时广播。 |
| `src-tauri/src/runtime/provider/mod.rs`, `src-tauri/src/commands/provider.rs` | 将 provider 持久化视图与私有 runtime credential 分离。 |
| `agent-sidecar/src/policy/{types.ts,matchers.ts,evaluate.ts}` | 与 Rust fixture 对齐的通用策略匹配器。 |
| `agent-sidecar/src/instructions.ts` | 不依赖 SDK setting source 的 Aide/global/project `CLAUDE.md` loader。 |
| `agent-sidecar/src/permissions.ts` | 保留 Claude 确认适配和 AskUserQuestion 重组，删除 SDK 规则持久化。 |
| `agent-sidecar/src/session-worker.ts`, `agent-sidecar/src/session-manager.ts`, `agent-sidecar/src/types.ts` | snapshot 生命周期、PreToolUse enforcement、live update command 与 wire 类型。 |
| `src/types/permissions.ts`, `src/api/permissions.ts`, `src/composables/usePermissions.ts` | Vue 的 provider-agnostic 权限 DTO、Tauri invoke 封装和保留草稿的状态层。 |
| `src/components/settings/permissions/*` | scope tabs、规则列表、编辑器、解释面板和主题化样式。 |
| `src/composables/useModal.ts`, `src/components/ModalDialog.vue` | 可复用受控 custom-form modal 模式。 |
| `src/components/SettingsPanel.vue`, `src/components/PermissionDialog.vue`, `src/types/chat.ts` | 权限 tab 接线，并移除 SDK “always allow” UI/协议字段。 |
| `src/components/ProviderSettings.vue`, `src/composables/useSettings.ts`, `src/types.ts` | 不回显 provider/CodeGraph secrets 的 configured-state UI。 |

## Canonical Contracts

所有持久化文件共享以下外层，未知 `values` 成员必须 round-trip：

```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDocument {
    pub schema_version: u32,
    #[serde(default)]
    pub values: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub permissions: PermissionSection,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, Eq, PartialEq, Ord, PartialOrd)]
#[serde(rename_all = "lowercase")]
pub enum SettingsScope { Managed, User, Project, Local, Session }
```

策略 snapshot 是 Rust→sidecar 的唯一授权输入；`revision` 单调递增，sidecar 只接受不低于当前值的 snapshot：

```ts
export interface PermissionPolicySnapshot {
  revision: number;
  rules: PermissionRule[];
}

export interface PermissionRule {
  id: string;
  scope: "managed" | "user" | "project" | "local" | "session";
  order: number;
  effect: "allow" | "ask" | "deny";
  tool: string;
  matcher: PermissionMatcher;
  source: { label: string; path?: string; readOnly: boolean };
}
```

`PermissionMatcher` 只能是以下可解释联合：

```ts
export type PermissionMatcher =
  | { kind: "tool" }
  | { kind: "bash"; mode: "all" | "prefix" | "contains"; value?: string }
  | { kind: "path"; field: "file_path" | "path" | "notebook_path"; folder?: string }
  | { kind: "field"; field: "url" | "query" | "command"; equals: string };
```

同一 scope 的候选规则按 `(specificity DESC, order ASC)` 选择；各 scope 的 winner 中只要存在 `deny` 即拒绝，且解释链记录该 deny 压过的低层结果；否则按 `session > local > project > user > managed` 选择 winner。无 winner 返回 `defer`。

---

### Task 1: 建立统一 schema、描述符目录和可测试的 settings 服务边界

**Files:**
- Create: `src-tauri/src/settings/mod.rs`
- Create: `src-tauri/src/settings/schema.rs`
- Create: `src-tauri/src/settings/descriptors.rs`
- Create: `src-tauri/src/settings/schema_test.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `SettingsDocument`, `SettingsScope`, `SettingDescriptor`, `SettingValueKind`, `SettingsService`。
- Produces: `all_descriptors() -> &'static [SettingDescriptor]` 与 `validate_descriptor_catalog()`。
- Consumes later: storage/migration/policy commands only depend on `SettingsService`, not on `commands::settings::config_path()`.

- [x] **Step 1: 先检查 Cargo 依赖文件的既有修改归属**

Run:

```bash
git diff -- src-tauri/Cargo.toml package.json pnpm-lock.yaml
```

Expected: 记录现有 diff；若 `src-tauri/Cargo.toml` 仍有不是本任务产生的改动，先将它保留原样。Task 2 需要加入 `keyring` 前，实施者必须要求所有者确认该文件的基线，不能把未知 diff 一并覆盖或提交。

- [x] **Step 2: 写失败测试，锁定 schema 默认值、unknown-field round-trip 和 descriptor 完整性**

```rust
#[test]
fn settings_document_keeps_unknown_safe_values() {
    let mut doc: SettingsDocument = serde_json::from_value(serde_json::json!({
        "schemaVersion": 1,
        "values": { "futurePlugin": { "enabled": true } },
        "permissions": { "rules": [] }
    })).unwrap();
    doc.values.insert("settings".into(), serde_json::json!({ "theme": "glass" }));
    let saved = serde_json::to_value(&doc).unwrap();
    assert_eq!(saved["values"]["futurePlugin"]["enabled"], true);
}

#[test]
fn every_legacy_persisted_field_has_exactly_one_descriptor() {
    validate_descriptor_catalog().unwrap();
    let ids: std::collections::BTreeSet<_> = all_descriptors().iter().map(|d| d.id).collect();
    for expected in [
        "settings.fontSize", "settings.fontFamily", "settings.proxy",
        "settings.codegraphEmbedder", "providers", "activeProvider",
        "workspace", "hiddenWorkspaces", "systemDefaultModelMappings",
        "claudeMigrationDone", "claudeMigrationDismissed",
    ] {
        assert!(ids.contains(expected), "missing descriptor: {expected}");
    }
    assert_eq!(ids.len(), all_descriptors().len());
}
```

- [x] **Step 3: 运行测试，确认尚不存在实现**

Run: `cargo test --manifest-path src-tauri/Cargo.toml settings::schema_test`

Expected: FAIL，`settings` module 和相关类型不存在。

- [x] **Step 4: 实现数据模型与 catalog，不在 command 中复制 schema**

在 `schema.rs` 定义 `SETTINGS_SCHEMA_VERSION: u32 = 1`、`SettingsDocument`、`PermissionSection { rules: Vec<StoredPermissionRule> }`、`SettingsScope`，并给缺失 `permissions`/`values` serde default。`StoredPermissionRule` 不包含 `source` 与 `scope`（scope 来自所在 document），只包含稳定 UUID、effect、tool、matcher、稳定 order。

在 `descriptors.rs` 使用静态 catalog，不使用散落的字符串白名单：

```rust
pub struct SettingDescriptor {
    pub id: &'static str,
    pub default: serde_json::Value,
    pub kind: SettingValueKind,
    pub scopes: &'static [SettingsScope],
    pub ui_owner: &'static str,
    pub sensitive: bool,
    pub project_overridable: bool,
}

pub fn descriptor(id: &str) -> Option<&'static SettingDescriptor> {
    all_descriptors().iter().find(|entry| entry.id == id)
}
```

覆盖当前 `config.json` 的 `settings.*`、provider 元数据、workspace、`active_provider`、system default mapping、迁移标记、hidden workspaces、extensions/marketplaces、JDK 与权限 rules。`settings.codegraphEmbedder.apiKey`、`providers[].apiKey`、`providers[].authToken` 只能用 `sensitive: true` 描述符表示，不能给默认明文。明确 user-only 的 workspace/provider 字段；只将确有项目语义的 UI 偏好和 permissions 标记为 project/local 可覆盖。

在 `mod.rs` 只声明领域子模块并定义服务骨架：

```rust
pub struct SettingsService {
    paths: SettingsPaths,
    secrets: std::sync::Arc<dyn SecretStore>,
    state: std::sync::RwLock<SettingsState>,
}

impl SettingsService {
    pub fn new(paths: SettingsPaths, secrets: std::sync::Arc<dyn SecretStore>) -> Self;
    pub fn initialize_blocking(&self) -> Result<(), SettingsError>;
    pub fn effective_document_blocking(&self, project_root: Option<&std::path::Path>) -> Result<EffectiveSettings, SettingsError>;
}
```

注册根 `mod settings; mod policy;`，但本步骤不要删除旧 command；先让新模块可单独测试。

- [x] **Step 5: 运行 Rust schema 测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml settings::schema_test`

Expected: PASS；测试证明未知安全字段不丢失、catalog 中没有重复 ID、所有现有持久化字段均有 owner。

- [x] **Step 6: 检查本任务 diff，不提交**

Run: `git diff --check && git diff -- src-tauri/src/settings src-tauri/src/lib.rs`

Expected: 无 whitespace error；没有对已有 `config.json` 读写路径的行为变更。

---

### Task 2: 实现分层存储、OS secret store 与一次性安全迁移

**Files:**
- Create: `src-tauri/src/settings/store.rs`
- Create: `src-tauri/src/settings/secrets.rs`
- Create: `src-tauri/src/settings/migration.rs`
- Create: `src-tauri/src/settings/store_test.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/settings/mod.rs`
- Modify: `src-tauri/src/commands/mod.rs`

**Interfaces:**
- Produces: `SettingsPaths::managed/user/project_shared/project_local`, `SettingsStore::{read,write_atomic,mutate}`, `SecretStore`, `run_legacy_migration`。
- Produces: `EffectiveSettings { documents: Vec<LayeredDocument>, values: Value }`.
- Consumes: Task 1 schema/catalog; later commands call `SettingsService::mutate_scope_blocking`.

- [x] **Step 1: 添加 keyring 依赖前确认 Cargo 基线，然后写失败测试**

在确认 Task 1 的 Cargo diff 已归属后，在 `[dependencies]` 加入：

```toml
keyring = "3"
```

新增以下测试。文件操作全部在 `temp_dir()` 下进行，注入 `SettingsPaths` 与 `MemorySecretStore`，绝不触碰真实 keychain：

```rust
#[test]
fn failed_atomic_write_keeps_previous_document_and_cached_snapshot() {
    let fixture = TestStore::new();
    fixture.write_user(serde_json::json!({"schemaVersion": 1, "values": {"settings": {"theme": "warm-dark"}}}));
    fixture.fail_next_persist();
    assert!(fixture.service().mutate_scope_blocking(SettingsScope::User, |doc| {
        doc.values.insert("settings".into(), serde_json::json!({"theme": "glass"}));
        Ok(())
    }).is_err());
    assert_eq!(fixture.read_user()["values"]["settings"]["theme"], "warm-dark");
    assert_eq!(fixture.service().cached_theme(), "warm-dark");
}

#[test]
fn migration_moves_secret_and_never_keeps_it_in_settings_json() {
    let fixture = TestStore::with_legacy_config(serde_json::json!({
        "settings": {"codegraphEmbedder": {"apiKey": "cg-secret"}},
        "providers": [{"id": "p1", "apiKey": "provider-secret", "authToken": "token"}]
    }));
    fixture.service().initialize_blocking().unwrap();
    let text = std::fs::read_to_string(fixture.paths.user()).unwrap();
    assert!(!text.contains("cg-secret") && !text.contains("provider-secret") && !text.contains("token"));
    assert_eq!(fixture.secrets.get("codegraph/default/apiKey").unwrap().as_deref(), Some("cg-secret"));
    assert!(fixture.paths.legacy_config().exists() == false);
    assert!(fixture.paths.legacy_backup().exists());
}

#[test]
fn migration_is_idempotent_and_does_not_read_legacy_after_new_document_exists() {
    let fixture = TestStore::with_legacy_config(serde_json::json!({"settings": {"theme": "glass"}}));
    fixture.service().initialize_blocking().unwrap();
    std::fs::write(fixture.paths.legacy_config(), r#"{"settings":{"theme":"bad"}}"#).unwrap();
    fixture.service().initialize_blocking().unwrap();
    assert_eq!(fixture.service().cached_theme(), "glass");
}
```

- [x] **Step 2: 运行存储测试，确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml settings::store_test`

Expected: FAIL，store、migration、secret trait 与 test seam 尚不存在。

- [x] **Step 3: 实现路径、原子 writer 和 scope 可写性**

`SettingsPaths` 不能把平台路径字符串散落在 command 内：Windows 使用 `PROGRAMDATA`（缺失时明确报错，不回退用户目录），macOS/Linux 使用上述固定路径；测试通过构造函数注入路径。`project_shared`/`project_local` 只能在提供真实 project root 时返回。

`write_atomic` 要在目标目录创建 temp 文件，写入 prettified JSON、`sync_all()`、原子 rename；失败删除 temp 并返回原始路径上下文。仅在 writer 成功后替换 `SettingsService` 的缓存。对 project scope 先检查 directory/file 可写性，失败返回 `ScopeNotWritable { scope, path }`；不得创建或修改 `.gitignore`。

```rust
pub fn mutate_scope_blocking<F>(&self, scope: SettingsScope, project: Option<&Path>, f: F) -> Result<MutationResult, SettingsError>
where
    F: FnOnce(&mut SettingsDocument) -> Result<(), SettingsError>;
```

调用前读取并验证 candidate，调用 `f`，再次 descriptor/rule validation，原子写入，然后才更新 cache/revision。`Managed` 与 `Session` 永远返回 read-only error；会话层只由运行时建立，不能落盘。

- [x] **Step 4: 实现 secret abstraction 和迁移顺序**

`secrets.rs` 只暴露下列接口；`KeyringSecretStore` 用服务名 `io.aide.desktop`，账户名使用 `aide/settings/<stable-ref>`：

```rust
pub trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, SettingsError>;
    fn set(&self, key: &str, value: &str) -> Result<(), SettingsError>;
    fn delete(&self, key: &str) -> Result<(), SettingsError>;
}
```

`MemorySecretStore` 只在 `#[cfg(test)]` 或显式 test constructor 使用。任何 `SettingsError` 的 `Display` 只显示 logical secret key，绝不格式化 value。

迁移顺序固定为：读取 legacy → schema/descriptor validate → 提取并写入 keychain → 构造完全脱敏的 `SettingsDocument`（保留未知安全字段）→ 原子写 user `settings.json` → 原子写脱敏 `config.json.migrated.bak` → 删除 legacy `config.json`。若 settings write 失败，旧文件和 in-memory snapshot 都保持；若写入成功但删除 legacy 失败，新的 document 已成为唯一读取来源，启动记录不含秘密的警告并在下一次 initialize 只尝试清理/脱敏旧文件，绝不再次将它当作设置来源。

`config.json.migrated.bak` 必须删除/替换 API key、auth token、CodeGraph key 字段为 `{"configured": true}`，而不是保存旧明文。不要将原始 legacy JSON 放在 crash report 或 tracing。

- [x] **Step 5: 运行存储、迁移和 schema 测试**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml settings::
```

Expected: PASS；包括原子失败、层路径、迁移幂等、secret 脱敏和 unknown field 保留。

- [x] **Step 6: 运行格式与依赖检查，不提交**

Run:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml settings::
git diff --check
```

Expected: PASS；如果首次获取 `keyring` 失败，停止并按代理约束请求用户批准，不要重复拉取。

---

### Task 3: 把现有设置、Provider 与 CodeGraph consumer 切到新服务并隔离秘密

**Files:**
- Modify: `src-tauri/src/commands/settings.rs`
- Modify: `src-tauri/src/runtime/provider/mod.rs`
- Modify: `src-tauri/src/commands/provider.rs`
- Modify: `src-tauri/src/runtime/env.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands/settings.rs` tests and provider tests
- Modify: `src/types.ts`
- Modify: `src/composables/useSettings.ts`
- Modify: `src/components/ProviderSettings.vue`
- Modify: `src/components/SettingsPanel.vue`

**Interfaces:**
- Produces: public `ProviderConfigView` / `ProviderConfigInput` and `SecretMutation` (`unchanged | set | clear`) rather than returning raw credentials.
- Produces: public `CodeGraphEmbedderView { ..., apiKeyConfigured: boolean }`.
- Consumes: Task 2 `SettingsService` and `SecretStore`; runtime-only `ProviderConfig` remains private and may contain resolved values only in Rust memory.

- [x] **Step 1: 写失败测试，保证 API 响应和 JSON 永不泄漏秘密**

```rust
#[test]
fn provider_view_redacts_credentials_but_runtime_resolution_gets_them() {
    let service = test_service_with_secret("provider/p1/apiKey", "top-secret");
    service.save_provider_input(provider_input("p1", SecretMutation::Set("top-secret".into()))).unwrap();
    let view = service.list_provider_views().unwrap();
    assert!(view[0].api_key_configured);
    assert!(!serde_json::to_string(&view).unwrap().contains("top-secret"));
    assert_eq!(service.resolve_runtime_provider("p1").unwrap().api_key, "top-secret");
}

#[test]
fn get_settings_returns_configured_state_not_codegraph_key() {
    let service = test_service_with_secret("codegraph/default/apiKey", "secret");
    let settings = service.get_public_settings().unwrap();
    assert!(settings.codegraph_embedder.api_key_configured);
    assert!(!serde_json::to_string(&settings).unwrap().contains("secret"));
}
```

- [x] **Step 2: 运行测试，确认现有 raw `ProviderConfig` API 不满足约束**

Run: `cargo test --manifest-path src-tauri/Cargo.toml provider_view_redacts_credentials`

Expected: FAIL；当前 `ProviderConfig` 带 `api_key`/`auth_token`，并且从 config 直接读出。

- [x] **Step 3: 实现公开 view、输入 mutation 与 runtime-only resolver**

保留现有 Rust runtime `ProviderConfig` 作为私有的已解析对象，避免把 secret plumbing 扩散到各 strategy。新增边界 DTO：

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfigView {
    pub id: String,
    pub kind: ProviderKind,
    pub name: String,
    pub base_url: String,
    pub api_key_configured: bool,
    pub auth_token_configured: bool,
    // 其余原有非敏感字段
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretMutation { Unchanged, Set(String), Clear }
```

`set_providers` 接受 `ProviderConfigInput`，每个 secret 字段采用 `SecretMutation`；空 input 绝不能隐式清除现有 credential。保存 provider 元数据与 keychain mutation 必须在同一个 service mutation 事务中：先验证所有非敏感字段和 secret mutation，再写 keychain，最后原子写 document/cache。keychain 成功而 document 失败只会留下不可引用的 orphan credential，不能泄漏/启用它；记录不含 value 的清理诊断。

`get_settings` / `set_settings` 改为 async command，clone `Arc<SettingsService>` 后在 `spawn_blocking` 完成读取/写入。旧 `load_config/save_config/with_config_mut` 删除或降为仅迁移私有 helper，所有现有 caller 迁移到 service。`lib.rs` setup 中先 `initialize_blocking`，再启动 runtime；原有同步 `get_settings()` 调用改为在 async setup task 中 await 新的 service getter。

- [x] **Step 4: 将 Vue 状态改为 configured-state，不读取旧明文**

在 `src/types.ts` 将 `CodeGraphEmbedderConfig.apiKey: string` 改为 `apiKeyConfigured: boolean`；请求 payload 使用专用：

```ts
export type SecretMutation =
  | { action: "unchanged" }
  | { action: "set"; value: string }
  | { action: "clear" };
```

`useSettings` 不再把 API key 放入 defaults/reactive singleton；新增 `setCodegraphEmbedder(config, apiKey: SecretMutation)`，失败时抛出给调用方而不是吞掉。`ProviderSettings.vue` 将 credential 输入保留为组件本地空 `ref`：显示“已配置/未配置”、替换和清除按钮；加载 provider 时不得用 `v-model` 回填明文。`SettingsPanel.vue` 的 CodeGraph key 同样显示 configured state，只有用户新输入时才发送 `set`。

- [x] **Step 5: 运行 Rust、Vue 类型检查和既有 provider 回归**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml runtime::provider::
pnpm build
```

Expected: PASS；运行期环境变量仍可从 keychain-resolved provider 生成，Vue build 不再依赖 `apiKey: string`。

- [x] **Step 6: 检查 secret 回归，不提交**

Run:

```bash
git diff --check
git diff -- src-tauri/src/runtime/provider src-tauri/src/commands/settings.rs src/components/ProviderSettings.vue src/components/SettingsPanel.vue src/composables/useSettings.ts
```

Expected: 不出现从 backend 返回/持久化 raw secret 的新路径。

---

### Task 4: 用共享 fixture 建立 Rust provider-agnostic 权限策略内核

**Files:**
- Create: `src-tauri/src/policy/mod.rs`
- Create: `src-tauri/src/policy/model.rs`
- Create: `src-tauri/src/policy/matchers.rs`
- Create: `src-tauri/src/policy/evaluate.rs`
- Create: `src-tauri/src/policy/fixtures/permission-policy.json`
- Create: `src-tauri/src/policy/evaluate_test.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/settings/schema.rs`

**Interfaces:**
- Produces: `PermissionRule`, `PermissionMatcher`, `PermissionPolicySnapshot`, `PolicyDecision { disposition, winner, chain }`。
- Produces: `evaluate(snapshot, ToolInvocation) -> PolicyDecision` and `validate_rule(rule) -> Result<(), PolicyValidationError>`.
- Consumes later: Tauri explanation endpoint and sidecar fixture parity test.

- [x] **Step 1: 写 fixture 与失败测试，固定 precedence 和安全边界**

创建 JSON fixture，每个 case 含 `name`、`rules`、`invocation`、`expectedDisposition`、`expectedWinner`；至少写以下 cases：

```json
[
  {
    "name": "managed deny beats local allow",
    "rules": [
      {"id":"m","scope":"managed","order":0,"effect":"deny","tool":"Bash","matcher":{"kind":"bash","mode":"prefix","value":"rm"}},
      {"id":"l","scope":"local","order":0,"effect":"allow","tool":"Bash","matcher":{"kind":"bash","mode":"prefix","value":"rm -rf build"}}
    ],
    "invocation":{"tool":"Bash","input":{"command":"rm -rf build"}},
    "expectedDisposition":"deny",
    "expectedWinner":"m"
  },
  {
    "name": "more specific same-scope rule wins",
    "rules": [
      {"id":"a","scope":"project","order":0,"effect":"ask","tool":"Bash","matcher":{"kind":"bash","mode":"all"}},
      {"id":"b","scope":"project","order":1,"effect":"allow","tool":"Bash","matcher":{"kind":"bash","mode":"prefix","value":"pnpm test"}}
    ],
    "invocation":{"tool":"Bash","input":{"command":"pnpm test --runInBand"}},
    "expectedDisposition":"allow",
    "expectedWinner":"b"
  },
  {
    "name": "shell chaining never inherits prefix allow",
    "rules": [{"id":"a","scope":"user","order":0,"effect":"allow","tool":"Bash","matcher":{"kind":"bash","mode":"prefix","value":"pnpm test"}}],
    "invocation":{"tool":"Bash","input":{"command":"pnpm test && rm -rf /"}},
    "expectedDisposition":"defer",
    "expectedWinner":null
  }
]
```

再在 Rust test 中加载 fixture：

```rust
#[test]
fn shared_fixture_has_identical_policy_results() {
    for case in load_fixture_cases() {
        let result = evaluate(&case.snapshot(), &case.invocation()).unwrap();
        assert_eq!(result.disposition.as_str(), case.expected_disposition, "{}", case.name);
        assert_eq!(result.winner.as_ref().map(|r| r.id.as_str()), case.expected_winner.as_deref(), "{}", case.name);
    }
}
```

额外用临时目录/symlink（平台不支持时 skip with documented cfg）测试 folder rule 不会把 `allowed/link/outside.txt` 误判为 allowed。

- [x] **Step 2: 运行 policy 测试，确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml policy::evaluate_test`

Expected: FAIL，policy module 和 fixture loader 不存在。

- [x] **Step 3: 实现明确的 validation、specificity 与 matcher**

`PermissionMatcher` 只能反序列化为 Canonical Contracts 中的四种形式。`validate_rule` 要拒绝空 ID/tool、未知 scope、`field` 的未批准字段、空 prefix/contains/folder、`effect=allow && matcher.kind=bash && mode=contains`，以及 scope 与 document 不一致。

具体度固定为：tool=0；Bash all=1；Bash contains=2；Bash prefix=3；path all=1；path folder=3；field equals=3。不要根据字符串长度改变规则优先级。

Bash matcher 必须先扫描未引用的 shell token；存在 `;`、`|`、`&`、`<`、`>`、换行、反引号或 `$(` 时，prefix allow 一律不匹配。仅对 `allow` 启用该保守门；ask/deny 可以检测原始文本。prefix 还需检查命令边界，`pnpm testx` 不能匹配 `pnpm test`。

Path matcher 以 invocation cwd 解析相对路径，lexically normalize `.`/`..`，对 folder 用 path component containment；执行期还需 `resolve_existing_ancestor` 获取 deepest existing `realpath`，若 canonical target 不在 canonical folder 下则返回 no-match。该函数既供 Rust explanation command 使用，也在 TypeScript 侧等价实现；不存在文件允许对已解析父目录+剩余片段判断，不能因文件即将创建而把路径规则失效。

`evaluate` 先得每 scope winner，再按 canonical algorithm produce 完整 `chain`，每个 chain entry 包含 rule ID、scope、matched、specificity、`selected | shadowed_by_specificity | overridden_by_deny | overridden_by_lower_scope`。拒绝原因要从 rule summary 生成，不能复用 provider/SDK wording。

- [x] **Step 4: 运行所有 policy 测试**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml policy::
```

Expected: PASS；覆盖 managed deny、同层 specificity/order、lower scope override、no match、Bash injection、路径 component/symlink 和 field matcher。

- [x] **Step 5: 检查 fixture 的可移植性，不提交**

Run: `git diff --check && git diff -- src-tauri/src/policy src-tauri/src/settings/schema.rs`

Expected: fixture 不含真实项目路径、用户命令或 credential。

---

### Task 5: 让 Rust command 和 runtime 为每个活动会话生成、解释并广播策略快照

**Files:**
- Create: `src-tauri/src/commands/permissions.rs`
- Create: `src-tauri/src/commands/permissions_test.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/commands/chat.rs`
- Modify: `src-tauri/src/runtime/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/settings/mod.rs`

**Interfaces:**
- Produces Tauri commands: `get_permission_settings`, `create_permission_rule`, `update_permission_rule`, `delete_permission_rule`, `explain_permission_decision`.
- Produces `PermissionSettingsView`, `PermissionRuleDraft`, `PermissionExplanationView`.
- Produces runtime command additions: `permission_policy` on `send` and `{ cmd: "update_permission_policy", session_id, policy }`.

- [x] **Step 1: 写失败测试，锁定 CRUD 成功/失败和 broadcast 时机**

```rust
#[tokio::test]
async fn save_broadcasts_only_after_atomic_store_success() {
    let (service, runtime) = test_service_and_runtime_for("C:/repo");
    runtime.register_session_for_test("s-1", PathBuf::from("C:/repo"));
    create_permission_rule_impl(&service, &runtime, SettingsScope::Project, draft_allow_bash("pnpm test"), Some(Path::new("C:/repo"))).await.unwrap();
    assert!(runtime.sent_commands().iter().any(|c| c["cmd"] == "update_permission_policy"));

    runtime.clear_sent_commands();
    service.fail_next_persist_for_test();
    assert!(create_permission_rule_impl(&service, &runtime, SettingsScope::Project, draft_allow_bash("pnpm lint"), Some(Path::new("C:/repo"))).await.is_err());
    assert!(runtime.sent_commands().is_empty());
}

#[test]
fn explanation_shows_managed_deny_and_shadowed_local_allow() {
    let view = explain_for_test(managed_deny_and_local_allow());
    assert_eq!(view.final_decision, "deny");
    assert!(view.chain.iter().any(|line| line.status == "overridden_by_deny"));
}
```

- [x] **Step 2: 运行测试，确认 command/broadcast seam 尚不存在**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::permissions_test`

Expected: FAIL，permissions command 和 runtime registry 不存在。

- [x] **Step 3: 实现 provider-agnostic Tauri DTO 与异步 command**

定义只传通用数据的 DTO：

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRuleDraft {
    pub effect: PermissionEffect,
    pub tool: String,
    pub matcher: PermissionMatcher,
}

#[tauri::command]
pub async fn create_permission_rule(
    scope: SettingsScope,
    rule: PermissionRuleDraft,
    settings: State<'_, Arc<SettingsService>>,
    runtime: State<'_, AgentRuntimeManager>,
    workspace: State<'_, WorkspaceState>,
) -> Result<PermissionSettingsView, String>;
```

`get_permission_settings` 返回四个可见持久 scope 的 path、editable/reason、rules、effective revision。没有 project 时，project/local `editable=false`，reason 精确为“尚未打开项目”；文件系统不可写则返回实际 path 的“目录不可写”。managed 永远 readonly。

create/update/delete 都在 `spawn_blocking` 中验证 draft、写入指定 document、重算 effective snapshot；成功后才调用 `runtime.broadcast_policy_change(affected_root, snapshot_provider)`。`explain_permission_decision` 接收 `{ tool, input }`，仅用于 UI simulation，按当前 workspace 返回 final decision 和完整 chain；它不执行工具、不进入聊天事件。

- [x] **Step 4: 在 runtime 记录 session workspace 并发送初始/更新 snapshot**

`AgentRuntimeManager` 增加内部 `Mutex<HashMap<String, ActiveSessionRoute>>`：

```rust
struct ActiveSessionRoute {
    workspace_root: Option<PathBuf>,
    last_policy_revision: u64,
}
```

`send_message` 在发出 send command 前，用 session cwd 注册/刷新 route，并从 `SettingsService::permission_snapshot_blocking(Some(&cwd))` 得到 snapshot。send JSON 附加 `permission_policy`，并在 worker 尚未创建时保证其第一条 query 已携带策略。

`broadcast_policy_change` 只遍历会受到该 scope/root 影响的 routes：user/managed 影响所有，project/local 只影响同 canonical project root。每条写入 `{cmd:"update_permission_policy", session_id, policy}`；runtime 不存在/重启时保留 route 的最新 revision，下一条 send 自动补发。不要为 broadcast 新建 sidecar stdout event，更不要改变 delta coalescer。

- [x] **Step 5: 注册 commands 并运行 Rust integration tests**

在 `commands/mod.rs` 加 `pub mod permissions;`，在 `lib.rs` 以 `Arc::new(SettingsService::new(...))` 注册，并在 `generate_handler!` 注册五个 permission command。

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml commands::permissions_test
cargo test --manifest-path src-tauri/Cargo.toml policy:: settings::
```

Expected: PASS；没有失败写入后的广播，已有 session 和后续 session 都得到同一 revision。

- [x] **Step 6: 检查 async 边界，不提交**

Run: `git diff --check && git diff -- src-tauri/src/commands/permissions.rs src-tauri/src/runtime/mod.rs src-tauri/src/commands/chat.rs src-tauri/src/lib.rs`

Expected: 所有 file/keychain/serialization work 在 blocking thread；没有 `State` reference 被 move 到 closure。

---

### Task 6: 在 sidecar 建立与 Rust fixture 对齐的通用 policy evaluator

**Files:**
- Create: `agent-sidecar/src/policy/types.ts`
- Create: `agent-sidecar/src/policy/matchers.ts`
- Create: `agent-sidecar/src/policy/evaluate.ts`
- Create: `agent-sidecar/src/policy/evaluate.test.ts`
- Modify: `agent-sidecar/src/types.ts`

**Interfaces:**
- Produces: `evaluatePolicy(snapshot, { tool, input, cwd }): Promise<PolicyDecision>`.
- Consumes: `src-tauri/src/policy/fixtures/permission-policy.json`.
- Produces wire additions: optional `permission_policy` on `send`; `update_permission_policy` sidecar command.

- [x] **Step 1: 写 fixture parity 的失败测试**

```ts
import cases from "../../src-tauri/src/policy/fixtures/permission-policy.json";
import { evaluatePolicy } from "./evaluate.js";

it.each(cases)("matches Rust fixture: $name", async (fixture) => {
  const result = await evaluatePolicy({ revision: 1, rules: fixture.rules }, fixture.invocation);
  expect(result.disposition).toBe(fixture.expectedDisposition);
  expect(result.winner?.id ?? null).toBe(fixture.expectedWinner);
});

it("does not treat a symlink escape as a folder allow", async () => {
  const fixture = await makeFolderWithExternalSymlink();
  const result = await evaluatePolicy(fixture.policy, fixture.invocation);
  expect(result.disposition).toBe("defer");
});
```

- [x] **Step 2: 运行测试，确认模块缺失**

Run: `pnpm exec vitest run agent-sidecar/src/policy/evaluate.test.ts`

Expected: FAIL，policy module 尚不存在。

- [x] **Step 3: 实现 TypeScript matcher，不复制 Claude 代码**

Types only contain `PermissionPolicySnapshot`、`PermissionRule`、`PermissionMatcher`、`PolicyDecision`。Bash scanner、specificity、scope winner 和 deny override 必须与 Task 4 的 fixture 结果完全一致；代码不得 import Agent SDK。

Path matcher 使用 `node:path` + `node:fs/promises.realpath`；采用“最深存在祖先 realpath + 未存在 tail”算法，比较 `path.relative(canonicalFolder, canonicalTarget)`，只要结果以 `..` 开头或为 absolute 即 no-match。任何 `realpath`/权限错误返回 no-match，而不是 allow。matcher 返回 structured explanation entries，供 sidecar deny message 与测试使用。

在 `types.ts` 添加：

```ts
permission_policy?: PermissionPolicySnapshot;
// SidecarCommand union:
| { cmd: "update_permission_policy"; session_id: string; policy: PermissionPolicySnapshot }
```

不要把 rule 放入 `ChatEvent`；Vue/Rust 设置 UI 读取的是 Tauri command，而不是 sidecar event。

- [x] **Step 4: 运行 evaluator 测试和 sidecar typecheck/build**

Run:

```bash
pnpm exec vitest run agent-sidecar/src/policy/evaluate.test.ts
pnpm --dir agent-sidecar build
```

Expected: PASS；JSON fixture import 由现有 `resolveJsonModule` 支持，sidecar bundle 无 Claude SDK type leakage。

- [x] **Step 5: 检查 protocol diff，不提交**

Run: `git diff --check && git diff -- agent-sidecar/src/policy agent-sidecar/src/types.ts`

Expected: 新 wire 字段只有通用 policy 数据。

---

### Task 7: 将 policy 作为 PreToolUse 的权威前置层，移除 SDK settings 依赖并保留指令/确认行为

**Files:**
- Create: `agent-sidecar/src/instructions.ts`
- Create: `agent-sidecar/src/instructions.test.ts`
- Modify: `agent-sidecar/src/permissions.ts`
- Modify: `agent-sidecar/src/permissions.test.ts`
- Modify: `agent-sidecar/src/session-worker.ts`
- Modify: `agent-sidecar/src/session-worker.test.ts`
- Modify: `agent-sidecar/src/session-manager.ts`
- Modify: `agent-sidecar/src/session-manager.test.ts`
- Modify: `agent-sidecar/src/types.ts`

**Interfaces:**
- Produces: `loadAideInstructions(cwd, claudeConfigDir): Promise<string>`.
- Produces: `SessionWorker.applyPermissionPolicy(snapshot)` and generic `makePolicyHook()`.
- Consumes: Task 6 evaluator and existing `PermissionManager` pending queue.

- [x] **Step 1: 写失败测试，固定 setting source、instructions 与 hook 的四种结果**

```ts
it("does not load Claude filesystem settings but appends Aide and project instructions", async () => {
  const { worker, queryCalls } = makeWorker({
    instructions: "GLOBAL\n\nPROJECT",
    policy: emptyPolicy(),
  });
  await worker.startForTest();
  expect(queryCalls[0].options.settingSources).toEqual([]);
  expect(queryCalls[0].options.systemPrompt).toMatchObject({
    type: "preset", preset: "claude_code", append: "GLOBAL\n\nPROJECT",
  });
});

it.each([
  ["allow", "allow", false],
  ["deny", "deny", false],
  ["ask", "allow", true],
  ["defer", "defer", false],
] as const)("policy %s maps correctly", async (ruleEffect, expectedDecision, emitsPrompt) => {
  const { worker, events } = makeWorker({ policy: policyFor(ruleEffect) });
  const output = await worker._testPolicyHook()({ tool_name: "Bash", tool_input: { command: "pnpm test" } });
  expect(output.permissionDecision).toBe(expectedDecision);
  expect(events.some((event) => event.type === "permission_request")).toBe(emitsPrompt);
});
```

另写测试：收到 revision 2 后下一次 hook 用 revision 2；收到 revision 1 不回退；`Read` 也走 policy hook；`AskUserQuestion` 的 policy ask 将 answers 重组为 `updatedInput`；`permission_response` 不含 `always` 也不产生 `updatedPermissions`。

- [x] **Step 2: 运行测试，确认现有 SDK settings/always 行为失败**

Run:

```bash
pnpm exec vitest run agent-sidecar/src/instructions.test.ts agent-sidecar/src/permissions.test.ts agent-sidecar/src/session-worker.test.ts
```

Expected: FAIL；当前 worker 使用 `settingSources: ["project", "user"]`，PermissionManager 依赖 `PermissionUpdate`。

- [x] **Step 3: 写 Aide-controlled instruction loader**

`instructions.ts` 只读取两个精确文件，单文件最大 256 KiB，UTF-8 读取失败/超限时返回一条安全的 diagnostics text，不中断 query：

```ts
export async function loadAideInstructions(cwd: string, claudeConfigDir: string): Promise<string> {
  const files = [path.join(claudeConfigDir, "CLAUDE.md"), path.join(cwd, "CLAUDE.md")];
  const chunks = await Promise.all(files.map(readInstructionFile));
  return chunks.filter((text): text is string => !!text).join("\n\n");
}
```

它不得读取 `.claude/settings*.json`，不得递归扫描 instruction 文件。`SessionWorker` 在 query options 中设置：

```ts
settingSources: [],
systemPrompt: {
  type: "preset",
  preset: "claude_code",
  append: await loadAideInstructions(this.cwd, process.env.CLAUDE_CONFIG_DIR ?? ""),
},
```

保留现有 plugins、skills、allowedTools、image guard 与模型/permission mode 行为。

- [x] **Step 4: 重构 PermissionManager 为可复用的通用确认队列**

删除 `PermissionUpdate` import、`suggestions`、`alwaysAllowLabel`、`updatedPermissions`、`describeAlwaysAllow` 和 `autoApproveCovered`。抽出：

```ts
request(toolName: string, input: unknown, context: PermissionRequestContext): Promise<{
  approved: boolean;
  updatedInput?: Record<string, unknown>;
}>;
resolve(id: string, approved: boolean, answers?: Record<string, string>): ResolveOutcome | undefined;
```

`request` 仍处理 aborted signal、`permission_cancelled`、subagent name 和 AskUserQuestion answers。普通 `canUseTool` adapter 调 `request` 并返回 SDK `behavior: "allow" | "deny"`。没有 policy 命中时才会走它。

`permission_response` command 改为 `{ approved, answers?, nextMode? }`，保留 `ExitPlanMode` 的 existing `nextMode` 处理；不再接受/发送 `always`。PermissionDialog 后续任务将只展示“允许/拒绝”。

- [x] **Step 5: 在 SessionWorker 加 hook 和 live update**

worker 持有 `private permissionPolicy: PermissionPolicySnapshot = { revision: 0, rules: [] }`。`send` 首次带 policy 时调用 `applyPermissionPolicy`; `update_permission_policy` 同样调用；revision 小于当前时忽略。

在 `hooks.PreToolUse` 的最前面注册 `matcher: ".*"` 的 hook。hook 调 `evaluatePolicy`：

```ts
switch (decision.disposition) {
  case "allow": return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: decision.reason } };
  case "deny": return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason } };
  case "ask": {
    const answer = await this.permMgr.request(toolName, toolInput, hookContext);
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: answer.approved ? "allow" : "deny", permissionDecisionReason: answer.approved ? "Aide policy requires confirmation" : "User denied Aide policy confirmation", ...(answer.updatedInput ? { updatedInput: answer.updatedInput } : {}) } };
  }
  default: return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" } };
}
```

使用 SDK 实际 hook input 字段 `tool_name`/`tool_input`，不要从模型输出猜工具。保留 image guard，且让 policy hook 排在它之前；policy deny/allow 对 `Read` 也生效。`allowDangerouslySkipPermissions` 不得绕过 policy hook。

`SessionManager` 将 initial policy 传给新 worker，并将 `update_permission_policy` 路由给已有 worker；未知/已停止 session 安静忽略，使 Rust runtime 重启恢复不产生 fatal error。

- [x] **Step 6: 运行 sidecar 全量权限/worker/manager 回归**

Run:

```bash
pnpm exec vitest run agent-sidecar/src/permissions.test.ts agent-sidecar/src/session-worker.test.ts agent-sidecar/src/session-manager.test.ts agent-sidecar/src/instructions.test.ts agent-sidecar/src/policy/evaluate.test.ts
pnpm --dir agent-sidecar build
```

Expected: PASS；allow 不进入 `canUseTool`/Auto 逻辑、deny 不发确认、ask 使用旧确认事件、defer 仍按原 permission mode；Aide/project CLAUDE.md 仍注入而 Claude settings 不再被读取。

- [x] **Step 7: 检查 Claude-specific 边界，不提交**

Run: `git diff --check && git diff -- agent-sidecar/src/permissions.ts agent-sidecar/src/session-worker.ts agent-sidecar/src/instructions.ts`

Expected: `PermissionUpdate`、`updatedPermissions`、`projectSettings`、SDK suggestions 均已从通用授权路径消失；AskUserQuestion 行为仍只在 sidecar。

---

### Task 8: 建立 Vue 权限 DTO、Tauri API、composable 与 jsdom 测试基线

**Files:**
- Create: `src/types/permissions.ts`
- Create: `src/api/permissions.ts`
- Create: `src/api/permissions.test.ts`
- Create: `src/composables/usePermissions.ts`
- Create: `src/composables/usePermissions.test.ts`
- Modify: `src/types/index.ts`
- Modify: `src/types/chat.ts`
- Modify: `src/api.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `vitest.config.ts`

**Interfaces:**
- Produces: `PermissionSettingsView`, `PermissionRuleDraft`, `PermissionRuleView`, `PermissionExplanationView`, `PermissionScope`.
- Produces: `permissionsApi.get/create/update/remove/explain` and `usePermissions()`.
- Consumes: Task 5 exact Tauri DTO; later components do not call `invoke` directly.

- [x] **Step 1: 安装最小 Vue test 依赖，保留现有 Node 默认环境**

Run:

```bash
pnpm add -D @vue/test-utils jsdom
```

Expected: package manifest/lock 更新一次。若下载失败，停止并按代理规则询问用户，不进行重试。

在 `vitest.config.ts` 保留 `environment: "node"`；Vue component test 文件首行使用 `// @vitest-environment jsdom`，避免改变现有 sidecar/Rust-adjacent pure test 的环境。

- [x] **Step 2: 写 API/composable 失败测试，固定未保存草稿和写失败语义**

```ts
import { vi, describe, expect, it } from "vitest";
import { usePermissions } from "./usePermissions";

it("keeps an edited draft and does not claim success when save fails", async () => {
  const api = { get: vi.fn().mockResolvedValue(permissionView()), create: vi.fn().mockRejectedValue(new Error("disk locked")) };
  const state = usePermissions(api as any);
  await state.load();
  state.beginCreate("user");
  state.draft.effect = "allow";
  state.draft.tool = "Bash";
  state.draft.matcher = { kind: "bash", mode: "prefix", value: "pnpm test" };
  await expect(state.saveDraft()).rejects.toThrow("disk locked");
  expect(state.draft.matcher).toEqual({ kind: "bash", mode: "prefix", value: "pnpm test" });
  expect(state.lastSavedRevision).toBe(0);
});

it("serializes scope and rule payloads exactly", async () => {
  const invoke = vi.fn().mockResolvedValue(permissionView());
  await permissionsApi.create("project", validDraft(), invoke);
  expect(invoke).toHaveBeenCalledWith("create_permission_rule", { scope: "project", rule: validDraft() });
});
```

- [x] **Step 3: 运行测试，确认 DTO/API 不存在**

Run: `pnpm exec vitest run src/api/permissions.test.ts src/composables/usePermissions.test.ts`

Expected: FAIL，module/type 不存在。

- [x] **Step 4: 实现 provider-agnostic front-end state layer**

`src/types/permissions.ts` 直接镜像 Task 5 的 public DTO，并保留 typed `ScopeAvailability`/`ExplanationEntry`。不要 import `agent-sidecar` types。

`permissionsApi` 接收可选 invoke function 仅供测试，production default 使用 `invoke`：

```ts
export const permissionsApi = {
  get: (invoke = tauriInvoke) => invoke<PermissionSettingsView>("get_permission_settings"),
  create: (scope: PermissionScope, rule: PermissionRuleDraft, invoke = tauriInvoke) => invoke<PermissionSettingsView>("create_permission_rule", { scope, rule }),
  update: (scope: PermissionScope, id: string, rule: PermissionRuleDraft, invoke = tauriInvoke) => invoke<PermissionSettingsView>("update_permission_rule", { scope, id, rule }),
  remove: (scope: PermissionScope, id: string, invoke = tauriInvoke) => invoke<PermissionSettingsView>("delete_permission_rule", { scope, id }),
  explain: (tool: string, input: unknown, invoke = tauriInvoke) => invoke<PermissionExplanationView>("explain_permission_decision", { invocation: { tool, input } }),
};
```

`usePermissions` 保存 draft 和 `saving/error`，只在 API resolve 后用返回 view 替换 rules/revision。失败必须保留 draft、保持现有 list，并把错误抛给调用组件；toast 由 UI 决定。把 `PermissionRequest.alwaysAllowLabel` 从 `src/types/chat.ts` 移除，同时更新事件消费处的 type narrowing；不要影响 `fromSubagent`。

- [x] **Step 5: 运行 API/composable、类型检查**

Run:

```bash
pnpm exec vitest run src/api/permissions.test.ts src/composables/usePermissions.test.ts
pnpm build
```

Expected: PASS；所有 invoke command/argument 名称与 Rust command 一致，Vue 类型不再暴露 alwaysAllowLabel。

- [x] **Step 6: 检查测试环境隔离，不提交**

Run: `git diff --check && git diff -- package.json pnpm-lock.yaml vitest.config.ts src/types src/api src/composables/usePermissions.ts`

Expected: 全局 Vitest 默认仍为 node，只有 Vue mount tests opt into jsdom。

---

### Task 9: 扩展主题化 modal 基建，供独立权限规则编辑器复用

**Files:**
- Modify: `src/composables/useModal.ts`
- Modify: `src/components/ModalDialog.vue`
- Create: `src/composables/useModal.test.ts`
- Create: `src/components/ModalDialog.test.ts`

**Interfaces:**
- Produces: `useModal().custom<T>(request: CustomModalRequest<T>): Promise<T | null>`.
- Consumes later: `PermissionRuleEditor.vue` emits `submit(payload)` and `cancel`.

- [x] **Step 1: 写 jsdom 失败测试，固定 custom modal resolution**

```ts
// @vitest-environment jsdom
it("resolves a typed custom modal payload and closes once", async () => {
  const { custom, modalState } = useModal();
  const pending = custom<{ tool: string }>({ title: "新规则", component: FakeEditor });
  modalState.resolveCustom?.({ tool: "Bash" });
  await expect(pending).resolves.toEqual({ tool: "Bash" });
  expect(modalState.visible).toBe(false);
});

it("cancels a custom modal without native browser APIs", async () => {
  const { custom, modalState } = useModal();
  const pending = custom({ title: "编辑规则", component: FakeEditor });
  modalState.cancel();
  await expect(pending).resolves.toBeNull();
});
```

- [x] **Step 2: 运行测试，确认当前 modal mode 不支持 component**

Run: `pnpm exec vitest run src/composables/useModal.test.ts src/components/ModalDialog.test.ts`

Expected: FAIL，现有 mode 只有 prompt/confirm/choice/notice。

- [x] **Step 3: 实现受控 custom mode，不破坏现有四种模式**

添加：

```ts
export interface CustomModalRequest<T> {
  title: string;
  component: Component;
  props?: Record<string, unknown>;
  width?: "sm" | "md" | "lg";
}
```

`modalState` 仍只能有一个 pending resolver。`ModalDialog.vue` 在 custom 分支渲染：

```vue
<component
  :is="state.component"
  v-bind="state.componentProps"
  @submit="state.resolveCustom"
  @cancel="state.cancel"
/>
```

保留 focus trap、Escape、overlay cancel 和现有 token styles。custom editor 自己渲染动作按钮，ModalDialog 不应再同时生成一组通用提交按钮。没有 `window.*` 与 `title`。

- [x] **Step 4: 运行 modal 回归**

Run: `pnpm exec vitest run src/composables/useModal.test.ts src/components/ModalDialog.test.ts && pnpm build`

Expected: PASS；原 prompt/confirm/choice/notice tests（如有）行为未变。

- [x] **Step 5: 检查样式和 diff，不提交**

Run: `git diff --check && git diff -- src/composables/useModal.ts src/components/ModalDialog.vue`

Expected: custom mode 无新增硬编码视觉 token。

---

### Task 10: 实现独立、主题化的 Permissions settings 模块及其组件测试

**Files:**
- Create: `src/components/settings/PermissionsSettings.vue`
- Create: `src/components/settings/permissions/PermissionScopeTabs.vue`
- Create: `src/components/settings/permissions/PermissionRuleList.vue`
- Create: `src/components/settings/permissions/PermissionRuleCard.vue`
- Create: `src/components/settings/permissions/PermissionRuleEditor.vue`
- Create: `src/components/settings/permissions/PermissionDecisionPanel.vue`
- Create: `src/components/settings/permissions/PermissionsSettings.test.ts`
- Create: `src/components/settings/permissions/PermissionRuleEditor.test.ts`
- Create: `src/components/settings/permissions/PermissionScopeTabs.test.ts`

**Interfaces:**
- Consumes: `usePermissions`, `permissionsApi`, `useModal`, `useToast`, Task 8 DTO.
- Produces: a self-contained `<PermissionsSettings />` page; parent only supplies no props and mounts it in tab content.

- [x] **Step 1: 写 component 失败测试，锁定 scope、readonly 和 editor validation**

```ts
// @vitest-environment jsdom
it("disables an unavailable project scope with its server reason", async () => {
  const wrapper = mount(PermissionScopeTabs, { props: { scopes: unavailableProjectScopes(), modelValue: "user" } });
  const project = wrapper.get('[data-scope="project"]');
  expect(project.attributes("disabled")).toBeDefined();
  expect(project.text()).toContain("尚未打开项目");
});

it("does not render mutation controls for managed policy", async () => {
  const wrapper = mount(PermissionRuleList, { props: { scope: managedScopeWithRule() } });
  expect(wrapper.find('[data-action="edit-rule"]').exists()).toBe(false);
  expect(wrapper.find('[data-action="delete-rule"]').exists()).toBe(false);
});

it("rejects unsafe Bash contains allow before submit", async () => {
  const wrapper = mount(PermissionRuleEditor, { props: { initial: bashContainsAllowDraft() } });
  await wrapper.get('form').trigger('submit');
  expect(wrapper.emitted("submit")).toBeFalsy();
  expect(wrapper.text()).toContain("“包含文本”不能用于始终允许 Bash");
});
```

再写 PermissionsSettings integration tests：scope 切换、create/edit via mocked `useModal.custom`、delete via mocked `confirm`、save failure toast 不关编辑器、explanation panel renders `overridden_by_deny`。

- [x] **Step 2: 运行 tests，确认组件不存在**

Run:

```bash
pnpm exec vitest run src/components/settings/permissions/PermissionScopeTabs.test.ts src/components/settings/permissions/PermissionRuleEditor.test.ts src/components/settings/permissions/PermissionsSettings.test.ts
```

Expected: FAIL，components 不存在。

- [x] **Step 3: 实现 scope tabs 和只读/不可写状态**

Scope tabs 固定显示“用户全局 / 项目共享 / 项目本地 / 受管策略”，顺序不得按对象枚举变化。用户全局始终可选；无项目或不可写 scope 的按钮禁用，使用 `v-tooltip="scope.reason"` 解释。页头显示 server 返回的真实 storage path；project local 文案明确“仅本机，不建议提交”。managed 显示只读 banner，绝不渲染 add/edit/delete。

所有 spacing 用 `calc(var(--aide-space-unit) * N)`，背景/边框/状态 badge 使用 semantic token，例如 `var(--aide-success)`, `var(--aide-warning)`, `var(--aide-danger)`, `var(--aide-surface-default)`；可用 `color-mix(in srgb, var(--aide-danger) 16%, transparent)` 形成 subtle surface。

- [x] **Step 4: 实现 rule cards、form modal 和解释面板**

`PermissionRuleCard` 用纯展示 summary：工具名、Bash `全部命令/前缀/包含`、folder/path、effect badge、scope/source、shadow reason。可编辑 card 的 `编辑`/`删除` 使用 `Icon` + `v-tooltip`，不使用 native title。

`PermissionRuleEditor` 接收 initial draft，使用 `ThemedSelect` 选择 effect/tool/matcher；根据 tool 显示可理解的条件字段。前端禁止空文本、无效 folder、未知 field、Bash `allow+contains`，但后端错误仍显示在 form 顶部。submit 只 emit normalized `PermissionRuleDraft`，不直接 invoke。

`PermissionsSettings` 在新增/编辑时调用 `modal.custom<PermissionRuleDraft>({ title, component: PermissionRuleEditor, props })`；成功后调用 `showToast("权限规则已保存", "success")`；失败显示 `showToast("保存失败：…", "error")` 并重新打开同一 draft modal。删除调用 `confirm("删除规则", "…", "删除", true)`；成功才 toast。决策面板提供 tool select 与 command/path JSON-free input，根据 tool 组装 `{ command }` 或 `{ file_path }`，调用 `explain` 并逐行展示 winner/shadow chain；它只解释，不执行调用。

- [x] **Step 5: 运行组件测试、构建**

Run:

```bash
pnpm exec vitest run src/components/settings/permissions/PermissionScopeTabs.test.ts src/components/settings/permissions/PermissionRuleEditor.test.ts src/components/settings/permissions/PermissionsSettings.test.ts
pnpm build
```

Expected: PASS；managed 和 unavailable scopes 无 mutation controls，draft 在失败后可继续保存，所有 component mount 使用 jsdom directive。

- [ ] **Step 6: 手工主题检查，不提交**

Run: `pnpm dev`

Expected: 在 warm-dark、catppuccin、glass 下打开独立 component 的 story/test host 或实际 Settings 页面，所有 card、disabled state、toast、modal、badge、focus ring 随主题变化；没有白底、原生 tooltip 或硬编码色。

---

### Task 11: 将权限页面接入 SettingsPanel，并以安全的会话确认 UI 取代 SDK “always allow”

**Files:**
- Modify: `src/components/SettingsPanel.vue`
- Modify: `src/components/PermissionDialog.vue`
- Modify: `src/composables/useChatSession.ts`
- Modify: `src/types/chat.ts`
- Modify: `agent-sidecar/src/types.ts`
- Modify: `src/components/SettingsPanel.test.ts`
- Modify: `src/components/PermissionDialog.test.ts`
- Modify: `agent-sidecar/src/permissions.test.ts`

**Interfaces:**
- Consumes: `<PermissionsSettings />`; simplified `permission_response` contract from Task 7.
- Produces: tab order `通用 / 模型 / 权限 / 扩展 / 市场 / 代码索引 / Java` and ordinary confirmation with allow/deny only.

- [x] **Step 1: 写失败测试，锁定 tab 顺序和 no-persistence dialog contract**

```ts
// @vitest-environment jsdom
it("places Permissions between Model and Extensions", () => {
  const wrapper = mount(SettingsPanel, mountSettingsOptions());
  expect(wrapper.findAll("[data-settings-tab]").map((node) => node.text())).toEqual([
    "通用", "模型", "权限", "扩展", "市场", "代码索引", "Java",
  ]);
});

it("ordinary permission confirmation exposes only deny and allow", () => {
  const wrapper = mount(PermissionDialog, { props: { permission: bashPermission() } });
  expect(wrapper.find('[data-action="always-allow"]').exists()).toBe(false);
  expect(wrapper.find('[data-action="allow"]').exists()).toBe(true);
  expect(wrapper.find('[data-action="deny"]').exists()).toBe(true);
});
```

- [x] **Step 2: 运行 tests，确认旧 UI 仍有 always button**

Run: `pnpm exec vitest run src/components/SettingsPanel.test.ts src/components/PermissionDialog.test.ts`

Expected: FAIL，SettingsPanel 没有 permission tab，dialog 仍渲染 always allow。

- [x] **Step 3: 接入页面，不把权限业务内联进 SettingsPanel**

扩展 `Tab` union 为 `"permissions"`，nav 按固定顺序插入，content 分支只渲染：

```vue
<PermissionsSettings v-else-if="activeTab === 'permissions'" />
```

保留现有 scroll container、dialog shell、其他 tab 和 diagnostics 的实现；Diagnostics 维持其当前可达入口（若当前产品决定它仍在 nav，放到 Java 后，不得让新 Permission tab 改变其条件显示逻辑）。

- [x] **Step 4: 移除 SDK always 线，保留特殊确认流程**

删除 `PermissionRequest.alwaysAllowLabel`、`always?: boolean` 以及 `permission_response` 中的 always payload。PermissionDialog 的普通工具仅 emit：

```ts
emit("respond", permission.id, true, answers, nextMode)
```

保留 `AskUserQuestion` 的 answers、`ExitPlanMode` 的 mode selection 与 `nextMode`、subagent attribution、队列计数、Bash/Edit/Write/WebFetch 展示和 cancel。普通用户若想持久化规则，通过 PermissionDialog 的非阻塞“管理规则”文本按钮打开 SettingsPanel 的 permissions tab（以现有 parent event/state 接线实现，不直接写规则）；点击不自动批准当前 request。

`useChatSession` 调 Rust `permission_response` 时只传 `{ sessionId, id, approved, answers, nextMode }`。同步更新 sidecar union 和 tests，确认无字符串 `alwaysAllowLabel`、`updatedPermissions` 或 `projectSettings` 残留。

- [x] **Step 5: 运行前端/sidecar 权限回归**

Run:

```bash
pnpm exec vitest run src/components/SettingsPanel.test.ts src/components/PermissionDialog.test.ts agent-sidecar/src/permissions.test.ts agent-sidecar/src/session-worker.test.ts
pnpm build
pnpm --dir agent-sidecar build
```

Expected: PASS；计划模式、提问回答、普通允许/拒绝和中断取消保持工作，任何点击不会写 Claude settings。

- [x] **Step 6: 检查 UI integration diff，不提交**

Run: `git diff --check && git diff -- src/components/SettingsPanel.vue src/components/PermissionDialog.vue src/composables/useChatSession.ts src/types/chat.ts agent-sidecar/src/types.ts`

Expected: SettingsPanel 只做 navigation composition，权限业务仍在独立模块。

---

### Task 12: 做跨层回归、文档更新与人工验收记录

**Files:**
- Modify: `README.md` 或现有设置/运行文档中最贴近的用户文档（选择一个已有主入口，不复制大段内容）
- Modify: `docs/ARCHITECTURE.md` 中 settings/runtime 边界的简短链接或段落（仅在该文件已有对应章节时）
- Create: `docs/testing/permission-settings-manual-acceptance.md`
- Modify: `docs/superpowers/plans/2026-07-27-aide-settings-and-permissions.md`（勾选实施过程中实际完成的步骤；不要伪造勾选）

**Interfaces:**
- Documents: settings file locations、managed read-only semantics、secret non-export behavior、legacy migration backup location、policy precedence、live-update behavior、manual test matrix。

- [x] **Step 1: 先跑每层聚焦测试并修复任何真实回归**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml settings:: policy:: commands::permissions_test runtime::provider::
pnpm exec vitest run agent-sidecar/src/policy agent-sidecar/src/permissions.test.ts agent-sidecar/src/session-worker.test.ts agent-sidecar/src/session-manager.test.ts agent-sidecar/src/instructions.test.ts
pnpm exec vitest run src/api/permissions.test.ts src/composables/usePermissions.test.ts src/components/settings/permissions src/components/SettingsPanel.test.ts src/components/PermissionDialog.test.ts
```

Expected: PASS。若失败，先回到拥有该 interface 的任务修复根因，不要在 test 中放宽 assertion 或加特例绕过安全规则。

- [x] **Step 2: 运行全量构建/测试**

Run:

```bash
pnpm test
pnpm build
pnpm --dir agent-sidecar build
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: 全部 PASS。若 Cargo 或 pnpm 因网络拉取依赖失败，按代理规则停下并请求用户批准；不要反复尝试。

- [x] **Step 3: 写用户和维护者文档**

文档必须明确：

```text
- 日常编辑入口是 Aide Settings，不是 JSON editor。
- 用户/项目/本地/managed 的文件位置和谁可写。
- `deny` 的跨层不可放宽、同层具体度/顺序、无匹配 fallback。
- API key/token 仅存 OS credential store；“已配置”不表示可导出明文。
- 首次启动将 config.json 转为 settings.json；脱敏备份为 config.json.migrated.bak。
- 保存成功会更新后续工具调用；已显示的确认框不会被事后自动批准/拒绝。
```

不要在 README 与 ARCHITECTURE 重复完整规则；README 链接到架构/验收文档。

- [ ] **Step 4: 执行手工验收并记录结果**

在 `docs/testing/permission-settings-manual-acceptance.md` 写可勾选矩阵，并实际验证：

1. 从含 Provider、CodeGraph key、workspace layout、普通偏好的旧 `~/.aide/config.json` 启动；确认 `settings.json` 无秘密、keychain 配置状态正确、布局/偏好不丢失、legacy backup 脱敏。
2. 在用户层新增 Bash `pnpm test` allow；临时让 Auto classifier 不可用，运行 `pnpm test --runInBand`，确认直接放行；运行 `pnpm test && rm -rf build`，确认不因 prefix 规则放行。
3. 在 managed 写 `deny Bash rm`，项目 local 写 `allow Bash rm -rf build`；确认最终 deny 和解释链均展示 managed rule。
4. 删除规则后，不重启会话执行同一调用；确认下一次走原 permission mode，当前已打开的旧确认框不被自动结算。
5. 无 project、project read-only、managed scope 下检查 disabled/readonly 文案与 mutation control。
6. warm-dark、catppuccin、glass 下检查 tab、scope states、modal、toast、focus、explanation panel；确认无原生浏览器 UI、白底或固定色。
7. 验证 AskUserQuestion、ExitPlanMode、subagent permission attribution、provider switch、image Read guard 与普通 PermissionDialog 仍正常。

- [x] **Step 5: 最终安全与 diff 审查，不提交**

Run:

```bash
git diff --check
git status --short
```

逐项人工搜索/审查：`apiKey`, `authToken`, `updatedPermissions`, `PermissionUpdate`, `projectSettings`, `settingSources: ["project", "user"]`, `window.alert`, `window.confirm`, `window.prompt`, `title=`。Expected: 除历史迁移解析和 runtime-only resolver 外没有 secret JSON/API 路径；没有 Claude settings persistence；没有不应保留的 old SDK authorization path。

---

## Plan Self-Review

- [x] **规格覆盖：** Task 1–3 覆盖统一 schema、描述符、未知字段、秘密 keychain、旧 config 迁移和所有现有 consumer；Task 4–7 覆盖 precedence、Bash/path 安全、provider-agnostic snapshot、即时 session 更新、SDK isolation、CLAUDE.md 保留；Task 8–11 覆盖独立权限 UI、modal/toast/ThemedSelect、readonly/disabled/shadow explanation、dialog migration；Task 12 覆盖 Rust/sidecar/frontend/manual acceptance/documentation。
- [x] **安全覆盖：** 明文 credential 不返回 Vue、不写 settings/backup/log；原子失败不更新 active snapshot；upper deny、shell chaining 和 symlink escape 有直接测试；无匹配回退而非放宽。
- [x] **架构覆盖：** root-level `settings/`/`policy/` 是领域层，`commands/` 是薄边界，`settings/permissions/` 是独立 UI 模块；Rust/Vue 不引入 Claude SDK type。
- [x] **占位扫描：** 本计划没有 TBD/TODO/“类似 Task N”式实现缺口；每项修改提供了文件、接口、失败测试、命令和通过标准。
- [x] **类型一致性：** 所有任务统一使用 `PermissionPolicySnapshot`、`PermissionRuleDraft`、`SettingsScope`、`SecretMutation`、`SettingsService`、`update_permission_policy` 这些契约名称。
