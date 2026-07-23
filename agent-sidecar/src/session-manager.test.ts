import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionManager } from "./session-manager.js";
import { ImageInputCapabilityCache } from "./imageInputCapability.js";

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

/**
 * Runtime-level image capability probes must be answered before getOrCreate(),
 * so a Rust preflight can check support without creating or mutating a real chat session.
 */
describe("SessionManager — image input capability probe", () => {
  it("answers image capability probes without creating a session worker", async () => {
    const output: any[] = [];
    const manager = new SessionManager({
      emit: (sessionId, event) => output.push({ session_id: sessionId, ...event }),
      probeImageInput: async () => false,
    });

    manager.handleCommand({
      cmd: "probe_image_input",
      request_id: "p-1",
      model: "glm-5.2",
      env: { ANTHROPIC_BASE_URL: "https://gateway" },
    });
    await vi.waitFor(() => expect(output).toContainEqual({
      session_id: "_runtime",
      type: "image_input_probe_result",
      request_id: "p-1",
      supported: false,
    }));

    expect(manager.getAllWorkers().size).toBe(0);
  });

  it("returns null for probe failures and keeps the stdin command loop alive", async () => {
    const output: any[] = [];
    const manager = new SessionManager({
      emit: (sessionId, event) => output.push({ session_id: sessionId, ...event }),
      probeImageInput: async () => {
        throw new Error("provider probe failed");
      },
    });

    expect(() => manager.handleCommand({
      cmd: "probe_image_input",
      request_id: "p-err",
      env: {},
    })).not.toThrow();
    await vi.waitFor(() => expect(output).toContainEqual({
      session_id: "_runtime",
      type: "image_input_probe_result",
      request_id: "p-err",
      supported: null,
    }));

    expect(manager.getAllWorkers().size).toBe(0);
  });

  it("shares one cache between runtime probes and newly-created workers", async () => {
    const cache = new ImageInputCapabilityCache();
    const manager = new SessionManager({
      emit: () => {},
      imageCapabilityCache: cache,
      probeImageInput: async () => true,
    });

    manager.handleCommand({
      cmd: "probe_image_input",
      request_id: "p-cache",
      model: "vision-model",
      env: { ANTHROPIC_BASE_URL: "https://gateway" },
    });
    await Promise.resolve();

    const worker = manager.__testCreateWorker("temp-cache") as any;
    expect(worker.imageCapabilityCache).toBe(cache);
  });

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
