# 知识库 MCP 插件 P1（读通路）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent 在用户明确提及知识库时，能通过内置 MCP 工具 `aide-knowledge` 检索并读取知识库文档。

**Architecture:** 桌面前端把凭据（baseUrl + Bearer token）推给 Rust，落成 `~/.aide/knowledge.json`；sidecar 侧新增进程内 MCP server（`type: "sdk"`，`createSdkMcpServer`），**每次工具调用**现读该文件建 REST 客户端，直连 knowledge-server 的 HTTP 接口。不新增 send 协议字段、不新增 IPC 事件、不改 headless 与 remote 协议。

**Tech Stack:** TypeScript（agent-sidecar，Node 20 + vitest）、Rust（src-tauri，tauri v2 command + serde_json）、Vue 3（桌面前端 localStorage → `api.invoke`）

**Spec:** `docs/superpowers/specs/2026-09-13-knowledge-mcp-design.md` —— 实施前必读，本计划的取舍全部源自它（尤其 §3 凭据通道、§5 挂载门控、§7 工具级放行）。P2（写通路）见 `2026-09-13-knowledge-mcp-p2-write.md`。

## Global Constraints

以下每条都是硬约束，每个任务的验收都隐含包含：

- **函数形状**：单函数输入 ≤4（位置参数 + options/struct 字段合计）；函数 ≤40 行；嵌套 ≤3 层；编排主函数 ≤10 行只做子函数调用。
- **TS**：`any` 零容忍（用 `unknown` + 收窄）；索引访问的 undefined 臂必须处理；禁空 catch；async 错误必须处理。
- **工具失败语义**：一律返回**文本**，永不 throw、永不 `isError`（`agent-sidecar/src/extensions/codegraphTools.ts:50` 红线的先例）。
- **凭据纪律**：token 绝不进日志 / 错误消息（`agent-sidecar/src/engine/sessionMetadata.ts` 的 N5）；env 里只放**文件路径**。
- **同步 Tauri 命令**做磁盘 IO 必须在首行埋 `crate::diagnostics::trace_command("函数名")`——`pnpm check:sync-io` 是构建门禁，漏了就红。
- **挂载门控**（三条，任一不满足即不注册）：`AIDE_KB_TOOLS=off`、`!trusted`、`taskTools` 非空。
- **不碰**：`agent-sidecar/src/extensions/__snapshots__/codegraphTools.test.ts.snap` 与 `docxTools.test.ts.snap`（工作区已有的改动）、`src-tauri/Cargo.toml`（本期不需要新依赖）、remote-pwa / remote REGISTRY / headless schema。
- **提交粒度**：每任务一次提交，提交信息用 `feat(knowledge): ...` / `test(knowledge): ...` / `fix(knowledge): ...`。

## File Structure

| 文件 | 职责 | 期 |
|---|---|---|
| `src-tauri/src/commands/knowledge.rs`（新建） | 凭据落盘/删除：动作判定（纯）+ 原子写（副作用） | P1 |
| `src-tauri/src/commands/mod.rs`（改） | 注册 `pub mod knowledge;` | P1 |
| `src-tauri/src/commands/settings.rs`（改） | `persist_file` 开成 `pub(crate)`（复用 Windows 杀软重试） | P1 |
| `src-tauri/src/lib.rs`（改） | 注册命令 | P1 |
| `src-tauri/src/runtime/mod.rs`（改） | spawn sidecar 时注入 `AIDE_KB_CONFIG_FILE` | P1 |
| `packages/aide-sdk/src/api.ts`（改） | `api.setKnowledgeRuntimeConfig` 门面 | P1 |
| `src/components/KnowledgeBase/kbRuntime.ts`（新建） | localStorage → Rust 单向镜像 | P1 |
| `src/main.ts`（改） | 启动推一次 | P1 |
| `src/composables/useKnowledgeBase.ts`（改） | 登录/建管理员/加入/登出/初始化各推一次 | P1 |
| `agent-sidecar/src/extensions/knowledge/config.ts`（新建） | 凭据文件读取 + fail-closed 校验 | P1 |
| `agent-sidecar/src/extensions/knowledge/client.ts`（新建） | REST 薄客户端 + DTO + 错误归一 | P1 |
| `agent-sidecar/src/extensions/knowledge/format.ts`（新建） | 纯函数格式化器（工具返回文本的唯一产地） | P1 |
| `agent-sidecar/src/extensions/knowledgeTools.ts`（新建） | 工具定义 + 编排（P1：4 读工具） | P1 |
| `agent-sidecar/src/extensions/knowledgeMcp.ts`（新建） | 注册器（门控 + instructions + 组装） | P1 |
| `agent-sidecar/src/engine/session-worker/queryContext.ts`（改） | 并入 `assembleMcpServers` | P1 |
| `agent-sidecar/src/engine/session-worker/queryOptions.ts`（改） | `allowedTools` 加四条读规则 | P1 |
| `packages/aide-sdk/src/composables/useCustomizations.ts`（改） | 内置 MCP 前端镜像登记 | P1 |
| `agent-sidecar/src/engine/session-worker.test.ts`（改） | 精确断言 `allowedTools` 需同步（`session-worker.test.ts:450`） | P1 |
| `agent-sidecar/smoke-mcp.ts`（改） | 修两条失效 import + 加 KB 冒烟段 | P1 |

P2 会新建 `agent-sidecar/src/extensions/knowledge/space.ts` 与 `knowledge/operations.ts`，并扩写 `knowledgeTools.ts` / `format.ts`（见 P2 计划）。

---

### Task 1: Rust 凭据命令（落盘 / 删除 + env 注入）

**Files:**
- Create: `src-tauri/src/commands/knowledge.rs`
- Modify: `src-tauri/src/commands/mod.rs`（模块声明，`jdk` 与 `marketplace` 之间）
- Modify: `src-tauri/src/commands/settings.rs:465`（`fn persist_file` → `pub(crate) fn persist_file`）
- Modify: `src-tauri/src/lib.rs`（命令注册表，紧跟 `commands::chat::start_btw_session,` 之后）
- Modify: `src-tauri/src/runtime/mod.rs:160-163`（`AIDE_ENABLED_PLUGINS_FILE` 之后）

**Interfaces:**
- Produces（给 Task 2 的前端用）：Tauri 命令 `knowledge_set_runtime_config(base_url: String, token: Option<String>) -> Result<(), String>`；前端调用名 `knowledge_set_runtime_config`，参数 `{ baseUrl, token }`（Tauri v2 自动 camelCase → snake_case）。
- Produces（给 Task 3 的 sidecar 用）：sidecar 进程 env `AIDE_KB_CONFIG_FILE` = `~/.aide/knowledge.json` 的绝对路径。

- [ ] **Step 1: 写失败测试**

新建 `src-tauri/src/commands/knowledge.rs`，先只写测试与类型骨架：

```rust
//! 知识库运行时凭据：桌面前端推送 → 落 `~/.aide/knowledge.json` → agent-sidecar 的
//! 进程内 MCP 工具（aide-knowledge）**每次调用现读**。
//!
//! 为什么凭据落文件而不是进 env：Bash 工具子进程会继承 sidecar 的 env，模型跑
//! `env` 就能把 token 带走（红线见 agent-sidecar/src/engine/sessionMetadata.ts）。
//! 这里只把**路径**经 env 交给 sidecar（AIDE_KB_CONFIG_FILE），凭据本体落盘。
//! 为什么独立文件而不写进 state.json：诊断快照会 dump state.json，独立文件隔离掉
//! 那条路径（风险与 localStorage 里已存的明文 token 等价，见设计 spec §6.1）。

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

/// 凭据文件路径：`~/.aide/knowledge.json`（与 state.json 同目录，刻意独立）。
pub fn kb_config_path() -> PathBuf {
    crate::commands::our_config_dir().join("knowledge.json")
}

/// 入参 → 动作：登出删文件 / 否则写。分支判定与副作用分离，便于直接单测。
enum ConfigAction {
    Write(Value),
    Delete,
}

/// 纯函数：凭据 JSON 形状（`version` 供将来无痛演进；sidecar 不认识就 fail-closed
/// 当未配置）。token 缺失或全空白 = 登出 → 删文件（绝不把空串写成有效凭据）。
fn config_action(base_url: &str, token: Option<&str>) -> ConfigAction {
    match token.map(str::trim) {
        None | Some("") => ConfigAction::Delete,
        Some(t) => ConfigAction::Write(json!({ "version": 1, "baseUrl": base_url, "token": t })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logout_when_token_missing_or_blank() {
        assert!(matches!(config_action("http://kb:8788", None), ConfigAction::Delete));
        assert!(matches!(config_action("http://kb:8788", Some("   ")), ConfigAction::Delete));
    }

    #[test]
    fn write_carries_version_base_url_and_token() {
        let ConfigAction::Write(v) = config_action("http://kb:8788", Some("tok")) else {
            panic!("expected ConfigAction::Write");
        };
        assert_eq!(v["version"], 1);
        assert_eq!(v["baseUrl"], "http://kb:8788");
        assert_eq!(v["token"], "tok");
    }

    #[test]
    fn apply_writes_then_deletes_idempotently() {
        let dir = std::env::temp_dir().join(format!("aide-kb-test-{}", std::process::id()));
        let path = dir.join("knowledge.json");
        apply_config_action(&path, config_action("http://kb:8788", Some("tok"))).unwrap();
        assert!(fs::read_to_string(&path).unwrap().contains("\"token\": \"tok\""));
        apply_config_action(&path, config_action("http://kb:8788", None)).unwrap();
        assert!(!path.exists());
        // 再删一次 = 已是登出态，幂等成功（不是错误）
        apply_config_action(&path, config_action("http://kb:8788", None)).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test --lib commands::knowledge`
Expected: FAIL —— `cannot find function 'apply_config_action' in this scope`（编译失败即「红」）。

- [ ] **Step 3: 实现动作执行层与命令**

在 `knowledge.rs` 的 `config_action` 之后、`#[cfg(test)]` 之前插入：

```rust
/// 副作用层：执行动作。删是幂等的（文件不在 = 已是登出态）；写是原子替换。
fn apply_config_action(path: &Path, action: ConfigAction) -> Result<(), String> {
    match action {
        ConfigAction::Delete => {
            if path.exists() {
                fs::remove_file(path)
                    .map_err(|e| format!("Failed to remove knowledge config: {e}"))?;
            }
            Ok(())
        }
        ConfigAction::Write(v) => {
            let content = serde_json::to_string_pretty(&v)
                .map_err(|e| format!("Serialize knowledge config: {e}"))?;
            write_config_atomic(path, &content)
        }
    }
}

/// 先写 .tmp 再 rename。rename 复用 `settings::persist_file`——那里的 Windows
/// 杀软瞬态锁重试是实测踩出来的，不重写一份。
fn write_config_atomic(path: &Path, content: &str) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "knowledge config path has no parent".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create config dir: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, content).map_err(|e| format!("Failed to write knowledge config temp: {e}"))?;
    if let Err(e) = crate::commands::settings::persist_file(&tmp, path) {
        // rename 始终失败：清理临时文件，原文件未动
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// 写 / 删知识库凭据。`token` 为 `None` 或空白 = 登出 → 删文件。
///
/// 同步命令：一个几百字节文件的写，达不到冻主线程的量级，按构建期守卫
/// （`scripts/check-sync-io-commands.mjs`）要求埋 `trace_command`——真卡了能点名。
#[tauri::command]
pub fn knowledge_set_runtime_config(base_url: String, token: Option<String>) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("knowledge_set_runtime_config");
    apply_config_action(&kb_config_path(), config_action(&base_url, token.as_deref()))
}
```

- [ ] **Step 4: 接线三处**

1. `src-tauri/src/commands/mod.rs`：在 `pub mod jdk;` 与 `pub mod marketplace;` 之间加一行 `pub mod knowledge;`。
2. `src-tauri/src/commands/settings.rs:465`：`fn persist_file(...)` 改成 `pub(crate) fn persist_file(...)`（其余不动）。
3. `src-tauri/src/lib.rs`：在 `commands::chat::start_btw_session,` 之后加：

```rust
            // Knowledge base runtime credentials (→ ~/.aide/knowledge.json)
            commands::knowledge::knowledge_set_runtime_config,
```

4. `src-tauri/src/runtime/mod.rs`：在 `cmd.env("AIDE_ENABLED_PLUGINS_FILE", ...);` 之后加：

```rust
        // 知识库凭据文件的**路径**（凭据本体走文件、不走 env——env 会被 Bash 工具
        // 子进程继承，模型跑 `env` 即可外带，见 agent-sidecar/src/engine/sessionMetadata.ts）。
        let kb_config = crate::commands::knowledge::kb_config_path();
        cmd.env("AIDE_KB_CONFIG_FILE", dunce::simplified(&kb_config));
```

- [ ] **Step 5: 跑测试 + 构建门禁**

Run: `cd src-tauri && cargo test --lib commands::knowledge`
Expected: PASS，3 passed。

Run: `cd src-tauri && cargo check`
Expected: 无 error、无 warning（新代码不得引入未使用导入）。

Run: `cd .. && pnpm check:sync-io`
Expected: 通过（`knowledge_set_runtime_config` 已埋 trace_command）。

> 若测试二进制被杀软锁住（本仓库已知现象），改用 `cargo check` + Step 6 的手工验证作为本步证据，并在提交信息里注明。

- [ ] **Step 6: 手工验证（真实文件）**

Run（dev 版 app 起来后）：
```
cat ~/.aide/knowledge.json
```
Expected: 文件不存在（还没登录过知识库）——本任务只保证命令可调用，真值由 Task 2 写入。

- [ ] **Step 7: 提交**

```bash
git add src-tauri/src/commands/knowledge.rs src-tauri/src/commands/mod.rs src-tauri/src/commands/settings.rs src-tauri/src/lib.rs src-tauri/src/runtime/mod.rs
git commit -m "feat(knowledge): 凭据落盘命令 + sidecar env 路径注入"
```

---

### Task 2: 前端推送链路（localStorage → Rust）

**Files:**
- Modify: `packages/aide-sdk/src/api.ts`（`api` 对象末尾，`setWorkspaceCodegraphEnabled` 之后、闭合 `};` 之前）
- Create: `src/components/KnowledgeBase/kbRuntime.ts`
- Create: `src/components/KnowledgeBase/kbRuntime.test.ts`
- Modify: `src/main.ts`
- Modify: `src/composables/useKnowledgeBase.ts`（`init` / `login` / `setup` / `join` / `logout` 五处）

**Interfaces:**
- Consumes（Task 1）：命令 `knowledge_set_runtime_config`，参数 `{ baseUrl: string, token: string | null }`。
- Produces（Task 3 起的隐性契约）：`~/.aide/knowledge.json` 的 JSON 形状 `{ version: 1, baseUrl, token }`——sidecar 的 `parseKbConfig` 按这个形状解析。

- [ ] **Step 1: 写失败测试**

新建 `src/components/KnowledgeBase/kbRuntime.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const setKnowledgeRuntimeConfig = vi.fn();
vi.mock("@/api", () => ({
  api: { setKnowledgeRuntimeConfig: (i: unknown) => setKnowledgeRuntimeConfig(i) },
}));

import { pushKnowledgeRuntime } from "./kbRuntime";

describe("pushKnowledgeRuntime", () => {
  beforeEach(() => {
    setKnowledgeRuntimeConfig.mockReset().mockResolvedValue(undefined);
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  it("把 localStorage 里的 baseUrl + token 原样推给主进程", async () => {
    localStorage.setItem("aide.kb.baseUrl", "http://kb:8788");
    localStorage.setItem("aide.kb.token", "tok-1");
    await pushKnowledgeRuntime();
    expect(setKnowledgeRuntimeConfig).toHaveBeenCalledWith({ baseUrl: "http://kb:8788", token: "tok-1" });
  });

  it("未登录时推 baseUrl + null（主进程据此删文件）", async () => {
    await pushKnowledgeRuntime();
    expect(setKnowledgeRuntimeConfig).toHaveBeenCalledWith({ baseUrl: "http://127.0.0.1:8788", token: null });
  });

  it("推送失败不抛（调用方是 fire-and-forget，抛了会变成未处理拒绝）", async () => {
    setKnowledgeRuntimeConfig.mockRejectedValue(new Error("disk full"));
    await expect(pushKnowledgeRuntime()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/KnowledgeBase/kbRuntime.test.ts`
Expected: FAIL —— `Failed to resolve import "./kbRuntime"`。

- [ ] **Step 3: 写 api 门面 + 镜像模块**

在 `packages/aide-sdk/src/api.ts` 的 `api` 对象里（`setWorkspaceCodegraphEnabled` 那一项之后）加：

```ts
  /**
   * 把知识库凭据镜像给 Rust（→ `~/.aide/knowledge.json` → sidecar 的 aide-knowledge
   * 内置工具每次调用现读）。**桌面专属能力**：remote-pwa 没有知识库面板，也不进
   * remote REGISTRY（REGISTRY 只白名单入站 invoke，桌面走 TauriTransport 直达命令）。
   * `token: null` = 登出（Rust 删文件）。
   */
  setKnowledgeRuntimeConfig(input: { baseUrl: string; token: string | null }): Promise<void> {
    return getTransport().invoke("knowledge_set_runtime_config", {
      baseUrl: input.baseUrl,
      token: input.token,
    });
  },
```

新建 `src/components/KnowledgeBase/kbRuntime.ts`：

```ts
// 知识库凭据 → 主进程单向镜像（`~/.aide/knowledge.json` → sidecar 内置工具 aide-knowledge）。
//
// localStorage 是唯一真相源（kbClient 的 getBaseUrl/getToken）。**凭据每次变更都要跟一次**，
// 现有调用点：
//   src/main.ts（应用启动，覆盖"上次登录过、本次没开面板"）
//   useKnowledgeBase 的 init / login / setup / join / logout
// 新增变更点（比如以后换存储介质）必须同步加推送，否则 agent 侧会拿着旧凭据。
//
// 失败不抛：调用方是 fire-and-forget，抛出去会变成未处理拒绝刷日志；而推送失败只
// 影响 agent 侧工具可用性，知识库面板本身照常工作。
import { api } from "@/api";
import { getBaseUrl, getToken } from "./kbClient";

export async function pushKnowledgeRuntime(): Promise<void> {
  try {
    await api.setKnowledgeRuntimeConfig({ baseUrl: getBaseUrl(), token: getToken() });
  } catch (e) {
    console.warn("[knowledge] 凭据推送给主进程失败——agent 侧知识库工具将不可用", e);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/KnowledgeBase/kbRuntime.test.ts`
Expected: PASS，3 passed。

- [ ] **Step 5: 接四处调用**

1. `src/main.ts`：文件末尾（`useNotifications().hydrate();` 之后）加

```ts
// 知识库凭据镜像到主进程（agent 侧 aide-knowledge 工具每次调用现读该文件）
void pushKnowledgeRuntime();
```
   并在导入区加 `import { pushKnowledgeRuntime } from "./components/KnowledgeBase/kbRuntime";`

2. `src/composables/useKnowledgeBase.ts`：导入区加 `import { pushKnowledgeRuntime } from "@/components/KnowledgeBase/kbRuntime";`，然后在五处各加一行：

| 函数 | 位置 | 加什么 |
|---|---|---|
| `init()` | 函数体开头（`kb.status()` 探测之前） | `void pushKnowledgeRuntime();` |
| `login()` | `user.value = await kb.login(...)` 之后 | `void pushKnowledgeRuntime();` |
| `setup()` | `user.value = await kb.bootstrap(...)` 之后 | `void pushKnowledgeRuntime();` |
| `join()` | `user.value = await kb.join(...)` 之后 | `void pushKnowledgeRuntime();` |
| `logout()` | `setToken(null);` 之后 | `void pushKnowledgeRuntime();` |

> 为什么是这五处：`init()` 那处是**无条件**镜像（不管有没有登录）——① localStorage 里 token 被清掉时它顺带把主进程的文件删掉，保持两侧一致；② 它就是「改服务地址」那条路径的落点（`KbLogin.vue` 的 `onBaseBlur` → `setBaseUrl` → `emit("retry")` → `KnowledgeBase.vue` 的 `k.init()`，spec §6.2 第 4 点），所以不需要再单独挂到 KbLogin 上。登录三路各自推一次是因为它们不经过 `init()`。

- [ ] **Step 6: 前端类型检查**

Run: `npx vue-tsc --noEmit`
Expected: 无 error。

- [ ] **Step 7: 手工端到端验证**

1. `pnpm dev` 起 dev 版 app。
2. 打开知识库面板，登录（或建管理员）。
3. Run: `cat ~/.aide/knowledge.json`
   Expected: 出现 `{"version": 1, "baseUrl": "...", "token": "..."}`。
4. 面板里登出。
5. Run: `cat ~/.aide/knowledge.json`
   Expected: 文件已消失。

- [ ] **Step 8: 提交**

```bash
git add packages/aide-sdk/src/api.ts src/components/KnowledgeBase/kbRuntime.ts src/components/KnowledgeBase/kbRuntime.test.ts src/main.ts src/composables/useKnowledgeBase.ts
git commit -m "feat(knowledge): 凭据前端镜像链路（启动/登录/登出推给主进程）"
```

---

### Task 3: sidecar 凭据读取（fail-closed）

**Files:**
- Create: `agent-sidecar/src/extensions/knowledge/config.ts`
- Test: `agent-sidecar/src/extensions/knowledge/config.test.ts`

**Interfaces:**
- Consumes（Task 1）：env `AIDE_KB_CONFIG_FILE`；文件形状 `{ version: 1, baseUrl, token }`。
- Produces（给 Task 4/6）：`KbRuntimeConfig { baseUrl: string; token: string }`、`readKbConfig(env?): KbRuntimeConfig | null`、`parseKbConfig(raw): KbRuntimeConfig | null`、常量 `KB_CONFIG_FILE_ENV`。

- [ ] **Step 1: 写失败测试**

新建 `agent-sidecar/src/extensions/knowledge/config.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseKbConfig, readKbConfig, KB_CONFIG_FILE_ENV } from "./config.js";

describe("parseKbConfig", () => {
  it("正常形状 → 配置，尾斜杠被剥掉", () => {
    const cfg = parseKbConfig('{"version":1,"baseUrl":"http://kb:8788/","token":"t"}');
    expect(cfg).toEqual({ baseUrl: "http://kb:8788", token: "t" });
  });

  it("JSON 坏 → null（不抛）", () => {
    expect(parseKbConfig("{ not json")).toBeNull();
  });

  it("version 不认识 → null（fail-closed，给将来演进留门）", () => {
    expect(parseKbConfig('{"version":2,"baseUrl":"http://kb","token":"t"}')).toBeNull();
  });

  it("baseUrl 缺失或空 → null", () => {
    expect(parseKbConfig('{"version":1,"token":"t"}')).toBeNull();
    expect(parseKbConfig('{"version":1,"baseUrl":"","token":"t"}')).toBeNull();
  });

  it("token 缺失或空 → null", () => {
    expect(parseKbConfig('{"version":1,"baseUrl":"http://kb"}')).toBeNull();
    expect(parseKbConfig('{"version":1,"baseUrl":"http://kb","token":""}')).toBeNull();
  });

  it("非对象（数组/字符串/null）→ null", () => {
    expect(parseKbConfig("[]")).toBeNull();
    expect(parseKbConfig("null")).toBeNull();
    expect(parseKbConfig('"x"')).toBeNull();
  });
});

describe("readKbConfig", () => {
  it("env 没给路径 → null（不是错误：说明这台机器没登录过知识库）", () => {
    expect(readKbConfig({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("路径指向不存在的文件 → null", () => {
    const env = { [KB_CONFIG_FILE_ENV]: join(tmpdir(), "kb-nope-does-not-exist.json") } as NodeJS.ProcessEnv;
    expect(readKbConfig(env)).toBeNull();
  });

  it("正常文件 → 配置", () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-cfg-"));
    const file = join(dir, "knowledge.json");
    writeFileSync(file, '{"version":1,"baseUrl":"http://kb:8788","token":"t"}');
    try {
      expect(readKbConfig({ [KB_CONFIG_FILE_ENV]: file } as NodeJS.ProcessEnv)).toEqual({
        baseUrl: "http://kb:8788",
        token: "t",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-sidecar && npx vitest run src/extensions/knowledge/config.test.ts`
Expected: FAIL —— `Failed to resolve import "./config.js"`。

- [ ] **Step 3: 实现**

新建 `agent-sidecar/src/extensions/knowledge/config.ts`：

```ts
// 知识库运行时凭据：桌面前端 → Rust 写 `~/.aide/knowledge.json` → 这里**每次工具调用现读**。
//
// 为什么现读而不是会话级下发：MCP server 的闭包值随 query() spawn 冻结
// （session-worker.ts 的 startLoop → queryContext.ts），会话中途重新登录知识库后
// 旧值会一直用到开新会话——现读让重登自愈（设计 spec §3）。
// 为什么凭据在文件里而不是 env：env 会被 Bash 工具子进程继承，模型跑 `env` 即可
// 外带（engine/sessionMetadata.ts 红线）。env 里只有**路径**。
import { readFileSync } from "node:fs";

export interface KbRuntimeConfig {
  baseUrl: string;
  token: string;
}

/** 凭据文件路径的 env 键：由 Rust spawn sidecar 时注入（只有路径，没有凭据）。 */
export const KB_CONFIG_FILE_ENV = "AIDE_KB_CONFIG_FILE";

const SUPPORTED_VERSION = 1;

/**
 * 纯函数：凭据 JSON 文本 → 配置或 null。fail-closed：任何一处不对都当「未配置」，
 * 由调用方给出「请先登录」的引导文本。永不抛。
 */
export function parseKbConfig(raw: string): KbRuntimeConfig | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null; // 坏 JSON = 未配置，不向上抛（工具层红线是失败也返回文本）
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.version !== SUPPORTED_VERSION) return null;
  if (typeof o.baseUrl !== "string" || o.baseUrl.length === 0) return null;
  if (typeof o.token !== "string" || o.token.length === 0) return null;
  return { baseUrl: o.baseUrl.replace(/\/+$/, ""), token: o.token };
}

/** 读凭据文件。env 没给路径 / 文件不存在 / 内容坏 → null（= 这台机器没登录过）。 */
export function readKbConfig(env: NodeJS.ProcessEnv = process.env): KbRuntimeConfig | null {
  const path = env[KB_CONFIG_FILE_ENV];
  if (!path) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null; // 文件不存在 = 从未登录；权限问题同样降级成「未配置」
  }
  return parseKbConfig(raw);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent-sidecar && npx vitest run src/extensions/knowledge/config.test.ts`
Expected: PASS，9 passed。

- [ ] **Step 5: 提交**

```bash
git add agent-sidecar/src/extensions/knowledge/config.ts agent-sidecar/src/extensions/knowledge/config.test.ts
git commit -m "feat(knowledge): sidecar 凭据读取（fail-closed，调用时现读）"
```

---

### Task 4: REST 客户端（超时 + 错误归一）

**Files:**
- Create: `agent-sidecar/src/extensions/knowledge/client.ts`
- Test: `agent-sidecar/src/extensions/knowledge/client.test.ts`

**Interfaces:**
- Consumes：`KbRuntimeConfig`（Task 3）。
- Produces（给 Task 5/6）：`createKbClient(cfg, fetchImpl?)`、`withQuery`、`toFailure`、类型 `KbClient` / `KbResult<T>` / `KbFailure` / `KbQuery` / `KbUpload` / `KbSpace` / `KbDocumentSummary` / `KbDocument` / `KbSearchHit` / `KbSearchResult` / `KbSaveResult` / `KbIngestResult`、常量 `KB_HTTP_TIMEOUT_MS` / `KB_INGEST_TIMEOUT_MS`。

- [ ] **Step 1: 写失败测试**

新建 `agent-sidecar/src/extensions/knowledge/client.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import { createKbClient, docPath, toFailure, withQuery, type KbRuntimeConfig } from "./client.js";

const cfg: KbRuntimeConfig = { baseUrl: "http://kb:8788", token: "tok" };

/** 假 fetch：记录调用，返回给定响应。 */
function fakeFetch(reply: { status: number; body: string }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { status: reply.status, text: async () => reply.body } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("withQuery", () => {
  it("拼查询串，undefined 的键跳过", () => {
    expect(withQuery("/api/search", { q: "部署", limit: 20, spaceId: undefined })).toBe(
      "/api/search?q=" + encodeURIComponent("部署") + "&limit=20",
    );
  });

  it("没有有效键时保持原路径（不冒出一个 ?）", () => {
    expect(withQuery("/api/spaces", {})).toBe("/api/spaces");
    expect(withQuery("/api/spaces")).toBe("/api/spaces");
  });
});

describe("docPath", () => {
  it("uuid 原样进路径", () => {
    expect(docPath("a1b2-c3")).toBe("/api/documents/a1b2-c3");
  });

  it("带斜杠的 id 被编码（裸拼会多出一段路径）", () => {
    expect(docPath("d/1")).toBe("/api/documents/d%2F1");
  });
});

describe("createKbClient", () => {
  it("GET 成功 → data；带 Bearer 头与 Accept", async () => {
    const { fn, calls } = fakeFetch({ status: 200, body: '{"ok":1}' });
    const r = await createKbClient(cfg, fn).getJson<{ ok: number }>("/api/health");
    expect(r).toEqual({ ok: true, data: { ok: 1 } });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers.Accept).toBe("application/json");
  });

  it("POST 带 JSON body 与 Content-Type", async () => {
    const { fn, calls } = fakeFetch({ status: 200, body: "{}" });
    await createKbClient(cfg, fn).sendJson("/api/documents", "POST", { title: "t" });
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(calls[0]!.init.body).toBe('{"title":"t"}');
  });

  it("401 → unauthorized（401 不当作通用 bad_request）", async () => {
    const { fn } = fakeFetch({ status: 401, body: '{"error":"unauthorized","message":"登录已失效"}' });
    const r = await createKbClient(cfg, fn).getJson("/api/spaces");
    expect(r).toEqual({ ok: false, failure: { kind: "unauthorized" } });
  });

  it("409 → locked，并带上服务端 message", async () => {
    const { fn } = fakeFetch({ status: 409, body: '{"error":"locked","message":"文档正被张三编辑"}' });
    const r = await createKbClient(cfg, fn).sendJson("/api/documents/x", "PUT", {});
    expect(r).toEqual({ ok: false, failure: { kind: "locked", message: "文档正被张三编辑" } });
  });

  it("500 → server，带状态码", async () => {
    const { fn } = fakeFetch({ status: 503, body: "" });
    const r = await createKbClient(cfg, fn).getJson("/api/spaces");
    expect(r).toEqual({ ok: false, failure: { kind: "server", status: 503 } });
  });

  it("2xx 但 body 不是 JSON → bad_response", async () => {
    const { fn } = fakeFetch({ status: 200, body: "<html>proxy</html>" });
    const r = await createKbClient(cfg, fn).getJson("/api/spaces");
    expect(r).toEqual({ ok: false, failure: { kind: "bad_response", detail: "response body is not JSON" } });
  });

  it("fetch 抛错 → network，带 baseUrl 与原始信息（不带 token）", async () => {
    const fn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await createKbClient(cfg, fn).getJson("/api/spaces");
    expect(r).toEqual({
      ok: false,
      failure: { kind: "network", baseUrl: "http://kb:8788", detail: "ECONNREFUSED" },
    });
  });

  it("超时 → timeout（用假定时器把 15s 推快）", async () => {
    vi.useFakeTimers();
    try {
      const fn = ((_url: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
        })) as unknown as typeof fetch;
      const p = createKbClient(cfg, fn).getJson("/api/search", { q: "x" });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await p).toEqual({ ok: false, failure: { kind: "timeout" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sendFile 走 multipart，字段名 file", async () => {
    const { fn, calls } = fakeFetch({ status: 201, body: '{"documentId":"d1"}' });
    const r = await createKbClient(cfg, fn).sendFile(
      "/api/ingest",
      { spaceId: "s1" },
      { filename: "a.md", data: new Uint8Array([35, 32]) },
    );
    expect(r).toEqual({ ok: true, data: { documentId: "d1" } });
    expect(calls[0]!.url).toBe("http://kb:8788/api/ingest?spaceId=s1");
    expect(calls[0]!.init.body).toBeInstanceOf(FormData);
  });
});

describe("toFailure", () => {
  it("403 → forbidden；未知 4xx → bad_request 且带服务端 message", () => {
    expect(toFailure(403, "{}")).toEqual({ kind: "forbidden" });
    expect(toFailure(422, '{"error":"bad","message":"标题不能为空"}')).toEqual({
      kind: "bad_request",
      message: "标题不能为空",
    });
  });

  it("错误体不是 JSON → message 退回截断原文（不抛）", () => {
    const f = toFailure(400, "x".repeat(500));
    expect(f.kind).toBe("bad_request");
    expect(f.kind === "bad_request" && f.message.length).toBe(200);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-sidecar && npx vitest run src/extensions/knowledge/client.test.ts`
Expected: FAIL —— `Failed to resolve import "./client.js"`。

- [ ] **Step 3: 实现**

新建 `agent-sidecar/src/extensions/knowledge/client.ts`：

```ts
// 知识库 REST 薄客户端：baseUrl + Bearer token + 超时 + 错误归一。
// 只做传输，不认识业务语义（工具在 knowledgeTools.ts，文案在 format.ts）。
//
// 失败一律归一成 KbFailure（判别联合），**不抛**——工具层红线是「失败也返回文本」，
// 抛异常会让 agent 卡在错误上（codegraphTools.ts:50 先例）。fetch 可注入，单测不需要
// 真起 HTTP 服务。
import type { KbRuntimeConfig } from "./config.js";

// ── 失败归一 ──

export type KbFailure =
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "locked"; message: string }
  | { kind: "bad_request"; message: string }
  | { kind: "server"; status: number }
  | { kind: "network"; baseUrl: string; detail: string }
  | { kind: "timeout" }
  | { kind: "bad_response"; detail: string };

export type KbResult<T> = { ok: true; data: T } | { ok: false; failure: KbFailure };

// ── REST DTO（镜像 knowledge-server 的 serde camelCase）──

export interface KbSpace {
  id: string;
  key: string;
  name: string;
  visibility: string;
  role?: string;
}
export interface KbDocumentSummary {
  id: string;
  parentId?: string | null;
  slug: string;
  title: string;
  versionNo: number;
  status: string;
  updatedAt: string;
}
export interface KbDocument {
  id: string;
  spaceId: string;
  parentId?: string | null;
  slug: string;
  title: string;
  content: string;
  versionNo: number;
  status: string;
}
export interface KbSearchHit {
  documentId: string;
  spaceId: string;
  title: string;
  versionNo: number;
  rank: number;
  snippet: string;
}
export interface KbSearchResult {
  query: string;
  hits: KbSearchHit[];
}
export interface KbSaveResult {
  documentId: string;
  revisionId: string;
  versionNo: number;
  merged: boolean;
}
export interface KbIngestResult {
  documentId: string;
  revisionId: string;
  title: string;
  backend: string;
  warnings?: string[];
}

// ── 客户端 ──

export type KbQuery = Record<string, string | number | undefined>;

/** multipart 上传内容：字节由调用方（工具层）读完并做过尺寸校验，这里只负责传。 */
export interface KbUpload {
  filename: string;
  data: Uint8Array;
}

export interface KbClient {
  getJson<T>(path: string, query?: KbQuery): Promise<KbResult<T>>;
  sendJson<T>(path: string, method: "POST" | "PUT", body: unknown): Promise<KbResult<T>>;
  sendFile<T>(path: string, query: KbQuery, file: KbUpload): Promise<KbResult<T>>;
}

export const KB_HTTP_TIMEOUT_MS = 15_000;
export const KB_INGEST_TIMEOUT_MS = 120_000;

type FetchLike = typeof fetch;

/** 查询串：undefined 跳过（可选参数不该出现在 URL 里）。纯函数，测试直接覆盖。 */
export function withQuery(path: string, query?: KbQuery): string {
  if (!query) return path;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length > 0 ? `${path}?${parts.join("&")}` : path;
}

/**
 * 文档路径。id 是 uuid，但**必须**编码——编码挡的是拼接手误（如模型传了带 `/` 的
 * 字符串），一旦裸拼就会多出一段路径、打到别的端点上。读写两侧共用这一个构造器。
 */
export function docPath(documentId: string): string {
  return `/api/documents/${encodeURIComponent(documentId)}`;
}

/** HTTP 状态 + 错误体 → 领域失败。错误体形状 `{error, message}`（message 是中文）。 */
export function toFailure(status: number, bodyText: string): KbFailure {
  const message = extractMessage(bodyText);
  if (status === 401) return { kind: "unauthorized" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 404) return { kind: "not_found" };
  if (status === 409) return { kind: "locked", message };
  if (status >= 500) return { kind: "server", status };
  return { kind: "bad_request", message };
}

/** 错误体 `{error, message}` → message；解析不了就回一段截断原文（永不抛）。 */
function extractMessage(bodyText: string): string {
  try {
    const v: unknown = JSON.parse(bodyText);
    if (typeof v === "object" && v !== null) {
      const m = (v as Record<string, unknown>).message;
      if (typeof m === "string" && m.length > 0) return m;
    }
  } catch {
    // 不是 JSON：退回截断原文（服务端 5xx 时可能是反向代理的 HTML）
  }
  return bodyText.slice(0, 200);
}

/** 原始响应：「拿到了响应」与「没拿到」的分界（拿不到 → KbFailure）。 */
type RawResult = { ok: true; status: number; text: string } | { ok: false; failure: KbFailure };

export function createKbClient(cfg: KbRuntimeConfig, fetchImpl: FetchLike = fetch): KbClient {
  async function raw(
    method: string,
    path: string,
    body: BodyInit | undefined,
    timeoutMs: number,
  ): Promise<RawResult> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(`${cfg.baseUrl}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${cfg.token}`,
          ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}),
        },
        ...(body === undefined ? {} : { body }),
        signal: ctl.signal,
      });
      return { ok: true, status: resp.status, text: await resp.text() };
    } catch (e) {
      // abort 只有一种来源：上面那个超时定时器
      if (ctl.signal.aborted) return { ok: false, failure: { kind: "timeout" } };
      return {
        ok: false,
        failure: {
          kind: "network",
          baseUrl: cfg.baseUrl,
          detail: e instanceof Error ? e.message : String(e),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function finish<T>(r: RawResult): Promise<KbResult<T>> {
    if (!r.ok) return r;
    if (r.status < 200 || r.status >= 300) {
      return { ok: false, failure: toFailure(r.status, r.text) };
    }
    try {
      return { ok: true, data: JSON.parse(r.text) as T };
    } catch {
      return { ok: false, failure: { kind: "bad_response", detail: "response body is not JSON" } };
    }
  }

  return {
    async getJson<T>(path: string, query?: KbQuery): Promise<KbResult<T>> {
      return finish<T>(await raw("GET", withQuery(path, query), undefined, KB_HTTP_TIMEOUT_MS));
    },
    async sendJson<T>(path: string, method: "POST" | "PUT", body: unknown): Promise<KbResult<T>> {
      return finish<T>(await raw(method, path, JSON.stringify(body), KB_HTTP_TIMEOUT_MS));
    },
    async sendFile<T>(path: string, query: KbQuery, file: KbUpload): Promise<KbResult<T>> {
      const form = new FormData();
      form.append("file", new Blob([file.data]), file.filename);
      return finish<T>(await raw("POST", withQuery(path, query), form, KB_INGEST_TIMEOUT_MS));
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent-sidecar && npx vitest run src/extensions/knowledge/client.test.ts`
Expected: PASS，15 passed。

- [ ] **Step 5: 提交**

```bash
git add agent-sidecar/src/extensions/knowledge/client.ts agent-sidecar/src/extensions/knowledge/client.test.ts
git commit -m "feat(knowledge): REST 客户端（超时 + 错误归一，fetch 可注入）"
```

---

### Task 5: 格式化器（工具返回文本的唯一产地）

**Files:**
- Create: `agent-sidecar/src/extensions/knowledge/format.ts`
- Test: `agent-sidecar/src/extensions/knowledge/format.test.ts`

**Interfaces:**
- Consumes：`KbFailure` / `KbDocument` / `KbDocumentSummary` / `KbSearchResult` / `KbSpace`（Task 4）。
- Produces（给 Task 6）：`KB_NOT_CONNECTED_TEXT`、`KB_READ_MAX_CHARS`、`formatFailure(f)`、`formatSearchHits(data)`、`formatDocument(doc)`、`formatSpaces(spaces)`、`formatDocumentList(docs)`、`stripHighlight(s)`。

- [ ] **Step 1: 写失败测试**

新建 `agent-sidecar/src/extensions/knowledge/format.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import {
  KB_NOT_CONNECTED_TEXT,
  KB_READ_MAX_CHARS,
  formatDocument,
  formatDocumentList,
  formatFailure,
  formatSearchHits,
  formatSpaces,
  stripHighlight,
} from "./format.js";
import type { KbDocument, KbFailure } from "./client.js";

describe("stripHighlight", () => {
  it("剥掉 [[HL]] / [[/HL]] 哨兵，保留文字", () => {
    expect(stripHighlight("部署[[HL]]回滚[[/HL]]流程")).toBe("部署回滚流程");
  });
});

describe("formatFailure（每条失败原因都给下一步，永不抛）", () => {
  const cases: [KbFailure, string][] = [
    [{ kind: "unauthorized" }, "sign in again"],
    [{ kind: "forbidden" }, "permission"],
    [{ kind: "not_found" }, "search"],
    [{ kind: "locked", message: "被占用" }, "被占用"],
    [{ kind: "bad_request", message: "标题不能为空" }, "标题不能为空"],
    [{ kind: "server", status: 502 }, "502"],
    [{ kind: "network", baseUrl: "http://kb:8788", detail: "ECONNREFUSED" }, "http://kb:8788"],
    [{ kind: "timeout" }, "timed out"],
    [{ kind: "bad_response", detail: "not JSON" }, "not JSON"],
  ];

  it.each(cases)("%o 的文案含关键指引", (failure, needle) => {
    const text = formatFailure(failure);
    expect(typeof text).toBe("string");
    expect(text).toContain(needle);
  });

  it("unauthorized 明确说不需要开新会话（现读凭据，重登即生效）", () => {
    expect(formatFailure({ kind: "unauthorized" })).toContain("no new session");
  });

  it("network 文案带 baseUrl 但不含 token", () => {
    const text = formatFailure({ kind: "network", baseUrl: "http://kb:8788", detail: "ECONNREFUSED" });
    expect(text).toContain("http://kb:8788");
    expect(text).not.toContain("Bearer");
  });
});

describe("formatSearchHits", () => {
  it("命中列表带 documentId / 空间 / 摘要", () => {
    const text = formatSearchHits({
      query: "部署",
      hits: [
        { documentId: "d1", spaceId: "s1", title: "上线检查", versionNo: 3, rank: 0.5, snippet: "[[HL]]部署[[/HL]]前" },
      ],
    });
    expect(text).toContain("d1");
    expect(text).toContain("上线检查");
    expect(text).toContain("v3");
    expect(text).toContain("部署前");
    expect(text).not.toContain("[[HL]]");
  });

  it("零命中给换关键词的指引（不是错误）", () => {
    const text = formatSearchHits({ query: "不存在的东西", hits: [] });
    expect(text).toContain("不存在的东西");
    expect(text.toLowerCase()).toContain("no match");
  });
});

describe("formatDocument", () => {
  const doc: KbDocument = {
    id: "d1", spaceId: "s1", slug: "a", title: "标题", content: "正文", versionNo: 7, status: "published",
  };

  it("带标题 / id / 版本号 / 正文", () => {
    const text = formatDocument(doc);
    expect(text).toContain("标题");
    expect(text).toContain("d1");
    expect(text).toContain("7");
    expect(text).toContain("正文");
  });

  it("超长截断并注明（不静默丢内容）", () => {
    const text = formatDocument({ ...doc, content: "x".repeat(KB_READ_MAX_CHARS + 10) });
    expect(text).toContain("Truncated");
    expect(text.length).toBeLessThan(KB_READ_MAX_CHARS + 500);
  });
});

describe("formatSpaces / formatDocumentList", () => {
  it("空间列表带 id 与名称", () => {
    const text = formatSpaces([{ id: "s1", key: "eng", name: "工程", visibility: "internal", role: "editor" }]);
    expect(text).toContain("s1");
    expect(text).toContain("工程");
    expect(text).toContain("editor");
  });

  it("零空间时给出检查成员资格的指引", () => {
    expect(formatSpaces([])).toContain("no knowledge base spaces");
  });

  it("文档列表带 id / 版本 / 更新时间；空列表不提到不存在的工具", () => {
    const text = formatDocumentList([
      { id: "d1", parentId: null, slug: "a", title: "标题", versionNo: 2, status: "published", updatedAt: "2026-09-13T00:00:00Z" },
    ]);
    expect(text).toContain("d1");
    expect(text).toContain("v2");
    const empty = formatDocumentList([]);
    expect(empty).toContain("no documents");
    expect(empty).not.toContain("create_document"); // P1 没有写工具，文案不许点名不存在的工具
  });
});

describe("KB_NOT_CONNECTED_TEXT", () => {
  it("指向知识库面板登录（这是「未配置」唯一的用户可见出口）", () => {
    expect(KB_NOT_CONNECTED_TEXT).toContain("知识库 panel");
    expect(KB_NOT_CONNECTED_TEXT).toContain("sign in");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-sidecar && npx vitest run src/extensions/knowledge/format.test.ts`
Expected: FAIL —— `Failed to resolve import "./format.js"`。

- [ ] **Step 3: 实现**

新建 `agent-sidecar/src/extensions/knowledge/format.ts`：

```ts
// 知识库工具返回文本的唯一产地（纯函数，单测直接覆盖）。
//
// 红线：失败也返回**文本**，永不 throw、永不 isError——工具报错会让 agent 纠结，
// 文本提示让它自然换路（codegraphTools.ts:50 先例）。每条失败文案都要写清「下一步」。
import type {
  KbDocument,
  KbDocumentSummary,
  KbFailure,
  KbSearchResult,
  KbSpace,
} from "./client.js";

/** 未配置 / 已登出时的引导文本（工具恒挂，未登录也有话可说——设计 spec §5.1）。 */
export const KB_NOT_CONNECTED_TEXT =
  "The knowledge base is not connected — no credentials are saved for this desktop. " +
  "Ask the user to sign in from the 知识库 panel, then retry (no new session is needed).";

/** `read_document` 输出上限：超出截断并显式注明。 */
export const KB_READ_MAX_CHARS = 100_000;

/** 摘要里的 `[[HL]]…[[/HL]]` 哨兵剥掉——服务端标记不该混进模型后续写回的正文。 */
export function stripHighlight(s: string): string {
  return s.replaceAll("[[HL]]", "").replaceAll("[[/HL]]", "");
}

/** 失败 → 下一步。switch 必须穷尽 KbFailure（漏一种 TS 会报 never）。 */
export function formatFailure(f: KbFailure): string {
  switch (f.kind) {
    case "unauthorized":
      return "The knowledge base rejected the saved credentials (401). Tell the user to sign in again from the 知识库 panel, then retry — no new session is needed.";
    case "forbidden":
      return "The signed-in account has no permission for this space or document (403). Ask the user to check space membership, or pick another space.";
    case "not_found":
      return "Not found (404) — the document may have been deleted, or the id is wrong. Use search or list_documents to locate it again.";
    case "locked":
      return `The document is currently locked by another editor (409): ${f.message}. Wait a moment and retry, or ask the user to close their editor.`;
    case "bad_request":
      return `The knowledge base rejected the request: ${f.message}`;
    case "server":
      return `The knowledge base returned a server error (${f.status}). Retry once; if it persists, tell the user to check the knowledge base service.`;
    case "network":
      return `Could not reach the knowledge base at ${f.baseUrl} (${f.detail}). Retry once; if it persists, check that the service is running and that the address in the 知识库 panel is right.`;
    case "timeout":
      return "The knowledge base request timed out. Retry once; if it keeps timing out, tell the user the service may be overloaded.";
    case "bad_response":
      return `The knowledge base returned an unexpected response: ${f.detail}`;
  }
}

export function formatSearchHits(data: KbSearchResult): string {
  const hits = data.hits ?? [];
  if (hits.length === 0) {
    return `No match for "${data.query}" in the knowledge base. Try different keywords, or ask the user which document they mean.`;
  }
  const lines = hits.map(
    (h) =>
      `- ${h.title} — documentId ${h.documentId} (space ${h.spaceId}, v${h.versionNo})\n  ${stripHighlight(h.snippet)}`,
  );
  return `Knowledge base hits for "${data.query}" (${hits.length}):\n${lines.join("\n")}`;
}

export function formatDocument(doc: KbDocument): string {
  const body = doc.content ?? "";
  const truncated = body.length > KB_READ_MAX_CHARS;
  const shown = truncated ? body.slice(0, KB_READ_MAX_CHARS) : body;
  const head = `# ${doc.title}\ndocumentId ${doc.id}, space ${doc.spaceId}, version ${doc.versionNo}, status ${doc.status}`;
  const tail = truncated
    ? `\n\n⚠ Truncated at ${KB_READ_MAX_CHARS} characters — the document is longer than what is shown above.`
    : "";
  return `${head}\n\n${shown}${tail}`;
}

export function formatSpaces(spaces: KbSpace[]): string {
  if (spaces.length === 0) {
    return "The signed-in user can see no knowledge base spaces. Ask the user to check their space membership in the 知识库 panel.";
  }
  const lines = spaces.map(
    (s) => `- ${s.name} — id ${s.id} (key ${s.key}, visibility ${s.visibility}${s.role ? `, your role ${s.role}` : ""})`,
  );
  return `Knowledge base spaces (${spaces.length}):\n${lines.join("\n")}`;
}

export function formatDocumentList(docs: KbDocumentSummary[]): string {
  if (docs.length === 0) {
    return "This space has no documents yet.";
  }
  const lines = docs.map(
    (d) =>
      `- ${d.title} — id ${d.id}${d.parentId ? ` (under ${d.parentId})` : ""}, v${d.versionNo}, updated ${d.updatedAt}`,
  );
  return `Documents in this space (${docs.length}):\n${lines.join("\n")}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent-sidecar && npx vitest run src/extensions/knowledge/format.test.ts`
Expected: PASS，20 passed（`it.each` 的 9 条按 9 条算）。

- [ ] **Step 5: 提交**

```bash
git add agent-sidecar/src/extensions/knowledge/format.ts agent-sidecar/src/extensions/knowledge/format.test.ts
git commit -m "feat(knowledge): 工具文案格式化器（失败也给下一步）"
```

---

### Task 6: 4 个读工具（每次调用现读凭据）

**Files:**
- Create: `agent-sidecar/src/extensions/knowledgeTools.ts`
- Test: `agent-sidecar/src/extensions/knowledgeTools.test.ts`

**Interfaces:**
- Consumes：`readKbConfig`（Task 3）、`createKbClient` + DTO（Task 4）、格式化器（Task 5）。
- Produces（给 Task 7）：`buildKnowledgeTools(env): SdkMcpToolDefinition[]`。

- [ ] **Step 1: 写失败测试**

新建 `agent-sidecar/src/extensions/knowledgeTools.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildKnowledgeTools } from "./knowledgeTools.js";
import { KB_CONFIG_FILE_ENV } from "./knowledge/config.js";

/** 取工具定义（按名字），并调用它的 handler ——与真实模型调用同一条代码路径。
 *  handler 的入参用 `unknown`（不用 `any`）：测试传的都是对象字面量，收窄在这里没有价值。 */
type AnyTool = {
  name: string;
  handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>;
};

function toolByName(env: NodeJS.ProcessEnv, name: string): AnyTool {
  const tools = buildKnowledgeTools(env) as unknown as AnyTool[];
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not built`);
  return found;
}

let dir: string;
let credEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-tools-"));
  const file = join(dir, "knowledge.json");
  writeFileSync(file, '{"version":1,"baseUrl":"http://kb.test","token":"tok"}');
  credEnv = { [KB_CONFIG_FILE_ENV]: file } as NodeJS.ProcessEnv;
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

/** 用假 fetch 顶掉全局 fetch（client.ts 的默认参数在调用时读全局，所以能顶掉）。 */
function stubFetch(reply: { status: number; body: string }) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    return { status: reply.status, text: async () => reply.body } as Response;
  });
  return calls;
}

describe("buildKnowledgeTools", () => {
  it("P1 只暴露 4 个读工具", () => {
    const names = (buildKnowledgeTools(credEnv) as unknown as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(["search", "read_document", "list_spaces", "list_documents"]);
  });
});

describe("未配置凭据（恒挂的降级路径）", () => {
  it("任何工具都返回「未连接 + 去登录」，且不发请求", async () => {
    const calls = stubFetch({ status: 200, body: "{}" });
    const r = await toolByName({} as NodeJS.ProcessEnv, "search").handler({ query: "x" }, undefined);
    expect(r.content[0]!.text).toContain("sign in");
    expect(calls).toEqual([]);
  });
});

describe("search", () => {
  it("拼 q / spaceId / limit，返回命中", async () => {
    const calls = stubFetch({
      status: 200,
      body: JSON.stringify({
        query: "部署",
        hits: [{ documentId: "d1", spaceId: "s1", title: "上线", versionNo: 1, rank: 0.9, snippet: "[[HL]]部署[[/HL]]" }],
      }),
    });
    const r = await toolByName(credEnv, "search").handler({ query: "部署", spaceId: "s1", limit: 5 }, undefined);
    expect(calls[0]).toBe("http://kb.test/api/search?q=%E9%83%A8%E7%BD%B2&spaceId=s1&limit=5");
    expect(r.content[0]!.text).toContain("d1");
  });

  it("401 → 引导重新登录（不是抛错）", async () => {
    stubFetch({ status: 401, body: '{"error":"unauthorized","message":"登录已失效"}' });
    const r = await toolByName(credEnv, "search").handler({ query: "x" }, undefined);
    expect(r.content[0]!.text).toContain("sign in again");
  });

  it("网络失败 → 带 baseUrl 的文本", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await toolByName(credEnv, "search").handler({ query: "x" }, undefined);
    expect(r.content[0]!.text).toContain("http://kb.test");
  });
});

describe("read_document", () => {
  it("取全文并做 URL 编码（id 不会拼出额外路径段）", async () => {
    const calls = stubFetch({
      status: 200,
      body: JSON.stringify({ id: "d/1", spaceId: "s1", slug: "a", title: "T", content: "正文", versionNo: 2, status: "published" }),
    });
    const r = await toolByName(credEnv, "read_document").handler({ documentId: "d/1" }, undefined);
    expect(calls[0]).toBe("http://kb.test/api/documents/d%2F1");
    expect(r.content[0]!.text).toContain("正文");
  });

  it("404 → 引导回 search", async () => {
    stubFetch({ status: 404, body: '{"error":"not_found","message":"不存在"}' });
    const r = await toolByName(credEnv, "read_document").handler({ documentId: "x" }, undefined);
    expect(r.content[0]!.text).toContain("search");
  });
});

describe("list_spaces / list_documents", () => {
  it("list_spaces 打 /api/spaces 并渲染空间", async () => {
    const calls = stubFetch({
      status: 200,
      body: JSON.stringify([{ id: "s1", key: "eng", name: "工程", visibility: "internal" }]),
    });
    const r = await toolByName(credEnv, "list_spaces").handler({}, undefined);
    expect(calls[0]).toBe("http://kb.test/api/spaces");
    expect(r.content[0]!.text).toContain("工程");
  });

  it("list_documents 打空间文档树", async () => {
    const calls = stubFetch({ status: 200, body: JSON.stringify([]) });
    const r = await toolByName(credEnv, "list_documents").handler({ spaceId: "s1" }, undefined);
    expect(calls[0]).toBe("http://kb.test/api/spaces/s1/documents");
    expect(r.content[0]!.text).toContain("no documents");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-sidecar && npx vitest run src/extensions/knowledgeTools.test.ts`
Expected: FAIL —— `Failed to resolve import "./knowledgeTools.js"`。

- [ ] **Step 3: 实现**

新建 `agent-sidecar/src/extensions/knowledgeTools.ts`：

```ts
// aide-knowledge 的工具定义（P1 = 4 个读工具；写工具见 P2 计划）。
//
// 组织：本文件上层只做编排（buildKnowledgeTools 是一张表），每个工具一个
// buildXxxTool，各自成形、互不依赖。
//
// **凭据在每次调用现读**（readKbConfig）——MCP server 的闭包值随 query() spawn 冻结
// （session-worker.ts 的 startLoop → queryContext.ts），会话中途重新登录知识库后旧值
// 会一直用到开新会话；现读让重登自愈，也让「未登录」能返回引导文本而不是没有工具
// （设计 spec §3 / §5.1）。
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { readKbConfig } from "./knowledge/config.js";
import {
  createKbClient,
  docPath,
  type KbClient,
  type KbDocument,
  type KbDocumentSummary,
  type KbResult,
  type KbSearchResult,
  type KbSpace,
} from "./knowledge/client.js";
import {
  KB_NOT_CONNECTED_TEXT,
  formatDocument,
  formatDocumentList,
  formatFailure,
  formatSearchHits,
  formatSpaces,
} from "./knowledge/format.js";

interface ToolResult {
  content: { type: "text"; text: string }[];
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * 单请求工具的公共壳：现读凭据 → 建客户端 → 跑一次请求 → 成功/失败各走格式化器。
 * 永不抛（工具层红线）。多请求工具（P2 的 append / ingest）自己组合这几步。
 */
async function kbCall<T>(
  env: NodeJS.ProcessEnv,
  run: (client: KbClient) => Promise<KbResult<T>>,
  onOk: (data: T) => string,
): Promise<ToolResult> {
  const cfg = readKbConfig(env);
  if (!cfg) return textResult(KB_NOT_CONNECTED_TEXT);
  const r = await run(createKbClient(cfg));
  return textResult(r.ok ? onOk(r.data) : formatFailure(r.failure));
}

function buildSearchTool(env: NodeJS.ProcessEnv) {
  return tool(
    "search",
    "Full-text search across the team knowledge base (the server tokenizes Chinese itself). Returns matching documents with a snippet, each carrying the documentId needed by read_document. Use natural keywords, not SQL/LIKE patterns.",
    {
      query: z.string().describe("Search keywords, e.g. '部署回滚' or 'release checklist'"),
      spaceId: z.string().optional().describe("Restrict to one space id (from list_spaces). Omit to search every space the user can read."),
      limit: z.number().int().min(1).max(100).optional().describe("Max hits (default 20, server caps at 100)"),
    },
    (args) =>
      kbCall<KbSearchResult>(
        env,
        (c) => c.getJson<KbSearchResult>("/api/search", { q: args.query, spaceId: args.spaceId, limit: args.limit }),
        formatSearchHits,
      ),
  );
}

function buildReadDocumentTool(env: NodeJS.ProcessEnv) {
  return tool(
    "read_document",
    "Read one knowledge base document in full (markdown) together with its version number. Call this before updating or appending to a document so you edit what is actually there.",
    { documentId: z.string().describe("Document id (uuid) from search or list_documents") },
    (args) =>
      kbCall<KbDocument>(env, (c) => c.getJson<KbDocument>(docPath(args.documentId)), formatDocument),
  );
}

function buildListSpacesTool(env: NodeJS.ProcessEnv) {
  return tool(
    "list_spaces",
    "List the knowledge base spaces (id / key / name / role) the signed-in user can see. This is how you learn the spaceId other tools need.",
    {},
    () => kbCall<KbSpace[]>(env, (c) => c.getJson<KbSpace[]>("/api/spaces"), formatSpaces),
  );
}

function buildListDocumentsTool(env: NodeJS.ProcessEnv) {
  return tool(
    "list_documents",
    "List the documents in one knowledge base space (flat tree: id / parentId / title / versionNo / updatedAt). Use it to browse what exists when the user has not named a document.",
    { spaceId: z.string().describe("Space id from list_spaces") },
    (args) =>
      kbCall<KbDocumentSummary[]>(
        env,
        (c) => c.getJson<KbDocumentSummary[]>(`/api/spaces/${encodeURIComponent(args.spaceId)}/documents`),
        formatDocumentList,
      ),
  );
}

/** 工具总装：本文件唯一的编排点（一张表，不加逻辑）。 */
export function buildKnowledgeTools(env: NodeJS.ProcessEnv) {
  return [
    buildSearchTool(env),
    buildReadDocumentTool(env),
    buildListSpacesTool(env),
    buildListDocumentsTool(env),
  ];
}
```

> 若 `tool(..., {}, handler)` 的空 zod shape 在本版 SDK 上编译不过（仓库里没有无参工具先例），退路是 `z.object({}).shape` 或给 `list_spaces` 加一个 `z.string().optional()` 的过滤参数——**不要**改工具名。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent-sidecar && npx vitest run src/extensions/knowledgeTools.test.ts`
Expected: PASS，9 passed。

- [ ] **Step 5: 提交**

```bash
git add agent-sidecar/src/extensions/knowledgeTools.ts agent-sidecar/src/extensions/knowledgeTools.test.ts
git commit -m "feat(knowledge): 4 个读工具（search / read_document / list_spaces / list_documents）"
```

---

### Task 7: 注册器 + 装配三处 + 放行规则

**Files:**
- Create: `agent-sidecar/src/extensions/knowledgeMcp.ts`
- Test: `agent-sidecar/src/extensions/knowledgeMcp.test.ts`
- Modify: `agent-sidecar/src/engine/session-worker/queryContext.ts:88-99`
- Modify: `agent-sidecar/src/engine/session-worker/queryOptions.ts:73`
- Modify: `agent-sidecar/src/engine/session-worker.test.ts:450`（精确断言）
- Modify: `packages/aide-sdk/src/composables/useCustomizations.ts:74-77`

**Interfaces:**
- Consumes：`buildKnowledgeTools(env)`（Task 6）。
- Produces（给前端镜像与后续维护）：`KNOWLEDGE_READ_RULES`（四条**工具级**放行规则）、`KNOWLEDGE_INSTRUCTIONS`、`knowledgeMcpRegistration(env, trusted, taskTools)`。

- [ ] **Step 1: 写失败测试**

新建 `agent-sidecar/src/extensions/knowledgeMcp.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { knowledgeMcpRegistration, KNOWLEDGE_INSTRUCTIONS, KNOWLEDGE_READ_RULES } from "./knowledgeMcp.js";

describe("knowledgeMcpRegistration — 门控矩阵", () => {
  it("默认注册（缺省 trusted=true、无 taskTools）", () => {
    const spec = knowledgeMcpRegistration({} as NodeJS.ProcessEnv);
    expect(spec).not.toBeNull();
    expect(spec!["aide-knowledge"]).toBeDefined();
  });

  it("AIDE_KB_TOOLS=off → null", () => {
    expect(knowledgeMcpRegistration({ AIDE_KB_TOOLS: "off" } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("!trusted → null（受限模式不暴露知识库读写）", () => {
    expect(knowledgeMcpRegistration({} as NodeJS.ProcessEnv, false)).toBeNull();
  });

  it("btw 任务支线（taskTools 非空）→ null（前缀最小化）", () => {
    expect(knowledgeMcpRegistration({} as NodeJS.ProcessEnv, true, ["Bash"])).toBeNull();
  });

  it("trusted 优先于 env（两道门并列，任一不满足即 null）", () => {
    expect(knowledgeMcpRegistration({} as NodeJS.ProcessEnv, false, undefined)).toBeNull();
  });
});

describe("放行规则是**工具级**的（server 级会连写工具一起放行）", () => {
  it("四条常量逐字固定", () => {
    expect(KNOWLEDGE_READ_RULES).toEqual([
      "mcp__aide-knowledge__search",
      "mcp__aide-knowledge__read_document",
      "mcp__aide-knowledge__list_spaces",
      "mcp__aide-knowledge__list_documents",
    ]);
  });

  it("没有任何一条等于 server 前缀（防漂移成 mcp__aide-knowledge）", () => {
    for (const rule of KNOWLEDGE_READ_RULES) {
      expect(rule).not.toBe("mcp__aide-knowledge");
      expect(rule.startsWith("mcp__aide-knowledge__")).toBe(true);
    }
  });
});

describe("instructions 是 MCP 采纳率的必需品", () => {
  it("工具描述快照 + instructions 关键句（防静默消失）", () => {
    const spec = knowledgeMcpRegistration({} as NodeJS.ProcessEnv);
    // SDK server 实例内含 zod v4 schema（内部 root 自引用），直接 JSON.stringify 会抛
    // circular structure —— 用 WeakSet replacer 去环（codegraphTools.test.ts 先例）。
    const seen = new WeakSet();
    const json = JSON.stringify(spec, (_key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
    expect(json).toMatchSnapshot();
    expect(json).toContain("mcp__aide-knowledge__search");
    expect(json).toContain("USE ONLY ON EXPLICIT REQUEST");
    expect(json).toContain(KNOWLEDGE_INSTRUCTIONS);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-sidecar && npx vitest run src/extensions/knowledgeMcp.test.ts`
Expected: FAIL —— `Failed to resolve import "./knowledgeMcp.js"`。

- [ ] **Step 3: 实现注册器**

新建 `agent-sidecar/src/extensions/knowledgeMcp.ts`：

```ts
// aide-knowledge（知识库读写）MCP server 注册。
// 组织文件在上层，子实现各自独立（knowledgeTools.ts + knowledge/ 子目录）。
//
// 注册条件（任一不满足即 null）：
// - `AIDE_KB_TOOLS=off`：operator 级开关（调试 / 不想让 agent 碰知识库的部署）。
// - `!trusted`：受限模式不暴露知识库读写。
// - `taskTools` 非空：btw 任务支线全新会话，前缀最小化（沿 docsMcp 写法）。
// **刻意不设「配置了才挂」的第四道门**：未登录也挂载，调用返回「去知识库面板登录」
// 的引导文本——工具列表跨会话稳定，且会话中途第一次登录能当场生效（设计 spec §5.1）。
//
// server 实例 per-worker 构造；**无 emit 参数**——本 server 直连知识库的 HTTP，
// 不像 codegraph 要回主进程查索引（无 IPC 客户端）。
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { buildKnowledgeTools } from "./knowledgeTools.js";

/**
 * allowedTools 规则：**工具级**，只放行四个读工具。
 *
 * ⚠️ 不要照抄 codegraph/docs 的 server 级规则（`mcp__aide-codegraph`）——那是「整个
 * server 都只读」才成立的写法。本 server 混着写工具，server 级规则会把写操作一起
 * 放行，破坏「写必弹窗」（设计 spec §7）。
 */
export const KNOWLEDGE_READ_RULES = [
  "mcp__aide-knowledge__search",
  "mcp__aide-knowledge__read_document",
  "mcp__aide-knowledge__list_spaces",
  "mcp__aide-knowledge__list_documents",
] as const;

/**
 * MCP instructions 块（initialize 时呈现给模型）。2026-07-26 codegraph 冒烟实锤：
 * 没有它时模型对第三方 MCP 工具视而不见，连 prompt 直接点名都会被无视——这不是优化
 * 是必需品。删除或弱化前必须先跑 agent-sidecar/smoke-mcp.ts 验证行为不退化。
 */
export const KNOWLEDGE_INSTRUCTIONS = `This environment has built-in tools for the user's team knowledge base (知识库), exposed as the aide-knowledge MCP server. Rules:
1. USE ONLY ON EXPLICIT REQUEST. Call these tools only when the user explicitly mentions the knowledge base (知识库 / 存到知识库 / 查一下知识库). Never search the knowledge base proactively.
2. To find content you MUST call mcp__aide-knowledge__search first — never guess document ids, and never try to read knowledge base content with Grep/Read (it lives in a server, not in the workspace). Then mcp__aide-knowledge__read_document with the documentId from the hits.
3. Don't know what exists? Use mcp__aide-knowledge__list_spaces then mcp__aide-knowledge__list_documents to browse instead of guessing.
4. Cite documents as 知识库《标题》, and summarize instead of pasting a whole document back to the user.
5. FAILURES COME BACK AS TEXT with the next step (not connected / login expired / locked / unreachable). Follow the hint: if it says the user must sign in, tell them to sign in from the 知识库 panel and retry.`;

/**
 * 默认注册。`trusted=false` 或 `taskTools` 非空或 `AIDE_KB_TOOLS=off` → null。
 * 省略 trusted = 信任（向后兼容，测试与手工调用用）。
 */
export function knowledgeMcpRegistration(
  env: NodeJS.ProcessEnv = process.env,
  trusted = true,
  taskTools?: string[],
): Record<string, unknown> | null {
  if (!trusted) return null;
  if (taskTools) return null;
  if (env.AIDE_KB_TOOLS === "off") return null;

  const server = createSdkMcpServer({
    name: "aide-knowledge",
    version: "1.0.0",
    instructions: KNOWLEDGE_INSTRUCTIONS,
    tools: buildKnowledgeTools(env),
  });

  return { "aide-knowledge": server };
}
```

- [ ] **Step 4: 装配三处**

1. `agent-sidecar/src/engine/session-worker/queryContext.ts`：

导入区加：
```ts
import { knowledgeMcpRegistration } from "../../extensions/knowledgeMcp.js";
```

在 `const docsMcp = ...` 之后加：
```ts
  // 知识库读写（P1 只有读工具）：注册条件=任务支线跳过、!trusted 跳过、
  // AIDE_KB_TOOLS=off 跳过。**未登录也挂**——凭据每次调用现读，未配置时工具返回
  // 「去知识库面板登录」的引导文本（设计 spec §5.1）。无 emit 参数：直连知识库
  // 的 HTTP，不走主进程 IPC（不像 codegraph）。
  const knowledgeMcp = knowledgeMcpRegistration(deps.processEnv, deps.trusted, deps.taskTools);
```
（`deps.taskTools` 已是 `string[] | undefined`，语义与传入 `knowledgeMcpRegistration` 的第三参一致。）

把 `:93` 的终装改成：
```ts
  const assembledMcp = assembleMcpServers(
    { ...(codegraphMcp ?? {}), ...(docsMcp ?? {}), ...(knowledgeMcp ?? {}) },
    userMcp,
  );
```

2. `agent-sidecar/src/engine/session-worker/queryOptions.ts:73`：

```ts
import { KNOWLEDGE_READ_RULES } from "../../extensions/knowledgeMcp.js";
```
```ts
    // allowedTools 统一:问答支线(轻量/完整)与主会话同形,保持前缀一致;
    // btw 任务支线由 btwQueryOverrides 在后方覆盖成白名单。
    // 知识库只放行**读**工具（工具级规则）——写工具走权限弹窗，见 knowledgeMcp.ts。
    allowedTools: ["Agent", "Task", CODEGRAPH_ALLOW_RULE, DOCS_ALLOW_RULE, ...KNOWLEDGE_READ_RULES],
```
（`queryOptions.ts:7-8` 已有 `import { CODEGRAPH_ALLOW_RULE } from "../../extensions/codegraphTools.js";` 等两行，新导入紧随其后即可。）

3. `agent-sidecar/src/engine/session-worker.test.ts:450`：精确断言同步（这是设计上的变更，不是测试缺陷）：

```ts
    expect(captured?.allowedTools).toEqual([
      "Agent", "Task", "mcp__aide-codegraph", "mcp__aide-docs",
      "mcp__aide-knowledge__search",
      "mcp__aide-knowledge__read_document",
      "mcp__aide-knowledge__list_spaces",
      "mcp__aide-knowledge__list_documents",
    ]);
```

同时在该文件里加一条写规则**不在**白名单的断言（P1 就该锁住的行为，P2 加写工具时靠它防回归）：

```ts
  it("knowledge 写工具不在 allowedTools（写必弹窗）", async () => {
    // 复用上面 lightweight btw 用例的捕获方式
    let captured: any;
    const fakeQuery = ((args: any) => {
      captured = args?.options ?? args;
      return (async function* () {})();
    }) as any;
    const worker = new SessionWorker("kb-write-rule", () => {}, { queryFn: fakeQuery, cwd: "/proj" });
    worker.handleCommand({
      cmd: "send", session_id: "kb-write-rule", prompt: "你好", cwd: "/proj", env: {}, codegraph_enabled: true,
    } as any);
    await vi.waitFor(() => expect(captured).toBeDefined());
    worker.stop();
    const rules: string[] = captured?.allowedTools ?? [];
    for (const r of rules) expect(r).not.toBe("mcp__aide-knowledge");
    expect(rules).not.toContain("mcp__aide-knowledge__create_document");
  });
```

4. `packages/aide-sdk/src/composables/useCustomizations.ts:74-77` 的 `builtinMcpServers` 加一项：

```ts
  { id: "aide-knowledge", transport: "in-process", purpose: "内置知识库读写（search / read_document / list_spaces / list_documents，写工具见 P2），受信任工作区挂载；未登录时工具返回登录引导" },
```

- [ ] **Step 5: 跑测试**

Run: `cd agent-sidecar && npx vitest run src/extensions/knowledgeMcp.test.ts src/engine/session-worker.test.ts`
Expected: PASS。首次运行会**新生成** `src/extensions/__snapshots__/knowledgeMcp.test.ts.snap`——确认内容里含四条工具名与 instructions，且 diff 不涉及 `codegraphTools.test.ts.snap` / `docxTools.test.ts.snap`。

Run: `cd agent-sidecar && npx vitest run`
Expected: 全绿。

Run: `npx vitest run`（仓库根，同时跑前端与 sidecar）
Expected: 全绿——尤其 `useCustomizations` 与 `queryContext` 相关用例。

- [ ] **Step 6: 前端镜像可见性手工验证**

`pnpm dev` → 设置 → 扩展面板 → 「内置 MCP」区。
Expected: 出现 `aide-knowledge`，标注 `内置 · 只读 · in-process`，purpose 文案正确。

- [ ] **Step 7: 提交**

```bash
git add agent-sidecar/src/extensions/knowledgeMcp.ts agent-sidecar/src/extensions/knowledgeMcp.test.ts agent-sidecar/src/extensions/__snapshots__/knowledgeMcp.test.ts.snap agent-sidecar/src/engine/session-worker/queryContext.ts agent-sidecar/src/engine/session-worker/queryOptions.ts agent-sidecar/src/engine/session-worker.test.ts packages/aide-sdk/src/composables/useCustomizations.ts
git commit -m "feat(knowledge): 注册器 + 装配三处 + 工具级读放行规则"
```

---

### Task 8: 冒烟（真模型采纳率）+ 端到端验收

**Files:**
- Modify: `agent-sidecar/smoke-mcp.ts`（修两条失效 import + 加 KB 段）

**Interfaces:**
- Consumes：`KNOWLEDGE_INSTRUCTIONS`（Task 7）。

- [ ] **Step 1: 修既有失效 import**

`smoke-mcp.ts:9-10` 两条路径指向早已搬走的文件（`./src/codegraphTools.js` / `./src/docsMcp.js`），脚本现在加载即失败。改成：

```ts
import { CODEGRAPH_INSTRUCTIONS } from "./src/extensions/codegraphTools.js";
import { DOCS_INSTRUCTIONS } from "./src/extensions/docsMcp.js";
import { KNOWLEDGE_INSTRUCTIONS } from "./src/extensions/knowledgeMcp.js";
```

验证（零成本、确定性的那一半——导入目标确实存在）：

Run: `cd agent-sidecar && ls src/extensions/codegraphTools.ts src/extensions/docsMcp.ts src/extensions/knowledgeMcp.ts`
Expected: 三个文件都在。真跑由 Step 3 覆盖。

- [ ] **Step 2: 加 KB 冒烟段**

在 `smoke-mcp.ts` 末尾追加（mock handler 只为验证 instructions 是否让模型采纳工具，不需要真知识库）：

```ts
// 5) knowledge 冒烟——验证 instructions 让模型在「用户点名知识库」时采纳 search。
// 用 mock handler：本段验的是 instructions 的采纳率，不是知识库连通性（那由手工 E2E 验）。
const knowledgeServer = createSdkMcpServer({
  name: "aide-knowledge",
  version: "1.0.0",
  instructions: KNOWLEDGE_INSTRUCTIONS,
  tools: [
    tool(
      "search",
      "Full-text search across the team knowledge base. Returns matching documents with a snippet, each carrying the documentId needed by read_document.",
      { query: z.string().describe("Search keywords"), spaceId: z.string().optional().describe("Restrict to one space id") },
      async (args) => ({
        content: [{ type: "text" as const, text: `MOCK search(${String((args as any).query)}) -> 上线检查清单 (documentId d1)` }],
      }),
    ),
    tool(
      "list_spaces",
      "List the knowledge base spaces the signed-in user can see.",
      {},
      async () => ({ content: [{ type: "text" as const, text: "MOCK spaces: 工程 (id s1)" }] }),
    ),
  ],
});

const knowledgeTools = await runQuery(
  "knowledge",
  "帮我查一下知识库里关于「上线检查」的内容。",
  { "aide-knowledge": knowledgeServer },
  ["mcp__aide-knowledge__search", "mcp__aide-knowledge__list_spaces"],
  "knowledge",
);
if (!knowledgeTools.some((n) => n.includes("search") || n.includes("list_spaces"))) {
  console.error("\nFAIL: model did not call a knowledge tool — KNOWLEDGE_INSTRUCTIONS may be ineffective");
  process.exit(1);
}
console.log("\nPASS: knowledge tool was called");
```

- [ ] **Step 3: 跑冒烟（真模型，需 API 凭据）**

Run: `cd agent-sidecar && npx tsx smoke-mcp.ts`
Expected: 五段全 PASS（`read_docx was called` / `write_docx was called` / `read_pdf was called` / `knowledge tool was called`）。若 model 未调用，按输出调整 `KNOWLEDGE_INSTRUCTIONS` 的措辞后重跑（这是本步存在的唯一目的）。

- [ ] **Step 4: 端到端手工验收（真实知识库）**

前置：本机起 knowledge-server（`cd knowledge-server && cargo run`，需一个 PG，见其 README），库里至少有 1 个空间 + 1 篇文档。

1. `pnpm build:sidecar` 重建 sidecar（**改 src 必须重建，dev 跑的是 dist**），再 `pnpm dev`。
2. 知识库面板登录。
3. 新开一个会话，发：「帮我查一下知识库里关于 X 的内容」（X = 你库里的真实关键词）。
   Expected: agent 调 `search`（工具卡片可见），结果里出现文档标题与 documentId；让它「读一下这篇」，它调 `read_document` 并给出内容摘要。
4. 未登录场景：面板登出，**同一个会话**再发「查一下知识库里的 X」。
   Expected: agent 说出「知识库未连接，请先登录」之类的引导文本，**不是**报错卡死。
5. 登录过期场景（可选）：手改 `~/.aide/knowledge.json` 里的 token 成垃圾值，同会话再查。
   Expected: 出现「登录已失效，请重新登录」引导；回面板重新登录后**同会话**再查 → 恢复正常（这条验的就是「现读凭据」的设计目标）。

- [ ] **Step 5: 分支对账 + 提交**

按 Global Constraints 出**分支对账表**（分支 | 覆盖 | 测试名），把结果回填到 spec 的附录 B，然后：

```bash
git add agent-sidecar/smoke-mcp.ts docs/superpowers/specs/2026-09-13-knowledge-mcp-design.md
git commit -m "test(knowledge): 冒烟采纳率段 + 读通路分支对账"
```

---

## 完成判据（P1）

- `npx vitest run`（根）与 `cd agent-sidecar && npx vitest run` 全绿。
- `cd src-tauri && cargo check` 通过，`pnpm check:sync-io` 通过。
- `pnpm build` 通过（含 `vue-tsc --noEmit`）。
- 手工验收 4 条全过（含「重新登录后同会话自愈」）。
- spec 附录 B 的分支对账表已回填，无空行。
- P2（写通路）未开始——那是下一个计划。
