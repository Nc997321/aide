import { describe, it, expect } from "vitest";
import { SessionWorker } from "./session-worker.js";
import { ImageInputCapabilityCache } from "./imageInputCapability.js";
import type { ChatEvent } from "./types.js";

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
    worker: new SessionWorker(sid, (e) => events.push(e), {
      imageCapabilityCache: new ImageInputCapabilityCache(),
    }),
    events,
  };
}

async function flushPromises() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function imageProbeQuery(supported: true | false | null) {
  return (() => (async function* () {
    if (supported === null) return;
    yield supported
      ? { type: "result", subtype: "success", is_error: false }
      : {
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          api_error_status: 400,
          result: "This model does not support image input.",
        };
  })()) as any;
}

function controllableImageProbeQuery(onProbeStart: () => void, probeGate: Promise<void>) {
  return (() => (async function* () {
    onProbeStart();
    await probeGate;
    yield { type: "result", subtype: "success", is_error: false };
  })()) as any;
}

function makeWorkerWithImageCapability(supported: true | false | null) {
  const events: any[] = [];
  const worker = new SessionWorker("s1", (e) => events.push(e), {
    imageCapabilityCache: new ImageInputCapabilityCache(),
    queryFn: imageProbeQuery(supported),
  });
  return { worker, events };
}

function makeWorkerWithControllableImageProbe() {
  const events: any[] = [];
  let resolveProbeStarted!: () => void;
  const probeStarted = new Promise<void>((resolve) => {
    resolveProbeStarted = resolve;
  });
  let releaseProbe!: () => void;
  const probeGate = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  const worker = new SessionWorker("s1", (e) => events.push(e), {
    imageCapabilityCache: new ImageInputCapabilityCache(),
    queryFn: controllableImageProbeQuery(() => resolveProbeStarted(), probeGate),
  });
  return { worker, events, probeStarted, releaseProbe };
}

describe("SessionWorker — image input capability guard", () => {
  it("denies an image Read via the PreToolUse hook when the model is unsupported", async () => {
    const { worker, events } = makeWorkerWithImageCapability(false);
    const hook = worker._testImageGuardHook();
    const result = await hook(
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "C:/repo/diagram.PNG" }, tool_use_id: "tu1" } as any,
      "tu1",
      { signal: new AbortController().signal } as any,
    );

    expect(result).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
    expect(result!.hookSpecificOutput!.permissionDecisionReason).toContain("不支持图片输入");
    expect(events.some((event) => event.type === "permission_request")).toBe(false);
  });

  it("the hook allows an image Read when supported or inconclusive (no deny)", async () => {
    const supported = makeWorkerWithImageCapability(true);
    const r1 = await supported.worker._testImageGuardHook()(
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "diagram.png" }, tool_use_id: "tu1" } as any,
      "tu1",
      { signal: new AbortController().signal } as any,
    );
    expect(r1).toEqual({});

    const unknown = makeWorkerWithImageCapability(null);
    const r2 = await unknown.worker._testImageGuardHook()(
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "diagram.png" }, tool_use_id: "tu2" } as any,
      "tu2",
      { signal: new AbortController().signal } as any,
    );
    expect(r2).toEqual({});
  });

  it("the hook allows a text Read without probing (non-image path)", async () => {
    const { worker } = makeWorkerWithImageCapability(false);
    const result = await worker._testImageGuardHook()(
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "README.md" }, tool_use_id: "tu1" } as any,
      "tu1",
      { signal: new AbortController().signal } as any,
    );
    expect(result).toEqual({});
  });

  it("preserves the existing canUseTool permission flow for text Read", async () => {
    const text = makeWorkerWithImageCapability(false);
    void text.worker._testCanUseTool()("Read", { file_path: "README.md" }, {});
    expect(text.events[0]?.type).toBe("permission_request");
  });

  it("does not enqueue a direct image attachment when the capability probe rejects it", async () => {
    const { worker, events } = makeWorkerWithImageCapability(false);
    worker.handleCommand({
      cmd: "send",
      session_id: "s1",
      prompt: "看看这张图",
      images: [{ data: "not-used", mediaType: "image/png" }],
      env: {},
    } as any);
    await flushPromises();

    expect(worker._testQueueLength()).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: "image_input_rejected",
    }));
  });

  it("does not mutate the jump queue for rejected image attachments", async () => {
    const { worker, events } = makeWorkerWithImageCapability(false);
    (worker as any).currentQuery = { interrupt: async () => {} };
    (worker as any).turnActive = true;

    worker.handleCommand({
      cmd: "send",
      session_id: "s1",
      prompt: "插队看图",
      jump_queue: true,
      images: [{ data: "not-used", mediaType: "image/png" }],
      env: {},
    } as any);
    await flushPromises();

    expect(worker.jumpQueueCtl.has()).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "image_input_rejected",
    }));
  });

  it("keeps the existing direct image send path when the capability probe is inconclusive", async () => {
    const { worker, events } = makeWorkerWithImageCapability(null);

    worker.handleCommand({
      cmd: "send",
      session_id: "s1",
      prompt: "看看这张图",
      images: [{ data: "not-used", mediaType: "image/png" }],
      env: {},
    } as any);
    await flushPromises();

    expect(worker._testQueueLength()).toBe(1);
    expect(events.some((event) => event.type === "image_input_rejected")).toBe(false);
  });

  it("keeps an earlier image send ahead of a later text send while the probe is pending", async () => {
    const { worker, probeStarted, releaseProbe } = makeWorkerWithControllableImageProbe();
    const pushed: string[] = [];
    (worker.queue as any).push = (msg: any) => {
      const content = msg.message.content;
      pushed.push(Array.isArray(content)
        ? `image:${content.find((block: any) => block.type === "text")?.text ?? ""}`
        : `text:${content}`);
    };
    (worker as any).currentQuery = {};
    (worker as any).turnActive = true;

    worker.handleCommand({
      cmd: "send",
      session_id: "s1",
      prompt: "图片先来",
      images: [{ data: "not-used", mediaType: "image/png" }],
      env: {},
    } as any);
    await probeStarted;

    worker.handleCommand({
      cmd: "send",
      session_id: "s1",
      prompt: "后来的文本",
      env: {},
    } as any);

    expect(pushed).toEqual([]);

    releaseProbe();
    await flushPromises();

    expect(pushed).toEqual(["image:图片先来", "text:后来的文本"]);
  });

  it("uses the selected model from the session environment for its image probe", async () => {
    const previousModel = process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_MODEL = "runtime-default";
    const requests: any[] = [];
    const queryFn = ((request: any) => {
      requests.push(request);
      return (async function* () {
        yield { type: "result", subtype: "success", is_error: false };
      })();
    }) as any;
    const worker = new SessionWorker("s1", () => {}, {
      envOverrides: { ANTHROPIC_MODEL: "selected-vision-model" },
      imageCapabilityCache: new ImageInputCapabilityCache(),
      queryFn,
    });

    try {
      worker.handleCommand({
        cmd: "send",
        session_id: "s1",
        prompt: "看看这张图",
        images: [{ data: "not-used", mediaType: "image/png" }],
        env: { ANTHROPIC_MODEL: "selected-vision-model" },
      } as any);
      await flushPromises();

      expect(requests.find((request) => request.options.persistSession === false)?.options.model)
        .toBe("selected-vision-model");
    } finally {
      if (previousModel === undefined) delete process.env.ANTHROPIC_MODEL;
      else process.env.ANTHROPIC_MODEL = previousModel;
    }
  });

  it("does not admit an image send when the worker stops during its probe", async () => {
    const { worker, probeStarted, releaseProbe } = makeWorkerWithControllableImageProbe();
    const pushed: unknown[] = [];
    (worker.queue as any).push = (message: unknown) => pushed.push(message);

    worker.handleCommand({
      cmd: "send",
      session_id: "s1",
      prompt: "关闭前的图片",
      images: [{ data: "not-used", mediaType: "image/png" }],
      env: {},
    } as any);
    await probeStarted;

    worker.stop();
    releaseProbe();
    await flushPromises();

    expect(pushed).toEqual([]);
  });

  it("does not promote a pending jump send after the worker stops", async () => {
    let releaseQuery!: () => void;
    const queryGate = new Promise<void>((resolve) => { releaseQuery = resolve; });
    let markQueryStarted!: () => void;
    const queryStarted = new Promise<void>((resolve) => { markQueryStarted = resolve; });
    const worker = new SessionWorker("s1", () => {}, {
      imageCapabilityCache: new ImageInputCapabilityCache(),
      queryFn: (() => (async function* () {
        markQueryStarted();
        await queryGate;
        throw new Error("query cancelled");
      })()) as any,
    });
    const pushed: unknown[] = [];
    (worker.queue as any).push = (message: unknown) => pushed.push(message);

    void worker.startLoop();
    await queryStarted;
    worker.jumpQueueCtl.request({ prompt: "不应在关闭后发送" });
    worker.stop();
    releaseQuery();
    await flushPromises();

    expect(pushed).toEqual([]);
  });
});

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

  it("stop() sets stopped flag (startLoop must exit before spawning)", () => {
    const { worker } = makeWorker();
    expect(worker._testIsStopped()).toBe(false);
    worker.stop();
    expect(worker._testIsStopped()).toBe(true);
  });

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
});
