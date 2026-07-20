# Agent Runtime 会话身份/生命周期修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Agent Runtime 提交（89ee33d）的会话身份层，使对话能跨消息/跨重开延续、stop 不再泄漏子进程、卡死检测不再误报。

**Architecture:** 统一身份模型——SessionWorker 在 SessionManager 的 Map key 全程使用 SDK 真实 session id。新会话先用 tempId 建 worker，session_init 到达时**原子 re-key** 到 realId（与前端 finalizeSession 切到 realId 对齐）。resume 改为独立 `resume_session_id` 字段透传，不再覆盖路由键。`startLoop` 加 `stopped` 出口；`isStalled` 每条 SDK 消息更新时间戳。Rust 侧 session_init 的 `_routing_id`/`sdk_session_id` 重写**保留不动**（btw 流程依赖它）。

**Tech Stack:** TypeScript（agent-sidecar，esbuild bundle）、Rust（Tauri commands）、vitest（前端 + sidecar 单测，`pnpm test`）、`cargo test --lib`（Rust 单测，绕杀软锁见 CLAUDE.md 怪癖）。

## Global Constraints

- **跨平台红线**（CLAUDE.md）：Rust 不硬编码 `\\`；本计划只动 chat.rs 的 JSON 构造与 runtime.rs 无变更，无平台特有逻辑。
- **多 Agent 抽象红线**：`SidecarCommand` / `ChatEvent` 协议保持 provider-agnostic；新增的 `resume_session_id` 是通用字段（任何 provider 的"续写已有会话"都映射成它），不引入 Claude 专属语义。
- **sidecar 事件出口必须过 delta 合并层**：本计划不改 DeltaCoalescer，SessionWorker 的 `emit` 仍走 `this.coalescer.push`。
- **不重写成熟模块**：模型切换/权限/任务/子代理/OutputTail 的尾轮询逻辑不动；只动身份字段、生命周期出口、resume 路由、re-key。
- **测试命令**：前端/sidecar 用 `pnpm test`（vitest，include `agent-sidecar/src/**/*.test.ts`）；Rust 用 `cd src-tauri && cargo test --lib`（绕杀软锁）。
- **bundle 重建**：改完 agent-sidecar 后需 `cd agent-sidecar && pnpm build` 重建 `dist/runtime.js`（dev 模式跑的就是这个产物）。

## File Structure

- `agent-sidecar/src/session-worker.ts` — 改：`sessionId` 字段重命名 `resumeSource`、新增公开 `routingKey` 字段、`stopped` 标志、`startLoop` 出口、`isStalled` 时间戳更新、`resume_session_id` 消费、`queryFn` 测试缝。
- `agent-sidecar/src/session-manager.ts` — 改：emit 闭包读 `worker.routingKey` 并在 session_init 时 re-key；修正矛盾注释。
- `agent-sidecar/src/types.ts` — 改：`send` 命令加 `resume_session_id?: string`。
- `agent-sidecar/src/session-worker.test.ts` — 改：更新字段引用、新增 stopped/isStalled/resume 测试。
- `agent-sidecar/src/session-manager.test.ts` — 新建：re-key 行为测试。
- `src-tauri/src/commands/chat.rs` — 改：抽 `build_send_command` 纯函数、`resume_id` → `resume_session_id` 字段、不再覆盖 `session_id`；补测试。
- `src-tauri/src/runtime.rs` — **不动**（session_init 重写保留）。
- 前端 `src/composables/useChatSession.ts`、`useBtwSession.ts`、`App.vue` — **不动**（Rust session_init 重写保留，前端 finalizeSession / isBtwSid 行为不变）。

---

### Task 1: 重命名 sessionId→resumeSource，引入 routingKey 字段

纯重构，零行为变更。先把语义混乱的字段名改对，后续任务才有干净的词汇表。

**Files:**
- Modify: `agent-sidecar/src/session-worker.ts:111-173`（字段声明 + 构造函数）、`:311-394`（handleCommand）、`:400-557`（startLoop）、`:575-578`（_testForkState）
- Test: `agent-sidecar/src/session-worker.test.ts`

**Interfaces:**
- Produces: `SessionWorker.resumeSource: string`（原 `sessionId`，fork/resume 源，初始空）、`SessionWorker.routingKey: string`（公开可变，Map 路由键，构造时 = 第一个参数）。`_testForkState()` 返回值键名 `forkSource` 保留不变（只是值来源换成 `resumeSource`）。

- [ ] **Step 1: 更新测试（字段名不变，加 routingKey 断言）**

替换 `agent-sidecar/src/session-worker.test.ts` 全文：

```typescript
import { describe, it, expect } from "vitest";
import { SessionWorker } from "./session-worker.js";

/**
 * 验证 SessionWorker 的 fork 源 / 路由键设定逻辑。
 *
 * 关键不变量：
 * - 构造时 fork 源为空（普通会话不 resume）
 * - routingKey 等于构造参数（SessionManager 据此 re-key）
 * - 只有 btw / provider_switched 才设 fork 源（在 handleCommand 里）
 * - BTW 从 fork_from 读 fork 源，不从 session_id 读
 */

function makeWorker(sid = "test-sid") {
  const events: any[] = [];
  return {
    worker: new SessionWorker(sid, (e) => events.push(e)),
    events,
  };
}

describe("SessionWorker — fork source / routing key invariants", () => {
  it("constructor: fork source starts empty (no resume for normal session)", () => {
    const { worker } = makeWorker();
    const { forkSource, shouldFork } = worker._testForkState();
    expect(forkSource).toBe("");
    expect(shouldFork).toBe(false);
  });

  it("constructor: routingKey equals the constructor arg", () => {
    const { worker } = makeWorker("temp-abc");
    expect(worker.routingKey).toBe("temp-abc");
  });

  it("constructor with btwMode: fork source still empty (set by handleCommand, not constructor)", () => {
    const { worker } = makeWorker();
    const { forkSource } = worker._testForkState();
    expect(forkSource).toBe("");
  });

  it("stop() cleans up without throwing", () => {
    const { worker } = makeWorker();
    worker.stop();
    expect(worker.isActive()).toBe(false);
  });

  it("isActive() returns false before startLoop", () => {
    const { worker } = makeWorker();
    expect(worker.isActive()).toBe(false);
  });

  it("isStalled() returns false with no query", () => {
    const { worker } = makeWorker();
    expect(worker.isStalled()).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试，确认 routingKey 断言失败**

Run: `pnpm test -- session-worker.test`
Expected: FAIL — `worker.routingKey is undefined`（字段尚未引入）。

- [ ] **Step 3: 重命名字段并引入 routingKey**

在 `agent-sidecar/src/session-worker.ts`：

1. 把 L115 `sessionId = "";` 改为：
```typescript
  /** fork/resume 源：SDK 会话 ID。空串=全新会话不 resume。
   *  仅 btw / provider_switched / 重开会话时设置（在 handleCommand 或 session_init 里）。
   *  注意：这不是路由键——路由键是 routingKey，由 SessionManager 管理。 */
  resumeSource = "";
  /** 当前在 SessionManager.workers Map 里的 key。构造时=tempId，
   *  session_init 到达后由 SessionManager re-key 成 SDK 真实会话 ID。
   *  emit 闭包读这个字段注入 session_id，所以 re-key 后事件自动带新 key。 */
  routingKey: string;
```

2. 构造函数（L152-173）把 `_routingId` 用起来——当前是带下划线的未用参数。把签名和函数体改为：
```typescript
  constructor(
    routingId: string,
    emitToStdout: (event: ChatEvent) => void,
    opts: SessionWorkerOptions = {},
  ) {
    this.emitToStdout = emitToStdout;
    this.routingKey = routingId;
    this.btwMode = opts.btwMode ?? false;
    this.lightweightMode = opts.lightweightMode ?? false;
    this.cwd = opts.cwd;
    this.envOverrides = opts.envOverrides ?? {};

    // DeltaCoalescer 的输出经注入回调写 stdout（带上 session_id）
    this.coalescer = new DeltaCoalescer((event) => {
      this.emitToStdout(event);
    });

    if (opts.initialModel) {
      this.currentModel = opts.initialModel;
    }
  }
```

3. 全文把 `this.sessionId` 替换为 `this.resumeSource`（共 6 处：L318、L327、L423、L456、L505、L513）。可用逐处 Edit（每处上下文不同，避免 replace_all 误伤）。具体：
   - L318 `if (cmd.session_id) this.sessionId = cmd.session_id;` → `this.resumeSource = cmd.session_id;`
   - L327 `if (forkFrom) this.sessionId = forkFrom;` → `this.resumeSource = forkFrom;`
   - L423 `if (this.sessionId && this.shouldForkNextConnect && !this.btwMode)` → `if (this.resumeSource && ...)`
   - L456 `...forkResumeOptions(this.sessionId ?? "", this.shouldForkNextConnect)` → `this.resumeSource ?? ""`
   - L505 `newSid !== this.sessionId` → `newSid !== this.resumeSource`
   - L513 `this.sessionId = newSid ?? this.sessionId;` → `this.resumeSource = newSid ?? this.resumeSource;`

4. `_testForkState`（L576-578）改为：
```typescript
  _testForkState(): { forkSource: string; shouldFork: boolean } {
    return { forkSource: this.resumeSource, shouldFork: this.shouldForkNextConnect };
  }
```

5. 把 L112-114 那段关于 `sessionId` 的注释删掉（已被上面新字段注释取代）。

- [ ] **Step 4: 运行测试，确认全绿**

Run: `pnpm test -- session-worker.test`
Expected: PASS（全部 6 条）。

- [ ] **Step 5: 确认 sidecar 类型检查 + 提交**

Run: `cd agent-sidecar && npx tsc --noEmit`
Expected: 无错误。

```bash
git add agent-sidecar/src/session-worker.ts agent-sidecar/src/session-worker.test.ts
git commit -m "refactor(agent-runtime): rename sessionId→resumeSource, introduce routingKey

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: stop() 加 stopped 标志 + startLoop 干净退出 + isStalled 时间戳修复

修 Bug 3（stop 后 startLoop 无限自旋/泄漏子进程）和 Bug 4（isStalled 永远误报）。

**Files:**
- Modify: `agent-sidecar/src/session-worker.ts:400-557`（startLoop）、`:569-587`（isStalled/stop）、`:243-270` 邻近（无）
- Test: `agent-sidecar/src/session-worker.test.ts`

**Interfaces:**
- Produces: `SessionWorker._testIsStopped(): boolean`、导出纯函数 `isStalledRelativeTo(lastMessageAt, now, hasQuery): boolean`。

- [ ] **Step 1: 写失败测试（isStalledRelativeTo 纯函数 + stopped 标志）**

在 `agent-sidecar/src/session-worker.test.ts` 顶部 import 加上纯函数：
```typescript
import { SessionWorker, isStalledRelativeTo } from "./session-worker.js";
```

在 describe 块末尾追加：
```typescript
  it("isStalledRelativeTo: no query → never stalled", () => {
    expect(isStalledRelativeTo(0, 100_000, false)).toBe(false);
  });

  it("isStalledRelativeTo: query + <90s since last message → not stalled", () => {
    expect(isStalledRelativeTo(0, 89_999, true)).toBe(false);
  });

  it("isStalledRelativeTo: query + >90s since last message → stalled", () => {
    expect(isStalledRelativeTo(0, 90_001, true)).toBe(true);
  });

  it("stop() sets stopped flag (startLoop must exit before spawning)", () => {
    const { worker } = makeWorker();
    expect(worker._testIsStopped()).toBe(false);
    worker.stop();
    expect(worker._testIsStopped()).toBe(true);
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm test -- session-worker.test`
Expected: FAIL — `isStalledRelativeTo is not exported` / `_testIsStopped is not a function`。

- [ ] **Step 3: 实现纯函数 + stopped 标志 + 时间戳更新**

在 `agent-sidecar/src/session-worker.ts`：

1. 文件顶部（class 外，`PERMISSION_MODES` 附近）加导出纯函数：
```typescript
/** 卡死判定的纯逻辑——抽出可单测，不依赖 Date.now() / 私有 currentQuery。
 *  hasQuery: 是否有 SDK query 在跑；lastMessageAt/now: 毫秒时间戳。 */
export function isStalledRelativeTo(
  lastMessageAt: number,
  now: number,
  hasQuery: boolean,
): boolean {
  if (!hasQuery) return false;
  return now - lastMessageAt > 90_000;
}
```

2. 在 `SessionWorker` 字段区（`turnActive` 附近）加：
```typescript
  private stopped = false;
```

3. `isStalled`（L570-573）改为用纯函数：
```typescript
  isStalled(): boolean {
    return isStalledRelativeTo(this.lastSdkMessageAt, Date.now(), this.currentQuery !== null);
  }
```

4. `startLoop`（L400-557）的 `while (true) {` 改为带出口检查：
```typescript
  async startLoop(cwd?: string): Promise<void> {
    try {
      while (!this.stopped) {
        try {
```
（即 `while (true)` → `while (!this.stopped)`；相应地末尾 `break` 仍保留——queue.close() 时 for-await 结束走 break，stop() 时走 while 条件，双保险。）

5. 在 for-await 循环体最前面（L464 `for await (const msg of q) {` 之后第一行）加时间戳更新：
```typescript
          for await (const msg of q) {
            this.lastSdkMessageAt = Date.now();
            if ((msg as any).type === "result") {
```

6. `stop()`（L581-586）在最前面设标志：
```typescript
  stop(): void {
    this.stopped = true;
    this.currentQuery?.close?.();
    this.currentQuery = null;
    this.queue.close();
    this.stopAllOutputTails();
  }
```

7. 在 `_testForkState` 附近加测试钩子：
```typescript
  _testIsStopped(): boolean {
    return this.stopped;
  }
```

- [ ] **Step 4: 运行测试，确认全绿**

Run: `pnpm test -- session-worker.test`
Expected: PASS（全部 10 条）。

- [ ] **Step 5: 提交**

```bash
git add agent-sidecar/src/session-worker.ts agent-sidecar/src/session-worker.test.ts
git commit -m "fix(agent-runtime): stop() exits startLoop, isStalled uses live timestamp

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: SessionManager 在 session_init 时 re-key worker（tempId→realId）

修 Bug 1（第二条消息开新会话丢上下文）。核心：worker 的 Map key 在 SDK 确认真实 id 后同步迁移到 realId，与前端 finalizeSession 对齐。

**Files:**
- Modify: `agent-sidecar/src/session-manager.ts:18-94`（emitToStdout / getOrCreate / 注释）
- Test: `agent-sidecar/src/session-manager.test.ts`（新建）
- Modify: `agent-sidecar/src/session-worker.ts` — 加 `_emitForTest` 测试钩子（让测试能同步触发 session_init 走完整 emit 链路）

**Interfaces:**
- Produces: `SessionWorker._emitForTest(event: ChatEvent): void`（同步触发 `this.emit` → coalescer → emit 闭包，用于测试 re-key）。`SessionManager.getAllWorkers()` 已存在（L108）。

- [ ] **Step 1: 加 SessionWorker._emitForTest 测试钩子**

在 `agent-sidecar/src/session-worker.ts` 的 `_testForkState` 附近加：
```typescript
  /** 测试专用：同步触发 emit 链路（→ coalescer → emit 闭包）。
   *  session_init 是非增量事件，deltaCoalescer.push 同步 flush+透传，
   *  所以调用后 SessionManager 的 re-key 立即生效。 */
  _emitForTest(event: ChatEvent): void {
    this.emit(event);
  }
```

- [ ] **Step 2: 写失败测试（re-key 行为）**

新建 `agent-sidecar/src/session-manager.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionManager } from "./session-manager.js";

/**
 * 验证 SessionManager 的 session_init re-key 行为——Bug 1 的回归保护。
 *
 * 关键不变量：
 * - 新会话用 tempId 建 worker，session_init 到达后 worker 原子迁移到 realId
 * - re-key 后用 realId 路由能找到同一个 worker，tempId 找不到
 * - 非 session_init 事件不触发 re-key
 * - re-key 后事件自动带 realId（emit 闭包读 worker.routingKey）
 */
describe("SessionManager — session_init re-key", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  function sendInit(manager: SessionManager, tempId: string, realId: string) {
    // 模拟 SDK 在首条 send 后回的 session_init：mapper 把 SDK session_id 放进 event.session_id
    manager.handleCommand({
      cmd: "send",
      session_id: tempId,
      prompt: "hi",
      cwd: "/tmp",
      env: {},
    });
    // handleCommand 建 worker 但不 startLoop（无 SDK）；直接对 worker emit session_init
    const workers = manager.getAllWorkers();
    const worker = workers.get(tempId);
    if (!worker) throw new Error("worker not created under tempId");
    (worker as any)._emitForTest({ type: "session_init", session_id: realId });
  }

  it("new session: worker re-keyed from tempId to realId on session_init", () => {
    const manager = new SessionManager();
    sendInit(manager, "temp-1", "real-1");
    const workers = manager.getAllWorkers();
    expect(workers.has("temp-1")).toBe(false);
    expect(workers.has("real-1")).toBe(true);
    expect(workers.get("real-1")!.routingKey).toBe("real-1");
  });

  it("after re-key, routing with realId finds the worker (second-message regression)", () => {
    const manager = new SessionManager();
    sendInit(manager, "temp-1", "real-1");
    // 第二条消息带 realId 进来——必须命中已 re-key 的 worker，而不是新建
    manager.handleCommand({
      cmd: "interrupt", // interrupt 不 startLoop，能干净验证路由
      session_id: "real-1",
    });
    // worker 仍存在且唯一（没因 realId 找不到而新建第二个）
    expect(manager.getAllWorkers().size).toBe(1);
    expect(manager.getAllWorkers().has("real-1")).toBe(true);
  });

  it("non-init events do NOT re-key", () => {
    const manager = new SessionManager();
    manager.handleCommand({ cmd: "send", session_id: "temp-2", prompt: "hi", cwd: "/tmp", env: {} });
    const worker = manager.getAllWorkers().get("temp-2")!;
    (worker as any)._emitForTest({ type: "text_delta", delta: "x" });
    expect(manager.getAllWorkers().has("temp-2")).toBe(true);
    expect(manager.getAllWorkers().has("real-2")).toBe(false);
  });

  it("session_init for an already-realId worker (reopened session) is a no-op re-key", () => {
    const manager = new SessionManager();
    manager.handleCommand({ cmd: "send", session_id: "real-9", prompt: "hi", cwd: "/tmp", env: {} });
    const worker = manager.getAllWorkers().get("real-9")!;
    (worker as any)._emitForTest({ type: "session_init", session_id: "real-9" });
    expect(manager.getAllWorkers().size).toBe(1);
    expect(manager.getAllWorkers().has("real-9")).toBe(true);
    expect(worker.routingKey).toBe("real-9");
  });

  it("session_init event on stdout carries _routing_id=tempId and session_id=realId (Rust rewrite contract)", () => {
    const manager = new SessionManager();
    sendInit(manager, "temp-1", "real-1");
    const lastCall = stdoutSpy.mock.calls.at(-1)?.[0] as string;
    const parsed = JSON.parse(lastCall);
    expect(parsed.type).toBe("session_init");
    expect(parsed._routing_id).toBe("temp-1");
    expect(parsed.session_id).toBe("real-1");
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `pnpm test -- session-manager.test`
Expected: FAIL — `workers.has("real-1")` is false（未 re-key）；`_routing_id` 可能也错。

- [ ] **Step 4: 实现 re-key**

在 `agent-sidecar/src/session-manager.ts`：

1. 修正 L18-23 那段矛盾注释，改为：
```typescript
  /** 把事件序列化并写入 stdout。注入 session_id 让 Rust 侧 route 到前端。
   *
   * session_init 特判：SDK 给的 event.session_id 是真实会话 ID，路由键在
   * _routing_id——Rust 据此把 session_id 重写回路由键、真 ID 放 sdk_session_id
   * （btw 的 isBtwSid 靠 session_id=路由键命中，再从 sdk_session_id 取真 ID）。
   * 其他事件 session_id 即路由键，直接注入。
   *
   * 注意：调用方传入的 sessionId 必须是 worker 当前的 routingKey——re-key 后
   * 自动跟着变（见 getOrCreate 的 emit 闭包，读 worker.routingKey）。
   */
```
（`emitToStdout` 函数体 L24-33 不变——它仍是纯写入器。）

2. `getOrCreate`（L76-94）把建 worker 的 emit 闭包改成读 `worker.routingKey` + session_init 时 re-key。替换整个方法体：
```typescript
  private getOrCreate(sid: string | undefined, cmd: SidecarCommand & { cmd: "send" }): SessionWorker {
    if (sid && this.workers.has(sid)) {
      return this.workers.get(sid)!;
    }

    // 新建 SessionWorker
    const sessionId = sid ?? `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let worker: SessionWorker;
    const emit = (event: ChatEvent) => {
      // 读 worker.routingKey 而非捕获固定 sessionId——re-key 后事件自动带新 key
      this.emitToStdout(worker.routingKey, event);
      // session_init：SDK 确认真实会话 ID，把 worker 从 tempId 原子迁移到 realId，
      // 与前端 finalizeSession 切到 realId 对齐。否则第二条消息带 realId 进来
      // getOrCreate 找不到 worker、新建一个全新 SDK 会话，上一轮上下文全丢。
      if (event.type === "session_init") {
        const realId = (event as { session_id?: string }).session_id;
        if (realId && realId !== worker.routingKey) {
          this.rekeyWorker(worker, worker.routingKey, realId);
        }
      }
    };
    worker = new SessionWorker(sessionId, emit, {
      cwd: cmd.cwd,
      btwMode: !!(cmd as any).btw,
      lightweightMode: !!(cmd as any).lightweight,
      envOverrides: (cmd as any).env ?? {},
    });

    this.workers.set(sessionId, worker);
    return worker;
  }

  /** 原子 re-key：从 Map 删旧 key、改 worker.routingKey、写新 key。 */
  private rekeyWorker(worker: SessionWorker, oldKey: string, newKey: string): void {
    this.workers.delete(oldKey);
    worker.routingKey = newKey;
    this.workers.set(newKey, worker);
  }
```

- [ ] **Step 5: 运行测试，确认全绿**

Run: `pnpm test -- session-manager.test`
Expected: PASS（全部 5 条）。

- [ ] **Step 6: 跑全套 sidecar 测试，确认没回归**

Run: `pnpm test`
Expected: PASS（所有 sidecar + 前端测试）。

- [ ] **Step 7: 提交**

```bash
git add agent-sidecar/src/session-manager.ts agent-sidecar/src/session-manager.test.ts agent-sidecar/src/session-worker.ts
git commit -m "fix(agent-runtime): re-key worker to SDK realId on session_init

修复第二条消息开新会话丢上下文（Bug 1）：worker 在 SessionManager 的
Map key 全程用 SDK 真实 session id，session_init 时原子从 tempId 迁到
realId，与前端 finalizeSession 对齐。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: resume 改为独立 resume_session_id 字段（不再覆盖路由键）

修 Bug 2（重开历史会话不 resume、开新会话）。`chat.rs` 不再用 `resume_id` 覆盖 `session_id`；改为独立字段透传，`SessionWorker.handleCommand` 在首条 send（无活 query）时把它赋给 `resumeSource`，`startLoop` 的 `forkResumeOptions` 自然走 resume。

**Files:**
- Modify: `src-tauri/src/commands/chat.rs:61-120`（send_message，抽 build_send_command）、`:282-361`（测试）
- Modify: `agent-sidecar/src/types.ts:128-148`（send 命令加字段）
- Modify: `agent-sidecar/src/session-worker.ts:311-394`（handleCommand 消费 resume_session_id）、`SessionWorkerOptions` 加 `queryFn`
- Test: `agent-sidecar/src/session-worker.test.ts`（resume_session_id → resumeSource）、`src-tauri/src/commands/chat.rs` 测试模块

**Interfaces:**
- Consumes: Task 1 的 `resumeSource` 字段。
- Produces: `build_send_command(...)` 纯函数（Rust）；`SidecarCommand` send 的 `resume_session_id?: string`；`SessionWorkerOptions.queryFn?`（测试缝，生产省略用真 SDK `query`）。

- [ ] **Step 1: 写 Rust 失败测试（build_send_command 不覆盖 session_id）**

在 `src-tauri/src/commands/chat.rs` 的 `mod tests`（L282 末尾）追加：

```rust
    /// 回归（Bug 2）：resume_id 必须进 resume_session_id 字段，不能覆盖 session_id（路由键）。
    /// 覆盖了会让 SessionManager 用真 ID 建 worker，但 SessionWorker.resumeSource 仍空 → 不 resume。
    #[test]
    fn build_send_command_resume_goes_to_separate_field() {
        let env: HashMap<String, String> = HashMap::new();
        let cmd = build_send_command(
            "main-sid",        // session_id（路由键 = 前端 sid）
            "继续聊",
            None,              // images
            Some("resume-xyz".to_string()), // resume_id
            None, None, None, None, false, &env,
            "/tmp",
        );
        assert_eq!(cmd["cmd"], "send");
        assert_eq!(cmd["session_id"], "main-sid");       // 路由键不变
        assert_eq!(cmd["resume_session_id"], "resume-xyz"); // resume 进独立字段
        assert!(cmd.get("provider_switched").is_none() || cmd["provider_switched"] == false);
    }

    /// 回归：无 resume_id 时不出 resume_session_id 字段（普通新会话）。
    #[test]
    fn build_send_command_no_resume_field_when_absent() {
        let env: HashMap<String, String> = HashMap::new();
        let cmd = build_send_command(
            "temp-1", "hi", None, None, None, None, None, None, false, &env, "/tmp",
        );
        assert_eq!(cmd["session_id"], "temp-1");
        assert!(cmd.get("resume_session_id").is_none());
    }

    /// 回归：provider_switched 仍照常带，且不干扰 resume_session_id。
    #[test]
    fn build_send_command_provider_switched_and_resume_coexist() {
        let env: HashMap<String, String> = HashMap::new();
        let cmd = build_send_command(
            "main-sid", "hi", None,
            Some("resume-xyz".to_string()),
            None, None, None, None,
            true, &env, "/tmp",
        );
        assert_eq!(cmd["session_id"], "main-sid");
        assert_eq!(cmd["resume_session_id"], "resume-xyz");
        assert_eq!(cmd["provider_switched"], true);
    }
```

- [ ] **Step 2: 运行 Rust 测试，确认失败**

Run: `cd src-tauri && cargo test --lib build_send_command`
Expected: 编译错误 — `build_send_command` 未定义。

- [ ] **Step 3: 抽 build_send_command 纯函数 + 改 send_message 调用它**

在 `src-tauri/src/commands/chat.rs`，把 `send_message`（L61-120）的命令构造部分抽成纯函数。在 `send_message` 之前插入：

```rust
/// 构造 `send` 命令的 JSON（纯函数，可单测）。
///
/// 关键：resume_id 进 `resume_session_id` 独立字段，**不覆盖 `session_id`**（路由键）。
/// SessionManager 按 session_id 路由到/建 worker；SessionWorker 在首条 send（无活 query）
/// 时把 resume_session_id 赋给 resumeSource，startLoop 的 forkResumeOptions 据此 resume。
/// 旧行为（resume_id 覆盖 session_id）会让路由键换成真 ID 但 resumeSource 仍空 → 不 resume。
#[allow(clippy::too_many_arguments)]
fn build_send_command(
    session_id: &str,
    prompt: &str,
    images: Option<&Vec<serde_json::Value>>,
    resume_id: Option<String>,
    initial_model: Option<String>,
    permission_mode: Option<String>,
    jump_queue: Option<bool>,
    workspace_root: Option<String>,
    provider_switched: bool,
    env_vars: &HashMap<String, String>,
    cwd: &str,
) -> serde_json::Value {
    let mut cmd = json!({
        "cmd": "send",
        "session_id": session_id,
        "prompt": prompt,
        "cwd": cwd,
        "env": env_vars,
    });
    if let Some(imgs) = images {
        if !imgs.is_empty() {
            cmd["images"] = json!(imgs);
        }
    }
    if let Some(rid) = resume_id {
        cmd["resume_session_id"] = json!(rid);
    }
    if let Some(ref model) = initial_model {
        if !model.is_empty() {
            if let Some(env) = cmd.get_mut("env").and_then(|e| e.as_object_mut()) {
                env.insert("ANTHROPIC_MODEL".to_string(), json!(model));
            }
        }
    }
    if let Some(mode) = permission_mode {
        if !mode.is_empty() {
            cmd["permission_mode"] = json!(mode);
        }
    }
    if jump_queue == Some(true) {
        cmd["jump_queue"] = json!(true);
    }
    if provider_switched {
        cmd["provider_switched"] = json!(true);
    }
    let _ = workspace_root; // cwd 已在外部解析传入
    cmd
}
```

然后把 `send_message` 的函数体（L74-119）替换为调用它：

```rust
    let cwd = session_cwd(&workspace_root, &workspace_state);
    let cwd_str = cwd.to_string_lossy().to_string();

    let provider_env = current_provider_env();
    let provider_switched = runtime_mgr.connection_drifted(&session_id, &provider_env);
    runtime_mgr.upsert_fingerprint(&session_id, &provider_env);

    let cmd = build_send_command(
        &session_id,
        &prompt,
        images.as_ref(),
        resume_id,
        initial_model,
        permission_mode,
        jump_queue,
        workspace_root,
        provider_switched,
        &provider_env,
        &cwd_str,
    );

    runtime_mgr.send_to_runtime(&cmd).await
```

删掉旧的 `send_message_cmd_has_session_id` 测试里关于 resume 覆盖的隐含假设——实际上那条测试构造的 json 没传 resume_id，仍成立，保留即可。但 `send_message_cmd_no_fork_triggers_for_normal_session`（L329-337）也是手动构造 json，不调用 build_send_command，保留。

- [ ] **Step 4: 运行 Rust 测试，确认全绿**

Run: `cd src-tauri && cargo test --lib build_send_command`
Expected: PASS（3 条新增）。

Run: `cd src-tauri && cargo test --lib`
Expected: PASS（chat.rs 全部测试，含原有 6 条 + 新 3 条）。

- [ ] **Step 5: types.ts 加 resume_session_id 字段**

在 `agent-sidecar/src/types.ts` 的 `send` 命令（L129-148）加字段。在 `fork_from?: string;` 后面加：

```typescript
      // 重开已有会话时带：SDK 据此 resume 已有会话上下文。与 session_id（路由键）
      // 解耦——session_id 用于 SessionManager 路由，resume_session_id 用于 SDK resume。
      // 省略=全新会话不 resume。btw 用 fork_from + forkSession，不带这个。
      resume_session_id?: string;
```

- [ ] **Step 6: SessionWorkerOptions 加 queryFn 测试缝**

在 `agent-sidecar/src/session-worker.ts` 的 `SessionWorkerOptions`（L102-109）加：
```typescript
  /** 测试缝：覆盖 SDK query 实现。生产省略用真 query。 */
  queryFn?: typeof query;
```

在 import 区（L20）`import { query } from "@anthropic-ai/claude-agent-sdk";` 保留。在 class 字段区加：
```typescript
  private queryFn: typeof query;
```

构造函数里初始化（在 `this.routingKey = routingId;` 后）：
```typescript
    this.queryFn = opts.queryFn ?? query;
```

`startLoop` 里把 `query({...})`（L427）改为 `this.queryFn({...})`。

- [ ] **Step 7: 写 sidecar 失败测试（resume_session_id → resumeSource）**

在 `agent-sidecar/src/session-worker.test.ts` 的 import 里加类型：
```typescript
import type { ChatEvent } from "./types.js";
```

在 describe 块末尾追加：
```typescript
  it("send with resume_session_id sets resumeSource (reopen regression)", () => {
    // queryFn 返回空 async generator——startLoop 立即结束，不 spawn SDK
    const emptyQuery = (() => (async function* () {})()) as any;
    const { worker } = makeWorker();
    (worker as any).queryFn = emptyQuery;
    worker.handleCommand({
      cmd: "send",
      session_id: "real-7",
      prompt: "继续",
      cwd: "/tmp",
      resume_session_id: "real-7",
      env: {},
    } as any);
    // resumeSource 应等于 resume_session_id（startLoop 会据此 resume）
    expect(worker._testForkState().forkSource).toBe("real-7");
  });

  it("send without resume_session_id keeps resumeSource empty (brand-new session)", () => {
    const emptyQuery = (() => (async function* () {})()) as any;
    const { worker } = makeWorker();
    (worker as any).queryFn = emptyQuery;
    worker.handleCommand({
      cmd: "send",
      session_id: "temp-7",
      prompt: "你好",
      cwd: "/tmp",
      env: {},
    } as any);
    expect(worker._testForkState().forkSource).toBe("");
  });
```

注意：`makeWorker` 当前不传 queryFn，默认用真 `query`——上面用 `(worker as any).queryFn = emptyQuery` 在 handleCommand 前覆盖。但构造时 `this.queryFn = opts.queryFn ?? query` 已设成真 query；覆盖后再 handleCommand 不会重新初始化 queryFn，所以覆盖生效。✓

- [ ] **Step 8: 运行测试，确认失败**

Run: `pnpm test -- session-worker.test`
Expected: FAIL — `forkSource` 是 `""`（handleCommand 还没消费 resume_session_id）。

- [ ] **Step 9: 实现 handleCommand 消费 resume_session_id**

在 `agent-sidecar/src/session-worker.ts` 的 `handleCommand` send 分支，把"首条消息：启动 query 循环"块（L334-345）改为：

```typescript
      // 首条消息：启动 query 循环
      if (!this.currentQuery) {
        if (cmd.permission_mode) this.applyPermissionMode(cmd.permission_mode);
        // 重开已有会话：resume_session_id → resumeSource，startLoop 据此 resume。
        // 普通新会话不带这字段，resumeSource 保持空 → 全新会话。
        if (cmd.resume_session_id) this.resumeSource = cmd.resume_session_id;
        this.startLoop(cmd.cwd ?? this.cwd);
        this.queue.push({
          type: "user",
          message: buildUserMessage(cmd.prompt, cmd.images ?? []),
          parent_tool_use_id: null,
        } as any);
        this.turnActive = true;
        return;
      }
```

- [ ] **Step 10: 运行测试，确认全绿**

Run: `pnpm test -- session-worker.test`
Expected: PASS（全部 12 条）。

- [ ] **Step 11: 跑全套测试 + 类型检查**

Run: `pnpm test`
Expected: PASS。

Run: `cd agent-sidecar && npx tsc --noEmit`
Expected: 无错误。

Run: `cd src-tauri && cargo test --lib`
Expected: PASS。

- [ ] **Step 12: 提交**

```bash
git add src-tauri/src/commands/chat.rs agent-sidecar/src/types.ts agent-sidecar/src/session-worker.ts agent-sidecar/src/session-worker.test.ts
git commit -m "fix(agent-runtime): resume via dedicated resume_session_id field

修复重开历史会话不 resume（Bug 2）：resume_id 不再覆盖 session_id
（路由键），改走独立 resume_session_id 字段，SessionWorker 首条 send
时赋给 resumeSource，startLoop 据此 resume。抽 build_send_command 纯函数。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: 清理死代码 + 修正矛盾注释

低风险收尾：删 `OutputTail.onStop` 死代码（Bug 7），确认 Task 3 已修的注释无残留。

**Files:**
- Modify: `agent-sidecar/src/session-worker.ts:65-98`（OutputTail）、`:276-305`（startOutputTail 调用点）、`:491-496`（mapSdkMessage 调用点）

**Interfaces:**
- 无外部接口变化（`onStop` 从未生效，删除是纯清理）。

- [ ] **Step 1: 删 OutputTail 的 onStop 死参数**

在 `agent-sidecar/src/session-worker.ts`：

1. `OutputTail` 构造函数（L70-75）删 `onStop` 参数：
```typescript
  constructor(
    private readonly id: string,
    private readonly outputFile: string,
    private readonly emit: (e: ChatEvent) => void,
  ) {}
```

2. `startOutputTail`（L276-280）删 onStop 形参和传参：
```typescript
  startOutputTail(id: string, outputFile: string): void {
    if (this.outputTails.has(id)) return;
    this.outputTails.set(id, new OutputTail(id, outputFile, (e) => this.emit(e)));
    this.ensureOutputTailTimer();
  }
```

3. `mapSdkMessage` 调用点（L491-496）的 `start` 回调签名简化——mapper.ts 的 `outputTailHooks.start` 仍声明 4 参，这里只需用前两个：
```typescript
                start: (id, outputFile, _emit, _onStop) => {
                  // SessionWorker 的 emit 已绑定到实例，忽略传入的 emit/onStop
                  this.startOutputTail(id, outputFile);
                },
                stop: (id) => this.stopOutputTail(id),
```
（`_onStop` 现在确实没用，但 mapper.ts 的接口契约保留 4 参不动——改 mapper 签名会动 mapper.test.ts，超出本计划范围。这里保留 `_onStop` 占位即可。）

注意：`parseOutputLine`（L55-63）的 `onStop`/`claimModel` 参数与 `OutputTail.onStop` 无关（那是子代理 model claim），不动。

- [ ] **Step 2: 类型检查 + 测试**

Run: `cd agent-sidecar && npx tsc --noEmit`
Expected: 无错误（`_onStop` 占位接受）。

Run: `pnpm test`
Expected: PASS。

- [ ] **Step 3: 提交**

```bash
git add agent-sidecar/src/session-worker.ts
git commit -m "chore(agent-runtime): remove dead OutputTail.onStop param

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 重建 bundle + 端到端回归验证

**Files:** 无源码变更，只重建产物 + 手动验证。

- [ ] **Step 1: 重建 sidecar bundle**

Run: `cd agent-sidecar && pnpm build`
Expected: `dist/runtime.js` 生成成功（esbuild 无报错）。

- [ ] **Step 2: 启动 dev 跑一次真实对话（验证 Bug 1/2 修复）**

Run: `pnpm tauri dev`（在另一个终端；本会话用 Bash 后台或由用户操作）

手动验证清单：
1. **新会话连发两条**：发"你好"→等回复→发"我刚才说了什么"。模型应能回忆第一句（证明第二条命中同一 worker、未开新 SDK 会话）。修复前：第二条答非所问/像新对话。
2. **重开历史会话**：发几条→stop/重启 app→侧栏点回该会话→发"继续"。模型应延续上下文（证明 resume_session_id 生效）。修复前：开天窗。
3. **stop 后无 CPU 飙升**：发一条→点停止→观察任务管理器 `claude.exe` 是否在几秒内全部退出、无反复 spawn。修复前：可能残留/自旋。
4. **诊断仪表盘 stalled 数**：空闲 90s+ 后看仪表盘，活会话不该被误报 stalled（修复前：必误报）。
5. **btw 顺便问**：主会话跑着→切 btw 发"顺便问下 X"→抽屉显示流式→结论回插主对话批注。修复前/后行为应一致（btw 链路未改）。

- [ ] **Step 3: 跑全套自动化测试兜底**

Run: `pnpm test && cd src-tauri && cargo test --lib`
Expected: PASS。

- [ ] **Step 4: 提交 bundle 产物（如仓库跟踪 dist/runtime.js）**

查 CLAUDE.md 怪癖："dist/sidecar.js 需重建提交"。确认 dist/runtime.js 是否被跟踪：
Run: `git status --short dist/ agent-sidecar/dist/`
若 `agent-sidecar/dist/runtime.js` 有改动且被跟踪：
```bash
git add agent-sidecar/dist/runtime.js
git commit -m "build(agent-runtime): rebuild runtime.js bundle

Co-Authored-By: Claude <noreply@anthropic.com>"
```
若未跟踪（.gitignore）则跳过此步。

---

## Self-Review

**1. Spec coverage（对照评估的 7 个 bug）：**
- Bug 1（第二条消息开新会话）→ Task 3 re-key。✓
- Bug 2（重开不 resume）→ Task 4 resume_session_id。✓
- Bug 3（stop 后自旋/泄漏）→ Task 2 stopped 标志 + startLoop `while(!this.stopped)`。✓
- Bug 4（isStalled 误报）→ Task 2 isStalledRelativeTo + for-await 时间戳更新。✓
- Bug 5（注释矛盾）→ Task 3 Step 4-1 重写注释。✓
- Bug 6（error 重连 queue 迭代器泄漏）→ 评估为中级、不致命，本计划未单独修（旧迭代器被 GC，新迭代器从 queue 数组继续，无正确性问题）。**留作已知项，不在本计划范围。**
- Bug 7（OutputTail.onStop 死代码）→ Task 5。✓

**2. Placeholder scan：** 无 TBD/TODO；所有代码步骤含完整代码块；测试含完整断言。

**3. Type consistency：**
- `resumeSource`（Task 1 定义）→ Task 4 Step 9 消费、Task 4 Step 7 测试读 `forkSource`（值来源 `resumeSource`，键名不变）。✓
- `routingKey`（Task 1 定义，公开可变）→ Task 3 Step 4 emit 闭包读 `worker.routingKey`、`rekeyWorker` 写 `worker.routingKey`、测试断言 `routingKey`。✓
- `isStalledRelativeTo(lastMessageAt, now, hasQuery)`（Task 2 定义）→ `isStalled()` 调用签名匹配。✓
- `build_send_command`（Task 4 Step 3 定义，12 参）→ Step 1 测试调用 12 参、`send_message` Step 3 调用 12 参。✓ 参数顺序：`(session_id, prompt, images: Option<&Vec>, resume_id, initial_model, permission_mode, jump_queue, workspace_root, provider_switched, env_vars, cwd)` ——测试与实现一致。✓
- `SessionWorkerOptions.queryFn?: typeof query`（Task 4 Step 6）→ 测试用 `(worker as any).queryFn = emptyQuery` 覆盖（构造后赋值，绕过 opts 路径，因为 makeWorker 不传 opts）。注意：构造函数 `this.queryFn = opts.queryFn ?? query` 在 makeWorker 路径下设成真 query，测试在 handleCommand 前覆盖字段——`this.queryFn` 是实例字段可覆盖。✓

**4. 风险点：**
- Task 3 re-key 在 session_init emit 之后执行（emit 闭包先调 emitToStdout 再 re-key）。session_init 事件本身带 tempId（routingKey 此时未变）→ Rust 重写为 session_id=tempId、sdk_session_id=realId → 前端 finalizeSession(tempId, realId)。**与现有前端行为完全一致**。re-key 只影响**后续**事件和命令路由。✓
- re-key 与第二条消息的时序：session_init 在第一轮回复中发出，第二条消息由用户在第一轮结束后才发——re-key 远早于第二条消息到达，无竞态。✓
- btw：start_btw_session 用 fork_from（不是 resume_session_id），走 `shouldForkNextConnect=true` 路径（L321-328），Task 4 不动该路径。btw session_init 后 re-key 到 fork 出的 realId，`useBtwSession.handleBtwEvent` 仍从 `sdk_session_id` 取 realId（Rust 重写保留），`isBtwSid(raw)` 命中 tempId 或 realId。cleanup 用 `btwRealId ?? btwTempId` = re-key 后的 realId → stop_chat_session(realId) → SessionManager 找到 re-key 后的 worker。✓