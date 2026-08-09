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
    // HookJSONOutput 的 SDK 类型不含 hookSpecificOutput（联合类型成员），运行时有——
    // 本文件其它断言一律走 any，这里保持一致。
    expect((result as any).hookSpecificOutput?.permissionDecisionReason).toContain("不支持图片输入");
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

describe("SessionWorker — btw 回合结束自毁", () => {
  // 回归：btw worker 跑完不退出 → claude.exe 永远挂着 → CLI pid 元数据被
  // list_sessions 扫成侧栏幽灵空会话 + 每条 btw 白占几百 MB（2026-08-02 实锤）。
  it("btw worker self-stops after the single turn's result", async () => {
    const events: any[] = [];
    let selfStopped: SessionWorker | null = null;
    // 模拟真实 streaming-input query：result 之后仍挂着等新输入——自毁必须主动关。
    const hangingQuery = (() => (async function* () {
      yield { type: "system", subtype: "init", session_id: "real-btw" };
      yield {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "结论" }] },
        parent_tool_use_id: null,
      };
      yield { type: "result", subtype: "success", is_error: false };
      await new Promise(() => {}); // 永不 resolve：streaming input 等待中
    })()) as any;
    // 自毁在 result 后 setImmediate 调度；await selfStoppedP 等到自毁完成，
    // 隐含已等过 startLoop 的 await loadAideInstructions + for-await 消费到 result
    // （message_stop 在 result 处理时同步发出，早于 setImmediate 自毁）。
    // 替代固定次数 flushPromises——startLoop 前置 async 步骤一多，固定次数不够
    // 就会让 events 一直为空（pre-existing 失败根因）。
    let resolveStopped!: (w: SessionWorker) => void;
    const selfStoppedP = new Promise<SessionWorker>((r) => { resolveStopped = r; });
    const worker = new SessionWorker("btw-temp", (e) => events.push(e), {
      btwMode: true,
      imageCapabilityCache: new ImageInputCapabilityCache(),
      queryFn: hangingQuery,
      onSelfStop: (w) => { selfStopped = w; resolveStopped(w); },
    });

    worker.handleCommand({
      cmd: "send", session_id: "btw-temp", prompt: "问一句", cwd: "/tmp",
      env: {}, btw: true, fork_from: "main-sid",
    } as any);
    await selfStoppedP;

    // message_stop 先于自毁发出（前端 done 态/插批注依赖它）
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    expect(worker._testIsStopped()).toBe(true);
    expect(selfStopped).toBe(worker);
  });

  it("normal (non-btw) worker does NOT self-stop after result", async () => {
    let selfStopped: SessionWorker | null = null;
    const hangingQuery = (() => (async function* () {
      yield { type: "result", subtype: "success", is_error: false };
      await new Promise(() => {});
    })()) as any;
    const worker = new SessionWorker("s-normal", () => {}, {
      imageCapabilityCache: new ImageInputCapabilityCache(),
      queryFn: hangingQuery,
      onSelfStop: (w) => { selfStopped = w; },
    });

    worker.handleCommand({
      cmd: "send", session_id: "s-normal", prompt: "你好", cwd: "/tmp", env: {}, auto_title: false,
    } as any);
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(worker._testIsStopped()).toBe(false);
    expect(selfStopped).toBeNull();
    worker.stop();
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

  // 2026-08-09 缓存前缀对齐:轻量 btw 是 fork 支线,必须保持与主会话逐字节
  // 一致的请求前缀(mcpServers/skills/plugins/工具列表全注册)才能命中 prompt
  // cache——此前 tools:[] + 全不注册让缓存必崩、每次全价重读主会话历史。
  // 「纯问答」语义改由 policy hook 全 deny + prompt 尾部指令实现(行为层)。
  it("lightweight btw keeps full mcpServers / skills / plugins (cache prefix parity)", async () => {
    let captured: any;
    const fakeQuery = ((args: any) => {
      captured = args?.options ?? args;
      return (async function* () {})();
    }) as any;
    const worker = new SessionWorker("btw-lw", () => {}, {
      btwMode: true,
      lightweightMode: true,
      imageCapabilityCache: new ImageInputCapabilityCache(),
      queryFn: fakeQuery,
      cwd: "/proj",
    });
    worker.handleCommand({
      cmd: "send", session_id: "btw-lw", prompt: "问一句", cwd: "/proj",
      env: {}, btw: true, lightweight: true, fork_from: "main-sid",
    } as any);
    await new Promise((r) => setTimeout(r, 50));
    worker.stop();
    expect(captured?.mcpServers?.["aide-codegraph"]).toBeDefined();
    expect(captured?.tools).toBeUndefined(); // 不动工具列表 = 与主会话一致
    expect(captured?.allowedTools).toEqual(["Agent", "Task", "mcp__aide-codegraph"]);
    expect(captured?.skills).toBe("all");
    expect(captured?.persistSession).toBe(false);
  });

  // btw 任务支线(git-commit):全新会话无缓存可吃,前缀反向最小化——
  // tools/allowedTools 收成白名单,codegraph MCP / skills / plugins 全不注册。
  it("task btw (tools whitelist) minimizes prefix: no MCP / skills / plugins", async () => {
    let captured: any;
    const fakeQuery = ((args: any) => {
      captured = args?.options ?? args;
      return (async function* () {})();
    }) as any;
    const worker = new SessionWorker("btw-task", () => {}, {
      btwMode: true,
      imageCapabilityCache: new ImageInputCapabilityCache(),
      queryFn: fakeQuery,
      cwd: "/proj",
    });
    worker.handleCommand({
      cmd: "send", session_id: "btw-task", prompt: "提交", cwd: "/proj",
      env: {}, btw: true, tools: ["Bash", "Read", "Glob", "Grep"],
      // fork_from 省略 = 全新会话(不 fork 主会话)
    } as any);
    await new Promise((r) => setTimeout(r, 50));
    worker.stop();
    expect(captured?.mcpServers?.["aide-codegraph"]).toBeUndefined();
    expect(captured?.tools).toEqual(["Bash", "Read", "Glob", "Grep"]);
    expect(captured?.allowedTools).toEqual(["Bash", "Read", "Glob", "Grep"]);
    expect(captured?.skills).toEqual([]);
    expect(captured?.plugins).toEqual([]);
    expect(captured?.persistSession).toBe(false);
    expect(captured?.resume).toBeUndefined(); // 不 fork
    expect(captured?.forkSession).toBeUndefined();
  });

  it("full (non-lightweight) btw still registers codegraph MCP", async () => {
    let captured: any;
    const fakeQuery = ((args: any) => {
      captured = args?.options ?? args;
      return (async function* () {})();
    }) as any;
    const worker = new SessionWorker("btw-full", () => {}, {
      btwMode: true,
      lightweightMode: false,
      imageCapabilityCache: new ImageInputCapabilityCache(),
      queryFn: fakeQuery,
      cwd: "/proj",
    });
    worker.handleCommand({
      cmd: "send", session_id: "btw-full", prompt: "问一句", cwd: "/proj",
      env: {}, btw: true, fork_from: "main-sid",
    } as any);
    await new Promise((r) => setTimeout(r, 50));
    worker.stop();
    expect(captured?.mcpServers?.["aide-codegraph"]).toBeDefined();
    expect(captured?.persistSession).toBe(false);
    expect(captured?.tools).toBeUndefined();
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
 * 会话自动命名：全新会话首轮回复开始时（首条主线程 assistant 消息到达），
 * sidecar 用独立的小模型 query 生成标题并发 session_title 事件。
 *
 * 关键不变量：
 * - 只有「全新会话」（非 resume / 非 btw / 非 provider_switched）才生成
 * - auto_title:false（设置关闭）不生成
 * - 每个 worker 只尝试一次
 * - 主对话 query 与标题 query 都是同一个 queryFn：靠 prompt 类型区分
 *   （主对话是 async iterable，标题是一次性 string）
 * - 触发于首条 assistant 消息而非整轮 result（标题仅基于 userText）
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
  it("全新会话首轮回复开始即发出 session_title（不等整轮结束）", async () => {
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

  it("主轮只产 assistant 不产 result 时仍发出标题（钉住提前触发）", async () => {
    // 旧行为在 result 时触发——主轮没有 result 就不会发标题；新行为在首条
    // assistant 消息触发，故即便回复尚未结束（无 result）标题也照发。
    const events: any[] = [];
    const titleMessages = [
      { type: "assistant", message: { content: [{ type: "text", text: "登录修复" }] } },
      { type: "result", subtype: "success" },
    ];
    const queryFn = ((args: any) => {
      const msgs = typeof args.prompt === "string"
        ? titleMessages
        : [
            // 主轮：只产一条主线程 assistant，不产 result（模拟回复进行中）
            {
              type: "assistant",
              parent_tool_use_id: null,
              message: { model: "claude-sonnet-4-5", content: [{ type: "text", text: "好的，我看看。" }] },
            },
          ];
      return (async function* () {
        for (const m of msgs) yield m;
      })();
    }) as any;
    const worker = new SessionWorker("s-title2", (e) => events.push(e), {
      imageCapabilityCache: new ImageInputCapabilityCache(),
      queryFn,
    });
    worker.handleCommand({
      cmd: "send", session_id: "s-title2", prompt: "帮我修登录页 bug", cwd: "/tmp", env: {}, auto_title: true,
    } as any);
    const evt = await waitForEvent(events, "session_title");
    expect(evt).toBeDefined();
    expect(evt.title).toBe("登录修复");
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

  it("empty policy → no opinion (falls back to SDK permission flow, NOT defer)", async () => {
    const { worker } = makeWorker();
    const hook = worker._testPolicyHook("/tmp");
    const out: any = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } } as any);
    // No rule matched → hook must NOT emit permissionDecision. Returning "defer"
    // breaks the claude.exe CLI ("Tool result missing due to internal error"); {}
    // lets the CLI proceed with its normal permission flow (allowDangerouslySkipPermissions).
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
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

describe("SessionWorker — btw 权限守卫(无弹窗通路,一律 deny 不挂起)", () => {
  function makeBtwWorker(opts: { lightweight?: boolean } = {}) {
    const events: any[] = [];
    const worker = new SessionWorker("btw-guard", (e) => events.push(e), {
      btwMode: true,
      lightweightMode: opts.lightweight ?? false,
      imageCapabilityCache: new ImageInputCapabilityCache(),
      queryFn: (() => (async function* () {})()) as any,
      cwd: "/proj",
    });
    return { worker, events };
  }

  it("lightweight btw: policy hook denies EVERY tool instantly (no permission_request)", async () => {
    const { worker, events } = makeBtwWorker({ lightweight: true });
    const hook = worker._testPolicyHook("/proj");
    for (const tool of ["Bash", "Read", "mcp__aide-codegraph__find_symbol"]) {
      const out: any = await hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: {} } as any);
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    }
    expect(events.some((e: any) => e.type === "permission_request")).toBe(false);
    worker.stop();
  });

  it("full btw: policy ask → deny immediately (never reaches permMgr.request)", async () => {
    const { worker, events } = makeBtwWorker();
    worker._testApplyPermissionPolicy(rule("ask", "Bash"));
    const hook = worker._testPolicyHook("/proj");
    const out: any = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } } as any);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(events.some((e: any) => e.type === "permission_request")).toBe(false);
    worker.stop();
  });

  it("btw: canUseTool auto-denies without emitting permission_request", async () => {
    const { worker, events } = makeBtwWorker();
    const cb = worker._testCanUseTool();
    const out: any = await cb("Bash", { command: "rm -rf /" }, {} as any);
    expect(out.behavior).toBe("deny");
    expect(events.some((e: any) => e.type === "permission_request")).toBe(false);
    worker.stop();
  });

  it("btw: session-scope policy allow still passes at the policy layer (git whitelist path)", async () => {
    const { worker } = makeBtwWorker();
    worker._testApplyPermissionPolicy({
      revision: 1,
      rules: [{
        id: "git-status", scope: "session", order: 0, effect: "allow", tool: "Bash",
        matcher: { kind: "bash", mode: "prefix", value: "git status" },
        source: { label: "git-commit-task", readOnly: true },
      }],
    });
    const hook = worker._testPolicyHook("/proj");
    const out: any = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status --short" } } as any);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    worker.stop();
  });

  // 2026-08-09 运行时任真:defer 在 allowDangerouslySkipPermissions 下被 CLI 静默
  // 放行(canUseTool 根本不会被调,ipconfig 在 btw 任务里直接执行)——任务支线的
  // 白名单拦截必须在 policy hook 的 defer 分支完成。
  it("task btw (tools whitelist): defer → deny, not silent allow", async () => {
    const events: any[] = [];
    const worker = new SessionWorker("btw-task-guard", (e) => events.push(e), {
      btwMode: true,
      imageCapabilityCache: new ImageInputCapabilityCache(),
      queryFn: (() => (async function* () {})()) as any,
      cwd: "/proj",
    });
    worker.handleCommand({
      cmd: "send", session_id: "btw-task-guard", prompt: "任务", cwd: "/proj",
      env: {}, btw: true, tools: ["Bash"],
      permission_policy: {
        revision: 1,
        rules: [{
          id: "git-status", scope: "session", order: 0, effect: "allow", tool: "Bash",
          matcher: { kind: "bash", mode: "prefix", value: "git status" },
          source: { label: "git-commit-task", readOnly: true },
        }],
      },
    } as any);
    await flushPromises();
    const hook = worker._testPolicyHook("/proj");
    // 白名单内:allow
    const allow: any = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } } as any);
    expect(allow.hookSpecificOutput.permissionDecision).toBe("allow");
    // 白名单外:defer → deny(不是 {} 放行)
    const deny: any = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ipconfig" } } as any);
    expect(deny.hookSpecificOutput.permissionDecision).toBe("deny");
    worker.stop();
  });

  it("lightweight btw prompt gets the no-tools suffix (prefix parity preserved)", async () => {
    let capturedPrompt: any;
    const worker = new SessionWorker("btw-suffix", () => {}, {
      btwMode: true,
      lightweightMode: true,
      imageCapabilityCache: new ImageInputCapabilityCache(),
      queryFn: ((args: any) => {
        capturedPrompt = args?.prompt;
        return (async function* () {})();
      }) as any,
      cwd: "/proj",
    });
    worker.handleCommand({
      cmd: "send", session_id: "btw-suffix", prompt: "原问题", cwd: "/proj",
      env: {}, btw: true, lightweight: true, fork_from: "main-sid",
    } as any);
    await new Promise((r) => setTimeout(r, 50));
    // prompt 是 queue 的 async iterator——取出第一条 user 消息验证尾部指令
    const iter = (capturedPrompt as AsyncIterable<any>)[Symbol.asyncIterator]();
    const msg = (await iter.next()).value;
    expect(msg.message.content).toContain("原问题");
    expect(msg.message.content).toContain("不要调用任何工具");
    worker.stop();
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

describe("SessionWorker — set_permission_mode acceptEdits flush", () => {
  it("approves pending edit requests and dismisses their dialogs, leaving other tools pending", async () => {
    const { worker, events } = makeWorker();
    const cb = worker._testCanUseTool();
    // 两条挂起请求：一个编辑工具（应被连带放行）、一个 Bash（不应被动）。
    const editDecision = cb("Edit", { file_path: "x.ts" }, {} as any);
    const bashDecision = cb("Bash", { command: "ls" }, {} as any);
    await flushPromises();
    const editReq = events.find((e: any) => e.type === "permission_request" && e.name === "Edit");
    const bashReq = events.find((e: any) => e.type === "permission_request" && e.name === "Bash");
    expect(editReq).toBeTruthy();
    expect(bashReq).toBeTruthy();

    worker.handleCommand({ cmd: "set_permission_mode", session_id: "test-sid", mode: "acceptEdits" } as any);

    // 挂起的 Edit 被放行（对齐「进入编辑模式」按钮语义），弹窗经 permission_cancelled 撤下。
    await expect(editDecision).resolves.toMatchObject({ behavior: "allow" });
    expect(events.some((e: any) => e.type === "permission_cancelled" && e.id === editReq.id)).toBe(true);
    // 模式本身已落账并广播。
    expect(events.some((e: any) => e.type === "permission_modes_available" && e.current === "acceptEdits")).toBe(true);
    // Bash 不在编辑工具集内：仍挂着，既没放行也没撤弹窗。
    expect(events.some((e: any) => e.type === "permission_cancelled" && e.id === bashReq.id)).toBe(false);
    let bashSettled = false;
    void bashDecision.then(() => { bashSettled = true; });
    await flushPromises();
    expect(bashSettled).toBe(false);

    // 收尾：撤掉 Bash 挂起请求，避免悬空 promise。
    worker.handleCommand({ cmd: "interrupt", session_id: "test-sid" } as any);
    await expect(bashDecision).resolves.toMatchObject({ behavior: "deny" });
  });

  it("does not flush pending edits when switching to a non-edit mode", async () => {
    const { worker, events } = makeWorker();
    const cb = worker._testCanUseTool();
    const editDecision = cb("Edit", { file_path: "x.ts" }, {} as any);
    await flushPromises();
    const editReq = events.find((e: any) => e.type === "permission_request" && e.name === "Edit");

    worker.handleCommand({ cmd: "set_permission_mode", session_id: "test-sid", mode: "plan" } as any);
    await flushPromises();

    expect(events.some((e: any) => e.type === "permission_cancelled" && e.id === editReq.id)).toBe(false);
    worker.handleCommand({ cmd: "interrupt", session_id: "test-sid" } as any);
    await expect(editDecision).resolves.toMatchObject({ behavior: "deny" });
  });
});
