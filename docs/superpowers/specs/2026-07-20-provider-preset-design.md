# 供应商预设化（Provider Preset）设计

日期：2026-07-20
状态：待用户复核

## 背景与目标

当前 Aide 的 provider 模型是"用户从零自由填写一整个 `ProviderConfig`"——`base_url` / `api_key` /
`auth_token` / `model_mappings` 全部用户自己填。这有两个问题：

1. **接入新后端门槛高**：用户得自己知道 base_url、知道该填 `api_key` 还是 `auth_token`、知道模型名，
   配错就报错。Claude Agent SDK 只会说 Anthropic 协议，而用户想用的 GPT / Ollama / Kimi / DeepSeek
   都需要中间层或特定兼容端点——这些知识不该压给终端用户。
2. **我们无法对供应商做差异化操作**：base_url 是用户随意填的字符串，Aide 不知道一条 provider 指向的
   是 Anthropic 官方、CPA 中转、还是某个第三方网关，因此无法按供应商类型挂载专属行为
   （探测端口、打开管理面板、查登录态、刷新模型列表……）。

目标：把 provider 模型从"用户自由配置"改成"**从我们预置的供应商目录里选一个实例化**"——

- 预装目录由我们主导：用户从清单里挑一个供应商，不再凭空填 base_url。
- 供应商身份（`base_url` / `name` / `icon`）由我们锁定，用户不能改。
- 账号凭证（`api_key` / `auth_token`）与模型映射（`model_mappings` / `known_models`）由用户填。
- 因为供应商类型由我们定义，Aide 能按类型挂载**专属操作**——这才是"主导供应商"的真正回报。

这与 CLAUDE.md 的"深根 Claude Agent、不接其他 agent"红线不冲突：我们主导的仍是"把 Claude 指向哪个
Anthropic 协议后端"，只是把后端选项产品化。所有后端仍必须是 claude.exe 能说的 Anthropic 协议端点。

## 范围

采用 **UI 差异化 + 后端按 kind 策略**的方案：

- **前端**：按供应商类型渲染不同的"专属操作区"（按钮 / 状态徽标 / 链接）。
- **后端（Rust）**：`provider_to_env_vars` 从"按字段直映"改成"按 kind dispatch"，不同 kind 注入不同
  env / header、暴露不同 command。
- **不托管外部进程**：CPA 等外部代理仍由用户在 Aide 外部启动；CpaGpt kind 只做端口探测 / 状态读取 /
  打开管理面板，不负责拉起 CPA。托管外部进程（之前的 scope C）按需留作未来扩展。

v1 非目标（明确不做）：
- 同 kind 多实例（v1 每 kind 单实例，多账号留作小步扩展）。
- 远程 catalog（v1 编译进 app，来源与 `ProviderConfig` 形状正交，将来加远程不破坏数据模型）。
- catalog 预置模型名（模型名是用户侧领域，由用户填或由 `refresh_models` 操作拉取）。
- 托管外部进程。

## 数据模型

### `ProviderConfig`（`runtime/provider/mod.rs`）

新增判别字段 `kind`。对预置 kind，`base_url` / `name` / `icon` **不存入 config.json**，只在内存从 catalog
派生（见"存储设计"）。

```rust
struct ProviderConfig {
    id: String,
    kind: ProviderKind,                 // 新增：判别字段
    // —— 以下仅 Custom 实例持久化；预置实例不持久化，运行时从 catalog 派生 ——
    name: String,                      // Custom 可编辑；预置从 catalog 派生
    icon: String,                       // Custom 可编辑；预置从 catalog 派生
    base_url: String,                   // Custom 可编辑；预置从 catalog 派生（硬锁）
    // —— 以下所有 kind 都持久化、用户可编辑 ——
    api_key: Option<String>,
    auth_token: Option<String>,
    model_mappings: ModelMappings,      // 用户填
    effort_level: Option<String>,
    auto_compact_window: Option<u64>,
    autocompact_pct_override: Option<u32>,
    known_models: Vec<ModelOption>,     // 用户填 / refresh_models 填
}

enum ProviderKind {
    SystemDefault,   // Anthropic 官方
    CpaGpt,          // CPA / GPT 中转
    Ollama,
    Kimi,
    DeepSeek,
    Custom,          // 兜底：base_url/name/icon 可编辑、无专属操作
}
```

### base_url 锁定策略

**硬锁**：预置 kind 的 `base_url` 由 catalog 定义、UI 只读、不可改端口 / 主机 / 路径。
CpaGpt 恒为 `http://127.0.0.1:8317`。跑在非默认端口或远程主机的 CPA 用户退到 Custom kind
（失去 CPA 专属操作）——这是硬锁的已知代价，已确认接受。

### 存储设计

预置 kind 实例的 `base_url` / `name` / `icon` **不入 config.json**——加载时从内存中的 catalog 查表派生。
config.json 里一个预置实例只持久化：

```json
{
  "id": "xxx",
  "kind": "cpa_gpt",
  "api_key": null,
  "auth_token": "sk-local-cpa",
  "model_mappings": { ... },
  "effort_level": null,
  "auto_compact_window": null,
  "autocompact_pct_override": null,
  "known_models": []
}
```

好处：我们更新 catalog（修 base_url、换图标）后，所有预置实例下次加载自动跟进，零迁移。
Custom 实例持久化全字段（含 `base_url` / `name` / `icon`）。

代价：app 必须能加载到 catalog 文件才能渲染预置实例——成立（catalog 编译进 resources，只读）。

## Catalog

### 源

编译进 app：一份静态 JSON 放 `src-tauri/resources/provider-catalog.json`（与
`default-models.json` 同级，经 `tauri.conf.json` resources 打包）。加载时读入内存，作为预置 kind
身份的唯一来源。前端通过 `get_provider_catalog` 命令取，不另存一份（避免漂移）。

### Catalog 结构

每个 preset 只含身份 + 能力声明，**不含任何模型字段**：

```json
{
  "kind": "cpa_gpt",
  "name": "CPA 中转",
  "icon": "C",
  "base_url": "http://127.0.0.1:8317",
  "auth_mode": "auth_token",
  "actions": ["probe_port", "open_management", "codex_login_status", "test_connection"]
}
```

- `auth_mode`：`api_key` | `auth_token`——告诉 UI 该渲染哪个凭证输入框。CPA = `auth_token`，其余 = `api_key`。
- `actions`：能力声明——前端据此渲染专属操作区子组件，Rust 据此知道该 kind 暴露哪些 command。
- Custom 不在 catalog（它是兜底 kind，`base_url` / `name` / `icon` 用户填、`actions` 为空）。

### v1 预置清单

| kind | 显示名 | icon | base_url | auth_mode | actions |
|---|---|---|---|---|---|
| system_default | Anthropic | A | null（SDK 默认） | api_key | refresh_models, view_quota, test_connection |
| cpa_gpt | CPA 中转 | C | http://127.0.0.1:8317 | auth_token | probe_port, open_management, codex_login_status, test_connection |
| ollama | Ollama | O | https://ollama.com | api_key | test_connection |
| kimi | Kimi | K | https://api.kimi.com/coding/ | api_key | test_connection |
| deepseek | DeepSeek | D | https://api.deepseek.com/anthropic | api_key | test_connection |

`base_url` 与端点可用性已由用户确认。

## 分层归位（修掉既有倒置）

现状有分层倒置：`runtime.rs` 反向 `use crate::commands::chat::build_runtime_env_vars`
（runtime.rs:77）和 `use crate::commands::provider::connection_fingerprint`（runtime.rs:11）——
runtime 层在依赖 commands 层。env 组装与连接指纹本质是 runtime 职责，却躺在 `commands/` 里。

借这次把 `runtime.rs` 升成 `runtime/` 模块，把"后端身份"整体（数据类型 + env 组装 + 连接指纹 +
策略）归位进 runtime 层，`commands/*` 退化为 IPC 薄命令。依赖方向正过来：`commands/*` → `runtime/*`，
runtime 不再 import commands。

## kind 分发扩展点

按 CLAUDE.md 分层红线（主控文件在上层、子实现放同名子目录），归位进 agent runtime 层：

```
src-tauri/src/runtime/
├── mod.rs                     # AgentRuntimeManager：进程生命周期 / stdin-stdout / drift 检测（上层主控）
├── env.rs                     # build_runtime_env_vars —— 从 commands/chat 搬入（组 spawn env）
└── provider/                  # "怎么跟后端说话"全在这
    ├── mod.rs                 # ProviderConfig / ProviderKind / catalog 加载 / 迁移 / connection_fingerprint / dispatch（上层）
    └── strategy/              # ProviderStrategy trait + 各 kind 实现（下层）
        ├── mod.rs
        ├── system_default.rs
        ├── cpa_gpt.rs
        ├── ollama.rs
        ├── kimi.rs
        ├── deepseek.rs
        └── custom.rs
```

### Rust 侧 — `ProviderStrategy` trait

```rust
trait ProviderStrategy {
    /// 注入给 sidecar 的 env 变量集合（替代现有 provider_to_env_vars 的直映逻辑）。
    fn env_vars(&self, cfg: &ProviderConfig) -> Vec<(String, String)>;

    /// 专属操作列表，供前端渲染 + command 路由。
    fn actions(&self) -> &[ActionDef];

    /// test_connection：发一个最小 Anthropic /v1/messages 请求验证端点 + 凭证可用。
    fn test_connection(&self, cfg: &ProviderConfig) -> Result<ConnectionStatus>;

    /// 可选：按 action 分发的其它操作（probe_port / open_management / refresh_models / ...）。
    fn run_action(&self, cfg: &ProviderConfig, action: &str) -> Result<ActionResult>;
}
```

各实现职责：

- **system_default**：`env_vars` 走现状逻辑（含空凭证回落进程 env 的兜底）；`refresh_models` 复用现有
  `refresh_system_default_models`（打 Anthropic `/v1/models` 填 `known_models`）；`view_quota` 查额度。
- **cpa_gpt**：`env_vars` v1 注入 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`（与 custom 同形）；
  若 spike 发现 CPA 需要额外 header / env 才在该实现里加，不在 trait 层预先声明。
  `probe_port` 探测 `127.0.0.1:8317` 是否响应；`open_management` 返回
  `http://127.0.0.1:8317/management.html` 供前端用 `shell.open` 打开；`codex_login_status` 读 CPA
  `auth-dir` 判断 codex 登录态是否存在。
- **ollama / kimi / deepseek**：`env_vars` 注入 `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`；v1 仅
  `test_connection`。
- **custom**：`env_vars` 走现状的 base_url / key / token 直映逻辑；`actions` 为空。

`provider_to_env_vars` 从 `commands/provider.rs` 搬入 `runtime/provider/`，改为调
`strategy_for(kind).env_vars(cfg)`；`build_runtime_env_vars` 从 `commands/chat.rs` 搬入
`runtime/env.rs`；`connection_fingerprint` 从 `commands/provider.rs` 搬入 `runtime/provider/mod.rs`。
单一出口不变，下游 sidecar / drift 检测全部无感；`commands/chat::send_message` 和
`runtime::spawn_runtime` 改为调 `runtime::env::build_runtime_env_vars()`。

### 前端侧 — 专属操作区

`ProviderSettings.vue` 右侧表单按 kind 渲染一个"专属操作区"子组件：

```
src/components/provider/
├── ProviderActionsCpa.vue        # CpaGpt：探测端口 / 打开管理面板 / Codex 登录态 / 测试连接
├── ProviderActionsAnthropic.vue  # SystemDefault：刷新模型列表 / 查看额度 / 测试连接
└── ProviderActionsGeneric.vue    # Ollama/Kimi/DeepSeek：仅测试连接
```

Custom 不渲染操作区。组件按 catalog 的 `actions` 列表渲染对应按钮 / 徽标，点击调对应 Tauri command。

## 新增 / 编辑 UX

### 新增供应商

点"新增"→ 弹 catalog 选择面板（preset 卡片网格：icon + name + 一行简述）+ 底部一个"自定义（高级）"入口。

- 选某 preset → 创建该 kind 的实例：`base_url` / `name` / `icon` 从 catalog 锁定填入（内存态），
  `model_mappings` / `known_models` 留空待填，`api_key` / `auth_token` 留空。单实例约束：已添加的
  kind 在面板置灰。
- 选"自定义" → 创建 Custom 实例，全部字段可编辑。

### 编辑供应商（右侧表单，按 kind 分区）

| 区 | 预置 kind | Custom |
|---|---|---|
| 顶部 name + icon | 只读展示 | 可编辑 |
| base_url | 只读展示 | 可编辑 |
| 账号区（api_key 或 auth_token，按 `auth_mode`） | 可编辑 | 可编辑 |
| 模型区 model_mappings + known_models | 可编辑可加 | 可编辑可加 |
| 行为区 effort / auto_compact / pct | 可编辑 | 可编辑 |
| 专属操作区 | 按 `actions` 渲染子组件 | 无 |

## 迁移

老 config.json 特征：`active_provider: "__system_default__"` 哨兵 + 顶层
`system_default_model_mappings`。

加载时检测到老 schema → 一次性迁移（纯函数，单测覆盖）：

1. 哨兵 + `system_default_model_mappings` → 合成一个 `SystemDefault` 实例（`id` 保留
   `"__system_default__"`，`active_provider` 引用不变）。
2. `providers[]` 既有条目按 `base_url` 匹配：
   - 空 / null → 合并进上面的 SystemDefault（去重，保留其 `model_mappings` / 凭证）。
   - 命中某预置 base_url → 标对应预置 kind，丢弃持久化的 `base_url` / `name` / `icon`（改由 catalog 派生）。
   - 其余 → 标 `Custom`，全字段保留。
3. 原子 temp + rename 写回新 schema；老 config 备份成 `config.json.bak-<epoch>`。
4. 加载失败 / 迁移报错 → 回退备份、明显告警，不静默丢配置。

## 验证

- **单测**
  - `ProviderStrategy::env_vars`：每种 kind 各自产出正确 env 集合；SystemDefault 输出与现状逐字段一致
    （回归保证）；CpaGpt 与 Custom 同形（v1）；Custom 直映。
  - 迁移函数：构造老 schema 样本（纯哨兵 / 哨兵 + 自定义条目 / 条目 base_url 命中预置 / 条目 base_url
    未知 / 多条空 base_url 去重）→ 断言新 schema + `active_provider` 引用正确。
  - Catalog 加载校验。
- **集成**（即原 spike）：CPA 跑起来 + Codex 登录 → Aide 加 CpaGpt 预置实例 → 填
  `auth_token = sk-local-cpa` → `probe_port` 确认活着 → 发一条消息 → 看 round-trip。
- **回归**：SystemDefault 预置实例行为与现状一致（env 兜底逻辑不退化）；老配置迁移后能正常发消息。

## 风险与缓解

1. **claude.exe ↔ CPA 协议兼容性**（存在性风险，预设化不改变它）——preset 机制只把"指向 CPA"产品化，
   不解决 claude.exe 能否跟 CPA 通话。Mitigation：spike 先行；若崩，崩点在 CPA / claude.exe 侧而非 Aide，
   不在本次代码范围。
2. **迁移破坏老配置**——Mitigation：原子写 + `.bak` 备份 + 迁移单测 + 加载失败回退备份。
3. **catalog 缺失 / 损坏**——预置实例无法派生 base_url。Mitigation：catalog 编译进 resources（只读）；
   加载校验，缺失时降级告警。
4. **`provider_to_env_vars` 改 dispatch 后漏传某个 env**——Mitigation：strategy trait 接口 + 单测断言
   每种 kind 的 env 输出集合；迁移期 SystemDefault 输出与现状逐字段一致。

## 新增 / 改动的 Tauri command

`commands/*` 退化为 IPC 薄命令，全部调 `runtime/provider/` 暴露的接口，不再持有后端身份逻辑。

新增命令：
- `get_provider_catalog` — 返回 catalog presets（前端"新增"面板 + 只读字段渲染用；调 `runtime::provider::catalog()`）。
- `test_provider_connection(provider_id)` — 通用，调 `strategy_for(kind).test_connection(cfg)`。
- `cpa_probe_port` / `cpa_open_management` / `cpa_login_status` — CpaGpt 专属，调 `strategy_for(CpaGpt).run_action(...)`。
- `view_anthropic_quota` — SystemDefault 专属。

改动命令：
- `get_providers` / `set_providers` / `get_active_provider_id` / `set_active_provider_id` — schema 变
  （加 `kind`；预置实例不持久化 `base_url` / `name` / `icon`），仍是薄读写层，调 `runtime::provider` 的持久化函数。
- `refresh_system_default_models` — 泛化为按 provider 的 `refresh_models`（v1 仍只 SystemDefault 实现）。

非命令的内部搬移（见"分层归位"）：
- `build_runtime_env_vars`：`commands/chat.rs` → `runtime/env.rs`。
- `provider_to_env_vars`：`commands/provider.rs` → `runtime/provider/`，改为按 kind dispatch。
- `connection_fingerprint`：`commands/provider.rs` → `runtime/provider/mod.rs`。
- `load_config` 迁移：老 schema 检测 + 迁移 + 备份落 `runtime/provider/mod.rs`（迁移纯函数，单测覆盖）。