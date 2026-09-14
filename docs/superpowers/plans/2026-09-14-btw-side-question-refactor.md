# btw 塌缩为官方 side_question 单路径 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 btw 从「三分支 + 每次提问新建 claude.exe」塌缩为「一条 `btw_ask` 命令 → 主 worker 进程内 `askSideQuestion` → 广播 `btw_answer`」，实测延迟从 ~8s 降到 ~1.6s。

**Architecture:** 前端 invoke `btw_ask` → Rust 组 JSON 下发 Runtime → sidecar `SessionManager` **查（不建）** 主 worker → `worker.askSideQuestion()` 调 SDK 控制通道 RPC → 结果经事件通道广播给所有客户端，RPC 返回值只表成败。

**Tech Stack:** TypeScript（agent-sidecar，vitest）、Vue 3 + `@aide/sdk`（pnpm workspace）、Rust/Tauri v2。

**Spec:** [docs/superpowers/specs/2026-09-14-btw-side-question-refactor-design.md](../specs/2026-09-14-btw-side-question-refactor-design.md)

## Global Constraints

- **不改 `@aide/sdk` 里的共享代码直接 import `@tauri-apps/*`**；命令一律走 `api.ts` 门面（`getTransport().invoke`）。
- **UI 状态只认事件通道**：任何改变 UI 的结果都必须广播事件，不允许只靠 RPC 返回值。
- **TS 零 `any`**（`unknown` + 收窄）；禁空 catch。
- **sidecar 改源码后必须 build**（`pnpm build:sidecar` 或仓库既有构建脚本）才能被 dev 进程加载——只改 `agent-sidecar/src/` 不生效。
- **Rust 命令一律 async**；不新增同步命令（否则要埋 `trace_command`，见 CLAUDE.md）。
- **`Command::new` 必带 `CREATE_NO_WINDOW`** ——本计划不新增任何子进程调用，仅在测试里用到命令时遵守。
- 提交信息用仓库既有风格（`feat(...)` / `refactor(...)` / `chore(...)`，中文正文）。

## File Structure

| 文件 | 职责 | 本计划动作 |
|---|---|---|
| `agent-sidecar/src/engine/types.ts` | chat-event 协议真相源 | 新增 `btw_answer` 事件变体 |
| `agent-sidecar/src/engine/stdoutFrames.ts` | 背压可丢弃策略 | 不加（`btw_answer` 不可丢） |
| `agent-sidecar/src/engine/session-worker.ts` | 单会话 query 生命周期 | 新增 `askSideQuestion()` |
| `agent-sidecar/src/engine/session-manager.ts` | 会话路由 | 新增 `askSideQuestion()`（查不建） |
| `agent-sidecar/src/headless-schema.ts` | 对外命令契约 | 新增 `btw_ask`，删 4 个旧字段 |
| `packages/aide-sdk/src/api.ts` | 命令门面 | 加 `btwAsk`，删 `startBtwSession` |
| `packages/aide-sdk/src/composables/useBtwSession.ts` | btw store 与事件处理 | 塌缩为 await + 单事件 |
| `src-tauri/src/commands/chat.rs` | Tauri 命令 | 加 `btw_ask`，删 `start_btw_session` |
| `src-tauri/src/remote/rpc.rs` + `rpc/handlers.rs` | 远程白名单 | 换行 + 换 handler |
| `src-tauri/src/lib.rs` | 命令注册 | 换名 |

---

### Task 1: `btw_answer` 事件进协议真相源

**Files:**
- Modify: `agent-sidecar/src/engine/types.ts`（`ChatEvent` 联合末尾，约 243 行 `session_title` 附近）
- Test: `agent-sidecar/src/engine/stdoutFrames.test.ts`

**Interfaces:**
- Produces: `ChatEvent` 变体（**worker 侧形状**，`session_id` 由 `SessionManager.emitToStdout` 注入后才是线上帧）：
  `{ type:"btw_answer"; sessionId:string; question:string; response?:string; error?:string; synthetic?:boolean }`

- [ ] **Step 1: 写失败测试**

在 `agent-sidecar/src/engine/stdoutFrames.test.ts` 追加（文件已存在，沿用其 import 风格）：

```ts
describe("btw_answer 背压策略", () => {
  it("是不可丢弃事件——背压期间丢一条就少一个答案", () => {
    expect(
      isDroppableEvent({
        type: "btw_answer",
        session_id: "s1",
        question: "q",
        response: "a",
      } as ChatEvent),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-sidecar && npx vitest run src/engine/stdoutFrames.test.ts -t "btw_answer"`
Expected: FAIL — 类型错误（`btw_answer` 不在 `ChatEvent` 联合里）

- [ ] **Step 3: 加事件变体**

`agent-sidecar/src/engine/types.ts`，在 `| { type: "session_title"; title: string }` 之后插入：

```ts
  // btw 侧问（官方 side_question 通道）的一次问答结果。session_id 是**主会话** id，
  // 前端据此把事件路由到对应会话的抽屉；question 用于同一会话多条 btw 之间消歧。
  // response 与 error 互斥；synthetic=true 表示官方兜底答复（渲染但不入历史）。
  | {
      type: "btw_answer";
      /** worker 自己的 routingKey；stdout 帧的 session_id 由 manager 注入。 */
      sessionId: string;
      question: string;
      response?: string;
      error?: string;
      synthetic?: boolean;
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent-sidecar && npx vitest run src/engine/stdoutFrames.test.ts -t "btw_answer"`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add agent-sidecar/src/engine/types.ts agent-sidecar/src/engine/stdoutFrames.test.ts
git commit -m "feat(btw): btw_answer 事件进 chat-event 协议（不可丢弃）"
```

---

### Task 2: `SessionWorker.askSideQuestion()`

**Files:**
- Modify: `agent-sidecar/src/engine/session-worker.ts`（新增 public 方法，放在 `stop()` 之前）
- Test: `agent-sidecar/src/engine/session-worker.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `btw_answer` 事件
- Produces:
  - `type BtwHistoryRound = { question: string; response: string }`
  - `SessionWorker.askSideQuestion(question: string, history: BtwHistoryRound[]): Promise<{ ok: true } | { ok: false; reason: string }>`

- [ ] **Step 1: 写失败测试**

追加到 `agent-sidecar/src/engine/session-worker.test.ts`：

```ts
describe("SessionWorker — btw 侧问", () => {
  it("没有存活 query 时拒绝，且不发事件", async () => {
    const { worker, events } = makeWorker("btw-guard-1");
    const r = await worker.askSideQuestion("问一句", []);
    expect(r.ok).toBe(false);
    expect(events).toEqual([]);
  });

  it("SDK 句柄缺 askSideQuestion（版本漂移）时拒绝并广播 error", async () => {
    const events: ChatEvent[] = [];
    // 假句柄：可迭代（startLoop 需要）+ 没有任何 askSideQuestion 方法
    const fakeQuery = (async function* () {
      await new Promise(() => {});
      // eslint-disable-next-line no-unreachable
      yield {};
    })();
    const worker = new SessionWorker("btw-guard-2", (e) => events.push(e), {
      queryFn: (() => fakeQuery) as any,
    });
    void worker.startLoop();
    await flushPromises();

    const r = await worker.askSideQuestion("问一句", []);
    expect(r.ok).toBe(false);
    const ans = events.filter((e) => e.type === "btw_answer");
    expect(ans).toHaveLength(1);
    expect((ans[0] as any).error).toContain("引擎不支持");
  });

  it("成功路径：广播 response，返回值不含正文", async () => {
    const events: ChatEvent[] = [];
    const fakeQuery = (async function* () {
      await new Promise(() => {});
      // eslint-disable-next-line no-unreachable
      yield {};
    })();
    (fakeQuery as any).askSideQuestion = async (q: string, opts: any) => {
      expect(q).toBe("问一句");
      expect(opts).toEqual({ history: [{ question: "旧问", response: "旧答" }] });
      return { response: "答案是石榴", synthetic: false };
    };
    const worker = new SessionWorker("btw-ok", (e) => events.push(e), {
      queryFn: (() => fakeQuery) as any,
    });
    void worker.startLoop();
    await flushPromises();

    const r = await worker.askSideQuestion("问一句", [{ question: "旧问", response: "旧答" }]);
    expect(r).toEqual({ ok: true }); // ← 不含 response 字段
    const ans = events.filter((e) => e.type === "btw_answer") as any[];
    expect(ans).toHaveLength(1);
    expect(ans[0]).toMatchObject({
      question: "问一句",
      response: "答案是石榴",
      synthetic: false,
    });
    // session_id 由 SessionManager.emitToStdout 注入，worker 侧只在事件里带上
    // 自己的 sessionId（这里断言的是 worker 事件，不是 stdout 帧）
    expect(ans[0].sessionId).toBe("btw-ok");
  });

  it("空 history 不传 history 参数（对齐官方：不传就没有连续性）", async () => {
    const events: ChatEvent[] = [];
    const fakeQuery = (async function* () {
      await new Promise(() => {});
      // eslint-disable-next-line no-unreachable
      yield {};
    })();
    let sawOpts: unknown = "unset";
    (fakeQuery as any).askSideQuestion = async (_q: string, opts: any) => {
      sawOpts = opts;
      return { response: "ok", synthetic: false };
    };
    const worker = new SessionWorker("btw-nohistory", (e) => events.push(e), {
      queryFn: (() => fakeQuery) as any,
    });
    void worker.startLoop();
    await flushPromises();

    await worker.askSideQuestion("问一句", []);
    expect(sawOpts).toBeUndefined();
  });

  it("synthetic 兜底答复照常广播并标记", async () => {
    const events: ChatEvent[] = [];
    const fakeQuery = (async function* () {
      await new Promise(() => {});
      // eslint-disable-next-line no-unreachable
      yield {};
    })();
    (fakeQuery as any).askSideQuestion = async () => ({
      response: "兜底答复",
      synthetic: true,
    });
    const worker = new SessionWorker("btw-synth", (e) => events.push(e), {
      queryFn: (() => fakeQuery) as any,
    });
    void worker.startLoop();
    await flushPromises();

    await worker.askSideQuestion("问一句", []);
    const ans = events.filter((e) => e.type === "btw_answer") as any[];
    expect(ans[0].synthetic).toBe(true);
  });

  it("SDK 返回 null 时广播 error", async () => {
    const events: ChatEvent[] = [];
    const fakeQuery = (async function* () {
      await new Promise(() => {});
      // eslint-disable-next-line no-unreachable
      yield {};
    })();
    (fakeQuery as any).askSideQuestion = async () => null;
    const worker = new SessionWorker("btw-null", (e) => events.push(e), {
      queryFn: (() => fakeQuery) as any,
    });
    void worker.startLoop();
    await flushPromises();

    const r = await worker.askSideQuestion("问一句", []);
    expect(r.ok).toBe(false);
    const ans = events.filter((e) => e.type === "btw_answer") as any[];
    expect(ans[0].error).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-sidecar && npx vitest run src/engine/session-worker.test.ts -t "btw 侧问"`
Expected: FAIL — `worker.askSideQuestion is not a function`

- [ ] **Step 3: 实现**

`agent-sidecar/src/engine/session-worker.ts`：在文件顶部类型区加

```ts
/** btw 跨问历史的一条问答（线上形状与官方 side_question 的 history 元素同形）。 */
export type BtwHistoryRound = { question: string; response: string };

/** 侧问结果：只表成败，正文一律走 btw_answer 事件（UI 状态只认事件通道）。 */
export type AskSideQuestionResult = { ok: true } | { ok: false; reason: string };
```

在 `stop()` 方法之前加（保持与 `interrupt` 等同层的 public 方法顺序）：

```ts
  /** btw 侧问：走主 query 的官方 side_question 控制通道，进程内完成，不起新进程。
   *
   *  正文不进返回值——统一经 btw_answer 广播，三端渲染同一条事件（多端一致性红线）。
   *  守卫是运行时必需：askSideQuestion 在 sdk.d.ts 里零类型（只在 sdk.mjs 运行时
   *  存在，0.3.252 实测），SDK 升级改名/移除时这里必须报错而不是崩。 */
  async askSideQuestion(
    question: string,
    history: BtwHistoryRound[],
  ): Promise<AskSideQuestionResult> {
    const q = this.currentQuery as
      | (NonNullable<typeof this.currentQuery> & {
          askSideQuestion?: (
            question: string,
            opts?: { history?: BtwHistoryRound[] },
          ) => Promise<{ response: string; synthetic?: boolean } | null>;
        })
      | null;
    const emitAnswer = (payload: { response?: string; error?: string; synthetic?: boolean }) =>
      this.emit({
        type: "btw_answer",
        session_id: this.routingKey,
        question,
        ...payload,
      });

    if (typeof q?.askSideQuestion !== "function") {
      const reason = "当前引擎不支持侧问（会话未运行或 SDK 版本漂移）";
      emitAnswer({ error: reason });
      return { ok: false, reason };
    }

    try {
      const r = await q.askSideQuestion(question, history.length ? { history } : undefined);
      if (!r?.response) {
        const reason = "模型没有给出答复";
        emitAnswer({ error: reason });
        return { ok: false, reason };
      }
      emitAnswer({ response: r.response, synthetic: r.synthetic ?? false });
      return { ok: true };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      emitAnswer({ error: reason });
      return { ok: false, reason };
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent-sidecar && npx vitest run src/engine/session-worker.test.ts -t "btw 侧问"`
Expected: PASS（5 条）

- [ ] **Step 5: 提交**

```bash
git add agent-sidecar/src/engine/session-worker.ts agent-sidecar/src/engine/session-worker.test.ts
git commit -m "feat(btw): SessionWorker.askSideQuestion 走官方 side_question 通道"
```

---

### Task 3: `SessionManager.askSideQuestion()`（查，不建）

**Files:**
- Modify: `agent-sidecar/src/engine/session-manager.ts`
- Test: `agent-sidecar/src/engine/session-manager.test.ts`（若不存在则创建）

**Interfaces:**
- Consumes: `SessionWorker.askSideQuestion`（Task 2）
- Produces: `SessionManager.askSideQuestion(sessionId: string, question: string, history: BtwHistoryRound[]): Promise<AskSideQuestionResult>`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from "vitest";
import { SessionManager } from "./session-manager.js";

describe("SessionManager — btw 侧问路由", () => {
  it("worker 不存在时拒绝（查而不建）", async () => {
    const mgr = new SessionManager({ emit: () => {} });
    const r = await mgr.askSideQuestion("不存在的会話", "问一句", []);
    expect(r.ok).toBe(false);
    // 关键：不得凭空创建 worker
    expect(mgr.getAllWorkers().size).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-sidecar && npx vitest run src/engine/session-manager.test.ts`
Expected: FAIL — `mgr.askSideQuestion is not a function`

- [ ] **Step 3: 实现**

在 `session-manager.ts` 的 `stopSession` 之后加：

```ts
  /** btw 侧问：**只查不建**。主 worker 不存在（新会话未发消息 / 用户停过 / 进程崩过）
   *  就直接拒绝——不起兜底 worker（设计决策 D2：那条老路同样冷启动，不值得养）。 */
  async askSideQuestion(
    sessionId: string,
    question: string,
    history: BtwHistoryRound[],
  ): Promise<AskSideQuestionResult> {
    const worker = this.workers.get(sessionId);
    if (!worker) {
      return { ok: false, reason: "会话未运行，先发一条消息再问" };
    }
    return worker.askSideQuestion(question, history);
  }
```

import 补：

```ts
import type { AskSideQuestionResult, BtwHistoryRound } from "./session-worker.js";
```

（`SessionWorker` 已是值导入，类型可从同模块取。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent-sidecar && npx vitest run src/engine/session-manager.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add agent-sidecar/src/engine/session-manager.ts agent-sidecar/src/engine/session-manager.test.ts
git commit -m "feat(btw): SessionManager 侧问路由（查而不建，无 worker 即拒）"
```

---

### Task 4: sidecar 命令入口 `btw_ask`

**Files:**
- Modify: `agent-sidecar/src/engine/types.ts`（`SidecarCommand` 联合）
- Modify: `agent-sidecar/src/engine/session-manager.ts`（`handleCommand` 分派）
- Modify: `agent-sidecar/src/headless-schema.ts`（新命令 schema）
- Test: `agent-sidecar/src/engine/session-manager.test.ts`

**Interfaces:**
- Consumes: `SessionManager.askSideQuestion`（Task 3）
- Produces: 命令形状 `{ cmd:"btw_ask"; session_id:string; question:string; history?: {question,response}[] }`

- [ ] **Step 1: 写失败测试**

追加到 `session-manager.test.ts`：

```ts
it("btw_ask 命令走侧问路由（无 worker → 拒绝）", async () => {
  const mgr = new SessionManager({ emit: () => {} });
  const r = await mgr.handleBtwAsk({
    cmd: "btw_ask",
    session_id: "nope",
    question: "问一句",
  } as any);
  expect(r.ok).toBe(false);
  expect(mgr.getAllWorkers().size).toBe(0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-sidecar && npx vitest run src/engine/session-manager.test.ts -t "btw_ask"`
Expected: FAIL — `mgr.handleBtwAsk is not a function`

- [ ] **Step 3: 实现**

`types.ts` 的 `SidecarCommand` 联合里加：

```ts
  // btw 侧问（官方 side_question 通道）。与 send 的区别：不走 getOrCreate，
  // 主 worker 不存在即拒；且不需要 cwd/env 等装配参数（复用存活 query 的）。
  | {
      cmd: "btw_ask";
      session_id: string;
      question: string;
      history?: { question: string; response: string }[];
    }
```

`session-manager.ts` 加方法（`handleCommand` 保持 void 语义不变，`btw_ask` 由独立入口消费，因为它需要返回值）：

```ts
  /** btw_ask 命令入口（唯一带返回值的命令）。 */
  async handleBtwAsk(
    cmd: Extract<SidecarCommand, { cmd: "btw_ask" }>,
  ): Promise<AskSideQuestionResult> {
    if (!cmd.session_id) return { ok: false, reason: "缺少 session_id" };
    return this.askSideQuestion(cmd.session_id, cmd.question, cmd.history ?? []);
  }
```

`headless-schema.ts` 加命令 schema 并在 `INVOKABLE_COMMANDS` 对账表注册（与既有 10 命令同法）：

```ts
const btwAskCommand = z.looseObject({
  cmd: z.literal("btw_ask"),
  session_id: sid,
  question: z.string().min(1),
  history: z
    .array(z.looseObject({ question: z.string(), response: z.string() }))
    .max(20)
    .optional(),
});
```

- [ ] **Step 4: 跑测试确认通过 + 对账用例**

Run: `cd agent-sidecar && npx vitest run src/engine/session-manager.test.ts src/headless-server.test.ts`
Expected: PASS（含命令清单对账用例——新增命令必须同步 `headless-server.ts` 的 `INVOKABLE_COMMANDS`）

- [ ] **Step 5: 提交**

```bash
git add agent-sidecar/src/engine/types.ts agent-sidecar/src/engine/session-manager.ts \
        agent-sidecar/src/headless-schema.ts agent-sidecar/src/headless-server.ts \
        agent-sidecar/src/engine/session-manager.test.ts
git commit -m "feat(btw): btw_ask 命令入口 + headless 契约登记"
```

---

### Task 5: 命令面切换 `start_btw_session` → `btw_ask`

**Files:**
- Modify: `packages/aide-sdk/src/api.ts`（DTO + 门面方法）
- Modify: `src-tauri/src/commands/chat.rs`（新增命令、删除旧命令）
- Modify: `src-tauri/src/lib.rs:559`（注册换名）
- Modify: `src-tauri/src/remote/rpc.rs:58`、`src-tauri/src/remote/rpc/handlers.rs`（远程白名单换名）

**Interfaces:**
- Consumes: 命令形状（Task 4）
- Produces:
  - `api.btwAsk({ sessionId, question, history }): Promise<{ ok: boolean; reason?: string }>`
  - Rust 命令 `btw_ask(session_id, question, history) -> Result<(), String>`

- [ ] **Step 1: 加门面方法（前端先接上）**

`packages/aide-sdk/src/api.ts`，替换 `StartBtwParams` 与 `startBtwSession`：

```ts
/** btw_ask 的完整负载（IPC 边界 DTO）。history 由发起端维护（封顶 20 轮）。 */
export interface BtwAskParams {
  sessionId: string;
  question: string;
  history: { question: string; response: string }[];
}
```

```ts
  /** btw 侧问（进程内 side_question）。正文经 btw_answer 事件广播回来，
   *  返回值只表成败——UI 状态一律以事件为准。 */
  btwAsk(params: BtwAskParams): Promise<{ ok: boolean; reason?: string }> {
    return getTransport().invoke("btw_ask", { ...params });
  },
```

（删除 `startBtwSession` 方法与其 `StartBtwParams` 接口。）

- [ ] **Step 2: Rust 侧新增命令**

`src-tauri/src/commands/chat.rs`：删除整个 `start_btw_session`（约 450-505 行），新增：

```rust
/// btw 侧问：进程内走官方 side_question 通道（不起新进程）。
/// 正文经 btw_answer 事件广播回所有客户端，本命令只负责下发与错误上报。
#[tauri::command]
pub async fn btw_ask(
    session_id: String,
    question: String,
    history: Option<Vec<serde_json::Value>>,
    runtime_mgr: State<'_, AgentRuntimeManager>,
) -> Result<(), String> {
    let mut cmd = json!({
        "cmd": "btw_ask",
        "session_id": session_id,
        "question": question,
    });
    if let Some(h) = history {
        if !h.is_empty() {
            cmd["history"] = json!(h);
        }
    }
    runtime_mgr.send_to_runtime(&cmd).await
}
```

- [ ] **Step 3: 注册与远程白名单换名**

- `src-tauri/src/lib.rs:559`：`commands::chat::start_btw_session` → `commands::chat::btw_ask`
- `src-tauri/src/remote/rpc.rs:58`：`("start_btw_session", handlers::start_btw_session)` → `("btw_ask", handlers::btw_ask)`
- `src-tauri/src/remote/rpc/handlers.rs`：替换 handler（含其 DTO 结构体）为——**照抄同文件 `stop_bg_task` 的形态**（`AppHandle` + `Value` + `BoxFuture`）：

```rust
/// btw_ask 参数 DTO（镜像前端 api.btwAsk）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BtwAskArgs {
    session_id: String,
    question: String,
    #[serde(default)]
    history: Option<Vec<Value>>,
}

pub fn btw_ask(app: AppHandle, params: Value) -> BoxFuture<'static, Result<Value, String>> {
    Box::pin(async move {
        let a: BtwAskArgs = parse(params)?;
        let runtime = app.state::<AgentRuntimeManager>();
        to_json(crate::commands::chat::btw_ask(a.session_id, a.question, a.history, runtime).await)
    })
}
```

**Rust 侧不做存活性校验**——"会话未运行"由 sidecar 判定（查不到 worker 即拒），Rust 保持哑管道。这也省掉为 runtime 新增查询方法。

- [ ] **Step 4: 编译**

Run: `cd src-tauri && cargo check`
Expected: 编译通过，无 `start_btw_session` 悬空引用

Run: `cd packages/aide-sdk && npx tsc --noEmit`
Expected: 通过（`useBtwSession` 尚未改，会报 `startBtwSession` 不存在——若报错，本步骤先跳到 Task 6 再回来）

- [ ] **Step 5: 提交**

```bash
git add packages/aide-sdk/src/api.ts src-tauri/src/commands/chat.rs src-tauri/src/lib.rs \
        src-tauri/src/remote/rpc.rs src-tauri/src/remote/rpc/handlers.rs
git commit -m "feat(btw): 命令面切换 start_btw_session → btw_ask"
```

---

### Task 6: `useBtwSession` 塌缩

**Files:**
- Modify: `packages/aide-sdk/src/composables/useBtwSession.ts`
- Modify: `packages/aide-sdk/src/composables/useChatSession.ts`（`sendBtw`）
- Test: `packages/aide-sdk/src/composables/useBtwSession.test.ts`（既有，改写）

**Interfaces:**
- Consumes: `api.btwAsk`（Task 5）、`btw_answer` 事件（Task 1）
- Produces:
  - `startBtw(opts: { ownerSid: string; question: string; model?: string; effort?: string }): Promise<void>`
  - `handleBtwAnswer(e: Record<string, unknown>): void`（对外只暴露这一个事件入口）

- [ ] **Step 1: 写失败测试**

改写 `useBtwSession.test.ts`，至少覆盖：

```ts
it("startBtw 用 ownerSid 调 btwAsk，不下发 promise 返回的正文", async () => {
  const calls: any[] = [];
  vi.spyOn(api, "btwAsk").mockImplementation(async (p: any) => {
    calls.push(p);
    return { ok: true };
  });
  await startBtw({ ownerSid: "sid-1", question: "问题" });
  expect(calls[0]).toEqual({ sessionId: "sid-1", question: "问题", history: [] });
  expect(store().messages).toEqual([]); // ← 正文一律等事件
});

it("btw_answer 事件才落正文，并按 question 匹配当前问题", async () => {
  await startBtwWithMockApi({ ownerSid: "sid-1", question: "问题" });
  handleBtwAnswer({ type: "btw_answer", session_id: "sid-1", question: "问题", response: "答案" });
  expect(store().messages.join("")).toBe("答案");
  expect(store().isBusy).toBe(false);
});

it("RPC 失败进 error 态", async () => {
  vi.spyOn(api, "btwAsk").mockRejectedValueOnce(new Error("会话未运行"));
  await startBtw({ ownerSid: "sid-1", question: "问题" });
  expect(store().error).toContain("会话未运行");
});

it("synthetic 答复渲染但不入历史", async () => {
  /* startBtw 后 handleBtwAnswer({... synthetic:true})；
     再 startBtw 第二次，断言第二次 calls[0].history 为空 */
});
```

**同时处置既有用例**（`useBtwSession.test.ts` 现有 20 条，逐条对照）：

| 既有用例 | 处置 |
|---|---|
| `isBtwSid false before start` | **删**（`isBtwSid` 已不存在） |
| `startBtw registers temp id; events route to store` | **改写**为"调 `btwAsk` 且不下发正文" |
| `message_stop assembles conclusion + calls onDone` | **改写**为 `btw_answer` 版本（含 `onDone` 批注断言） |
| `startBtw replaces existing btw (single instance)` | 保留（语义不变） |
| `cleanup kills process and clears id` | **删**（`cleanup` 已不存在） |
| `next btw prompt carries previous rounds' Q&A` | **改写**：断言第二次调用的 `history` 参数，而非 prompt 拼接 |
| `history is per owner session` | 保留（改断言点同上） |
| `empty/errored btw leaves no history` | 保留（改断言点同上） |
| `minimize hides drawer / reopen / error while minimized` | 保留（不依赖事件分流） |
| `task btw: no fork, tools/policy passthrough...` | **删**（任务支线已移除） |
| `rebindOwner follows temp→real rename` | 保留（抽屉绑定 + 记忆 key 仍需要） |
| `rebindOwner no-ops for unrelated ids` | 保留 |
| `answer over cap is tail-truncated in Q&A memory` | **删**（`BTW_ANSWER_CAP` 已移除） |
| `history rounds over cap drop oldest (keeps latest 20)` | 保留（唯一护栏，必须留） |
| `clearBtwHistory wipes owner memory` | 保留（改断言点：下一次 `history` 参数为空） |

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/aide-sdk && npx vitest run src/composables/useBtwSession.test.ts`
Expected: FAIL

- [ ] **Step 3: 改写实现**

`useBtwSession.ts` 的删除/保留：

- **删**：`btwTempId` / `btwRealId` / `isBtwSid` / `cleanup()` / `composePrompt()` / `handleBtwEvent` 的 `session_init|text_delta|message_stop|session_dead` 分支 / `taskId|taskLabel|taskIcon` 三个状态字段 / `BTW_ANSWER_CAP`
- **留**：`status` 状态机、`ownerSessionId`、`minimized`、`reopen`、`rebindOwner`、`onDoneCb`（批注回插）、`historyByOwner`（封顶 20）
- **改**：`startBtw` 改 async 调用门面；`handleBtwEvent` → `handleBtwAnswer`

核心实现：

```ts
async function startBtw(opts: { ownerSid: string; question: string; model?: string; effort?: string }) {
  resetState(opts.question);
  state.value.ownerSessionId = opts.ownerSid;
  state.value.model = opts.model ?? "";
  state.value.effort = opts.effort ?? "";
  try {
    await api.btwAsk({
      sessionId: opts.ownerSid,
      question: opts.question,
      // 注意形状转换：本地记忆是 {question, answer}，线上（官方 history 元素）是
      // {question, response}。别直接把本地数组丢过去。
      history: (historyByOwner.get(opts.ownerSid) ?? []).map((r) => ({
        question: r.question,
        response: r.answer,
      })),
    });
    state.value.status = "running"; // 正文等 btw_answer 事件；此处只表示命令已受理
  } catch (e) {
    state.value.isBusy = false;
    state.value.status = "error";
    state.value.error = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  }
}

/** btw_answer 事件：由 handleChatEvent 按 session_id 路由过来（主会话 id，非 btw 专属 id）。 */
function handleBtwAnswer(e: Record<string, unknown>) {
  if (e["session_id"] !== state.value.ownerSessionId) return;
  if (e["question"] !== state.value.question) return; // 同会话多条 btw 消歧
  const err = e["error"] as string | undefined;
  if (err) {
    state.value.isBusy = false;
    state.value.status = "error";
    state.value.error = err;
    state.value.minimized = false;
    return;
  }
  const answer = e["response"] as string;
  state.value.messages.push(answer);
  state.value.isBusy = false;
  state.value.done = true;
  state.value.status = "done";
  useCodeGraphProgress().scheduleRescan();
  const synthetic = e["synthetic"] === true;
  if (!synthetic && state.value.ownerSessionId) {
    const owner = state.value.ownerSessionId;
    const rounds = historyByOwner.get(owner) ?? [];
    rounds.push({ question: state.value.question, answer });
    if (rounds.length > BTW_HISTORY_ROUNDS_CAP) rounds.splice(0, rounds.length - BTW_HISTORY_ROUNDS_CAP);
    historyByOwner.set(owner, rounds);
  }
  const block: ActionBlock = {
    type: "action",
    actionId: "btw",
    label: state.value.question,
    icon: "↳",
    foldable: true,
    body: answer,
  };
  onDoneCb?.(block);
}
```

`useChatSession.ts` 的 `sendBtw` 相应简化（去掉 `forkFrom`/`lightweight`/`permissionMode`/`cwd`/`tempId`）：

```ts
await btw.startBtw({ ownerSid: sid, question: prompt, model: opts.model, effort: opts.effort });
```

（删除 `sendBtwTask` 整个函数与它导出的引用；`GIT_COMMIT_PROMPT` 常量一并删除。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/aide-sdk && npx vitest run src/composables/useBtwSession.test.ts src/composables/useChatSession`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/aide-sdk/src/composables/useBtwSession.ts \
        packages/aide-sdk/src/composables/useBtwSession.test.ts \
        packages/aide-sdk/src/composables/useChatSession.ts
git commit -m "refactor(btw): useBtwSession 塌缩为 await + 单事件，删事件分流与 prompt 拼接"
```

---

### Task 7: 事件路由接上（主会话 id 分派）

**Files:**
- Modify: `packages/aide-sdk/src/composables/useChatSession/events.ts:130-133`
- Test: `packages/aide-sdk/src/composables/useChatSession.test.ts`（或 events 的既有测试文件）

**Interfaces:**
- Consumes: `handleBtwAnswer`（Task 6）

- [ ] **Step 1: 写失败测试**

```ts
it("btw_answer 事件按主会话 id 路由到 btw store，不进主对话消息流", () => {
  const store = getStore("sid-1");
  const before = store.messages.length;
  startBtwForTest({ ownerSid: "sid-1", question: "问一句" });
  handleChatEvent({
    type: "btw_answer",
    session_id: "sid-1",
    question: "问一句",
    response: "答案",
  });
  expect(getStore("sid-1").messages.length).toBe(before + 1); // ← 只有批注那一条
  expect(useBtwSession().store.value.messages.join("")).toBe("答案");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/aide-sdk && npx vitest run src/composables/useChatSession`
Expected: FAIL — 事件被当普通事件处理或直接忽略

- [ ] **Step 3: 实现**

`events.ts` 的 `handleChatEvent`：把原来的 btw 分流块（130-133 行 `btw.isBtwSid(raw)` → `handleBtwEvent`）替换为：

```ts
  // btw 侧问结果：按主会话 id 路由到 btw store（不是 btw 专属 session id）。
  // 是否属于当前抽屉由 handleBtwAnswer 里的 ownerSessionId + question 双重匹配决定。
  if (e["type"] === "btw_answer") {
    useBtwSession().handleBtwAnswer(e);
    return;
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/aide-sdk && npx vitest run src/composables/useChatSession`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/aide-sdk/src/composables/useChatSession/events.ts packages/aide-sdk/src/composables/useChatSession.test.ts
git commit -m "refactor(btw): btw_answer 按主会话 id 分派到 btw store"
```

---

### Task 8: 前端 UI 切换（删轻量/完整 + 任务支线）

**Files:**
- Modify: `src/components/BtwDrawer.vue`、`src/components/ChatPanel/ChatPanel.vue`、`src/components/ChatPanel/ChatInputBox.vue`、`src/components/panelayout/PaneGroup.vue`
- Modify: `src/composables/useQuickActions.ts`

**Interfaces:**
- Consumes: Task 6 的新 `startBtw` 签名（无 lightweight）

- [ ] **Step 1: 删任务支线链路**

- `useQuickActions.ts`：删 `{ id:"git-commit", ... }` 项与 `kind:"task"`；`kind` 联合收敛为 `"prompt" | "btw"`
- `ChatInputBox.vue:73,785,907`：删 `"send-btw-task"` emit 与其两处触发
- `ChatPanel.vue:85,655`：删 `send-btw-task` 事件透传
- `PaneGroup.vue:58,127-128,206`：删 `onSendBtwTask` 与 `sendBtwTask` 导入

- [ ] **Step 2: 删轻量/完整 seg**

- `BtwDrawer.vue:6,9,33-35`：删 `lightweight` prop 与 `update:lightweight` emit 及 seg 模板整块
- `ChatPanel.vue:652,660,666,668`：删 `:btw-lightweight` / `@update:btw-lightweight` / `:lightweight` 透传
- `ChatInputBox.vue:72,797,816`：`send-btw` 的 opts 收敛为 `{ model?: string; effort?: string }`
- `PaneGroup.vue:123`：`onSendBtw` 签名同步

- [ ] **Step 3: 前端类型检查**

Run: `npx vue-tsc --noEmit`（或仓库既有 typecheck 脚本，见 `package.json` scripts）
Expected: 通过，无 `lightweight` / `taskId` 悬空引用

- [ ] **Step 4: 跑前端测试**

Run: `npx vitest run src/composables/useQuickActions.test.ts src/components`
Expected: PASS（含 useQuickActions 的既有用例——`kind:"task"` 相关用例同步删）

- [ ] **Step 5: 提交**

```bash
git add src/components/BtwDrawer.vue src/components/ChatPanel src/components/panelayout/PaneGroup.vue \
        src/composables/useQuickActions.ts src/composables/useQuickActions.test.ts
git commit -m "refactor(btw): 删任务支线与轻量/完整切换（btw 只有一种形态）"
```

---

### Task 9: sidecar 侧死代码清理

**Files:**
- Delete: `agent-sidecar/src/desktop/btwOptions.ts`、`agent-sidecar/src/desktop/btwOptions.test.ts`
- Modify: `agent-sidecar/src/engine/session-worker.ts`、`session-worker/queryOptions.ts`、`policy/sessionHook.ts`、`permissions.ts`
- Modify: `agent-sidecar/src/engine/types.ts`、`headless-schema.ts`（删 4 个旧字段）

**Interfaces:**
- 无新接口；只删。

- [ ] **Step 1: 删 btwOptions 与它的消费点**

- 删 `btwOptions.ts` + `btwOptions.test.ts`
- `session-worker/queryOptions.ts`：删 `btwQueryOverrides` 调用与 `btwOptions.js` import、`taskTools` 三元判断、`tools`/`allowedTools` 白名单覆盖
- `session-worker.ts`：删 `taskTools` 字段与 `cmd.tools` 分支、轻量 prompt 尾指令拼接（约 589-598 行）、`lightweightMode` 字段与透传

- [ ] **Step 2: 删 policy / permissions 的支线分支**

- `policy/sessionHook.ts`：删轻量全 deny 分支（约 116-129）、任务白名单分支（约 211-226）、`ask→deny` 分支（约 178-190）；`PolicyBranchState` 收敛掉 `lightweightMode` / `taskTools` 两个字段
- `permissions.ts`：删 `isBtw` 守卫与其注释叙事（保留 `isAutomation`）

- [ ] **Step 3: 删协议字段**

- `types.ts` 的 `SidecarCommand`：删 `btw` / `lightweight` / `fork_from` / `tools`
- `headless-schema.ts` 的 `sendCommand`：删同名四字段

- [ ] **Step 4: 全量单测 + 类型检查**

Run: `cd agent-sidecar && npx vitest run && npx tsc --noEmit`
Expected: PASS。若有用例仍在断言被删字段（`session-worker.test.ts` 里的 btw fork 源用例、`queryOptions.test.ts` 的 taskTools 用例、`sessionHook.test.ts` 的轻量 deny 用例），**同步删这些用例**——它们断言的行为已不存在。

- [ ] **Step 5: 构建 sidecar**

Run: `pnpm build:sidecar`（或仓库根 `pnpm build` 的 sidecar 段）
Expected: 构建通过

- [ ] **Step 6: 提交**

```bash
git add -A agent-sidecar
git commit -m "refactor(btw): 删三分支死代码（btwOptions/policy 分支/协议字段）"
```

---

### Task 10: 文档同步与真机验证

**Files:**
- Modify: `docs/headless-gateway-api.md`（命令与事件契约）
- Modify: `docs/headless-test-checklist.md`（若含 btw 用例）
- Modify: `src/composables/useQuickActions.ts:15-17`（注释说 CLI 的 /btw 是 TUI 专属、SDK 不可用——已被证伪）

- [ ] **Step 1: 更新契约文档**

`docs/headless-gateway-api.md`：命令清单里 `start_btw_session` 换成 `btw_ask`（含参数与返回值）；事件清单新增 `btw_answer`。**改完记得按记忆里的约定覆盖知识库镜像**《Headless 引擎对接文档（网关侧）》（先改仓库再 update_document）。

- [ ] **Step 2: 改 QuickActions 注释**

`useQuickActions.ts:15-17` 那句"CLI 的 /btw 是 TUI 专属，SDK 环境不可用"改为指向新实现（SDK 的 side_question 控制通道可用，走 `btw_ask`）。

- [ ] **Step 3: 真机验证（必须重启 dev 进程）**

```bash
# sidecar 改动必须 build 才会生效
pnpm build:sidecar && pnpm dev
```

逐条走（对应 spec §6）：

1. 新建会话 → 发一条消息 → 等 30s 空闲 → 发 btw：应 1~2s 出答案（对照老路 ~8s）
2. 主轮流式中发 btw：主轮不受影响，照常收尾
3. 停掉会话（`stopChatSession`）后再发 btw：抽屉显示"会话未运行，先发一条消息再问"
4. 同一会话连问两次，第二次的 `history` 非空且模型能引用第一次内容
5. 右键把 `askSideQuestion` 从 SDK 句柄上抹掉（或在旧版 SDK 上跑）：应报"当前引擎不支持侧问"而不是崩

- [ ] **Step 4: 提交**

```bash
git add docs/headless-gateway-api.md docs/headless-test-checklist.md src/composables/useQuickActions.ts
git commit -m "docs(headless): btw_ask / btw_answer 契约同步"
```

---

## 收尾检查

- [ ] `grep -rn "start_btw_session\|startBtwSession\|sendBtwTask\|btwOptions\|lightweight" src/ packages/ agent-sidecar/src/ src-tauri/src/` 无残留（`lightweight` 应只剩 GitTags 等无关用法）
- [ ] `pnpm check:sync-io` 通过（本计划未新增同步命令）
- [ ] 三端一致性：`btw_answer` 进事件契约后，remote-pwa 至少不崩（未处理即忽略；鸿蒙未实现 btw，不阻塞）
