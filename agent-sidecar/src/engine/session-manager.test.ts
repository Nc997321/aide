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
    // 用 __testCreateWorker 直接调 getOrCreate 建 worker——绕开 handleCommand(send)
    // 的 startLoop（会 spawn 真 claude.exe + MessageQueue 永久 await，测试挂起）。
    // mapper 把 SDK session_id 放进 event.session_id，这里模拟 SDK 回 session_init。
    const worker = (manager as any).__testCreateWorker(tempId) as { _emitForTest: (e: any) => void };
    worker._emitForTest({ type: "session_init", session_id: realId });
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
    const worker = (manager as any).__testCreateWorker("temp-2") as { _emitForTest: (e: any) => void };
    worker._emitForTest({ type: "text_delta", delta: "x" });
    expect(manager.getAllWorkers().has("temp-2")).toBe(true);
    expect(manager.getAllWorkers().has("real-2")).toBe(false);
  });

  it("session_init for an already-realId worker (reopened session) is a no-op re-key", () => {
    const manager = new SessionManager();
    const worker = (manager as any).__testCreateWorker("real-9") as { _emitForTest: (e: any) => void; routingKey: string };
    worker._emitForTest({ type: "session_init", session_id: "real-9" });
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

describe("SessionManager — provider env refresh", () => {
  it("refreshes an existing worker's provider environment and selected model before send", async () => {
    const manager = new SessionManager({ emit: () => {} });
    const worker = (manager as any).getOrCreate("session-1", {
      cmd: "send",
      session_id: "session-1",
      prompt: "first",
      env: {
        ANTHROPIC_BASE_URL: "https://old-gateway",
        ANTHROPIC_API_KEY: "old-key",
        ANTHROPIC_MODEL: "old-model",
      },
    });
    (worker as any).queryFn = (() => (async function* () {})()) as any;
    const replacementEnv = {
      ANTHROPIC_BASE_URL: "https://new-gateway",
      ANTHROPIC_API_KEY: "new-key",
      ANTHROPIC_MODEL: "new-model",
    };

    manager.handleCommand({
      cmd: "send",
      session_id: "session-1",
      prompt: "with image",
      env: replacementEnv,
    } as any);
    await Promise.resolve();

    expect(manager.getAllWorkers().get("session-1")).toBe(worker);
    expect((worker as any).envOverrides).toEqual(replacementEnv);
    expect((worker as any).currentModel).toBe("new-model");
  });
});

describe("SessionWorker — 自动化会话硬停补终态（2026-08-23 蒸馏被误杀回归）", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  function emittedEvents(sid: string): any[] {
    // 必须按 session_id 过滤：文件内前面的测试（provider env 等）起过桩 query，
    // 其异步收官会迟写到 stdout，落进本用例的 spy（单测隔离跑可复现差异）
    // 返回 any[]：调用方按事件字段断言（e.type），JSON.parse 产物本无静态形状。
    return stdoutSpy.mock.calls
      .map((c: unknown[]) => {
        try {
          return JSON.parse(String(c[0])) as { session_id?: string };
        } catch {
          return null;
        }
      })
      .filter((e: { session_id?: string } | null) => e !== null && e.session_id === sid);
  }

  /** 建 worker 并直接塞自动化配置/回合态（绕开 handleSend——它会 startLoop spawn 真 CLI）。 */
  function makeWorker(manager: SessionManager, sid: string, opts: { automation: boolean; midTurn: boolean }) {
    const worker = (manager as any).__testCreateWorker(sid) as any;
    if (opts.automation) {
      worker.automationConfig = {
        taskId: "aut_t",
        runId: "run_t",
        preset: "auto",
        tools: ["*"],
        mcpAllowlist: [],
        taskDir: "",
        sessionDir: "",
        maxTurns: 10,
        maxBudgetUsd: 1,
      };
    }
    worker.turnActive = opts.midTurn;
    return worker;
  }

  it("自动化会话回合中途 stop → 补发 message_stop(interrupted)，调度器能收尾", () => {
    const manager = new SessionManager();
    const worker = makeWorker(manager, "run_1", { automation: true, midTurn: true });
    worker.stop();
    const stops = emittedEvents("run_1").filter((e) => e.type === "message_stop");
    expect(stops).toHaveLength(1);
    expect(stops[0].stop_reason).toBe("interrupted");
    expect(stops[0].session_id).toBe("run_1");
  });

  it("自动化会话空闲时 stop → 不补（自然终态的 message_stop 已发）", () => {
    const manager = new SessionManager();
    const worker = makeWorker(manager, "run_2", { automation: true, midTurn: false });
    worker.stop();
    expect(emittedEvents("run_2").filter((e) => e.type === "message_stop")).toHaveLength(0);
  });

  it("普通会话回合中途 stop → 不补（前端走自己的中断收尾语义）", () => {
    const manager = new SessionManager();
    const worker = makeWorker(manager, "s1", { automation: false, midTurn: true });
    worker.stop();
    expect(emittedEvents("s1").filter((e) => e.type === "message_stop")).toHaveLength(0);
  });
});

/**
 * btw 侧问路由：**查而不建**。
 *
 * 关键不变量：
 * - worker 不存在时直接拒绝，绝不 getOrCreate（老路的兜底 worker 已废弃）
 * - 命中 worker 时原样转发 question/history，返回值透传
 */
describe("SessionManager — btw 侧问路由", () => {
  it("worker 不存在时拒绝，且不新建 worker", async () => {
    const manager = new SessionManager();
    const r = await manager.askSideQuestion("未运行的会话", "问一句", []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("会话未运行");
    expect(manager.getAllWorkers().size).toBe(0); // ← 查而不建
  });

  it("命中 worker 时原样转发 question / history", async () => {
    const manager = new SessionManager();
    const worker = (manager as any).__testCreateWorker("s-1") as any;
    const seen: any[] = [];
    worker.askSideQuestion = async (q: string, h: any[]) => {
      seen.push({ q, h });
      return { ok: true };
    };

    const r = await manager.askSideQuestion("s-1", "问一句", [{ question: "旧", response: "答" }]);
    expect(r).toEqual({ ok: true });
    expect(seen[0].q).toBe("问一句");
    expect(seen[0].h).toEqual([{ question: "旧", response: "答" }]);
  });

  it("worker 的拒绝原因原样回传（不吞错）", async () => {
    const manager = new SessionManager();
    const worker = (manager as any).__testCreateWorker("s-2") as any;
    worker.askSideQuestion = async () => ({ ok: false, reason: "引擎不支持" });

    const r = await manager.askSideQuestion("s-2", "问一句", []);
    expect(r).toEqual({ ok: false, reason: "引擎不支持" });
  });
});

/**
 * btw_ask 命令入口：fire-and-forget（与 send 同形，结果一律走事件通道）。
 *
 * 关键不变量：
 * - 无 worker 时不新建 worker，但**必须广播** btw_answer(error)——否则发起端永远
 *   收不到结果（事件通道是 UI 判定的唯一来源）
 * - 命中 worker 时委派给它，不重复发事件（worker 自己负责）
 */
describe("SessionManager — btw_ask 命令入口", () => {
  it("无 worker：拒绝并存档一条 btw_answer(error) 事件", async () => {
    const emitted: { sid: string; event: any }[] = [];
    const manager = new SessionManager({ emit: (sid, event) => emitted.push({ sid, event }) });

    await manager.handleBtwAsk({ cmd: "btw_ask", session_id: "s-nope", question: "问一句" });

    expect(manager.getAllWorkers().size).toBe(0); // ← 不新建
    expect(emitted).toHaveLength(1);
    expect(emitted[0].sid).toBe("s-nope");
    expect(emitted[0].event).toMatchObject({ type: "btw_answer", question: "问一句" });
    expect(emitted[0].event.error).toContain("会话未运行");
  });

  it("缺 session_id：不崩，也不广播（无处可投）", async () => {
    const emitted: any[] = [];
    const manager = new SessionManager({ emit: (sid, event) => emitted.push({ sid, event }) });
    await expect(
      manager.handleBtwAsk({ cmd: "btw_ask", session_id: "", question: "问一句" }),
    ).resolves.toBeUndefined();
    expect(emitted).toEqual([]);
  });

  it("命中 worker：委派给它，manager 不重复发事件", async () => {
    const emitted: any[] = [];
    const manager = new SessionManager({ emit: (sid, event) => emitted.push({ sid, event }) });
    const worker = (manager as any).__testCreateWorker("s-hit") as any;
    let called = 0;
    worker.askSideQuestion = async () => {
      called++;
      return { ok: true };
    };

    await manager.handleBtwAsk({
      cmd: "btw_ask",
      session_id: "s-hit",
      question: "问一句",
      history: [{ question: "旧", response: "答" }],
    });

    expect(called).toBe(1);
    expect(emitted).toEqual([]); // ← 事件由 worker 发，manager 不越权
  });
});
