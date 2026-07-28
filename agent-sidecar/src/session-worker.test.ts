import { describe, it, expect } from "vitest";
import { SessionWorker } from "./session-worker.js";
import { ImageInputCapabilityCache } from "./imageInputCapability.js";
import type { ChatEvent } from "./types.js";
import type { PermissionPolicySnapshot } from "./policy/types.js";

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

/**
 * codegraph MCP 工具注册：SessionWorker 组装的 query options 应带
 * mcpServers["aide-codegraph"] 和 allowedTools 放行前缀；
 * AIDE_CODEGRAPH_TOOLS=off 时整体不注册。
 */

describe("SessionWorker — codegraph MCP registration", () => {
  it("registers aide-codegraph MCP server and allow rule in query options", async () => {
    let captured: any;
    const fakeQuery = ((args: any) => {
      captured = args?.options ?? args;
      return (async function* () {})();
    }) as any;
    const worker = new SessionWorker("s-cg", () => {}, {
      imageCapabilityCache: new ImageInputCapabilityCache(),
      queryFn: fakeQuery,
      cwd: "/proj",
    });
    worker.handleCommand({
      cmd: "send", session_id: "s-cg", prompt: "你好", cwd: "/proj", env: {}, auto_title: false,
    } as any);
    await new Promise((r) => setTimeout(r, 50));
    worker.stop();
    expect(captured?.mcpServers?.["aide-codegraph"]).toBeDefined();
    expect(captured?.allowedTools).toContain("mcp__aide-codegraph");
  });

  it("AIDE_CODEGRAPH_TOOLS=off skips MCP registration", async () => {
    process.env.AIDE_CODEGRAPH_TOOLS = "off";
    try {
      let captured: any;
      const fakeQuery = ((args: any) => {
        captured = args?.options ?? args;
        return (async function* () {})();
      }) as any;
      const worker = new SessionWorker("s-cg-off", () => {}, {
        imageCapabilityCache: new ImageInputCapabilityCache(),
        queryFn: fakeQuery,
        cwd: "/proj",
      });
      worker.handleCommand({
        cmd: "send", session_id: "s-cg-off", prompt: "你好", cwd: "/proj", env: {}, auto_title: false,
      } as any);
      await new Promise((r) => setTimeout(r, 50));
      worker.stop();
      expect(captured?.mcpServers?.["aide-codegraph"]).toBeUndefined();
    } finally {
      delete process.env.AIDE_CODEGRAPH_TOOLS;
    }
  });
});

/**
 * 会话自动命名：全新会话的首个 result 到达后，sidecar 用独立的小模型 query
 * 生成标题并发 session_title 事件。
 *
 * 关键不变量：
 * - 只有「全新会话」（非 resume / 非 btw / 非 provider_switched）才生成
 * - auto_title:false（设置关闭）不生成
 * - 每个 worker 只尝试一次
 * - 主对话 query 与标题 query 都是同一个 queryFn：靠 prompt 类型区分
 *   （主对话是 async iterable，标题是一次性 string）
 */

/** 主对话假 query：产出一条 assistant 文本 + result 后结束。 */
function mainTurnMessages() {
  return [
    {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "好的，我先看一下登录页的代码。" }],
      },
    },
    { type: "result", subtype: "success", is_error: false },
  ];
}

function makeTitleWorker(titleMessages: unknown[]) {
  const events: any[] = [];
  const queryFn = ((args: any) => {
    const msgs = typeof args.prompt === "string" ? titleMessages : mainTurnMessages();
    return (async function* () {
      for (const m of msgs) yield m;
    })();
  }) as any;
  const worker = new SessionWorker("s-title", (e) => events.push(e), {
    imageCapabilityCache: new ImageInputCapabilityCache(),
    queryFn,
  });
  return { worker, events };
}

async function waitForEvent(events: any[], type: string, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = events.find((e) => e.type === type);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  return undefined;
}

describe("SessionWorker — 会话自动命名", () => {
  it("全新会话首轮 result 后发出 session_title", async () => {
    const { worker, events } = makeTitleWorker([
      { type: "assistant", message: { content: [{ type: "text", text: "修复登录 Bug" }] } },
      { type: "result", subtype: "success" },
    ]);
    worker.handleCommand({
      cmd: "send", session_id: "s-title", prompt: "帮我修登录页 bug", cwd: "/tmp", env: {}, auto_title: true,
    } as any);
    const evt = await waitForEvent(events, "session_title");
    expect(evt).toBeDefined();
    expect(evt.title).toBe("修复登录 Bug");
    worker.stop();
  });

  it("resume 的老会话不生成标题", async () => {
    const { worker, events } = makeTitleWorker([
      { type: "assistant", message: { content: [{ type: "text", text: "不该出现" }] } },
      { type: "result", subtype: "success" },
    ]);
    worker.handleCommand({
      cmd: "send", session_id: "s-title", prompt: "继续", cwd: "/tmp", env: {},
      resume_session_id: "old-sid", auto_title: true,
    } as any);
    // 等主轮跑完（result 已被消费）再断言没有标题事件
    await new Promise((r) => setTimeout(r, 300));
    expect(events.some((e) => e.type === "session_title")).toBe(false);
    worker.stop();
  });

  it("auto_title:false（设置关闭）不生成标题", async () => {
    const { worker, events } = makeTitleWorker([
      { type: "assistant", message: { content: [{ type: "text", text: "不该出现" }] } },
      { type: "result", subtype: "success" },
    ]);
    worker.handleCommand({
      cmd: "send", session_id: "s-title", prompt: "帮我修登录页 bug", cwd: "/tmp", env: {}, auto_title: false,
    } as any);
    await new Promise((r) => setTimeout(r, 300));
    expect(events.some((e) => e.type === "session_title")).toBe(false);
    worker.stop();
  });

  it("标题模型回复为空时静默放弃（不发事件）", async () => {
    const { worker, events } = makeTitleWorker([
      { type: "result", subtype: "success" }, // 没有 assistant 文本
    ]);
    worker.handleCommand({
      cmd: "send", session_id: "s-title", prompt: "帮我修登录页 bug", cwd: "/tmp", env: {}, auto_title: true,
    } as any);
    await new Promise((r) => setTimeout(r, 300));
    expect(events.some((e) => e.type === "session_title")).toBe(false);
    worker.stop();
  });
});

// ================================================================
// Task 7: Aide 权限策略 hook + 指令加载
// ================================================================

function rule(effect: "allow" | "ask" | "deny", tool: string): PermissionPolicySnapshot {
  return {
    revision: 1,
    rules: [{
      id: "r1", scope: "user", order: 0, effect, tool,
      matcher: { kind: "tool" },
      source: { label: "user", readOnly: false },
    }],
  };
}

describe("SessionWorker — Aide 权限策略 PreToolUse hook", () => {
  it("policy allow → permissionDecision allow (no confirmation)", async () => {
    const { worker } = makeWorker();
    worker._testApplyPermissionPolicy(rule("allow", "Bash"));
    const hook = worker._testPolicyHook("/tmp");
    const out: any = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } } as any);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(typeof out.hookSpecificOutput.permissionDecisionReason).toBe("string");
  });

  it("policy deny → permissionDecision deny (no confirmation)", async () => {
    const { worker } = makeWorker();
    worker._testApplyPermissionPolicy(rule("deny", "Bash"));
    const hook = worker._testPolicyHook("/tmp");
    const out: any = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } } as any);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("empty policy → defer (falls back to SDK permission mode)", async () => {
    const { worker } = makeWorker();
    const hook = worker._testPolicyHook("/tmp");
    const out: any = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } } as any);
    expect(out.hookSpecificOutput.permissionDecision).toBe("defer");
  });

  it("policy ask emits permission_request and resolves allow when approved", async () => {
    const { worker, events } = makeWorker();
    worker._testApplyPermissionPolicy(rule("ask", "Bash"));
    const hook = worker._testPolicyHook("/tmp");
    const pending = hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } } as any);
    await flushPromises();
    const req = events.find((e: any) => e.type === "permission_request");
    expect(req).toBeDefined();
    worker.permMgr.resolve(req.id, true);
    const out: any = await pending;
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("policy ask resolves deny when the user rejects", async () => {
    const { worker, events } = makeWorker();
    worker._testApplyPermissionPolicy(rule("ask", "Bash"));
    const hook = worker._testPolicyHook("/tmp");
    const pending = hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } } as any);
    await flushPromises();
    const req = events.find((e: any) => e.type === "permission_request");
    worker.permMgr.resolve(req.id, false);
    const out: any = await pending;
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("policy hook applies to Read too (not just authorize-only tools)", async () => {
    const { worker } = makeWorker();
    worker._testApplyPermissionPolicy(rule("deny", "Read"));
    const hook = worker._testPolicyHook("/tmp");
    const out: any = await hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "x.ts" } } as any);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("applyPermissionPolicy ignores lower revisions (no rollback)", async () => {
    const { worker } = makeWorker();
    worker._testApplyPermissionPolicy({ revision: 2, rules: [{ id: "r", scope: "user", order: 0, effect: "deny", tool: "Bash", matcher: { kind: "tool" }, source: { label: "user", readOnly: false } }] });
    worker._testApplyPermissionPolicy({ revision: 1, rules: [] }); // stale — must be ignored
    const hook = worker._testPolicyHook("/tmp");
    const out: any = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} } as any);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny"); // revision 2 still active
  });

  it("policy ask for AskUserQuestion reshapes answers into updatedInput", async () => {
    const { worker, events } = makeWorker();
    worker._testApplyPermissionPolicy(rule("ask", "AskUserQuestion"));
    const hook = worker._testPolicyHook("/tmp");
    const input = { questions: [{ question: "q", options: [{ label: "a" }] }] };
    const pending = hook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: input } as any);
    await flushPromises();
    const req = events.find((e: any) => e.type === "permission_request");
    worker.permMgr.resolve(req.id, true, { q: "a" });
    const out: any = await pending;
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.updatedInput).toEqual({ questions: input.questions, answers: { q: "a" } });
  });
});

describe("SessionWorker — 指令加载（settingSources:[] + preset systemPrompt）", () => {
  it("query options use settingSources:[] and preset+append systemPrompt (no Claude settings.json)", async () => {
    let resolveCapture!: (opts: any) => void;
    const captured = new Promise<any>((r) => { resolveCapture = r; });
    const worker = new SessionWorker("sid", () => {}, {
      cwd: "/tmp",
      imageCapabilityCache: new ImageInputCapabilityCache(),
      queryFn: ((args: any) => {
        resolveCapture(args.options);
        return (async function* () { /* empty generator */ })() as any;
      }) as any,
    });
    worker.handleCommand({ cmd: "send", session_id: "sid", prompt: "hi", cwd: "/tmp", env: {} } as any);
    const opts = await captured;
    expect(opts.settingSources).toEqual([]);
    expect(opts.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" });
    expect(typeof opts.systemPrompt.append).toBe("string");
    // policy hook is registered first on matcher ".*"
    expect(opts.hooks.PreToolUse[0].matcher).toBe(".*");
    worker.stop();
  });

  it("permission_response no longer carries always (command shape, no updatedPermissions)", async () => {
    const { worker, events } = makeWorker();
    // send a permission_request via the policy ask path, then resolve without `always`
    worker._testApplyPermissionPolicy(rule("ask", "Bash"));
    const hook = worker._testPolicyHook("/tmp");
    const pending = hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } } as any);
    await flushPromises();
    const req = events.find((e: any) => e.type === "permission_request");
    // Simulate the Rust permission_response command (no `always` field).
    worker.handleCommand({ cmd: "permission_response", session_id: "test-sid", id: req.id, approved: true } as any);
    const out: any = await pending;
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect((out.hookSpecificOutput as any).updatedPermissions).toBeUndefined();
  });
});
