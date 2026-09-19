# Agent LSP 工具 C1b（sidecar 侧）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent 真正拿到四个 LSP 工具——按语言服务器配置挂载、带显式状态文案、会话早期预热。

**Architecture:** 照 `codegraphClient.ts` / `codegraphTools.ts` 逐字同构。工具挂在 MCP server `aide-lsp` 上，四档闸门任一不满足就**不挂载**（返回 null），工具对模型不存在；查询经 `emit({type:"lsp_query"})` 走既有事件通道，主进程回 `{cmd:"lsp_result"}` 按 request_id 结算。

**Tech Stack:** TypeScript / Node / `@anthropic-ai/claude-agent-sdk` 的 `createSdkMcpServer` / zod

**Spec:** [docs/superpowers/specs/2026-09-19-agent-lsp-tool-design.md](../specs/2026-09-19-agent-lsp-tool-design.md)
**前置:** C1a（Rust 侧）已完成，帧契约与状态词已冻结

## Global Constraints

- **红线：任何情况下不得用空数组冒充「没有引用」。** `ready` + 空才是可信的「没有」；其余状态一律明确说「未验证/重试/退回 Grep」。
- **失败路径返回文本而非抛错**（沿 codegraph 约定）——工具永远返回 `textResult(...)`，绝不 throw。
- **单次工具结果目标 ≤2KB**，超出截断并如实标注（沿 codegraph 的输出纪律）。
- **`UserMessageBlock` 式的双份定义警觉**：本计划新增的状态词表若与 Rust 侧漂移，会**静默降级**。状态词必须与 `src-tauri/src/lsp/agent_status.rs` 的 `as_str()` 逐字一致，并由测试钉住。
- 测试命令：`cd agent-sidecar && npx vitest run <file>`。
- 改完 sidecar 要 `npm run build` 才进 dist；进安装版还需 `build:bin`。

## 帧契约（C1a 已定，勿改）

sidecar → Rust（事件）：`{ type:"lsp_query", request_id, tool, args, workspace_root }`
Rust → sidecar（命令）：`{ cmd:"lsp_result", request_id, ok, status, results?, count?, error? }`

**状态词八态**：`ready` / `indexing` / `no_symbol` / `no_server` / `untrusted` / `timeout` / `gone` / `error`
**工具名四个**：`symbols` / `references` / `definition` / `implementations`

---

### Task 1: 查询桥 `extensions/lspClient.ts`

**Files:**
- Create: `agent-sidecar/src/extensions/lspClient.ts`
- Test: `agent-sidecar/src/extensions/lspClient.test.ts`

**Interfaces:**
- Consumes: `ChatEvent`（`../engine/types.js`）
- Produces:
  - `export type LspTool = "symbols" | "references" | "definition" | "implementations" | "warm"`
  - `export interface LspQueryResponse { ok: boolean; status: string; results?: unknown[]; count?: number; error?: string; timedOut?: boolean; cancelled?: boolean }`
  - `export function queryLsp(tool: LspTool, args: Record<string, unknown>, workspaceRoot: string, emit: (e: ChatEvent) => void): Promise<LspQueryResponse>`
  - `export function resolveLspResult(cmd: {...}): void`
  - `export function cancelAllLspQueries(reason: string): void`
  - `export const LSP_QUERY_TIMEOUT_MS = 120_000`

**超时值为什么是 120s 而不是 codegraph 的 10s**：冷启动实测 46–73 秒（见基线文档），且主进程侧还会跑一次就绪探测。10s 会让**每次冷启动查询都超时**，正好复现我们要消灭的失败。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from "vitest";
import { queryLsp, resolveLspResult, cancelAllLspQueries, LSP_QUERY_TIMEOUT_MS } from "./lspClient.js";
import type { ChatEvent } from "../engine/types.js";

describe("lspClient", () => {
  it("emit 出带 request_id 的 lsp_query 事件", async () => {
    const events: ChatEvent[] = [];
    const p = queryLsp("references", { name: "get" }, "/proj", (e) => events.push(e));
    expect(events).toHaveLength(1);
    const ev = events[0] as Record<string, unknown>;
    expect(ev.type).toBe("lsp_query");
    expect(ev.tool).toBe("references");
    expect(ev.workspace_root).toBe("/proj");
    expect(typeof ev.request_id).toBe("string");
    // 按 request_id 结算
    resolveLspResult({ request_id: ev.request_id as string, ok: true, status: "ready", results: [1] });
    await expect(p).resolves.toMatchObject({ ok: true, status: "ready" });
  });

  it("未知 request_id 静默丢弃（超时/取消后迟到）", () => {
    expect(() => resolveLspResult({ request_id: "nope", ok: true, status: "ready" })).not.toThrow();
  });

  it("cancelAll 让挂起查询立刻以 cancelled 结算", async () => {
    const p = queryLsp("symbols", { name: "x" }, "/proj", () => {});
    cancelAllLspQueries("session stopped");
    await expect(p).resolves.toMatchObject({ ok: false, cancelled: true, error: "session stopped" });
  });

  /// 冷启动实测 46–73s，超时预算必须显著高于它，否则每次冷启动查询都超时。
  it("超时预算够长（> 冷启动上界 73s）", () => {
    expect(LSP_QUERY_TIMEOUT_MS).toBeGreaterThan(73_000);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-sidecar && npx vitest run src/extensions/lspClient.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

照抄 `extensions/codegraphClient.ts` 的形状（读它对照），改三处：事件类型 `lsp_query`、超时 120s、字段 `workspace_root`。

```ts
// 与 codegraphClient 同构：emit 一个带 request_id 的事件出去，主进程处理后经命令通道
// 回 `lsp_result`，这里按 id 结算。
//
// 超时预算 120s（codegraph 是 10s）：冷启动实测 46–73s，主进程还要跑一次就绪探测。
// 10s 会让每次冷启动查询都超时——那正是本设计要消灭的失败模式。
import { randomUUID } from "crypto";
import type { ChatEvent } from "../engine/types.js";

export type LspTool = "symbols" | "references" | "definition" | "implementations" | "warm";
// `warm` 不是给模型的工具，是 sidecar 会话早期 fire-and-forget 的预热（见 Task 5）。

export interface LspQueryResponse {
  ok: boolean;
  status: string;
  results?: unknown[];
  count?: number;
  error?: string;
  timedOut?: boolean;
  cancelled?: boolean;
}

interface Pending {
  resolve: (r: LspQueryResponse) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();

export const LSP_QUERY_TIMEOUT_MS = 120_000;

export function queryLsp(
  tool: LspTool,
  args: Record<string, unknown>,
  workspaceRoot: string,
  emit: (e: ChatEvent) => void,
): Promise<LspQueryResponse> {
  const request_id = randomUUID();
  // 必须走 worker 的 emit（→ DeltaCoalescer → stdout），禁止直写 process.stdout。
  emit({ type: "lsp_query", request_id, tool, args, workspace_root: workspaceRoot } as ChatEvent);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(request_id);
      resolve({ ok: false, status: "timeout", timedOut: true, error: "timeout" });
    }, LSP_QUERY_TIMEOUT_MS);
    pending.set(request_id, { resolve, timer });
  });
}

export function resolveLspResult(cmd: {
  request_id: string;
  ok: boolean;
  status?: string;
  results?: unknown[];
  count?: number;
  error?: string;
}): void {
  const p = pending.get(cmd.request_id);
  if (!p) return; // 未知/已超时/已取消——静默丢弃
  pending.delete(cmd.request_id);
  clearTimeout(p.timer);
  p.resolve({
    ok: cmd.ok,
    status: cmd.status ?? (cmd.ok ? "ready" : "error"),
    results: cmd.results,
    count: cmd.count,
    error: cmd.error,
  });
}

/** 会话停止/中断时清掉本进程内所有挂起查询（request_id 全局唯一，无需按会话分）。 */
export function cancelAllLspQueries(reason: string): void {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, status: "error", cancelled: true, error: reason });
  }
  pending.clear();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent-sidecar && npx vitest run src/extensions/lspClient.test.ts`
Expected: 4 passed

- [ ] **Step 5: 提交**

```bash
git add agent-sidecar/src/extensions/lspClient.ts agent-sidecar/src/extensions/lspClient.test.ts
git commit -m "feat(lsp): sidecar 查询桥——request_id 配对 + 120s 超时"
```

---

### Task 2: 状态文案 `extensions/lspStatusText.ts`

**Files:**
- Create: `agent-sidecar/src/extensions/lspStatusText.ts`
- Test: `agent-sidecar/src/extensions/lspStatusText.test.ts`

**Interfaces:**
- Consumes: `LspQueryResponse`（Task 1）
- Produces: `export function formatLspResponse(tool: LspTool, resp: LspQueryResponse, args: Record<string, unknown>): string`

**这是红线所在的模块**：它是「空 ≠ 没有」在模型侧的最后一道关。每条分支都要能被单独审查。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { formatLspResponse } from "./lspStatusText.js";

const call = (status: string, extra: Record<string, unknown> = {}) =>
  formatLspResponse("references", { ok: status === "ready", status, ...extra }, { name: "get" });

describe("formatLspResponse —— 空 ≠ 没有（红线）", () => {
  /// 最要紧的一条：非 ready 状态下**任何**空结果都不许被说成「没有引用」。
  it("非 ready 的空结果绝不说「没有」", () => {
    for (const s of ["indexing", "timeout", "gone", "error", "no_server", "untrusted"]) {
      const text = call(s).toLowerCase();
      expect(text, `${s} 不该说 no references`).not.toMatch(/no references (found)?\.?$/);
      expect(text).toMatch(/grep/); // 每条都要给出退路
    }
  });

  it("ready + 空 = 可信的「没有」，且与未就绪措辞不同", () => {
    const text = call("ready", { results: [], count: 0 });
    expect(text).toMatch(/no references/i);
    expect(text).toMatch(/index is ready|索引就绪|confirmed/i);
  });

  it("indexing 明确说「空结果不代表没有」并要求重试", () => {
    const text = call("indexing");
    expect(text).toMatch(/index/i);
    expect(text).toMatch(/retry|重试/i);
    expect(text).toMatch(/not.{0,20}(mean|imply)|不代表|does not/i);
  });

  it("no_server 指向配置而不是让模型重试", () => {
    const text = call("no_server");
    expect(text).toMatch(/no language server|未配置/i);
    expect(text).toMatch(/grep/i);
  });

  it("有结果时列出行号且截断到 2KB 以内", () => {
    const results = Array.from({ length: 200 }, (_, i) => ({
      file_path: `/proj/src/a${i}.rs`, line: i + 1, column: 1,
    }));
    const text = formatLspResponse("references", { ok: true, status: "ready", results }, { name: "get" });
    expect(text).toContain(":1");           // 行号在
    expect(text.length).toBeLessThan(2048); // 截断生效
    expect(text).toMatch(/truncated|已截断|200/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-sidecar && npx vitest run src/extensions/lspStatusText.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

文案照 codegraph 的 `formatToolResponse` 风格（英文、给动作、指退路）。**状态词必须与 `src-tauri/src/lsp/agent_status.rs` 的 `as_str()` 逐字一致**。

```ts
// LSP 工具结果的文本化。**这个模块是「空 ≠ 没有」红线在模型侧的最后一关。**
//
// 状态词与 Rust 侧 src-tauri/src/lsp/agent_status.rs 的 as_str() 必须逐字一致：
// 漂移的后果是模型读到未知状态而按默认分支处理——**静默降级**，不报错。
// 改一边就要改另一边，lspStatusText.test.ts 钉住了这八个词。
import type { LspQueryResponse, LspTool } from "./lspClient.js";

const MAX_BYTES = 2048;

export function formatLspResponse(
  tool: LspTool,
  resp: LspQueryResponse,
  args: Record<string, unknown>,
): string {
  const what = String(args.name ?? args.file ?? "");
  if (!resp.ok && resp.status !== "ready") return notReadyText(resp, what);
  return okText(tool, resp, what);
}

/** 非 ready：**绝不说「没有」**，一律给退路。 */
function notReadyText(resp: LspQueryResponse, what: string): string {
  const head = `LSP could not answer the ${what ? `\`${what}\` ` : ""}query (status: ${resp.status}).`;
  switch (resp.status) {
    case "indexing":
      return `${head} The language server is still building its index. An empty result now does NOT mean "no references" — it means the question was not answered yet. Retry in ~30s, or fall back to Grep and say the result is unverified.`;
    case "no_symbol":
      return `${head} The index is ready but has no symbol with that name (check the spelling, or try the bare name without \`Type::\`). Fall back to Grep if you expected a hit.`;
    case "no_server":
      return `${head} No language server is configured for this workspace. Use Grep.`;
    case "untrusted":
      return `${head} This workspace is not trusted, so LSP is disabled. Use Grep.`;
    case "timeout":
    case "gone":
      return `${head} The server did not complete the request. Treat the result as unverified — use Grep to confirm.`;
    default:
      return `${head} ${resp.error ?? "unknown error"}. Use Grep and say the result is unverified.`;
  }
}

function okText(tool: LspTool, resp: LspQueryResponse, what: string): string {
  const results = (resp.results ?? []) as Array<Record<string, unknown>>;
  if (results.length === 0) {
    // 只有走到这里才允许说「没有」——status=ready 是前提。
    return `No ${label(tool)} found for \`${what}\` — the language server's index is ready, so this is a confirmed negative, not a missing answer.`;
  }
  const lines = results.map((r) => `  ${r.file_path}:${r.line}:${r.column ?? 1}`);
  return `${results.length} ${label(tool)} for \`${what}\`:\n${clamp(lines.join("\n"), results.length)}`;
}

function label(tool: LspTool): string {
  return { symbols: "symbols", references: "references", definition: "definition", implementations: "implementations" }[tool];
}

/** 按字节截断（结果进上下文，超预算就是长期成本）。截断要如实说。 */
function clamp(body: string, total: number): string {
  if (Buffer.byteLength(body, "utf8") <= MAX_BYTES) return body;
  const buf = Buffer.from(body, "utf8").subarray(0, MAX_BYTES);
  return `${buf.toString("utf8")}\n…(truncated — ${total} results total)`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent-sidecar && npx vitest run src/extensions/lspStatusText.test.ts`
Expected: 5 passed

- [ ] **Step 5: 提交**

```bash
git add agent-sidecar/src/extensions/lspStatusText.ts agent-sidecar/src/extensions/lspStatusText.test.ts
git commit -m "feat(lsp): 状态文案——空 ≠ 没有在模型侧的最后一关"
```

---

### Task 3: 工具注册 `extensions/lspTools.ts`

**Files:**
- Create: `agent-sidecar/src/extensions/lspTools.ts`
- Test: `agent-sidecar/src/extensions/lspTools.test.ts`

**Interfaces:**
- Consumes: Task 1/2；`createSdkMcpServer` / `tool` 来自 SDK（见 `codegraphTools.ts` 的 import）
- Produces:
  - `export const LSP_ALLOW_RULE = "mcp__aide-lsp"`（与 codegraph 的 `CODEGRAPH_ALLOW_RULE` 同款前缀规则）
  - `export interface LspToolsDeps { cwd: string; emit: (e: ChatEvent) => void; env: NodeJS.ProcessEnv; trusted: boolean; lspLanguages: string[] }`
  - `export function lspMcpRegistration(deps: LspToolsDeps): Record<string, unknown> | null`

  > **为什么是 deps 对象而不是 5 个位置参数**：5 个参数超「单函数 ≤4 输入」的红线。
  > 沿仓库既有的依赖束先例（`engine/session-worker/queryContext.ts` 的 `QueryContextDeps`、
  > `mapper.ts` 的 `MapperDeps`）——字段名在调用点可见，不存在相邻同型错位的风险。
  > 注：`codegraphMcpRegistration` 是 5 个位置参数，本计划**不**复制那个形状。

**四档闸门**（任一不满足 → 返回 `null`，server 不挂载，工具对模型不存在）：
1. `!trusted` → null
2. `lspLanguages.length === 0`（该工作区没有配得上 LSP 的语言，C1a 的 `lsp_languages_for_path` 算好下发）
3. `env.AIDE_LSP_TOOLS === "off"` → null
4. （隐含）`emit` 为 undefined → null（headless 无 Rust 宿主时注不进来）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from "vitest";
import { lspMcpRegistration, LSP_ALLOW_RULE } from "./lspTools.js";

const OK = { cwd: "/proj", emit: () => {}, env: {} as NodeJS.ProcessEnv, trusted: true, lspLanguages: ["rust"] };

describe("lspMcpRegistration 的四档闸门", () => {
  it("全满足 → 挂载四个工具", () => {
    const spec = lspMcpRegistration(OK);
    expect(spec).not.toBeNull();
    const names = JSON.stringify(spec);
    for (const t of ["lsp_symbols", "lsp_references", "lsp_definition", "lsp_implementations"]) {
      expect(names).toContain(t);
    }
  });

  it("未信任 → 不挂载", () => {
    expect(lspMcpRegistration({ ...OK, trusted: false })).toBeNull();
  });

  /// 没有配得上 LSP 的语言就别挂——工具 schema 每轮重发，白付 token 还会诱导模型
  /// 去调一个注定返回 no_server 的工具。
  it("该工作区没有配得上 LSP 的语言 → 不挂载", () => {
    expect(lspMcpRegistration({ ...OK, lspLanguages: [] })).toBeNull();
  });

  it("env AIDE_LSP_TOOLS=off → 不挂载（逃生舱，同 codegraph/docx 惯例）", () => {
    expect(lspMcpRegistration({ ...OK, env: { AIDE_LSP_TOOLS: "off" } as NodeJS.ProcessEnv }))
      .toBeNull();
  });

  it("放行前缀是工具级 server 前缀（与 codegraph 同款）", () => {
    expect(LSP_ALLOW_RULE).toBe("mcp__aide-lsp");
  });

  /// 工具描述要引导到**语义**问题上去，且说清何时别用（纯文本查找仍归 Grep）。
  it("描述里点明用途与边界", () => {
    const spec = JSON.stringify(lspMcpRegistration(OK));
    expect(spec).toMatch(/references/i);
    expect(spec).toMatch(/same name|ambiguous|disambiguat/i);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-sidecar && npx vitest run src/extensions/lspTools.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

照抄 `extensions/codegraphTools.ts` 的形状（读它对照：`createSdkMcpServer` → `{ name, version, instructions, tools }`，每个 `tool(name, description, zodSchema, handler)`），`handler` 里调 `queryLsp` + `formatLspResponse` + `textResult`。

**工具描述要点**（codegraph 的实证：描述决定用法）：
- 都强调「当符号名有歧义/烂大街时用这个，一次调用替代 grep-then-read 扇出」
- `lsp_references` 明确写「返回的是编译器级精确引用，不含注释/字符串里的同名文本」
- 都写「纯文本/配置/日志查找仍用 Grep」

`instructions` 字段（SDK 的 server 级说明）写一段：本 server 的查询会等待索引就绪，冷启动可能几十秒；返回的 status 决定可信度，**非 ready 的空结果不代表没有**；不确定时用 Grep 并标注未验证。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent-sidecar && npx vitest run src/extensions/lspTools.test.ts`
Expected: 6 passed

- [ ] **Step 5: 提交**

```bash
git add agent-sidecar/src/extensions/lspTools.ts agent-sidecar/src/extensions/lspTools.test.ts
git commit -m "feat(lsp): agent LSP 工具注册 + 四档挂载闸门"
```

---

### Task 4: 接线——命令分发、闸门数据、清理

**Files:**
- Modify: `agent-sidecar/src/engine/session-manager.ts`（`handleCommand` 加一路分派）
- Modify: `agent-sidecar/src/engine/types.ts`（`send` 命令加 `lsp_languages?: string[]`）
- Modify: `agent-sidecar/src/engine/session-worker.ts`（接收 → `startLoop`；两处 `cancelAll`）
- Modify: `agent-sidecar/src/engine/session-worker/queryContext.ts`（deps + 注册调用）
- Modify: `src-tauri/src/commands/chat.rs:343` 与 `src-tauri/src/automation/scheduler.rs:369,1020`（三处构造点加 `lsp_languages`）

**Interfaces:**
- Consumes: Task 1/3；C1a 的 `commands::workspace::lsp_languages_for_path(app, workspace_root)`
- Produces: 端到端通路

- [ ] **Step 1: 命令分发**

`session-manager.ts` 的 `handleCommand` 里，`codegraph_result` / `browser_result` 之后加：

```ts
    // LSP MCP 工具的 Rust 回包：同 codegraph，按 request_id 结算，无会话路由。
    if (cmd.cmd === "lsp_result") {
      resolveLspResult(cmd);
      return;
    }
```

- [ ] **Step 2: 闸门数据下发**

`engine/types.ts` 的 send 命令加字段（紧邻 `codegraph_enabled?: boolean;`）：
```ts
      /** 该工作区配得上 LSP 的语言（主进程 lsp_languages_for_path 算好；空数组 = 不挂工具）。 */
      lsp_languages?: string[];
```

Rust 三处构造点各加一行（紧邻 `codegraph_enabled`）：
```rust
cmd["lsp_languages"] = json!(crate::commands::workspace::lsp_languages_for_path(&app, &cwd));
```
> `chat.rs:343` 与 `scheduler.rs` 两处的 `app` 取用方式不同，**照各自文件里已有的 `is_codegraph_enabled_for_path` 调用怎么拿上下文**。`scheduler.rs` 是纯函数区（注释明说「政策读属外壳，不进纯函数」）——若那里拿不到 app，把 `lsp_languages` 作为参数由调用方（外壳）算好传入，与 `codegraph_enabled` 同款处理。

- [ ] **Step 3: worker 接收 + 清理**

`session-worker.ts:696` 改为：
```ts
      this.startLoop(cmd.cwd ?? this.cwd, cmd.trusted !== false, cmd.codegraph_enabled === true, cmd.lsp_languages ?? []);
```
`startLoop` 签名加第四个参数（默认 `[]`），透传到 `queryContext` 的 deps。

两处清理（586 行 interrupted、1203 行 session stopped）各加：
```ts
      cancelAllLspQueries("interrupted");   // 1203 那处用 "session stopped"
```

- [ ] **Step 4: queryContext 注册**

```ts
  const lspMcp = lspMcpRegistration({
    cwd: deps.cwd, emit: deps.emit, env: deps.processEnv,
    trusted: deps.trusted, lspLanguages: deps.lspLanguages,
  });
```
并把它并入 `assembleMcpServers` 的内建那组（与 `codegraphMcp` 并列）。

- [ ] **Step 5: 测试 + 提交**

Run: `cd agent-sidecar && npx vitest run src/engine` —— **全部既有测试必须仍绿**（这是唯一能证明接线没碰坏 codegraph/browser 两路的地方）。

```bash
git add agent-sidecar/src src-tauri/src
git commit -m "feat(lsp): 接线——lsp_result 分发、闸门数据下发、会话清理"
```

---

### Task 5: 预热

**Files:**
- Modify: `src-tauri/src/lsp/agent_query.rs`（新增 `warm` 工具分支：只 ensure + 探测，不查询）
- Modify: `agent-sidecar/src/engine/session-worker.ts`（首条 send 后 fire-and-forget 一次预热）

**为什么必须有**：冷启动 46–73 秒，而 `probe_ready` 的预算是 30 秒。没有预热，agent 第一次查 LSP 时探测必然超预算 → 返回 `indexing` → 模型退回 Grep，**整条链白建**。预热的全部意义是把这段时间挪到「用户读题/打字」期间。

- [ ] **Step 1: Rust 侧 `warm` 分支**

在 `run_agent_query` 的 tool 分派处加：
```rust
        // 预热：只确保 server 起来并等到就绪，不执行查询。供 sidecar 在会话早期
        // fire-and-forget 调用——把 46–73s 的冷启动挪出 agent 的关键路径。
        "warm" => return warm_only(app, state, &langs, workspace_root).await,
```
`warm_only`：对每个语言 `ensure_lang`，成功则跑一次 `probe_ready`（复用既有函数），返回 `{ok, status}`。**不做查询。**

- [ ] **Step 2: sidecar 侧触发**

`session-worker.ts` 的首条 send 处理里（`startLoop` 之后、prompt 下发之前），条件满足时 fire-and-forget：

```ts
    // 会话早期预热语言服务器：冷启动 46–73s，等到 agent 真要用 LSP 时早已就绪。
    // fire-and-forget——预热失败不影响对话，只让后续查询返回 no_server。
    if (!this.lspWarmed && lspLanguages.length > 0) {
      this.lspWarmed = true; // 只预热一次
      void queryLsp("warm" as LspTool, {}, cwd, (e) => this.emit(e));
    }
```
> `warm` 已在 Task 1 的 `LspTool` 联合类型里，无需再改。

- [ ] **Step 3: 测试 + 提交**

Run: `cd agent-sidecar && npx vitest run src/engine src/extensions`
Run: `cd src-tauri && cargo test --lib lsp::`

```bash
git add agent-sidecar/src src-tauri/src
git commit -m "feat(lsp): 会话早期预热——把 46-73s 冷启动挪出关键路径"
```

---

### Task 6: 端到端验收

**Files:**
- Modify: `docs/superpowers/spikes/2026-09-19-lsp-agent-tools/run-lsp-ab.sh`（加一个「名字有歧义」的任务变体）
- Modify: `docs/superpowers/spikes/2026-09-19-lsp-agent-tools/README.md`（补 C1 验收结果）

**判据**（spec 定的）：歧义任务上，LSP 组应给出**精确的调用点集合**，且调用次数不劣于 Grep 组。

- [ ] **Step 1: 加任务变体**

`run-lsp-ab.sh` 里加 `TASK_AMBIGUOUS`（`LspManager::get` 的调用点——裸 `.get(` 有 547 处噪音，接收者变量名 `mgr` 只能靠读代码得到），并接受 `--task` 参数切换。

- [ ] **Step 2: 跑三方对照**

```bash
./run-lsp-ab.sh control c1-control --task ambiguous
./run-lsp-ab.sh hint    c1-hint    --task ambiguous
```
外加手工确认：装好 C1 的构建上，`aide-lsp` 的四个工具在工具列表里出现，且 `mcp__aide-lsp__lsp_references` 能返回调用点。

- [ ] **Step 3: 记录**

README 补一节「C1 端到端验收」，写清：任务、工具可用性、LSP 与 Grep 各自的调用次数与正确性、**以及是否真的优于 Grep**（若没有，如实写——这正是当初决定不做「LSP 优先」引导的依据）。

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/spikes/
git commit -m "docs(lsp): C1 端到端验收结果"
```

---

## 验收（C1b 完成时）

- [ ] `cd agent-sidecar && npx vitest run` 全绿
- [ ] `cd agent-sidecar && npm run typecheck` 干净
- [ ] `cd src-tauri && cargo test --lib` 全绿
- [ ] 端到端：新会话里 `aide-lsp` 工具出现在工具列表；歧义任务上 LSP 给出精确调用点
- [ ] `cd agent-sidecar && npm run build` 产物含 `lsp_query`（`grep -c lsp_query dist/runtime.js`）

## 未决

1. **`probe_ready` 的 30s 预算**在无预热的路径上偏低（冷启动 46–73s）。Task 5 落地后不再是问题；若预热失败，第一次真查询会返回 `indexing`（安全但无用）。是否要把它提到 90s 由 Task 6 的实测决定。
2. **远程/headless**：headless 没有 Rust 宿主 → `lsp_query` 永远收不到回包 → 120s 后超时 → 工具返回「unverified，用 Grep」。安全但慢；若 headless 真的会用，应改成**在注册处就不挂**（判据：emit 是否可用）。 Task 3 的第四档闸门已留口子。
