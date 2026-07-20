# Provider 预设化 — 前端 UX 实现计划（Plan 2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Aide 前端 Provider 设置从「用户自由填一整个 ProviderConfig」改成「从预置 catalog 选一个 kind 实例化 + 按 kind 渲染只读/可编辑分区 + 专属操作区」，对接 Plan 1 已交付的 Rust 后端命令。

**Architecture:** 在现有 `ProviderSettings.vue`（853 行单文件）+ `useProviders.ts`（162 行模块单例）之上改造：统一 SystemDefault 进 `providers[]`（去掉硬编码 const + 独立 mappings ref）、给 `ProviderConfig` 加 `kind`、新增 `useProviderCatalog`/`useProviderActions` 两个 composable、新增 catalog 选择面板 + 3 个按 kind 分发的专属操作子组件，最后把 `ProviderSettings.vue` 重构为 kind-aware 表单。Composable 走 vitest TDD；组件走 `vue-tsc --noEmit` 类型门 + 手动 smoke（项目未装 `@vue/test-utils`，无组件挂起测试基建）。

**Tech Stack:** Vue 3 Composition API + TypeScript + vitest（composable 测试）+ Tauri v2 IPC（`@tauri-apps/api/core` 的 `invoke`）+ `@tauri-apps/plugin-shell`（`open(url)` 打开 CPA 管理面板）+ `var(--aide-*)` 主题 token。

## Backend contract（Plan 1 已交付，本计划消费）

Rust 命令（`src-tauri/src/commands/provider.rs` + `lib.rs` invoke_handler 已注册）：

| 命令 | 签名 | 备注 |
|---|---|---|
| `get_providers` | `() -> Vec<ProviderConfig>` | 读 + 迁移 + enrich（预置 kind 的 name/icon/base_url 已从 catalog 填回） |
| `set_providers` | `{ providers: Vec<ProviderConfig> } -> ()` | 持久化前 strip 预置身份字段 |
| `get_active_provider_id` / `set_active_provider_id` | `() -> String` / `{ providerId } -> ()` | |
| `get_provider_catalog` | `() -> Vec<CatalogPreset>` | 5 个 preset，不含 Custom |
| `test_provider_connection` | `{ providerId } -> ConnectionStatus` | 通用 |
| `cpa_probe_port` | `() -> PortProbeResult { alive, detail }` | CpaGpt 专属 |
| `cpa_open_management` | `() -> String`（URL） | 前端 `open(url)` |
| `cpa_login_status` | `() -> LoginStatusResult { logged_in, detail }` | |
| `view_anthropic_quota` | `() -> serde_json::Value` | SystemDefault 专属，v1 stub |
| `refresh_models` | `{ providerId } -> ProviderModelMappings` | 持久化回 providers[] by id |

**已废弃命令**（Plan 1 保留为向后兼容，本计划 Task 4 从前端移除调用 + 从 `api.ts` 删 wrapper）：`get_system_default_model_mappings` / `set_system_default_model_mappings` / `refresh_system_default_models`。迁移后顶层 `system_default_model_mappings` 字段已删，这俩读写空值——前端改走统一 `set_providers`/`refresh_models` 路径。

## Serde 形态（前端类型必须逐字段对齐——这是硬契约）

- **`ProviderConfig`**：Rust `#[serde(rename_all = "camelCase")]` → 前端 camelCase：`id`、`kind`、`name`、`icon`、`baseUrl`、`apiKey`、`authToken`、`model`、`modelMappings`、`effortLevel`、`autoCompactWindow`、`autocompactPctOverride`、`knownModels: string[]`。
- **`CatalogPreset`**：Rust **无** `rename_all` → 前端 **snake_case**：`kind`、`name`、`icon`、`base_url`、`auth_mode`、`actions: string[]`。⚠️ 与 `ProviderConfig` 不同形——`enrichForDisplay` 要把 `base_url`→`baseUrl` 映射。
- **`ProviderKind`**（enum `#[serde(rename_all = "snake_case")]`）：`"system_default" | "cpa_gpt" | "ollama" | "kimi" | "deepseek" | "custom"`。
- **`AuthMode`**（enum `#[serde(rename_all = "snake_case")]`）：`"api_key" | "auth_token"`。
- **`ConnectionStatus`**：Rust `#[derive(serde::Serialize)]`，字段 `ok: bool`、`detail: String`（读 `strategy/mod.rs` 确认——Task 6 实现时核对实际字段名）。

## Global Constraints（所有任务隐式遵守，逐条来自 spec / 项目 CLAUDE.md）

- **前端 provider-agnostic 红线**：核心 chat-event / sidecar 协议层（`src/types/chat.ts`）不得引入 provider 专属字段。provider 专属逻辑只允许以「catalog `actions` 声明 + 按 kind 选 UI 子组件 + 通用 command 路由」的形式存在（`ProviderActions.vue` 按 kind dispatch 是 UI 分发，允许；禁止在协议层或 `useChatSession` 里写 `if kind == cpa_gpt` 的业务分支）。
- **主题唯一来源**：所有颜色/背景/边框/圆角/间距用 `var(--aide-*)`，禁止硬编码 hex；`tailwind.config.js` `theme.extend` 为空（不定义颜色工具类）。
- **禁止原生浏览器 UI**：hover 提示用 `v-tooltip`（禁止 `title="..."`），弹窗用 `useModal`，瞬时回执用 `useToast`，错误/二值抉择用 `useModal.choice`/`confirm`/`prompt`。
- **非 scoped 样式规则**：ProviderSettings 现用 `<style scoped>`——新增子组件同样 scoped；若子组件内部用 v-html/动态 DOM 才需非 scoped（本计划不涉及）。
- **`@/` 别名**：vitest 已配 `@ → src`（见 `vitest.config.ts`）；测试文件用 `@/` 或相对路径均可，跟随既有测试习惯（既有测试用相对路径 `../api`）。
- **Composable 测试隔离**：模块级单例 composable 必须导出 `__resetForTest()`，`beforeEach` 里调，否则测试间状态泄漏（既有 `useNotifications.test.ts` 即此模式）。
- **提交规范**：每个 Task 末 `git commit`，message 末尾必须带 `Co-Authored-By: Claude <noreply@anthropic.com>`。分支 `provider-preset-frontend`（从 `master` 拉，**不要在 master 上开工**）。
- **类型门 = 测试门**：每个 Task 收尾必须 `pnpm vue-tsc --noEmit` 零错误；涉及 composable 的 Task 额外 `pnpm test --run`（vitest）全绿。组件 Task 无 vitest 测试，门 = vue-tsc + 手动 smoke 清单。
- **不破坏既有 provider 流**：Plan 1 已让 SystemDefault 成为 `providers[]` 里的真实条目（id `__system_default__`、kind `system_default`、enrich 后 name=`Anthropic`、base_url=空）。前端 Task 4 统一处理后，旧的「虚拟前置 systemDefault + 独立 mappings ref」整条路径删除。
- **⚠️ 保留既有 provider 业务逻辑（最易出回归的红线）**：provider 那块细节极多——`useProviders` 的 `load`/`save`/`refresh`/`displayList`/`activeProvider` 回落、`ProviderSettings.handleSave` 的字段组装（5 个 modelMappings 字段 + effort/auto_compact_window/autocompact_pct_override + knownModels 标签）、`handleActivate`/`selectProvider`/`handleDelete` 的激活与回落、`useSessionProviders` 的会话绑定、以及下游 sidecar 的 `subagentModelDefault`/`apply_initial_model_override`/autocompact 逻辑——本计划只改「SystemDefault 的存储 backing（虚拟 const → providers[] 真实条目）」与「UI 按 kind 分区」，**不改任何字段的保存语义、不改 env 注入映射、不改会话绑定、不改 drift 检测**。每个动 `useProviders`/`ProviderSettings` 的 Task（4/5/9）必须：
  1. 动手前**先通读现有对应函数全文**，列出它读/写的每个字段 + 调的每个 api；
  2. 重写后**逐字段比对**——保存路径落盘的 JSON 字段集合必须与改前等价（SystemDefault 走 `updateProvider` 后，`set_providers` 收到的 SystemDefault 条目字段 = 改前 `setSystemDefaultModelMappings` 写顶层字段 + `set_providers` 写其它条目的并集语义）；
  3. `handleSave` 组装的 `ProviderModelMappings` 5 字段 + 3 行为字段 + knownModels 必须与改前**逐字段一致**，只换落盘出口（`saveSystemDefaultMappings` → `updateProvider`），不换组装逻辑；
  4. `refreshSystemDefaultModels` facade 改走 `refresh_models(__system_default__)` 后，前端 state 同步行为（refreshing flag + 拉回最新值）必须等价；
  5. Report 里附「改前 vs 改后」字段对照表，证明无语义漂移。**怀疑某处细节用途不明时，停下问 controller，不要猜着改。**

## File Structure（本计划 touching 的文件全览）

**新增：**
```
src/composables/useProviderCatalog.ts        # catalog 加载 + presetForKind + availablePresets + enrichForDisplay
src/composables/useProviderCatalog.test.ts
src/composables/useProviderActions.ts         # 6 个 action command 的异步 wrapper + loading/error 状态
src/composables/useProviderActions.test.ts
src/components/provider/ProviderActions.vue           # 按 kind dispatch 到子组件的壳（Custom → 不渲染）
src/components/provider/ProviderActionsCpa.vue        # CpaGpt：探测端口/打开管理/Codex 登录态/测试连接
src/components/provider/ProviderActionsAnthropic.vue  # SystemDefault：刷新模型/查看额度/测试连接
src/components/provider/ProviderActionsGeneric.vue    # Ollama/Kimi/DeepSeek：仅测试连接
src/components/provider/ProviderCatalogPicker.vue     # 「+ 添加」弹的 catalog 卡片网格 + 自定义入口
```

**修改：**
```
src/types.ts                       # 加 kind + ProviderKind + AuthMode + CatalogPreset
src/api.ts                         # + 7 个新 IPC wrapper；Task 4 删 3 个废弃 wrapper
src/composables/useProviders.ts    # 统一 SystemDefault + kind-aware add + __resetForTest
src/composables/useProviders.test.ts   # 新增
src/components/ProviderSettings.vue # capstone 重构：kind-aware 表单 + catalog picker + 专属操作区
```

**不 touched**（红线确认）：`src/types/chat.ts`、`src/composables/useChatSession*`、`src/composables/useSessionProviders.ts`（会话↔provider 绑定，本计划不动）、`src/composables/useSearchProviders.ts`（搜索 provider，无关概念）。

---

### Task 1: 前端类型 — `kind` + `ProviderKind` + `AuthMode` + `CatalogPreset`

**Files:**
- Modify: `src/types.ts`（130-165 行 `ProviderConfig`/`ProviderModelMappings` 区段）
- Modify: `src/composables/useProviders.ts`（`systemDefault` const + `addProvider` 里的 `ProviderConfig` 字面量补 `kind`）

**Interfaces:**
- Produces: `ProviderKind`、`AuthMode`、`CatalogPreset` 类型；`ProviderConfig.kind: ProviderKind`。后续所有 Task 消费。

- [ ] **Step 1: 在 `src/types.ts` 加新类型**

在 `ProviderModelMappings` interface 之前插入：

```ts
/** 与 Rust `ProviderKind` enum 对齐（serde rename_all = "snake_case"）。Custom 是兜底。 */
export type ProviderKind =
  | "system_default"
  | "cpa_gpt"
  | "ollama"
  | "kimi"
  | "deepseek"
  | "custom";

/** 与 Rust `AuthMode` enum 对齐（serde rename_all = "snake_case"）。 */
export type AuthMode = "api_key" | "auth_token";

/**
 * 与 Rust `CatalogPreset` 对齐。⚠️ Rust 此 struct 无 rename_all → 字段 snake_case
 *（与 ProviderConfig 的 camelCase 不同形）。`base_url`/`auth_mode` 保持 snake。
 */
export interface CatalogPreset {
  kind: ProviderKind;
  name: string;
  icon: string;
  base_url: string;
  auth_mode: AuthMode;
  actions: string[];
}
```

给 `ProviderConfig` interface 加 `kind` 字段（插在 `id` 之后）：

```ts
export interface ProviderConfig {
  id: string;
  kind: ProviderKind;        // 新增
  name: string;
  icon: string;
  baseUrl: string;
  apiKey: string;
  authToken: string;
  model: string;
  modelMappings: ProviderModelMappings;
  effortLevel: string;
  autoCompactWindow: string;
  autocompactPctOverride: string;
  knownModels: string[];
}
```

- [ ] **Step 2: 更新 `useProviders.ts` 里所有 `ProviderConfig` 字面量补 `kind`**

`systemDefault` const（约第 30 行）加 `kind: "system_default"`：

```ts
const systemDefault: ProviderConfig = {
  id: SYSTEM_DEFAULT_ID,
  kind: "system_default",        // 新增
  name: "系统默认",
  icon: "provider",
  baseUrl: "",
  apiKey: "",
  authToken: "",
  model: "",
  modelMappings: emptyMappings(),
  effortLevel: "",
  autoCompactWindow: "",
  autocompactPctOverride: "",
  knownModels: [],
};
```

`addProvider`（约第 95 行）构造的 `p: ProviderConfig` 加 `kind: partial.kind ?? "custom"`：

```ts
const p: ProviderConfig = {
  id: generateId(),
  kind: partial.kind ?? "custom",   // 新增
  name: partial.name ?? "新供应商",
  // ... 其余不变
};
```

> `ProviderConfig` 其它构造点（grep `: ProviderConfig` 确认）若存在同样补 `kind`。既有代码仅上述两处 + 测试 fixture。

- [ ] **Step 3: 类型门**

Run: `pnpm vue-tsc --noEmit`
Expected: 零错误（若报某处缺 `kind`，按 Step 2 方式补）。

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/composables/useProviders.ts
git commit -m "feat(provider): frontend types — kind + ProviderKind + AuthMode + CatalogPreset

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: `api.ts` — 加 7 个新 IPC wrapper

**Files:**
- Modify: `src/api.ts`（「供应商」区段，约 243-262 行）
- Create: `src/api.provider.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ProviderKind`/`CatalogPreset` 类型。
- Produces: `api.getProviderCatalog`/`testProviderConnection`/`cpaProbePort`/`cpaOpenManagement`/`cpaLoginStatus`/`viewAnthropicQuota`/`refreshModels`。Task 4/6 消费。

- [ ] **Step 1: 写失败测试 `src/api.provider.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// mock @tauri-apps/api/core 的 invoke
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";

beforeEach(() => {
  (invoke as any).mockReset();
});

describe("api provider wrappers — 新增 IPC", () => {
  it("getProviderCatalog 调 invoke('get_provider_catalog')", async () => {
    (invoke as any).mockResolvedValue([]);
    await api.getProviderCatalog();
    expect(invoke).toHaveBeenCalledWith("get_provider_catalog");
  });

  it("testProviderConnection 传 providerId", async () => {
    (invoke as any).mockResolvedValue({ ok: true, detail: "" });
    await api.testProviderConnection("cpa-local");
    expect(invoke).toHaveBeenCalledWith("test_provider_connection", { providerId: "cpa-local" });
  });

  it("cpaProbePort 无参", async () => {
    (invoke as any).mockResolvedValue({ alive: true, detail: "" });
    await api.cpaProbePort();
    expect(invoke).toHaveBeenCalledWith("cpa_probe_port");
  });

  it("cpaOpenManagement 无参返回 URL", async () => {
    (invoke as any).mockResolvedValue("http://127.0.0.1:8317/management.html");
    await api.cpaOpenManagement();
    expect(invoke).toHaveBeenCalledWith("cpa_open_management");
  });

  it("cpaLoginStatus 无参", async () => {
    (invoke as any).mockResolvedValue({ logged_in: true, detail: "" });
    await api.cpaLoginStatus();
    expect(invoke).toHaveBeenCalledWith("cpa_login_status");
  });

  it("viewAnthropicQuota 无参", async () => {
    (invoke as any).mockResolvedValue({});
    await api.viewAnthropicQuota();
    expect(invoke).toHaveBeenCalledWith("view_anthropic_quota");
  });

  it("refreshModels 传 providerId", async () => {
    (invoke as any).mockResolvedValue({ anthropicModel: "x" });
    await api.refreshModels("__system_default__");
    expect(invoke).toHaveBeenCalledWith("refresh_models", { providerId: "__system_default__" });
  });
});
```

Run: `pnpm test --run src/api.provider.test.ts`
Expected: FAIL（`api.getProviderCatalog` 等不存在）。

- [ ] **Step 2: 在 `src/api.ts`「供应商」区段加 7 个 wrapper**

在现有 `refreshSystemDefaultModels()` 之后插入（暂不删废弃 wrapper——Task 4 删）：

```ts
  getProviderCatalog(): Promise<CatalogPreset[]> {
    return invoke("get_provider_catalog");
  },
  testProviderConnection(providerId: string): Promise<ConnectionStatus> {
    return invoke("test_provider_connection", { providerId });
  },
  cpaProbePort(): Promise<PortProbeResult> {
    return invoke("cpa_probe_port");
  },
  cpaOpenManagement(): Promise<string> {
    return invoke("cpa_open_management");
  },
  cpaLoginStatus(): Promise<LoginStatusResult> {
    return invoke("cpa_login_status");
  },
  viewAnthropicQuota(): Promise<unknown> {
    return invoke("view_anthropic_quota");
  },
  refreshModels(providerId: string): Promise<ProviderModelMappings> {
    return invoke("refresh_models", { providerId });
  },
```

在 `src/types.ts` 末尾加 Rust 返回的辅助类型（对齐 `commands/provider.rs` 的 `PortProbeResult`/`LoginStatusResult`/`ConnectionStatus`——字段名读 Rust 源确认）：

```ts
/** Rust `commands::provider::PortProbeResult`。 */
export interface PortProbeResult { alive: boolean; detail: string }
/** Rust `commands::provider::LoginStatusResult`。 */
export interface LoginStatusResult { logged_in: boolean; detail: string }
/** Rust `runtime::provider::strategy::ConnectionStatus`——Task 6 实现时读 strategy/mod.rs 核对字段。 */
export interface ConnectionStatus { ok: boolean; detail: string }
```

> ⚠️ `ConnectionStatus` 的真实字段以 `src-tauri/src/runtime/provider/strategy/mod.rs` 里 `pub struct ConnectionStatus` 为准——Step 2 实现时 `grep -n "struct ConnectionStatus" -A 5 src-tauri/src/runtime/provider/strategy/mod.rs` 核对，若字段名不同则改这里 + 测试。`viewAnthropicQuota` 返回 `serde_json::Value`（任意 JSON），前端用 `unknown` 接，组件层按需 narrow。

别忘了在 `src/api.ts` 顶部 import 新类型：`import type { ..., CatalogPreset, PortProbeResult, LoginStatusResult, ConnectionStatus } from "./types";`（合并进既有 type import 行）。

- [ ] **Step 3: 测试转绿 + 类型门**

Run: `pnpm test --run src/api.provider.test.ts` → Expected PASS（7/7）。
Run: `pnpm vue-tsc --noEmit` → Expected 零错误。

- [ ] **Step 4: Commit**

```bash
git add src/api.ts src/types.ts src/api.provider.test.ts
git commit -m "feat(provider): api wrappers for catalog + actions + refresh_models

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: `useProviderCatalog.ts` — catalog 加载 + 查表 + 显示富化

**Files:**
- Create: `src/composables/useProviderCatalog.ts`
- Create: `src/composables/useProviderCatalog.test.ts`

**Interfaces:**
- Consumes: `api.getProviderCatalog`（Task 2）、`ProviderKind`/`CatalogPreset`/`ProviderConfig`（Task 1）。
- Produces: `catalog` ref、`presetForKind(kind)`、`availablePresets(addedKinds)`、`enrichForDisplay(provider)`、`loadCatalog()`、`__resetForTest()`。Task 5/8 消费。

- [ ] **Step 1: 写失败测试 `src/composables/useProviderCatalog.test.ts`**

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../api", () => ({
  api: {
    getProviderCatalog: vi.fn(),
  },
}));

import { api } from "../api";
import { useProviderCatalog } from "./useProviderCatalog";
import type { CatalogPreset, ProviderConfig, ProviderKind } from "../types";

const FIXTURE: CatalogPreset[] = [
  { kind: "system_default", name: "Anthropic", icon: "A", base_url: "", auth_mode: "api_key", actions: ["refresh_models", "view_quota", "test_connection"] },
  { kind: "cpa_gpt", name: "CPA 中转", icon: "C", base_url: "http://127.0.0.1:8317", auth_mode: "auth_token", actions: ["probe_port", "open_management", "codex_login_status", "test_connection"] },
  { kind: "ollama", name: "Ollama", icon: "O", base_url: "https://ollama.com", auth_mode: "api_key", actions: ["test_connection"] },
];

describe("useProviderCatalog", () => {
  const { catalog, presetForKind, availablePresets, enrichForDisplay, loadCatalog, __resetForTest } = useProviderCatalog();

  beforeEach(() => {
    __resetForTest();
    (api.getProviderCatalog as any).mockReset();
    (api.getProviderCatalog as any).mockResolvedValue(FIXTURE);
  });

  it("loadCatalog 填 catalog ref", async () => {
    await loadCatalog();
    expect(catalog.value).toHaveLength(3);
    expect(catalog.value[0].kind).toBe("system_default");
  });

  it("presetForKind 命中返回 preset，未命中（custom）返回 undefined", () => {
    // 未 load 时 catalog 空 → 返回 undefined
    expect(presetForKind("cpa_gpt")).toBeUndefined();
  });

  it("presetForKind load 后命中", async () => {
    await loadCatalog();
    expect(presetForKind("cpa_gpt")?.name).toBe("CPA 中转");
    expect(presetForKind("custom")).toBeUndefined();
  });

  it("availablePresets 过滤掉已添加的 kind（单实例约束）", async () => {
    await loadCatalog();
    const added: ProviderKind[] = ["system_default", "cpa_gpt"];
    const avail = availablePresets(added);
    expect(avail.map((p) => p.kind)).toEqual(["ollama"]);
  });

  it("enrichForDisplay 给预置 kind 填 name/icon/baseUrl（从 catalog 派生，不动 creds）", async () => {
    await loadCatalog();
    const p: ProviderConfig = {
      id: "x", kind: "cpa_gpt", name: "", icon: "", baseUrl: "",
      apiKey: "", authToken: "sk-local", model: "",
      modelMappings: { anthropicModel: "", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", subagent: "" },
      effortLevel: "", autoCompactWindow: "", autocompactPctOverride: "", knownModels: [],
    };
    const enriched = enrichForDisplay(p);
    expect(enriched.name).toBe("CPA 中转");
    expect(enriched.icon).toBe("C");
    expect(enriched.baseUrl).toBe("http://127.0.0.1:8317");
    expect(enriched.authToken).toBe("sk-local", "凭证不动");
    expect(enriched.kind).toBe("cpa_gpt");
  });

  it("enrichForDisplay 对 Custom 原样返回（不富化）", async () => {
    await loadCatalog();
    const p: ProviderConfig = {
      id: "c", kind: "custom", name: "my", icon: "M", baseUrl: "https://gw",
      apiKey: "k", authToken: "", model: "",
      modelMappings: { anthropicModel: "", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", subagent: "" },
      effortLevel: "", autoCompactWindow: "", autocompactPctOverride: "", knownModels: [],
    };
    const enriched = enrichForDisplay(p);
    expect(enriched.name).toBe("my");
    expect(enriched.baseUrl).toBe("https://gw");
  });

  it("enrichForDisplay 在 catalog 未加载时对预置 kind 不崩（返回原样）", () => {
    const p: ProviderConfig = {
      id: "x", kind: "ollama", name: "", icon: "", baseUrl: "",
      apiKey: "", authToken: "", model: "",
      modelMappings: { anthropicModel: "", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", subagent: "" },
      effortLevel: "", autoCompactWindow: "", autocompactPctOverride: "", knownModels: [],
    };
    const enriched = enrichForDisplay(p);
    expect(enriched.kind).toBe("ollama");
    // catalog 空 → 不富化，不崩
    expect(enriched.name).toBe("");
  });
});
```

Run: `pnpm test --run src/composables/useProviderCatalog.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 2: 实现 `src/composables/useProviderCatalog.ts`**

```ts
import { ref } from "vue";
import { api } from "../api";
import type { CatalogPreset, ProviderConfig, ProviderKind } from "../types";

const catalog = ref<CatalogPreset[]>([]);

/** 找 kind 对应的 preset；Custom / 未加载时返回 undefined。 */
function presetForKind(kind: ProviderKind): CatalogPreset | undefined {
  return catalog.value.find((p) => p.kind === kind);
}

/**
 * 单实例约束：返回还没被添加的 preset（addedKinds 里的置灰排除）。
 * catalog 不含 Custom——Custom 永远可加，由 picker 的「自定义」入口单独处理。
 */
function availablePresets(addedKinds: ProviderKind[]): CatalogPreset[] {
  return catalog.value.filter((p) => !addedKinds.includes(p.kind));
}

/**
 * 显示富化：预置 kind 的 name/icon/baseUrl 从 catalog 派生（内存态，对应 Rust enrich）。
 * ⚠️ CatalogPreset.base_url (snake) → ProviderConfig.baseUrl (camel) 映射。
 * Custom / catalog 未加载 / 未命中 → 原样返回（不崩）。
 * 不动凭证与 modelMappings——只富化身份三件套。
 */
function enrichForDisplay(p: ProviderConfig): ProviderConfig {
  if (p.kind === "custom") return p;
  const preset = presetForKind(p.kind);
  if (!preset) return p;
  return { ...p, name: preset.name, icon: preset.icon, baseUrl: preset.base_url };
}

async function loadCatalog(): Promise<void> {
  try {
    catalog.value = await api.getProviderCatalog();
  } catch (e) {
    console.warn("加载 provider catalog 失败:", e);
    // 保留空 catalog，UI 降级——预置 kind 显示空身份，不崩
  }
}

function __resetForTest(): void {
  catalog.value = [];
}

export function useProviderCatalog() {
  return { catalog, presetForKind, availablePresets, enrichForDisplay, loadCatalog, __resetForTest };
}
```

- [ ] **Step 3: 测试转绿 + 类型门**

Run: `pnpm test --run src/composables/useProviderCatalog.test.ts` → Expected PASS（7/7）。
Run: `pnpm vue-tsc --noEmit` → Expected 零错误。

- [ ] **Step 4: Commit**

```bash
git add src/composables/useProviderCatalog.ts src/composables/useProviderCatalog.test.ts
git commit -m "feat(provider): useProviderCatalog composable — load + presetForKind + enrichForDisplay

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: `useProviders.ts` 统一 SystemDefault + 删废弃 api wrapper

**Files:**
- Modify: `src/composables/useProviders.ts`
- Create: `src/composables/useProviders.test.ts`
- Modify: `src/api.ts`（删 3 个废弃 wrapper）

**Interfaces:**
- Consumes: `api.refreshModels`（Task 2）、Task 1 的 `kind` 字段。
- Produces: 统一后的 `useProviders` API（保持既有导出形状用 facade，让 `ProviderSettings.vue` 模板暂不崩；Task 9 重构模板后这些 facade 可删）。新增 `__resetForTest`。

**核心改动**：SystemDefault 不再是硬编码 const + 独立 mappings ref。`get_providers()` 现在返回的第一项就是 SystemDefault 真实条目（id `__system_default__`、kind `system_default`、enrich 后 name=`Anthropic`）。`displayList` 不再前置虚拟条目。`systemDefault`/`systemDefaultMappings`/`saveSystemDefaultMappings`/`refreshSystemDefaultModels` 退化为 facade，背后走统一 `providers[]` 路径。

- [ ] **Step 0: 通读现有 `useProviders.ts` + 字段清单（保留红线，必做）**

读 `src/composables/useProviders.ts` 全文 + `src/components/ProviderSettings.vue` 里所有调 `useProviders()` 返回值的地方（grep `useProviders()` / `systemDefaultMappings` / `saveSystemDefaultMappings` / `refreshSystemDefaultModels` / `systemDefault` in `src/`）。列出报告里：
- 现有 `load()` 调哪 3 个 api、写哪几个 ref；
- 现有 `saveSystemDefaultMappings` 调哪个 api、写哪个 ref + const 的哪个字段；
- 现有 `refreshSystemDefaultModels` 调哪个 api、写哪些状态、`refreshing` flag 何时置位；
- 现有 `displayList`/`activeProvider` 的回落逻辑；
- `ProviderSettings.vue` 模板读了 `useProviders` 的哪些导出（这决定 facade 必须保留哪些形状）。
**这份清单是 Step 2 重写后逐字段比对的基线。任何看不懂用途的细节停下问 controller，不要猜着改。**

- [ ] **Step 1: 写失败测试 `src/composables/useProviders.test.ts`**

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../api", () => ({
  api: {
    getProviders: vi.fn(),
    setProviders: vi.fn(),
    getActiveProviderId: vi.fn(),
    setActiveProviderId: vi.fn(),
    refreshModels: vi.fn(),
    getProviderCatalog: vi.fn().mockResolvedValue([]),
  },
}));

import { api } from "../api";
import { useProviders } from "./useProviders";
import type { ProviderConfig } from "../types";

const sd = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: "__system_default__", kind: "system_default", name: "Anthropic", icon: "A", baseUrl: "",
  apiKey: "", authToken: "", model: "",
  modelMappings: { anthropicModel: "claude-3", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", subagent: "" },
  effortLevel: "", autoCompactWindow: "", autocompactPctOverride: "", knownModels: [],
  ...overrides,
});

const cpa = (): ProviderConfig => ({
  id: "cpa-local", kind: "cpa_gpt", name: "CPA 中转", icon: "C", baseUrl: "http://127.0.0.1:8317",
  apiKey: "", authToken: "sk-local-cpa", model: "",
  modelMappings: { anthropicModel: "", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", subagent: "" },
  effortLevel: "", autoCompactWindow: "", autocompactPctOverride: "", knownModels: [],
});

describe("useProviders — SystemDefault 统一", () => {
  const P = useProviders();
  const { allProviders, displayList, activeProvider, systemDefault, systemDefaultMappings, load, updateProvider, saveSystemDefaultMappings, refreshSystemDefaultModels, __resetForTest } = P;

  beforeEach(() => {
    __resetForTest();
    (api.getProviders as any).mockReset();
    (api.getActiveProviderId as any).mockReset();
    (api.refreshModels as any).mockReset();
    (api.setProviders as any).mockReset().mockResolvedValue(undefined);
  });

  it("load 后 allProviders 含 SystemDefault 真实条目（来自 get_providers，不再虚拟前置）", async () => {
    (api.getProviders as any).mockResolvedValue([sd(), cpa()]);
    (api.getActiveProviderId as any).mockResolvedValue("__system_default__");
    await load();
    expect(allProviders.value.map((p) => p.id)).toEqual(["__system_default__", "cpa-local"]);
  });

  it("displayList = allProviders（SystemDefault 已在数组里，不重复前置）", async () => {
    (api.getProviders as any).mockResolvedValue([sd(), cpa()]);
    (api.getActiveProviderId as any).mockResolvedValue("cpa-local");
    await load();
    expect(displayList.value).toHaveLength(2);
    expect(displayList.value[0].id).toBe("__system_default__");
  });

  it("systemDefault computed 找 id=__system_default__ 的条目", async () => {
    (api.getProviders as any).mockResolvedValue([sd({ name: "Anthropic 官方" }), cpa()]);
    (api.getActiveProviderId as any).mockResolvedValue("cpa-local");
    await load();
    expect(systemDefault.value?.name).toBe("Anthropic 官方");
  });

  it("systemDefaultMappings computed 从 systemDefault.modelMappings 派生（不再独立 ref）", async () => {
    (api.getProviders as any).mockResolvedValue([sd()]);
    (api.getActiveProviderId as any).mockResolvedValue("__system_default__");
    await load();
    expect(systemDefaultMappings.value.anthropicModel).toBe("claude-3");
  });

  it("activeProvider 找不到时回落 SystemDefault", async () => {
    (api.getProviders as any).mockResolvedValue([sd()]);
    (api.getActiveProviderId as any).mockResolvedValue("nope");
    await load();
    expect(activeProvider.value.id).toBe("__system_default__");
  });

  it("saveSystemDefaultMappings 走 updateProvider(__system_default__, …)（不再调废弃 setSystemDefaultModelMappings）", async () => {
    (api.getProviders as any).mockResolvedValue([sd()]);
    (api.getActiveProviderId as any).mockResolvedValue("__system_default__");
    await load();
    await saveSystemDefaultMappings({ anthropicModel: "claude-4", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", subagent: "" });
    expect(api.setProviders).toHaveBeenCalledTimes(1);
    const saved = (api.setProviders as any).mock.calls[0][0] as ProviderConfig[];
    expect(saved.find((p) => p.id === "__system_default__")?.modelMappings.anthropicModel).toBe("claude-4");
  });

  it("refreshSystemDefaultModels 调 api.refreshModels('__system_default__')（不再调废弃 refreshSystemDefaultModels）", async () => {
    (api.getProviders as any).mockResolvedValue([sd()]);
    (api.getActiveProviderId as any).mockResolvedValue("__system_default__");
    (api.refreshModels as any).mockResolvedValue({ anthropicModel: "claude-4", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", subagent: "" });
    await load();
    await refreshSystemDefaultModels();
    expect(api.refreshModels).toHaveBeenCalledWith("__system_default__");
  });

  it("updateProvider 合并并落盘 setProviders", async () => {
    (api.getProviders as any).mockResolvedValue([sd(), cpa()]);
    (api.getActiveProviderId as any).mockResolvedValue("cpa-local");
    await load();
    await updateProvider("cpa-local", { authToken: "sk-new" });
    expect(allProviders.value.find((p) => p.id === "cpa-local")?.authToken).toBe("sk-new");
    expect(api.setProviders).toHaveBeenCalled();
  });
});
```

Run: `pnpm test --run src/composables/useProviders.test.ts`
Expected: FAIL（既有 `useProviders` 还有 `getSystemDefaultModelMappings` 调用 + 硬编码 const，行为不符）。

- [ ] **Step 2: 重写 `src/composables/useProviders.ts`**

```ts
import { ref, computed } from "vue";
import { api } from "../api";
import type { ProviderConfig, ProviderModelMappings } from "../types";

const SYSTEM_DEFAULT_ID = "__system_default__";

const emptyMappings = (): ProviderModelMappings => ({
  anthropicModel: "",
  defaultOpusModel: "",
  defaultSonnetModel: "",
  defaultHaikuModel: "",
  subagent: "",
});

// 模块级单例状态。SystemDefault 现在是 allProviders 里 id=__system_default__ 的真实条目
// （Plan 1 后 Rust get_providers 返回的第一项），不再硬编码 const + 独立 mappings ref。
const allProviders = ref<ProviderConfig[]>([]);
const activeProviderId = ref<string>(SYSTEM_DEFAULT_ID);
const loaded = ref(false);
const refreshing = ref(false);

const displayList = computed<ProviderConfig[]>(() => {
  // SystemDefault 恒置首（即使 get_providers 顺序变了也稳）
  const sd = allProviders.value.find((p) => p.id === SYSTEM_DEFAULT_ID);
  const rest = allProviders.value.filter((p) => p.id !== SYSTEM_DEFAULT_ID);
  return sd ? [sd, ...rest] : rest;
});

const systemDefault = computed<ProviderConfig | undefined>(() =>
  allProviders.value.find((p) => p.id === SYSTEM_DEFAULT_ID),
);

const systemDefaultMappings = computed<ProviderModelMappings>(
  () => systemDefault.value?.modelMappings ?? emptyMappings(),
);

const activeProvider = computed<ProviderConfig>(() => {
  const found = allProviders.value.find((p) => p.id === activeProviderId.value);
  if (found) return found;
  return systemDefault.value ?? fallbackSystemDefault();
});

// 仅当 providers[] 里竟然没有 SystemDefault 条目时用（异常降级，不崩）
function fallbackSystemDefault(): ProviderConfig {
  return {
    id: SYSTEM_DEFAULT_ID, kind: "system_default", name: "系统默认", icon: "provider", baseUrl: "",
    apiKey: "", authToken: "", model: "", modelMappings: emptyMappings(),
    effortLevel: "", autoCompactWindow: "", autocompactPctOverride: "", knownModels: [],
  };
}

function generateId(): string {
  return crypto.randomUUID?.() ?? `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function load(): Promise<void> {
  try {
    const [providers, id] = await Promise.all([
      api.getProviders(),
      api.getActiveProviderId(),
    ]);
    allProviders.value = providers;
    activeProviderId.value = id;
  } catch {
    // keep defaults
  }
  loaded.value = true;
}

async function addProvider(partial: Partial<ProviderConfig> = {}): Promise<ProviderConfig> {
  const p: ProviderConfig = {
    id: generateId(),
    kind: partial.kind ?? "custom",
    name: partial.name ?? "新供应商",
    icon: partial.icon ?? "provider",
    baseUrl: partial.baseUrl ?? "",
    apiKey: partial.apiKey ?? "",
    authToken: partial.authToken ?? "",
    model: partial.model ?? "",
    modelMappings: partial.modelMappings ?? emptyMappings(),
    effortLevel: partial.effortLevel ?? "",
    autoCompactWindow: partial.autoCompactWindow ?? "",
    autocompactPctOverride: partial.autocompactPctOverride ?? "",
    knownModels: partial.knownModels ?? [],
  };
  allProviders.value = [...allProviders.value, p];
  await api.setProviders(allProviders.value);
  return p;
}

async function updateProvider(id: string, partial: Partial<ProviderConfig>): Promise<void> {
  const idx = allProviders.value.findIndex((p) => p.id === id);
  if (idx === -1) return;
  allProviders.value[idx] = { ...allProviders.value[idx], ...partial };
  allProviders.value = [...allProviders.value];
  await api.setProviders(allProviders.value);
}

async function deleteProvider(id: string): Promise<void> {
  allProviders.value = allProviders.value.filter((p) => p.id !== id);
  await api.setProviders(allProviders.value);
  if (activeProviderId.value === id) {
    activeProviderId.value = SYSTEM_DEFAULT_ID;
    await api.setActiveProviderId(SYSTEM_DEFAULT_ID);
  }
}

async function setActiveProvider(id: string): Promise<void> {
  activeProviderId.value = id;
  await api.setActiveProviderId(id);
}

// —— SystemDefault facade（保持既有导出形状，ProviderSettings.vue 模板暂不崩；
//    Task 9 重构模板后若不再用，可删 facade）——
async function saveSystemDefaultMappings(mappings: ProviderModelMappings): Promise<void> {
  await updateProvider(SYSTEM_DEFAULT_ID, { modelMappings: mappings });
}

async function refreshSystemDefaultModels(): Promise<void> {
  refreshing.value = true;
  try {
    await api.refreshModels(SYSTEM_DEFAULT_ID);
    // 拉回最新 providers（refresh_models 持久化到 providers[]，前端 ref 要同步）
    allProviders.value = await api.getProviders();
  } catch (e) {
    console.warn("刷新系统默认模型列表失败:", e);
  } finally {
    refreshing.value = false;
  }
}

function __resetForTest(): void {
  allProviders.value = [];
  activeProviderId.value = SYSTEM_DEFAULT_ID;
  loaded.value = false;
  refreshing.value = false;
}

export function useProviders() {
  return {
    allProviders,
    activeProviderId,
    displayList,
    activeProvider,
    systemDefault,
    systemDefaultMappings,
    loaded,
    load,
    addProvider,
    updateProvider,
    deleteProvider,
    setActiveProvider,
    saveSystemDefaultMappings,
    refreshSystemDefaultModels,
    refreshing,
    SYSTEM_DEFAULT_ID,
    __resetForTest,
  };
}
```

- [ ] **Step 3: 从 `src/api.ts` 删 3 个废弃 wrapper**

删除：
```ts
  getSystemDefaultModelMappings(): Promise<ProviderModelMappings> { return invoke("get_system_default_model_mappings"); },
  setSystemDefaultModelMappings(mappings: ProviderModelMappings): Promise<void> { return invoke("set_system_default_model_mappings", { mappings }); },
  refreshSystemDefaultModels(): Promise<ProviderModelMappings> { return invoke("refresh_system_default_models"); },
```

> 删前 grep 确认无其它消费：`grep -rn "getSystemDefaultModelMappings\|setSystemDefaultModelMappings\|refreshSystemDefaultModels" src/`。应只剩 `api.ts` 定义 + `useProviders.ts`（Task 4 Step 2 已移除调用）+ `useProviders.test.ts` 的 mock（不含这仨，OK）。若有其它消费，先迁移再删。

- [ ] **Step 4: 测试转绿 + 类型门**

Run: `pnpm test --run src/composables/useProviders.test.ts` → Expected PASS（8/8）。
Run: `pnpm vue-tsc --noEmit` → Expected 零错误（若 `ProviderSettings.vue` 模板仍引用已删 api 方法会报——届时在 Task 9 修；若报错仅来自 `ProviderSettings.vue` 且是「已删方法」引用，临时注释该行让类型门过，Task 9 重构时彻底处理。**记录此情况到 report**）。

- [ ] **Step 4.5: 语义保留核对（保留红线，必做）**

对照 Step 0 的字段清单，在 report 里附「改前 vs 改后」表，逐项证明：
- `load()`：改前调 3 个 api（getProviders + getActiveProviderId + getSystemDefaultModelMappings）→ 改后调 2 个（getProviders + getActiveProviderId）。SystemDefault 的 mappings 现从 `getProviders` 返回的条目里取——**证明 Rust `get_providers` 返回的 SystemDefault 条目 `modelMappings` 与改前 `getSystemDefaultModelMappings` 顶层字段同源**（Plan 1 迁移已把顶层 sdm 收进 providers[] 条目，故等价）。
- `saveSystemDefaultMappings(m)`：改前 `setSystemDefaultModelMappings(m)` 写顶层字段 → 改后 `updateProvider(__system_default__, {modelMappings:m})` 走 `set_providers`。**证明落盘后 SystemDefault 条目的 modelMappings = 改前顶层字段值**（Rust `set_providers` strip 预置身份但保留 modelMappings，SystemDefault 是预置 kind，modelMappings 保留 ✓）。
- `refreshSystemDefaultModels`：改前 `refresh_system_default_models` 返回 mappings + 写本地 ref → 改后 `refresh_models(__system_default__)` + `load()` 同步。**证明 Rust `refresh_models` 对 SystemDefault 的持久化与改前等价**（Plan 1 Task 12 fix wave 已统一写 providers[] by id，SystemDefault 条目更新 ✓）。
- `displayList`/`activeProvider` 回落：改前虚拟前置 systemDefault const + find 回落 → 改后 SystemDefault 在 allProviders 里 + find 回落。**证明显示顺序与回落行为一致**（SystemDefault 恒置首 + 找不到 active 时回落 SystemDefault ✓）。
任何一项不能证明等价 → 停下问 controller。

- [ ] **Step 5: Commit**

```bash
git add src/composables/useProviders.ts src/composables/useProviders.test.ts src/api.ts
git commit -m "refactor(provider): unify SystemDefault into providers[] + drop deprecated sdm api wrappers

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: `useProviders.ts` kind-aware add — `addPresetProvider` + `addCustomProvider`

**Files:**
- Modify: `src/composables/useProviders.ts`
- Modify: `src/composables/useProviders.test.ts`（加测试）

**Interfaces:**
- Consumes: `useProviderCatalog.enrichForDisplay`（Task 3）。
- Produces: `addPresetProvider(kind)`（单实例 guard + 显示富化）、`addCustomProvider()`。Task 8（catalog picker）+ Task 9（ProviderSettings handleAdd）消费。

- [ ] **Step 1: 加失败测试到 `src/composables/useProviders.test.ts`**

在既有 describe 内加（或在 vi.mock 里补 `getProviderCatalog`——已在 Task 4 mock 里加了 `getProviderCatalog: vi.fn().mockResolvedValue([])`；这里要让它返回 fixture）。先在文件顶部 mock 区把 `getProviderCatalog` 的 mock 改成可配置，再加用例：

```ts
// 新增 import
import { useProviderCatalog } from "./useProviderCatalog";

// 在 describe 内加：
describe("useProviders — kind-aware add", () => {
  const P = useProviders();
  const C = useProviderCatalog();
  const { allProviders, addPresetProvider, addCustomProvider, __resetForTest } = P;

  beforeEach(async () => {
    P.__resetForTest();
    C.__resetForTest();
    (api.getProviders as any).mockReset().mockResolvedValue([]);
    (api.setProviders as any).mockReset().mockResolvedValue(undefined);
    (api.getProviderCatalog as any).mockResolvedValue([
      { kind: "cpa_gpt", name: "CPA 中转", icon: "C", base_url: "http://127.0.0.1:8317", auth_mode: "auth_token", actions: [] },
      { kind: "ollama", name: "Ollama", icon: "O", base_url: "https://ollama.com", auth_mode: "api_key", actions: [] },
    ]);
    await C.loadCatalog();
  });

  it("addPresetProvider(kind) 创建该 kind 实例，kind 正确，身份从 catalog 富化显示", async () => {
    const p = await addPresetProvider("cpa_gpt");
    expect(p.kind).toBe("cpa_gpt");
    expect(p.name).toBe("CPA 中转", "显示富化");
    expect(p.baseUrl).toBe("http://127.0.0.1:8317");
    expect(p.authToken).toBe("", "凭证留空待填");
    expect(p.id).not.toBe("");
  });

  it("addPresetProvider 单实例 guard：已存在的 kind 抛错", async () => {
    await addPresetProvider("cpa_gpt");
    await expect(addPresetProvider("cpa_gpt")).rejects.toThrow(/已存在|single instance/i);
  });

  it("addPresetProvider 落盘 setProviders（Rust 会 strip 身份字段，只存 kind+creds+mappings）", async () => {
    await addPresetProvider("ollama");
    expect(api.setProviders).toHaveBeenCalledTimes(1);
  });

  it("addCustomProvider 创建 kind=custom 实例，身份字段留空待用户填", async () => {
    const p = await addCustomProvider();
    expect(p.kind).toBe("custom");
    expect(p.name).toBe("新供应商");
    expect(p.baseUrl).toBe("");
  });
});
```

Run: `pnpm test --run src/composables/useProviders.test.ts`
Expected: FAIL（`addPresetProvider`/`addCustomProvider` 不存在）。

- [ ] **Step 2: 在 `useProviders.ts` 加两个方法**

顶部 import 加：`import { useProviderCatalog } from "./useProviderCatalog";`

在 `addProvider` 之后加：

```ts
/**
 * 新增预置 kind 实例。单实例约束：同 kind 已存在则抛错（picker 也会置灰，这是双保险）。
 * 身份字段（name/icon/baseUrl）从 catalog 富化填入——仅显示用；落盘时 Rust strip 只存
 * kind + 凭证 + mappings + 行为字段。凭证留空待用户填。
 */
async function addPresetProvider(kind: ProviderKind): Promise<ProviderConfig> {
  if (allProviders.value.some((p) => p.kind === kind)) {
    throw new Error(`该供应商类型已存在（单实例约束）：${kind}`);
  }
  const { enrichForDisplay } = useProviderCatalog();
  const p: ProviderConfig = enrichForDisplay({
    id: generateId(),
    kind,
    name: "", icon: "", baseUrl: "",
    apiKey: "", authToken: "", model: "",
    modelMappings: emptyMappings(),
    effortLevel: "", autoCompactWindow: "", autocompactPctOverride: "",
    knownModels: [],
  });
  allProviders.value = [...allProviders.value, p];
  await api.setProviders(allProviders.value);
  return p;
}

/** 新增 Custom 实例——全部字段可编辑，身份由用户填。 */
async function addCustomProvider(): Promise<ProviderConfig> {
  return addProvider({ kind: "custom" });
}
```

import 类型补：`import type { ProviderConfig, ProviderKind, ProviderModelMappings } from "../types";`（加 `ProviderKind`）。

`useProviders()` 返回对象加：`addPresetProvider, addCustomProvider,`。

- [ ] **Step 3: 测试转绿 + 类型门**

Run: `pnpm test --run src/composables/useProviders.test.ts` → Expected PASS（既有 8 + 新 4 = 12）。
Run: `pnpm vue-tsc --noEmit` → Expected 零错误。

- [ ] **Step 4: Commit**

```bash
git add src/composables/useProviders.ts src/composables/useProviders.test.ts
git commit -m "feat(provider): addPresetProvider (single-instance + enrich) + addCustomProvider

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: `useProviderActions.ts` — 6 个 action command 的异步 wrapper

**Files:**
- Create: `src/composables/useProviderActions.ts`
- Create: `src/composables/useProviderActions.test.ts`

**Interfaces:**
- Consumes: `api.testProviderConnection`/`cpaProbePort`/`cpaOpenManagement`/`cpaLoginStatus`/`viewAnthropicQuota`/`refreshModels`（Task 2）、`@tauri-apps/plugin-shell` 的 `open`。
- Produces: `testConnection(id)`、`cpaProbe()`、`cpaOpenManagement()`（调 `open(url)`）、`cpaLoginStatus()`、`viewQuota()`、`refreshModels(id)` + 每个的 loading/result/error 状态。Task 7 子组件消费。

- [ ] **Step 1: 写失败测试 `src/composables/useProviderActions.test.ts`**

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../api", () => ({
  api: {
    testProviderConnection: vi.fn(),
    cpaProbePort: vi.fn(),
    cpaOpenManagement: vi.fn(),
    cpaLoginStatus: vi.fn(),
    viewAnthropicQuota: vi.fn(),
    refreshModels: vi.fn(),
  },
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(),
}));

import { api } from "../api";
import { open } from "@tauri-apps/plugin-shell";
import { useProviderActions } from "./useProviderActions";

describe("useProviderActions", () => {
  const A = useProviderActions();
  const { testConnection, cpaProbe, cpaOpenManagement, cpaLoginStatus, viewQuota, refreshModels, __resetForTest } = A;

  beforeEach(() => {
    __resetForTest();
    (api.testProviderConnection as any).mockReset();
    (api.cpaProbePort as any).mockReset();
    (api.cpaOpenManagement as any).mockReset();
    (api.cpaLoginStatus as any).mockReset();
    (api.viewAnthropicQuota as any).mockReset();
    (api.refreshModels as any).mockReset();
    (open as any).mockReset();
  });

  it("testConnection(id) 调 api.testProviderConnection 并存结果", async () => {
    (api.testProviderConnection as any).mockResolvedValue({ ok: true, detail: "ok" });
    const r = await testConnection("cpa-local");
    expect(api.testProviderConnection).toHaveBeenCalledWith("cpa-local");
    expect(r?.ok).toBe(true);
  });

  it("cpaProbe 调 api.cpaProbePort 存 PortProbeResult", async () => {
    (api.cpaProbePort as any).mockResolvedValue({ alive: true, detail: "响应" });
    const r = await cpaProbe();
    expect(r?.alive).toBe(true);
  });

  it("cpaOpenManagement 拿 URL 后调 shell.open(url)", async () => {
    (api.cpaOpenManagement as any).mockResolvedValue("http://127.0.0.1:8317/management.html");
    await cpaOpenManagement();
    expect(open).toHaveBeenCalledWith("http://127.0.0.1:8317/management.html");
  });

  it("cpaLoginStatus 存 LoginStatusResult", async () => {
    (api.cpaLoginStatus as any).mockResolvedValue({ logged_in: true, detail: "已登录" });
    const r = await cpaLoginStatus();
    expect(r?.logged_in).toBe(true);
  });

  it("viewQuota 存任意 JSON", async () => {
    (api.viewAnthropicQuota as any).mockResolvedValue({ usage: 50 });
    const r = await viewQuota();
    expect((r as any).usage).toBe(50);
  });

  it("refreshModels(id) 调 api.refreshModels", async () => {
    (api.refreshModels as any).mockResolvedValue({ anthropicModel: "x" });
    await refreshModels("__system_default__");
    expect(api.refreshModels).toHaveBeenCalledWith("__system_default__");
  });

  it("action 失败时 lastError 被记录、不抛（UI 自己决定怎么展示）", async () => {
    (api.cpaProbePort as any).mockRejectedValue(new Error("boom"));
    const r = await cpaProbe();
    expect(r).toBeNull();
    expect(A.lastError.value).toContain("boom");
  });
});
```

Run: `pnpm test --run src/composables/useProviderActions.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 2: 实现 `src/composables/useProviderActions.ts`**

```ts
import { ref } from "vue";
import { api } from "../api";
import { open } from "@tauri-apps/plugin-shell";
import type { ConnectionStatus, PortProbeResult, LoginStatusResult, ProviderModelMappings } from "../types";

const lastError = ref<string | null>(null);
const probing = ref(false);
const testing = ref(false);
const refreshing = ref(false);
const loginChecking = ref(false);
const quotaLoading = ref(false);

const probeResult = ref<PortProbeResult | null>(null);
const connectionResult = ref<ConnectionStatus | null>(null);
const loginResult = ref<LoginStatusResult | null>(null);
const quotaResult = ref<unknown>(null);

async function run<T>(flag: { value: boolean }, fn: () => Promise<T>): Promise<T | null> {
  flag.value = true;
  lastError.value = null;
  try {
    return await fn();
  } catch (e: any) {
    lastError.value = e?.message ?? String(e);
    return null;
  } finally {
    flag.value = false;
  }
}

async function testConnection(providerId: string): Promise<ConnectionStatus | null> {
  const r = await run(testing, () => api.testProviderConnection(providerId));
  if (r) connectionResult.value = r;
  return r;
}

async function cpaProbe(): Promise<PortProbeResult | null> {
  const r = await run(probing, () => api.cpaProbePort());
  if (r) probeResult.value = r;
  return r;
}

async function cpaOpenManagement(): Promise<void> {
  const url = await run(ref({ value: false }), () => api.cpaOpenManagement());
  if (url) {
    try {
      await open(url);
    } catch (e: any) {
      lastError.value = `打开管理面板失败: ${e?.message ?? e}`;
    }
  }
}

async function cpaLoginStatus(): Promise<LoginStatusResult | null> {
  const r = await run(loginChecking, () => api.cpaLoginStatus());
  if (r) loginResult.value = r;
  return r;
}

async function viewQuota(): Promise<unknown | null> {
  const r = await run(quotaLoading, () => api.viewAnthropicQuota());
  if (r) quotaResult.value = r;
  return r;
}

async function refreshModels(providerId: string): Promise<ProviderModelMappings | null> {
  return run(refreshing, () => api.refreshModels(providerId));
}

function __resetForTest(): void {
  lastError.value = null;
  probing.value = testing.value = refreshing.value = loginChecking.value = quotaLoading.value = false;
  probeResult.value = connectionResult.value = loginResult.value = null;
  quotaResult.value = null;
}

export function useProviderActions() {
  return {
    lastError, probing, testing, refreshing, loginChecking, quotaLoading,
    probeResult, connectionResult, loginResult, quotaResult,
    testConnection, cpaProbe, cpaOpenManagement, cpaLoginStatus, viewQuota, refreshModels,
    __resetForTest,
  };
}
```

- [ ] **Step 3: 测试转绿 + 类型门**

Run: `pnpm test --run src/composables/useProviderActions.test.ts` → Expected PASS（7/7）。
Run: `pnpm vue-tsc --noEmit` → Expected 零错误。

- [ ] **Step 4: Commit**

```bash
git add src/composables/useProviderActions.ts src/composables/useProviderActions.test.ts
git commit -m "feat(provider): useProviderActions composable — 6 action wrappers + loading/error state

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: 专属操作区子组件 + dispatcher

**Files:**
- Create: `src/components/provider/ProviderActionsGeneric.vue`
- Create: `src/components/provider/ProviderActionsAnthropic.vue`
- Create: `src/components/provider/ProviderActionsCpa.vue`
- Create: `src/components/provider/ProviderActions.vue`

**Interfaces:**
- Consumes: `useProviderActions`（Task 6）、`v-tooltip`、`useToast`、`var(--aide-*)`。
- Produces: `<ProviderActions :provider="..." />` 按 `provider.kind` dispatch；Custom → 不渲染。Task 9 在表单底部挂它。

**无组件测试基建**——门 = `pnpm vue-tsc --noEmit` + 手动 smoke（Task 9 一起验）。所有状态/逻辑在 composable（Task 6 已测），组件仅渲染 + 调 wrapper，薄。

- [ ] **Step 1: `ProviderActionsGeneric.vue`（Ollama/Kimi/DeepSeek：仅测试连接）**

```vue
<script setup lang="ts">
import { useProviderActions } from "@/composables/useProviderActions";
import { useToast } from "@/composables/useToast";

const props = defineProps<{ providerId: string }>();
const { testConnection, testing, connectionResult } = useProviderActions();
const toast = useToast();

async function onTest() {
  const r = await testConnection(props.providerId);
  if (r) toast.notice("连接测试", r.detail || (r.ok ? "成功" : "失败"), r.ok ? "success" : "error");
}
</script>

<template>
  <div class="actions-area">
    <button class="action-btn" :disabled="testing" @click="onTest">
      {{ testing ? "测试中…" : "测试连接" }}
    </button>
    <span v-if="connectionResult" class="status-badge" :class="connectionResult.ok ? 'ok' : 'fail'">
      {{ connectionResult.ok ? "可连接" : "不可连接" }}
    </span>
  </div>
</template>

<style scoped>
.actions-area { display: flex; gap: 10px; align-items: center; padding: 10px 0; }
.action-btn {
  padding: 6px 14px; border-radius: var(--aide-radius-sm);
  background: var(--aide-surface-default); color: var(--aide-text-primary);
  border: 1px solid var(--aide-border); cursor: pointer; font-size: 14px;
}
.action-btn:hover:not(:disabled) { background: var(--aide-surface-hover); }
.action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.status-badge { padding: 2px 8px; border-radius: var(--aide-radius-sm); font-size: 12px; }
.status-badge.ok { background: var(--aide-success); color: var(--aide-text-on-accent); }
.status-badge.fail { background: var(--aide-danger); color: var(--aide-text-on-accent); }
</style>
```

> 先确认 `useToast` 的 `notice(title, msg, type)` 签名与 `AToast` 三态（success/error/info）——读 `src/composables/useToast.ts` 核对，若方法名/参数不同按实际改。`@/` 别名在 vue-tsc + vite 都通（vitest 也配了）。

- [ ] **Step 2: `ProviderActionsAnthropic.vue`（SystemDefault：刷新模型 + 查看额度 + 测试连接）**

```vue
<script setup lang="ts">
import { useProviderActions } from "@/composables/useProviderActions";
import { useToast } from "@/composables/useToast";
import { useProviders } from "@/composables/useProviders";

const props = defineProps<{ providerId: string }>();
const { testConnection, testing, connectionResult, viewQuota, quotaLoading, quotaResult, refreshModels, refreshing } = useProviderActions();
const { load } = useProviders();
const toast = useToast();

async function onTest() {
  const r = await testConnection(props.providerId);
  if (r) toast.notice("连接测试", r.detail || (r.ok ? "成功" : "失败"), r.ok ? "success" : "error");
}
async function onRefresh() {
  const m = await refreshModels(props.providerId);
  if (m) {
    await load(); // 同步前端 ref（refresh_models 持久化到 providers[]）
    toast.notice("刷新模型", "已更新模型映射", "success");
  }
}
async function onQuota() {
  const r = await viewQuota();
  if (r) toast.notice("额度", JSON.stringify(r), "info");
}
</script>

<template>
  <div class="actions-area">
    <button class="action-btn" :disabled="refreshing" @click="onRefresh">{{ refreshing ? "刷新中…" : "刷新模型列表" }}</button>
    <button class="action-btn" :disabled="quotaLoading" @click="onQuota">{{ quotaLoading ? "查询中…" : "查看额度" }}</button>
    <button class="action-btn" :disabled="testing" @click="onTest">{{ testing ? "测试中…" : "测试连接" }}</button>
    <span v-if="connectionResult" class="status-badge" :class="connectionResult.ok ? 'ok' : 'fail'">{{ connectionResult.ok ? "可连接" : "不可连接" }}</span>
  </div>
</template>

<style scoped>
.actions-area { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 10px 0; }
.action-btn { padding: 6px 14px; border-radius: var(--aide-radius-sm); background: var(--aide-surface-default); color: var(--aide-text-primary); border: 1px solid var(--aide-border); cursor: pointer; font-size: 14px; }
.action-btn:hover:not(:disabled) { background: var(--aide-surface-hover); }
.action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.status-badge { padding: 2px 8px; border-radius: var(--aide-radius-sm); font-size: 12px; }
.status-badge.ok { background: var(--aide-success); color: var(--aide-text-on-accent); }
.status-badge.fail { background: var(--aide-danger); color: var(--aide-text-on-accent); }
</style>
```

- [ ] **Step 3: `ProviderActionsCpa.vue`（CpaGpt：探测端口 + 打开管理 + Codex 登录态 + 测试连接）**

```vue
<script setup lang="ts">
import { onMounted } from "vue";
import { useProviderActions } from "@/composables/useProviderActions";
import { useToast } from "@/composables/useToast";

const props = defineProps<{ providerId: string }>();
const { testConnection, testing, connectionResult, cpaProbe, probing, probeResult, cpaOpenManagement, cpaLoginStatus, loginChecking, loginResult } = useProviderActions();
const toast = useToast();

onMounted(() => { void cpaProbe(); void cpaLoginStatus(); });

async function onTest() {
  const r = await testConnection(props.providerId);
  if (r) toast.notice("连接测试", r.detail || (r.ok ? "成功" : "失败"), r.ok ? "success" : "error");
}
async function onReprobe() {
  const r = await cpaProbe();
  if (r) toast.notice("端口探测", r.detail, r.alive ? "success" : "error");
}
</script>

<template>
  <div class="actions-area">
    <span class="status-badge" :class="probeResult?.alive ? 'ok' : 'fail'" v-tooltip="probeResult?.detail">
      CPA 端口：{{ probeResult ? (probeResult.alive ? '在线' : '离线') : '…' }}
    </span>
    <span class="status-badge" :class="loginResult?.logged_in ? 'ok' : 'warn'">
      Codex 登录：{{ loginResult ? (loginResult.logged_in ? '已登录' : '未登录') : '…' }}
    </span>
    <button class="action-btn" :disabled="probing" @click="onReprobe">{{ probing ? "探测中…" : "重新探测" }}</button>
    <button class="action-btn" @click="cpaOpenManagement">打开管理面板</button>
    <button class="action-btn" :disabled="testing" @click="onTest">{{ testing ? "测试中…" : "测试连接" }}</button>
  </div>
</template>

<style scoped>
.actions-area { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 10px 0; }
.action-btn { padding: 6px 14px; border-radius: var(--aide-radius-sm); background: var(--aide-surface-default); color: var(--aide-text-primary); border: 1px solid var(--aide-border); cursor: pointer; font-size: 14px; }
.action-btn:hover:not(:disabled) { background: var(--aide-surface-hover); }
.action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.status-badge { padding: 2px 8px; border-radius: var(--aide-radius-sm); font-size: 12px; }
.status-badge.ok { background: var(--aide-success); color: var(--aide-text-on-accent); }
.status-badge.warn { background: var(--aide-warning); color: var(--aide-text-on-accent); }
.status-badge.fail { background: var(--aide-danger); color: var(--aide-text-on-accent); }
</style>
```

- [ ] **Step 4: `ProviderActions.vue`（dispatcher）**

```vue
<script setup lang="ts">
import type { ProviderConfig } from "@/types";
import ProviderActionsCpa from "./ProviderActionsCpa.vue";
import ProviderActionsAnthropic from "./ProviderActionsAnthropic.vue";
import ProviderActionsGeneric from "./ProviderActionsGeneric.vue";

const props = defineProps<{ provider: ProviderConfig }>();
</script>

<template>
  <ProviderActionsCpa v-if="provider.kind === 'cpa_gpt'" :provider-id="provider.id" />
  <ProviderActionsAnthropic v-else-if="provider.kind === 'system_default'" :provider-id="provider.id" />
  <ProviderActionsGeneric v-else-if="provider.kind === 'ollama' || provider.kind === 'kimi' || provider.kind === 'deepseek'" :provider-id="provider.id" />
  <!-- Custom：无专属操作区，不渲染 -->
</template>
```

- [ ] **Step 5: 类型门**

Run: `pnpm vue-tsc --noEmit` → Expected 零错误。
> 若 `useToast.notice` 签名不符——读 `src/composables/useToast.ts` 改成正名（可能是 `push`/`show`/`success`）。若 `v-tooltip` 在字符串字面量上用法不同——读 `src/directives/tooltip.ts` 确认。

- [ ] **Step 6: Commit**

```bash
git add src/components/provider/
git commit -m "feat(provider): per-kind action subcomponents + ProviderActions dispatcher

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: `ProviderCatalogPicker.vue` — 新增供应商选择面板

**Files:**
- Create: `src/components/provider/ProviderCatalogPicker.vue`

**Interfaces:**
- Consumes: `useProviderCatalog`（Task 3）、`useProviders.allProviders`（算 addedKinds）、`v-tooltip`、`var(--aide-*)`。
- Produces: `<ProviderCatalogPicker @select="..." @cancel="..." />`。emit `select(kind: ProviderKind)` / `select-custom` / `cancel`。Task 9 在「+ 添加」按钮上挂。

**门 = vue-tsc + 手动 smoke（Task 9 验）。**

- [ ] **Step 1: 实现 `ProviderCatalogPicker.vue`**

```vue
<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useProviderCatalog } from "@/composables/useProviderCatalog";
import { useProviders } from "@/composables/useProviders";
import type { ProviderKind } from "@/types";

const emit = defineEmits<{
  (e: "select", kind: ProviderKind): void;
  (e: "select-custom"): void;
  (e: "cancel"): void;
}>();

const { catalog, loadCatalog, availablePresets } = useProviderCatalog();
const { allProviders } = useProviders();

onMounted(() => { void loadCatalog(); });

const addedKinds = computed<ProviderKind[]>(() => allProviders.value.map((p) => p.kind));
const presets = computed(() => availablePresets(addedKinds.value));
const disabledKinds = computed<Set<ProviderKind>>(() => {
  return new Set(allProviders.value.map((p) => p.kind));
});

function pick(kind: ProviderKind) {
  if (disabledKinds.value.has(kind)) return;
  emit("select", kind);
}
</script>

<template>
  <div class="picker-overlay" @click.self="emit('cancel')">
    <div class="picker-card">
      <div class="picker-title">选择供应商</div>
      <div class="grid">
        <button
          v-for="p in catalog"
          :key="p.kind"
          class="preset-card"
          :class="{ disabled: disabledKinds.has(p.kind) }"
          :disabled="disabledKinds.has(p.kind)"
          v-tooltip="disabledKinds.has(p.kind) ? '已添加（单实例）' : p.base_url || 'Anthropic 官方端点'"
          @click="pick(p.kind)"
        >
          <span class="preset-icon">{{ p.icon }}</span>
          <span class="preset-name">{{ p.name }}</span>
          <span class="preset-desc">{{ p.actions.length }} 项专属操作</span>
        </button>
      </div>
      <button class="custom-entry" @click="emit('select-custom')">自定义（高级）— 自填 base_url</button>
      <button class="cancel-btn" @click="emit('cancel')">取消</button>
    </div>
  </div>
</template>

<style scoped>
.picker-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 100; }
.picker-card { background: var(--aide-bg-base); border: 1px solid var(--aide-border); border-radius: var(--aide-radius-lg); padding: 20px; width: 460px; max-height: 80vh; overflow: auto; box-shadow: var(--aide-shadow-lg); }
.picker-title { font-size: 16px; font-weight: 600; color: var(--aide-text-primary); margin-bottom: 16px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.preset-card { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 14px 10px; border-radius: var(--aide-radius-md); background: var(--aide-surface-default); border: 1px solid var(--aide-border); cursor: pointer; font-size: 14px; color: var(--aide-text-primary); }
.preset-card:hover:not(.disabled) { background: var(--aide-surface-hover); border-color: var(--aide-accent); }
.preset-card.disabled { opacity: 0.4; cursor: not-allowed; }
.preset-icon { font-size: 22px; font-weight: 700; color: var(--aide-accent); }
.preset-name { font-weight: 600; }
.preset-desc { font-size: 12px; color: var(--aide-text-muted); }
.custom-entry { width: 100%; margin-top: 14px; padding: 10px; border-radius: var(--aide-radius-md); background: transparent; color: var(--aide-text-secondary); border: 1px dashed var(--aide-border); cursor: pointer; font-size: 14px; }
.custom-entry:hover { color: var(--aide-text-primary); border-color: var(--aide-accent); }
.cancel-btn { width: 100%; margin-top: 10px; padding: 8px; background: transparent; color: var(--aide-text-muted); border: none; cursor: pointer; font-size: 13px; }
</style>
```

> `presets` computed 现未在模板用（模板遍历完整 `catalog` 以便置灰展示已添加项）——保留 `presets` 以备 Task 9 或测试需要；若 vue-tsc 报未用变量，删 `presets` computed。实际模板用 `catalog` + `disabledKinds` 置灰，符合 spec「已添加的 kind 在面板置灰」。

- [ ] **Step 2: 类型门**

Run: `pnpm vue-tsc --noEmit` → Expected 零错误（若报 `presets` 未用，删之）。

- [ ] **Step 3: Commit**

```bash
git add src/components/provider/ProviderCatalogPicker.vue
git commit -m "feat(provider): ProviderCatalogPicker — preset card grid + custom entry + single-instance gray-out

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: `ProviderSettings.vue` capstone 重构 — kind-aware 表单 + catalog picker + 专属操作区

**Files:**
- Modify: `src/components/ProviderSettings.vue`（853 行——大改，但模板结构按 spec 分区重排）

**Interfaces:**
- Consumes: Task 3 (`useProviderCatalog`)、Task 4/5 (`useProviders` 统一 + `addPresetProvider`/`addCustomProvider`)、Task 7 (`ProviderActions`)、Task 8 (`ProviderCatalogPicker`)。

**这是本计划最复杂的 Task。建议 implementer 先通读现 `ProviderSettings.vue` 全文再动手。** 核心：去掉 `isSystemDefault` 特殊分支（SystemDefault 现在是 kind=system_default 的正常条目），所有 provider 走同一套分区表单，按 kind 决定只读/可编辑 + 专属操作区。

**无组件测试——门 = vue-tsc + 手动 smoke 清单（Step 5）。** 逻辑全在 composable（已测），组件是渲染 + 事件接线。

- [ ] **Step 1: 通读现状 + 拉清分区 + 字段清单（保留红线，必做）**

读 `src/components/ProviderSettings.vue` 全文。识别现有：左侧列表（181-215）、右侧表单（218-428）、`isSystemDefault` 分支、`handleAdd`/`handleSave`/`handleDelete`/`handleActivate`/`selectProvider`、`addModelTag`/`removeModelTag`、`PROVIDER_GLYPHS`、`form` state（systemDefaultMappings vs custom provider 双套）。

**在 report 里列出 `handleSave` 现状的字段组装清单**：它从 `form`/`systemDefaultMappings` 读哪些字段、组装成 `ProviderModelMappings` 的哪 5 个字段 + 哪 3 个行为字段（effortLevel/autoCompactWindow/autocompactPctOverride）+ knownModels，调 `updateProvider` 还是 `saveSystemDefaultMappings`。这是 Step 2 重写 `handleSave` 的基线——**重写后组装逻辑逐字段一致，只换落盘出口**（SystemDefault 从 `saveSystemDefaultMappings` 改走 `updateProvider(__system_default__, …)`，其余 provider 原本就走 `updateProvider` 不变）。任何看不懂的字段映射（尤其 `model` 废弃字段 vs `modelMappings.anthropicModel` 权威源）停下问 controller。

- [ ] **Step 2: 重写 `<script setup>` —— 单套 form state + kind-aware computed**

关键设计：
- `form` 不再分 systemDefaultMappings / custom 双套——单一 `selectedProvider: Ref<ProviderConfig | null>` + 编辑用 `formModel`（深拷贝 selectedProvider）。
- `selectedProvider` = `displayList` 里当前选中 id 对应条目（含 SystemDefault）。
- `isPreset` = `selectedProvider.kind !== "custom"`（决定 name/icon/baseUrl 只读）。
- `authMode` = `presetForKind(selectedProvider.kind)?.auth_mode`（Custom 无 preset → 显示两个凭证框，或保留现有「两个都显示」）。
- `handleAdd` → 打开 `showPicker = true`；picker `@select(kind)` → `addPresetProvider(kind)` + 选中新建；`@select-custom` → `addCustomProvider()` + 选中。
- `handleSave` → `updateProvider(selectedProvider.id, { ...formModel })`（统一，SystemDefault 也走这）。
- `handleDelete` → SystemDefault 不允许删（按钮隐藏）；其它 `deleteProvider(id)`。
- 表单底部挂 `<ProviderActions :provider="selectedProvider" />`（Custom 自动不渲染）。

```vue
<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { useProviders } from "@/composables/useProviders";
import { useProviderCatalog } from "@/composables/useProviderCatalog";
import { useToast } from "@/composables/useToast";
import { useModal } from "@/composables/useModal";
import ProviderActions from "@/components/provider/ProviderActions.vue";
import ProviderCatalogPicker from "@/components/provider/ProviderCatalogPicker.vue";
import IconOrChar from "@/components/IconOrChar.vue";
import ThemedSelect from "@/components/ThemedSelect.vue";
import type { ProviderConfig, ProviderKind, ProviderModelMappings } from "@/types";

const { allProviders, displayList, activeProviderId, load, updateProvider, deleteProvider, setActiveProvider, addPresetProvider, addCustomProvider, SYSTEM_DEFAULT_ID } = useProviders();
const { presetForKind, loadCatalog } = useProviderCatalog();
const toast = useToast();
const modal = useModal();

const selectedId = ref<string>(SYSTEM_DEFAULT_ID);
const showPicker = ref(false);

const selectedProvider = computed<ProviderConfig | undefined>(() =>
  displayList.value.find((p) => p.id === selectedId.value),
);

const isPreset = computed(() => selectedProvider.value?.kind !== "custom");
const isSystemDefault = computed(() => selectedProvider.value?.kind === "system_default");
const preset = computed(() => selectedProvider.value ? presetForKind(selectedProvider.value.kind) : undefined);
const authMode = computed(() => preset.value?.auth_mode); // undefined for Custom → 两个凭证框都显示

// 编辑态：深拷贝 selectedProvider，避免直接改 store
const form = ref<ProviderConfig | null>(null);
watch(selectedProvider, (p) => { form.value = p ? { ...p, modelMappings: { ...p.modelMappings }, knownModels: [...p.knownModels] } : null; }, { immediate: true });

onMounted(() => { void load(); void loadCatalog(); });

function selectProvider(id: string) { selectedId.value = id; }

async function handleActivate(id: string) {
  await setActiveProvider(id);
  toast.notice("已切换供应商", "", "success");
}

async function handleAdd() { showPicker.value = true; }

async function onPickerSelect(kind: ProviderKind) {
  showPicker.value = false;
  try {
    const p = await addPresetProvider(kind);
    selectedId.value = p.id;
    toast.notice("已添加", p.name, "success");
  } catch (e: any) {
    toast.notice("添加失败", e?.message ?? String(e), "error");
  }
}
async function onPickerCustom() {
  showPicker.value = false;
  const p = await addCustomProvider();
  selectedId.value = p.id;
}

async function handleSave() {
  if (!form.value) return;
  const f = form.value;
  await updateProvider(f.id, {
    name: f.name, icon: f.icon, baseUrl: f.baseUrl,
    apiKey: f.apiKey, authToken: f.authToken,
    modelMappings: { ...f.modelMappings },
    effortLevel: f.effortLevel, autoCompactWindow: f.autoCompactWindow,
    autocompactPctOverride: f.autocompactPctOverride, knownModels: [...f.knownModels],
  });
  toast.notice("已保存", "", "success");
}

async function handleDelete() {
  if (!selectedProvider.value || isSystemDefault.value) return;
  const ok = await modal.confirm("删除供应商", `确定删除「${selectedProvider.value.name}」？`, "删除");
  if (!ok) return;
  await deleteProvider(selectedProvider.value.id);
  selectedId.value = SYSTEM_DEFAULT_ID;
  toast.notice("已删除", "", "info");
}

// known_models 标签管理（保留现有逻辑）
const modelTagInput = ref("");
function addModelTag() {
  if (!form.value) return;
  const t = modelTagInput.value.trim();
  if (t && !form.value.knownModels.includes(t)) form.value.knownModels = [...form.value.knownModels, t];
  modelTagInput.value = "";
}
function removeModelTag(t: string) {
  if (!form.value) return;
  form.value.knownModels = form.value.knownModels.filter((x) => x !== t);
}
</script>
```

> ⚠️ `useModal.confirm(title, msg, confirmLabel)` 的真实签名读 `src/composables/useModal.ts` 核对——可能是 `confirm(title, message)` 返回 `Promise<boolean>`，或 `confirm(opts)`。按实际改。`useToast.notice` 同理（Task 7 已提）。

- [ ] **Step 3: 重写 `<template>` —— 左列表 + 右分区表单**

```vue
<template>
  <div class="provider-settings">
    <!-- 左列表 -->
    <div class="left-list">
      <div
        v-for="p in displayList"
        :key="p.id"
        class="list-item"
        :class="{ active: p.id === selectedId }"
        @click="selectProvider(p.id)"
      >
        <IconOrChar :icon="p.icon" :char="p.icon" />
        <div class="li-info">
          <div class="li-name">{{ p.name || '(未命名)' }}</div>
          <div class="li-model">{{ p.modelMappings.anthropicModel || '—' }}</div>
        </div>
        <button v-if="p.id !== activeProviderId" class="activate-btn" v-tooltip="'设为激活'" @click.stop="handleActivate(p.id)">●</button>
        <span v-else class="active-mark" v-tooltip="'当前激活'">✓</span>
      </div>
      <button class="add-btn" @click="handleAdd">+ 添加供应商</button>
    </div>

    <!-- 右表单 -->
    <div class="right-form" v-if="form">
      <!-- 顶部身份：预置只读，Custom 可编辑 -->
      <div class="section">
        <label>名称</label>
        <input v-if="!isPreset" class="text-input" v-model="form.name" />
        <div v-else class="readonly">{{ form.name }}</div>
      </div>
      <div class="section" v-if="!isPreset">
        <label>图标</label>
        <!-- 保留现有 PROVIDER_GLYPHS 图标选择器；Custom 才显示 -->
        <!-- 见现有 ProviderSettings 的图标选择器 markup，搬过来 -->
      </div>
      <div class="section">
        <label>Base URL</label>
        <input v-if="!isPreset" class="text-input" v-model="form.baseUrl" placeholder="https://..." />
        <div v-else class="readonly">{{ form.baseUrl || '(Anthropic 官方端点)' }}</div>
      </div>

      <!-- 账号区：按 auth_mode 渲染 -->
      <div class="section" v-if="authMode === 'api_key' || isPreset === false">
        <label>API Key</label>
        <input class="text-input" type="password" v-model="form.apiKey" placeholder="sk-..." />
      </div>
      <div class="section" v-if="authMode === 'auth_token' || isPreset === false">
        <label>Auth Token</label>
        <input class="text-input" type="password" v-model="form.authToken" />
      </div>
      <!-- Custom（isPreset=false）两个都显示；预置按 auth_mode 只显示一个 -->

      <!-- 模型区 -->
      <div class="section">
        <label>默认模型 (ANTHROPIC_MODEL)</label>
        <input class="text-input" v-model="form.modelMappings.anthropicModel" />
      </div>
      <div class="section"><label>Opus 别名</label><input class="text-input" v-model="form.modelMappings.defaultOpusModel" /></div>
      <div class="section"><label>Sonnet 别名</label><input class="text-input" v-model="form.modelMappings.defaultSonnetModel" /></div>
      <div class="section"><label>Haiku 别名</label><input class="text-input" v-model="form.modelMappings.defaultHaikuModel" /></div>
      <div class="section"><label>子代理模型</label><input class="text-input" v-model="form.modelMappings.subagent" /></div>

      <!-- 行为区 -->
      <div class="section">
        <label>Effort Level</label>
        <ThemedSelect :model-value="form.effortLevel" @update:model-value="form.effortLevel = $event" :options="[{value:'',label:'默认'},{value:'low',label:'LOW'},{value:'medium',label:'MEDIUM'},{value:'high',label:'HIGH'},{value:'max',label:'MAX'}]" block />
      </div>
      <div class="section"><label>自动压缩窗口 (tokens)</label><input class="text-input" type="number" v-model="form.autoCompactWindow" /></div>
      <div class="section"><label>压缩触发百分比</label><input class="text-input" type="number" v-model="form.autocompactPctOverride" /></div>

      <!-- 模型标签列表 -->
      <div class="section">
        <label>模型列表（会话下拉数据源）</label>
        <div class="tags">
          <span v-for="t in form.knownModels" :key="t" class="tag">{{ t }} <button @click="removeModelTag(t)">×</button></span>
        </div>
        <input class="text-input" v-model="modelTagInput" @keydown.enter.prevent="addModelTag" placeholder="输入模型名回车添加" />
      </div>

      <!-- 专属操作区：按 kind dispatch（Custom 不渲染） -->
      <ProviderActions v-if="selectedProvider" :provider="selectedProvider" />

      <!-- 操作按钮 -->
      <div class="actions">
        <button class="save-btn" @click="handleSave">保存</button>
        <button v-if="!isSystemDefault" class="delete-btn" @click="handleDelete">删除</button>
      </div>
      <div class="hint">更改连接凭据需重启会话生效。</div>
    </div>
  </div>

  <ProviderCatalogPicker v-if="showPicker" @select="onPickerSelect" @select-custom="onPickerCustom" @cancel="showPicker = false" />
</template>
```

> ⚠️ 上面是骨架。implementer 必须保留现有 `<style scoped>` 的 token 用量 + class 名（`.text-input`/`.section`/`.left-list`/`.list-item` 等），把现有样式块沿用——不要重写样式，只重排模板结构 + 接新组件。`PROVIDER_GLYPHS` 图标选择器（Custom 才用）从现有代码搬进 `v-if="!isPreset"` 区块。`ThemedSelect` 的 props/options 形式读 `src/components/ThemedSelect.vue` 核对。

- [ ] **Step 4: 类型门**

Run: `pnpm vue-tsc --noEmit` → Expected 零错误。
Run: `pnpm test --run` → Expected 既有 composable 测试全绿（本 Task 不动 composable）。

- [ ] **Step 4.5: handleSave 语义保留核对（保留红线，必做）**

对照 Step 1 的 handleSave 字段清单，在 report 里证明重写后：
- `ProviderModelMappings` 5 字段（anthropicModel/defaultOpusModel/defaultSonnetModel/defaultHaikuModel/subagent）组装与改前**逐字段一致**；
- 3 行为字段（effortLevel/autoCompactWindow/autocompactPctOverride）+ knownModels 落盘与改前一致；
- SystemDefault 保存出口从 `saveSystemDefaultMappings` → `updateProvider(__system_default__, …)`，落盘后 providers[] 里 SystemDefault 条目的 modelMappings = 改前顶层 sdm 字段值（等价，已在 Task 4 Step 4.5 证明 backing 等价）；
- `handleActivate`/`selectProvider`/`handleDelete` 的激活与回落行为与改前一致（SystemDefault 不可删——按钮隐藏；删除激活项后回落 SystemDefault）。
任何一项不符 → 停下问 controller。

- [ ] **Step 5: 手动 smoke 清单（`pnpm tauri dev`）**

- [ ] 打开设置 → providers tab：左侧列出 Anthropic（SystemDefault，来自 providers[]）+ 任何既有 provider。
- [ ] 选 Anthropic：右侧只读 name/base_url（base_url 显示「Anthropic 官方端点」）、API Key 输入框、5 个模型字段、effort/压缩区、专属操作区（刷新模型/查看额度/测试连接）、保存按钮、无删除按钮。
- [ ] 点「+ 添加」→ catalog picker 弹出，5 个 preset 卡片，已添加的 kind 置灰。
- [ ] 选 CPA 中转 → 创建 cpa_gpt 实例，右侧表单 name/base_url 只读（CPA 中转 / 8317）、Auth Token 输入框（不是 API Key）、专属操作区（端口探测/Codex 登录态/打开管理/测试连接）。
- [ ] 填 `auth_token = sk-local-cpa`（若 CPA 在跑）→ 点测试连接 → 成功 toast。
- [ ] 选「自定义（高级）」→ 创建 Custom 实例，name/icon/base_url 全可编辑，两个凭证框都显示，无专属操作区。
- [ ] 设为激活 → 切换；发一条消息 → 走对应 provider。
- [ ] 删除非 SystemDefault provider → 确认弹窗 → 删除；SystemDefault 无删除按钮。
- [ ] 保存 → toast「已保存」；重启会话能用到新凭据。
- [ ] 切 warm-dark ↔ catppuccin 主题 → 整窗重配色（picker/表单/操作区都跟）。

- [ ] **Step 6: Commit**

```bash
git add src/components/ProviderSettings.vue
git commit -m "feat(provider): ProviderSettings kind-aware refactor — catalog picker + per-kind readonly/editable + action area

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: 前端集成 smoke + 收尾

**Files:** 无代码改动（纯验证）。若 smoke 发现 composable/组件 bug，回补对应 Task。

- [ ] **Step 1: 全量类型 + 测试门**

Run: `pnpm vue-tsc --noEmit` → 零错误。
Run: `pnpm test --run` → 全绿（含 Task 2/3/4/5/6 新增的 composable/api 测试）。
Run: `cd src-tauri && cargo build` → 零警告（确认 Plan 1 后端未因前端改动被动摇——前端不动 Rust，应无变化）。

- [ ] **Step 2: 端到端 smoke（`pnpm tauri dev`）**

完整跑 Task 9 Step 5 的清单 + 以下回归：
- [ ] 老配置迁移后（Plan 1 已迁移过）前端 `get_providers` 返回含 SystemDefault 真实条目，显示正常。
- [ ] 切会话时 provider 绑定（`useSessionProviders`）不受影响——运行中的会话仍用旧 provider，新会话用新激活的。
- [ ] catalog 加载失败（断网/删 catalog 资源模拟）→ 不崩，预置 kind 显示空身份（降级）。

- [ ] **Step 3: 记录结果**

在 `docs/superpowers/plans/2026-07-20-provider-preset-frontend.md` 末尾加 `## 集成 smoke 结果` 节记录通过项 + 发现的 bug + 修复 Task 回溯。

- [ ] **Step 4: 收尾**

按 superpowers:finishing-a-development-branch 流程合并/PR（需用户同意调技能）。

---

## Self-Review

**1. Spec coverage:**
- 数据模型（前端 `ProviderConfig.kind` + `ProviderKind`/`AuthMode`/`CatalogPreset` 镜像 Rust serde 形态）：Task 1 ✓
- base_url 硬锁（预置只读、Custom 可编辑）：Task 9 表单 isPreset 分区 ✓
- 存储设计（前端不持久化预置身份——`addPresetProvider` 身份字段留空，Rust strip + enrich 循环）：Task 5 ✓
- Catalog（前端 `get_provider_catalog` 取、不另存）：Task 3 `useProviderCatalog` ✓
- 分层归位（前端 provider-agnostic 红线——`chat.ts` 不动、专属逻辑只走 catalog actions + UI dispatch）：Global Constraints + 不 touched 文件清单 ✓
- 专属操作区（3 子组件 + dispatcher）：Task 7 ✓
- 新增 UX（catalog picker 卡片网格 + 自定义入口 + 单实例置灰）：Task 8 ✓
- 编辑 UX（按 kind 分区只读/可编辑、auth_mode 凭证框、行为区、专属操作区）：Task 9 ✓
- 迁移（前端无迁移代码——Plan 1 已在 Rust 侧迁移；前端只消费 `get_providers` 的新 schema）：无需 Task ✓
- 验证（composable 单测 + 集成 smoke）：Task 2/3/4/5/6 vitest + Task 9/10 手动 smoke ✓
- 新增/改动 command 对接：Task 2 api wrappers ✓

**2. Placeholder scan:**
- Task 9 Step 3 模板里「保留现有 PROVIDER_GLYPHS 图标选择器 markup，搬过来」「保留现有 `<style scoped>`」——这是指现有代码搬迁，不是 placeholder；implementer 须从现 `ProviderSettings.vue` 抄对应 markup。✓（已明确指示来源）
- Task 9 Step 2/3 的 `useModal.confirm`/`useToast.notice`/`ThemedSelect` 签名——已标注「读源码核对」，不是硬编码猜测。✓
- 无 "TBD/TODO/implement later"。✓

**3. Type consistency:**
- `ProviderKind` snake_case 字符串字面量：Task 1 定义 → Task 3/5/7/8/9 全用同字面量 ✓
- `CatalogPreset` snake_case (`base_url`/`auth_mode`) vs `ProviderConfig` camelCase (`baseUrl`)：Task 1 类型定义注明 + Task 3 `enrichForDisplay` 做映射 ✓
- `ProviderModelMappings` camelCase 5 字段：Task 1 沿用既有 ✓
- `SYSTEM_DEFAULT_ID = "__system_default__"`：Task 4/5/9 一致 ✓
- `useProviderActions` 方法名（testConnection/cpaProbe/cpaOpenManagement/cpaLoginStatus/viewQuota/refreshModels）：Task 6 定义 → Task 7 子组件调用一致 ✓
- `addPresetProvider(kind)` / `addCustomProvider()`：Task 5 定义 → Task 9 onPickerSelect/onPickerCustom 调用一致 ✓

**4. 漏项补查：**
- `useSessionProviders.ts`（会话↔provider 绑定）不动——Task 9 smoke 验证不受影响 ✓
- `useSearchProviders.ts`（搜索 provider，无关概念）不动 ✓
- `src/types/chat.ts` 不动（provider-agnostic 红线）✓
- Task 4 删废弃 api wrapper 前 grep 确认无其它消费——已指示 ✓
- `refreshSystemDefaultModels` facade 在 Task 4 改走 `api.refreshModels(SYSTEM_DEFAULT_ID)` + `load()` 同步——Task 4 Step 2 实现 ✓
- catalog 加载失败降级——Task 3 `loadCatalog` catch + Task 10 smoke 验 ✓
- `ConnectionStatus` 字段名以 Rust 源为准——Task 2 Step 2 已指示核对 ✓

**5. 风险：**
- `ProviderSettings.vue` 853 行大改——Task 9 最易出回归。mitigation：composable 逻辑全测过、组件仅渲染、手动 smoke 清单详尽、保留现有样式/class 名。
- `useModal`/`useToast`/`ThemedSelect` 签名可能与骨架假设不符——mitigation：Task 7/9 明确要求读源码核对。
- 无组件测试基建——组件回归靠手动 smoke。mitigation：Task 9 清单覆盖所有 kind + 关键交互；未来可加 `@vue/test-utils` 但不在本计划范围。

无遗漏。计划可执行。

---

## Execution Handoff

Plan 2（前端 UX）完成。两种执行方式：

**1. Subagent-Driven（推荐）** — 每个 Task 派一个新 subagent，任务间我来 review，快速迭代（与 Plan 1 同模式）。

**2. Inline Execution** — 本会话内按 executing-plans 批量执行 + 检查点 review。

哪种？