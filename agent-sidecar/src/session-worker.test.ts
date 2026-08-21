import { describe, it, expect } from "vitest";
import { SessionWorker } from "./session-worker.js";
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
    worker: new SessionWorker(sid, (e) => events.push(e), {}),
    events,
  };
}

async function flushPromises() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("SessionWorker — jump queue", () => {
  it("does not promote a pending jump send after the worker stops", async () => {
    let releaseQuery!: () => void;
    const queryGate = new Promise<void>((resolve) => { releaseQuery = resolve; });
    let markQueryStarted!: () => void;
    const queryStarted = new Promise<void>((resolve) => { markQueryStarted = resolve; });
    const worker = new SessionWorker("s1", () => {}, {
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
    expect(captured?.allowedTools).toEqual(["Agent", "Task", "mcp__aide-codegraph", "mcp__aide-docs"]);
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

  it("permission_response with a message surfaces the deny reason to the SDK", async () => {
    const { worker, events } = makeWorker();
    worker._testApplyPermissionPolicy(rule("ask", "Bash"));
    const hook = worker._testPolicyHook("/tmp");
    const pending = hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf /tmp/cache" } } as any);
    await flushPromises();
    const req = events.find((e: any) => e.type === "permission_request");
    // 拒绝 + 理由：Rust permission_response 命令带 message 字段
    worker.handleCommand({ cmd: "permission_response", session_id: "test-sid", id: req.id, approved: false, message: "别删目录，改成只清空里层的 .tmp 文件" } as any);
    const out: any = await pending;
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    // 用户理由走 permissionDecisionReason 反馈给模型（hook 路径，非 canUseTool 的 message）
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("别删目录，改成只清空里层的 .tmp 文件");
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

  it("permission_response with sessionRules auto-allows the same file for the rest of the session", async () => {
    const { worker, events } = makeWorker();
    worker._testApplyPermissionPolicy(rule("ask", "Edit"));
    const hook = worker._testPolicyHook("/tmp");
    // 首次调用该文件 → ask，弹窗
    const first = hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/tmp/x.ts" } } as any);
    await flushPromises();
    const req = events.find((e: any) => e.type === "permission_request");
    expect(req).toBeTruthy();
    // 允许并携带前端推导的会话规则草稿（精确文件 matcher）
    worker.handleCommand({
      cmd: "permission_response", session_id: "test-sid", id: req.id, approved: true,
      sessionRules: [{ effect: "allow", tool: "Edit", matcher: { kind: "path", field: "file_path", file: "/tmp/x.ts" } }],
    } as any);
    const out: any = await first;
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    // 再次调用同一文件 → 直接放行，不再弹 permission_request
    const second = hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/tmp/x.ts" } } as any);
    await flushPromises();
    const out2: any = await second;
    expect(out2.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(events.filter((e: any) => e.type === "permission_request").length).toBe(1);
  });

  it("session rule covers only the exact file — a different file still asks", async () => {
    const { worker, events } = makeWorker();
    worker._testApplyPermissionPolicy(rule("ask", "Edit"));
    const hook = worker._testPolicyHook("/tmp");
    const first = hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/tmp/x.ts" } } as any);
    await flushPromises();
    const req = events.find((e: any) => e.type === "permission_request");
    worker.handleCommand({
      cmd: "permission_response", session_id: "test-sid", id: req.id, approved: true,
      sessionRules: [{ effect: "allow", tool: "Edit", matcher: { kind: "path", field: "file_path", file: "/tmp/x.ts" } }],
    } as any);
    await first;
    // 不同文件 → 仍走 ask。pathEqualsFile 走真实 fs（canonicalizeWithTail），
    // 单次 setImmediate 不够，等 I/O 落定再查事件。
    const other = hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/tmp/y.ts" } } as any);
    await new Promise((r) => setTimeout(r, 50));
    const reqs = events.filter((e: any) => e.type === "permission_request");
    expect(reqs.length).toBe(2);
    // 收尾：拒绝第二条挂起请求，避免测试悬挂
    worker.handleCommand({ cmd: "permission_response", session_id: "test-sid", id: reqs[1].id, approved: false } as any);
    await other;
  });

  it("duplicate session rules are deduplicated by (tool, matcher)", async () => {
    const { worker, events } = makeWorker();
    worker._testApplyPermissionPolicy(rule("ask", "Edit"));
    const hook = worker._testPolicyHook("/tmp");
    const draft = { effect: "allow" as const, tool: "Edit", matcher: { kind: "path" as const, field: "file_path" as const, file: "/tmp/x.ts" } };
    // 规则落地前同一文件已有两条挂起请求（并发 Edit），都带相同草稿 → 只存一条
    const p1 = hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/tmp/x.ts" } } as any);
    const p2 = hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/tmp/x.ts" } } as any);
    await flushPromises();
    const reqs = events.filter((e: any) => e.type === "permission_request");
    expect(reqs.length).toBe(2);
    worker.handleCommand({ cmd: "permission_response", session_id: "test-sid", id: reqs[0].id, approved: true, sessionRules: [draft] } as any);
    worker.handleCommand({ cmd: "permission_response", session_id: "test-sid", id: reqs[1].id, approved: true, sessionRules: [draft] } as any);
    await Promise.all([p1, p2]);
    expect(worker._testSessionRuleCount()).toBe(1);
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

describe("SessionWorker — 思考开关（send.thinking_enabled → spawn thinking 参数）", () => {
  async function captureSend(cmd: any, extraOpts: Record<string, unknown> = {}) {
    let captured: any;
    const fakeQuery = ((args: any) => {
      captured = args?.options ?? args;
      return (async function* () {})();
    }) as any;
    const worker = new SessionWorker("s-th", () => {}, {
      queryFn: fakeQuery,
      cwd: "/proj",
      ...extraOpts,
    });
    worker.handleCommand({
      cmd: "send", session_id: "s-th", prompt: "hi", cwd: "/proj", env: {},
      ...cmd,
    } as any);
    await new Promise((r) => setTimeout(r, 50));
    worker.stop();
    return captured;
  }

  it("缺省（未下发）→ adaptive + summarized（默认开）", async () => {
    const captured = await captureSend({});
    expect(captured.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("thinking_enabled:false → thinking: disabled", async () => {
    const captured = await captureSend({ thinking_enabled: false });
    expect(captured.thinking).toEqual({ type: "disabled" });
  });

  it("thinking_enabled:true → adaptive + summarized", async () => {
    const captured = await captureSend({ thinking_enabled: true });
    expect(captured.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("btw 支线恒关思考（轻量定位，与旧 low→disabled 等价），开关开启也不例外", async () => {
    const captured = await captureSend(
      { btw: true, lightweight: true, thinking_enabled: true },
      { btwMode: true, lightweightMode: true },
    );
    expect(captured.thinking).toEqual({ type: "disabled" });
  });
});
