import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionWorker } from "./session-worker.js";
import { userDenyMessage } from "./permissions.js";
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

/**
 * 用户消息广播（方案 C：三端统一只认事件，不再本地乐观渲染气泡）。
 *
 * 关键不变量：
 * - 模型收到消息 与 各端看见气泡 是同一个动作的两个面（pushUserMessage 保证）
 * - display 原样回灌，text 取原始输入而非展开后的 prompt
 * - 插队消息在真正接入（promote）时才广播，不是登记时
 */
describe("SessionWorker — user_message 广播", () => {
  function workerWithStubbedQueue(sid = "s1") {
    const events: ChatEvent[] = [];
    const worker = new SessionWorker(sid, (e) => events.push(e), {});
    // 拦住 queue.push：不进 SDK 输入流，只验证入队内容
    const pushed: any[] = [];
    (worker.queue as any).push = (m: any) => pushed.push(m);
    return { worker, events, pushed };
  }

  it("首条 send：入队模型输入的同时广播 user_message", async () => {
    const { worker, events, pushed } = workerWithStubbedQueue();
    worker.handleCommand({ cmd: "send", session_id: "s1", prompt: "你好", cwd: "/tmp" } as any);
    await flushPromises();

    // 模型侧：一条 user 输入
    expect(pushed).toHaveLength(1);
    expect(pushed[0].type).toBe("user");
    // UI 侧：广播给所有客户端——远程客户端（手机）发的消息靠这条才在桌面端出现
    expect(events.filter((e) => e.type === "user_message")).toEqual([
      { type: "user_message", text: "你好" },
    ]);
  });

  it("display 原样回灌；text 取原始输入而非展开后的 prompt", async () => {
    const { worker, events } = workerWithStubbedQueue();
    const display = [
      { type: "text", text: "看看这个文件" },
      { type: "mention", path: "src/a.ts", content: "const a = 1;" },
    ];
    worker.handleCommand({
      cmd: "send",
      session_id: "s1",
      // 发给模型的是展开后的完整文本（@引用内容已混进 prompt）
      prompt: "看看这个文件\n<file>const a = 1;</file>",
      display,
      cwd: "/tmp",
    } as any);
    await flushPromises();

    const um: any = events.find((e) => e.type === "user_message");
    expect(um.display).toEqual(display);
    // 关键：只渲染 text 的接收端（鸿蒙 v1）不该看到展开后的那一坨
    expect(um.text).toBe("看看这个文件");
  });

  it("插队消息：登记时不广播，promote 真正接入时才广播", async () => {
    const { worker, events } = workerWithStubbedQueue();
    // 伪造「有活 query + 轮次进行中」以走插队分支
    (worker as any).currentQuery = { interrupt: () => Promise.resolve() };
    (worker as any).turnActive = true;
    worker.handleCommand({
      cmd: "send",
      session_id: "s1",
      prompt: "插队",
      jump_queue: true,
      cwd: "/tmp",
    } as any);
    await flushPromises();
    // 登记阶段只应有提示条事件，不该冒出用户气泡（否则气泡会插在上轮回复中间）
    expect(events.filter((e) => e.type === "user_message")).toHaveLength(0);

    // 安全边界到达 → 接入
    (worker as any).promoteJumpQueue();
    await flushPromises();
    expect(events.filter((e) => e.type === "user_message").map((e: any) => e.text)).toEqual([
      "插队",
    ]);
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
 * 会话目录隔离（2026-09-07 侧栏污染 bug 的根因修复面）。
 *
 * 关键不变量：
 * - `automation.session_dir` 是协议一等字段，解析进 AutomationConfig.sessionDir
 * - 子进程生效配置根 = sessionDir 优先，sidecar 全局兜底（收尾清理/路径解析
 *   必须与启动时一致，否则幽灵注册条目回归）
 */
describe("SessionWorker — automation session_dir（会话目录隔离）", () => {
  it("协议字段 automation.session_dir 解析进配置，收尾跟随它", () => {
    const emptyQuery = (() => (async function* () {})()) as any;
    const { worker } = makeWorker();
    (worker as any).queryFn = emptyQuery;
    worker.handleCommand({
      cmd: "send",
      session_id: "aut-run-1",
      prompt: "做点事",
      cwd: "C:/ws",
      env: {},
      automation: {
        task_id: "aut_t",
        run_id: "run_1",
        tools: ["*"],
        mcp_allowlist: [],
        task_dir: "C:\\Users\\h\\.aide\\automations\\aut_t",
        session_dir: "C:\\Users\\h\\.aide\\scopes\\automation\\aut_t\\claude",
      },
    } as any);
    const cfg = (worker as any).automationConfig;
    expect(cfg.sessionDir).toBe("C:\\Users\\h\\.aide\\scopes\\automation\\aut_t\\claude");
    // 子进程生效配置根跟随协议字段（注册条目/转录都在它下面）
    expect((worker as any).subprocessConfigDir()).toBe(
      "C:\\Users\\h\\.aide\\scopes\\automation\\aut_t\\claude",
    );
    worker.stop();
  });

  it("未下发 session_dir（旧版主进程兼容）→ 收尾跟随 sidecar 全局配置根", () => {
    const emptyQuery = (() => (async function* () {})()) as any;
    const { worker } = makeWorker();
    (worker as any).queryFn = emptyQuery;
    worker.handleCommand({
      cmd: "send",
      session_id: "aut-run-2",
      prompt: "做点事",
      cwd: "C:/ws",
      env: {},
      automation: {
        task_id: "aut_t",
        run_id: "run_2",
        tools: ["*"],
        mcp_allowlist: [],
        task_dir: "",
        // session_dir 省略 = 旧版主进程
      },
    } as any);
    expect((worker as any).automationConfig.sessionDir).toBe("");
    expect((worker as any).subprocessConfigDir()).toBe(process.env.CLAUDE_CONFIG_DIR);
    worker.stop();
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

  it("btw teardown removes the claude.exe registry entry (幽灵会话回归)", async () => {
    // 2026-09-02 实锤：git-commit 支线退场后 sessions/<pid>.json 残留（claude.exe
    // 被强杀不自清），list_sessions 第二遍扫描把它列成侧栏幽灵会话
    // cypress-agent-c6。自毁收尾必须按 sessionId（routingKey 过户后的 realId）删条目。
    const regDir = mkdtempSync(path.join(os.tmpdir(), "btw-reg-"));
    const sessionsDir = path.join(regDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const entry = path.join(sessionsDir, "424242.json");
    writeFileSync(
      entry,
      JSON.stringify({ pid: 424242, sessionId: "real-btw", name: "cypress-agent-c6" }),
      "utf8",
    );
    const other = path.join(sessionsDir, "999.json");
    writeFileSync(other, JSON.stringify({ pid: 999, sessionId: "sid-other" }), "utf8");
    const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = regDir;
    try {
      const hangingQuery = (() => (async function* () {
        yield { type: "system", subtype: "init", session_id: "real-btw" };
        yield { type: "result", subtype: "success", is_error: false };
        await new Promise(() => {}); // streaming-input 等待中，自毁必须主动关
      })()) as any;
      let selfStopped: SessionWorker | null = null;
      // 测试不经 SessionManager——emit 闭包复刻它的 re-key（session_init 到达时
      // routingKey 过户到 realId），这是清理匹配的真实前置链路。
      let worker: SessionWorker;
      worker = new SessionWorker("btw-temp", (e: ChatEvent) => {
        if (e.type === "session_init" && e.session_id !== worker.routingKey) {
          worker.routingKey = e.session_id;
        }
      }, {
        btwMode: true,
        queryFn: hangingQuery,
        onSelfStop: (w) => { selfStopped = w; },
      });

      worker.handleCommand({
        cmd: "send", session_id: "btw-temp", prompt: "提交", cwd: "/tmp",
        env: {}, btw: true, fork_from: "main-sid",
      } as any);
      await flushPromises();
      await flushPromises();
      await flushPromises();

      expect(selfStopped).toBe(worker);
      expect(existsSync(entry)).toBe(false); // 本会话条目已清
      expect(existsSync(other)).toBe(true); // 别的会话条目不动

      // 幂等：自毁后重复触发（stopped 真臂）不得再走清理/回调
      const calls = [] as SessionWorker[];
      (worker as any).onSelfStop = (w: SessionWorker) => { calls.push(w); };
      (worker as any).selfTeardown();
      (worker as any).selfTeardown();
      expect(calls.length).toBe(0);
    } finally {
      if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
      rmSync(regDir, { recursive: true, force: true });
    }
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
      // 生产协议恒发 codegraph_enabled（主进程四处构造点下发）——fixture 同形
      cmd: "send", session_id: "s-cg", prompt: "你好", cwd: "/proj", env: {}, auto_title: false, codegraph_enabled: true,
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
      env: {}, btw: true, lightweight: true, fork_from: "main-sid", codegraph_enabled: true,
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
      env: {}, btw: true, fork_from: "main-sid", codegraph_enabled: true,
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
 * 会话自动命名：全新会话的首条 send 同步截取消息内容作标题并发
 * session_title 事件——纯本地截取，不再调用模型、不等助手回复。
 *
 * 关键不变量：
 * - 只有「全新会话」（非 resume / 非 btw / 非 provider_switched）才生成
 * - auto_title:false（自动化/headless 内部 opt-out）不生成
 * - 每个 worker 只命名一次
 * - 首条消息为空白时不发事件（会话保留默认名）
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

function makeTitleWorker() {
  const events: any[] = [];
  const queryFn = (() => (async function* () {
    for (const m of mainTurnMessages()) yield m;
  })()) as any;
  const worker = new SessionWorker("s-title", (e) => events.push(e), {
    queryFn,
  });
  return { worker, events };
}

describe("SessionWorker — 会话自动命名", () => {
  it("全新会话发送首条消息即发出 session_title（截取消息内容，不等回复）", () => {
    const { worker, events } = makeTitleWorker();
    worker.handleCommand({
      cmd: "send", session_id: "s-title", prompt: "帮我修登录页 bug", cwd: "/tmp", env: {},
    } as any);
    // 标题在 send 时同步产出——不调模型、不等助手回复，无需等待
    const evt = events.find((e) => e.type === "session_title");
    expect(evt).toBeDefined();
    expect(evt.title).toBe("帮我修登录页 bug");
    worker.stop();
  });

  it("标题压缩空白并截到 30 字", () => {
    const { worker, events } = makeTitleWorker();
    worker.handleCommand({
      cmd: "send", session_id: "s-title",
      prompt: "第一行\n第二行   第三行" + "长".repeat(40),
      cwd: "/tmp", env: {},
    } as any);
    const evt = events.find((e) => e.type === "session_title");
    expect(evt).toBeDefined();
    expect([...evt.title].length).toBe(30);
    expect(evt.title.startsWith("第一行 第二行 第三行")).toBe(true);
    worker.stop();
  });

  it("resume 的老会话不生成标题", async () => {
    const { worker, events } = makeTitleWorker();
    worker.handleCommand({
      cmd: "send", session_id: "s-title", prompt: "继续", cwd: "/tmp", env: {},
      resume_session_id: "old-sid",
    } as any);
    // 等主轮跑完（result 已被消费）再断言没有标题事件
    await new Promise((r) => setTimeout(r, 300));
    expect(events.some((e) => e.type === "session_title")).toBe(false);
    worker.stop();
  });

  it("auto_title:false（自动化/headless 内部 opt-out）不生成标题", async () => {
    const { worker, events } = makeTitleWorker();
    worker.handleCommand({
      cmd: "send", session_id: "s-title", prompt: "帮我修登录页 bug", cwd: "/tmp", env: {}, auto_title: false,
    } as any);
    await new Promise((r) => setTimeout(r, 300));
    expect(events.some((e) => e.type === "session_title")).toBe(false);
    worker.stop();
  });

  it("首条消息为空白时静默放弃（不发事件）", async () => {
    const { worker, events } = makeTitleWorker();
    worker.handleCommand({
      cmd: "send", session_id: "s-title", prompt: "   ", cwd: "/tmp", env: {},
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

  it("policy ask → permissionDecision ask：人工确认交还 canUseTool 通道", async () => {
    const { worker, events } = makeWorker();
    worker._testApplyPermissionPolicy(rule("ask", "Bash"));
    const hook = worker._testPolicyHook("/tmp");
    const out: any = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } } as any);
    // 2026-09-08：这里曾 await 用户应答后返回 deny + 用户原话，CLI 把它标成
    // permission-rule 并把原话裸塞进 tool_result（模型读成命令输出）。改为交还
    // CLI 的 canUseTool 通道，拒绝才能落到官方模板 + toolDenialKind:user-rejected。
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    // 应答权已交出：hook 自己不再弹窗（弹窗由 canUseTool 回调发起）
    expect(events.some((e: any) => e.type === "permission_request")).toBe(false);
  });

  it("policy ask 的应答点：canUseTool 批准后 allow", async () => {
    const { worker, events } = makeWorker();
    const cb = worker._testCanUseTool();
    const pending = cb("Bash", { command: "ls" }, {} as any);
    await flushPromises();
    const req: any = events.find((e: any) => e.type === "permission_request");
    expect(req).toBeDefined();
    worker.permMgr.resolve(req.id, true);
    const out: any = await pending;
    expect(out.behavior).toBe("allow");
  });

  it("policy ask 的应答点：canUseTool 拒绝后 deny，理由包进官方外框（绝不裸传）", async () => {
    const { worker, events } = makeWorker();
    const cb = worker._testCanUseTool();
    const withReason = cb("Bash", { command: "ls" }, {} as any);
    await flushPromises();
    const req1: any = events.find((e: any) => e.type === "permission_request");
    worker.permMgr.resolve(req1.id, false, undefined, "别删目录");
    const deny: any = await withReason;
    expect(deny.behavior).toBe("deny");
    expect(deny.decisionClassification).toBe("user_reject");
    expect(deny.message).toBe(userDenyMessage("别删目录"));

    // 无理由时同样带完整外框（STOP 变体）。裸传空串或中文兜底都会让模型把
    // tool_result 正文读成工具输出（正是 2026-09-08 事故的形态）。
    const noReason = cb("Bash", { command: "ls" }, {} as any);
    await flushPromises();
    const reqs = events.filter((e: any) => e.type === "permission_request");
    worker.permMgr.resolve(reqs[reqs.length - 1].id, false);
    expect(await noReason).toEqual({
      behavior: "deny",
      decisionClassification: "user_reject",
      message: userDenyMessage(),
    });
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

  it("AskUserQuestion 的答案经 canUseTool 重塑进 updatedInput", async () => {
    const { worker, events } = makeWorker();
    const cb = worker._testCanUseTool();
    const input = { questions: [{ question: "q", options: [{ label: "a" }] }] };
    const pending = cb("AskUserQuestion", input, {} as any);
    await flushPromises();
    const req = events.find((e: any) => e.type === "permission_request");
    worker.permMgr.resolve(req.id, true, { q: "a" });
    const out: any = await pending;
    expect(out.behavior).toBe("allow");
    expect(out.updatedInput).toEqual({ questions: input.questions, answers: { q: "a" } });
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

  it("permission_response with a message surfaces the deny reason as CLI feedback", async () => {
    const { worker, events } = makeWorker();
    const cb = worker._testCanUseTool();
    const pending = cb("Bash", { command: "rm -rf /tmp/cache" }, {} as any);
    await flushPromises();
    const req = events.find((e: any) => e.type === "permission_request");
    // 拒绝 + 理由：Rust permission_response 命令带 message 字段
    worker.handleCommand({ cmd: "permission_response", session_id: "test-sid", id: req.id, approved: false, message: "别删目录，改成只清空里层的 .tmp 文件" } as any);
    // 理由包进官方 YFe 外框后交给 CLI（SDK 通道不做包装，外框由宿主负责；
    // 2026-09-08：裸理由进工具结果位被模型读成命令输出）
    expect(await pending).toEqual({
      behavior: "deny",
      decisionClassification: "user_reject",
      message: userDenyMessage("别删目录，改成只清空里层的 .tmp 文件"),
    });
  });

  it("permission_response no longer carries always (command shape, no updatedPermissions)", async () => {
    const { worker, events } = makeWorker();
    // send a permission_request via the canUseTool path, then resolve without `always`
    const cb = worker._testCanUseTool();
    const pending = cb("Bash", { command: "ls" }, {} as any);
    await flushPromises();
    const req = events.find((e: any) => e.type === "permission_request");
    // Simulate the Rust permission_response command (no `always` field).
    worker.handleCommand({ cmd: "permission_response", session_id: "test-sid", id: req.id, approved: true } as any);
    const out: any = await pending;
    expect(out.behavior).toBe("allow");
    expect((out as any).updatedPermissions).toBeUndefined();
  });

  it("permission_response with sessionRules auto-allows the same file for the rest of the session", async () => {
    const { worker, events } = makeWorker();
    worker._testApplyPermissionPolicy(rule("ask", "Edit"));
    // 首次调用该文件 → hook 交还 CLI → canUseTool 弹窗
    const cb = worker._testCanUseTool();
    const first = cb("Edit", { file_path: "/tmp/x.ts" }, {} as any);
    await flushPromises();
    const req = events.find((e: any) => e.type === "permission_request");
    expect(req).toBeTruthy();
    // 允许并携带前端推导的会话规则草稿（精确文件 matcher）
    worker.handleCommand({
      cmd: "permission_response", session_id: "test-sid", id: req.id, approved: true,
      sessionRules: [{ effect: "allow", tool: "Edit", matcher: { kind: "path", field: "file_path", file: "/tmp/x.ts" } }],
    } as any);
    const firstOut: any = await first;
    expect(firstOut.behavior).toBe("allow");
    // 再次调用同一文件 → 会话规则命中，hook 直接放行，不再弹 permission_request
    const hook = worker._testPolicyHook("/tmp");
    const out2: any = await hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/tmp/x.ts" } } as any);
    expect(out2.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(events.filter((e: any) => e.type === "permission_request").length).toBe(1);
  });

  it("session rule covers only the exact file — a different file still asks", async () => {
    const { worker, events } = makeWorker();
    worker._testApplyPermissionPolicy(rule("ask", "Edit"));
    const cb = worker._testCanUseTool();
    const first = cb("Edit", { file_path: "/tmp/x.ts" }, {} as any);
    await flushPromises();
    const req = events.find((e: any) => e.type === "permission_request");
    worker.handleCommand({
      cmd: "permission_response", session_id: "test-sid", id: req.id, approved: true,
      sessionRules: [{ effect: "allow", tool: "Edit", matcher: { kind: "path", field: "file_path", file: "/tmp/x.ts" } }],
    } as any);
    await first;
    // 不同文件 → 仍走 ask（交还 canUseTool，hook 这里不再自己弹窗）。
    // pathEqualsFile 走真实 fs（canonicalizeWithTail），等 I/O 落定再断言。
    const hook = worker._testPolicyHook("/tmp");
    const other: any = await hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/tmp/y.ts" } } as any);
    expect(other.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(events.filter((e: any) => e.type === "permission_request").length).toBe(1);
  });

  it("file-family expansion: Write approval auto-allows Edit/MultiEdit on the same file", async () => {
    const { worker, events } = makeWorker();
    worker._testApplyPermissionPolicy(rule("ask", "Write"));
    // Write 新文件 → ask → canUseTool 弹窗，允许（草稿是 Write 工具的精确文件规则）
    const cb = worker._testCanUseTool();
    const first = cb("Write", { file_path: "/tmp/x.ts" }, {} as any);
    await flushPromises();
    const req = events.find((e: any) => e.type === "permission_request");
    worker.handleCommand({
      cmd: "permission_response", session_id: "test-sid", id: req.id, approved: true,
      sessionRules: [{ effect: "allow", tool: "Write", matcher: { kind: "path", field: "file_path", file: "/tmp/x.ts" } }],
    } as any);
    await first;
    const hook = worker._testPolicyHook("/tmp");
    // Edit 同一文件 → 家族规则命中，不再弹窗
    const edit = hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/tmp/x.ts" } } as any);
    await flushPromises();
    const outE: any = await edit;
    expect(outE.hookSpecificOutput.permissionDecision).toBe("allow");
    // MultiEdit 同一文件 → 同样直接放行
    const multi = hook({ hook_event_name: "PreToolUse", tool_name: "MultiEdit", tool_input: { file_path: "/tmp/x.ts" } } as any);
    await flushPromises();
    const outM: any = await multi;
    expect(outM.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(events.filter((e: any) => e.type === "permission_request").length).toBe(1);
  });

  it("file-family expansion keeps NotebookEdit independent", async () => {
    const { worker, events } = makeWorker();
    // Write 与 NotebookEdit 都配 ask 规则（家族只含 Write/Edit/MultiEdit）
    worker._testApplyPermissionPolicy({
      revision: 1,
      rules: [
        { id: "r1", scope: "user", order: 0, effect: "ask", tool: "Write", matcher: { kind: "tool" }, source: { label: "user", readOnly: false } },
        { id: "r2", scope: "user", order: 1, effect: "ask", tool: "NotebookEdit", matcher: { kind: "tool" }, source: { label: "user", readOnly: false } },
      ],
    });
    // Write 放行（家族展开：Edit/Write/MultiEdit 三条同路径规则）
    const cb = worker._testCanUseTool();
    const first = cb("Write", { file_path: "/tmp/x.ipynb" }, {} as any);
    await flushPromises();
    const req = events.find((e: any) => e.type === "permission_request");
    worker.handleCommand({
      cmd: "permission_response", session_id: "test-sid", id: req.id, approved: true,
      sessionRules: [{ effect: "allow", tool: "Write", matcher: { kind: "path", field: "file_path", file: "/tmp/x.ipynb" } }],
    } as any);
    await first;
    const hook = worker._testPolicyHook("/tmp");
    // NotebookEdit 同路径（notebook_path 字段）不在家族内 → 仍问（交还 canUseTool）
    const nb = hook({ hook_event_name: "PreToolUse", tool_name: "NotebookEdit", tool_input: { notebook_path: "/tmp/x.ipynb" } } as any);
    await new Promise((r) => setTimeout(r, 50));
    const nbOut: any = await nb;
    expect(nbOut.hookSpecificOutput.permissionDecision).toBe("ask");
    // hook 不再自己弹窗：全程只弹过 Write 那一次
    expect(events.filter((e: any) => e.type === "permission_request").length).toBe(1);
  });

  it("file-family expansion dedupes across the family (Write then Edit drafts → 3 rules)", async () => {
    const { worker } = makeWorker();
    const writeDraft = { effect: "allow" as const, tool: "Write", matcher: { kind: "path" as const, field: "file_path" as const, file: "/tmp/x.ts" } };
    const editDraft = { effect: "allow" as const, tool: "Edit", matcher: { kind: "path" as const, field: "file_path" as const, file: "/tmp/x.ts" } };
    worker._testApplyPermissionPolicy(rule("ask", "Edit"));
    worker.handleCommand({ cmd: "permission_response", session_id: "test-sid", id: "never", approved: true, sessionRules: [writeDraft] } as any);
    worker.handleCommand({ cmd: "permission_response", session_id: "test-sid", id: "never", approved: true, sessionRules: [editDraft] } as any);
    // Write 展开成 Edit/Write/MultiEdit 三条；Edit 草稿与之逐条去重 → 仍只有 3 条
    expect(worker._testSessionRuleCount()).toBe(3);
  });

  it("duplicate session rules are deduplicated by (tool, matcher) within the family", async () => {
    const { worker, events } = makeWorker();
    worker._testApplyPermissionPolicy(rule("ask", "Edit"));
    const cb = worker._testCanUseTool();
    const draft = { effect: "allow" as const, tool: "Edit", matcher: { kind: "path" as const, field: "file_path" as const, file: "/tmp/x.ts" } };
    // 规则落地前同一文件已有两条挂起请求（并发 Edit），都带相同草稿：
    // 家族展开后固定 3 条（Edit/Write/MultiEdit 各一），重复草稿不新增膨胀
    const p1 = cb("Edit", { file_path: "/tmp/x.ts" }, {} as any);
    const p2 = cb("Edit", { file_path: "/tmp/x.ts" }, {} as any);
    await flushPromises();
    const reqs = events.filter((e: any) => e.type === "permission_request");
    expect(reqs.length).toBe(2);
    worker.handleCommand({ cmd: "permission_response", session_id: "test-sid", id: reqs[0].id, approved: true, sessionRules: [draft] } as any);
    worker.handleCommand({ cmd: "permission_response", session_id: "test-sid", id: reqs[1].id, approved: true, sessionRules: [draft] } as any);
    await Promise.all([p1, p2]);
    expect(worker._testSessionRuleCount()).toBe(3);
  });
});

describe("SessionWorker — set_permission_mode auto flush", () => {
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

    // 真实场景是「手动模式下遇到 Edit 弹窗 → 切 auto」。不能直接发 auto：sidecar
    // 初值即 auto（清单首项），mode 未变会被幂等短路（session-worker.ts:683），
    // 既测不到连带放行也拿不到广播。
    worker.handleCommand({ cmd: "set_permission_mode", session_id: "test-sid", mode: "manual" } as any);
    worker.handleCommand({ cmd: "set_permission_mode", session_id: "test-sid", mode: "auto" } as any);

    // 挂起的 Edit 被放行（对齐「进入自动模式」按钮语义），弹窗经 permission_cancelled 撤下。
    await expect(editDecision).resolves.toMatchObject({ behavior: "allow" });
    expect(events.some((e: any) => e.type === "permission_cancelled" && e.id === editReq.id)).toBe(true);
    // 模式本身已落账并广播。
    expect(events.some((e: any) => e.type === "permission_modes_available" && e.current === "auto")).toBe(true);
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

// ================================================================
// context_usage 事件（SDK 0.3.246 数据扩展）
// ================================================================

async function waitForUsageEvent(events: ChatEvent[]): Promise<ChatEvent | undefined> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const hit = events.find((e) => e.type === "context_usage");
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  return undefined;
}

/** 造一个 yield 一条 result 后挂起的 query mock，getContextUsage 返回 fixture。
 *  挂起是关键：防止 generator 耗尽后 startLoop 的 while 立即发起第二轮 query。 */
function makeUsageWorker(
  events: ChatEvent[],
  getContextUsage: () => Promise<unknown>,
): { worker: SessionWorker; release: () => void } {
  // release! 非空断言：Promise executor 同步执行，gate 构造后必已赋值
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const worker = new SessionWorker("s-usage", (e) => events.push(e), {
    queryFn: (() => {
      const q: any = (async function* () {
        yield { type: "result" };
        await gate;
      })();
      q.getContextUsage = getContextUsage;
      return q;
    }) as any,
  });
  return { worker, release };
}

describe("SessionWorker — context_usage event extension", () => {
  it("透传 raw_max_tokens 与拍平后的 categories，丢弃 SDK color", async () => {
    const events: ChatEvent[] = [];
    const { worker, release } = makeUsageWorker(events, async () => ({
      categories: [
        { name: "System Prompt", tokens: 11_000, color: "#7B61FF" },
        { name: "Tools", tokens: 30_700, color: "#34D399", isDeferred: true },
      ],
      totalTokens: 125_500,
      maxTokens: 160_000,
      rawMaxTokens: 200_000,
      percentage: 62.8,
      gridRows: [],
      model: "test-model",
      memoryFiles: [],
      mcpTools: [],
      agents: [],
    }));
    void worker.startLoop("C:/tmp-ws");
    const ev = (await waitForUsageEvent(events)) as
      | Extract<ChatEvent, { type: "context_usage" }>
      | undefined;
    worker.stop();
    release();
    await flushPromises();

    expect(ev).toBeDefined();
    expect(ev?.raw_max_tokens).toBe(200_000);
    expect(ev?.categories).toEqual([
      { name: "System Prompt", tokens: 11_000, isDeferred: undefined },
      { name: "Tools", tokens: 30_700, isDeferred: true },
    ]);
    // DTO 拍平：SDK 的 color 是 CLI 品牌色，不进核心协议
    expect(JSON.stringify(ev?.categories)).not.toContain("color");
    expect(JSON.stringify(ev)).not.toContain("7B61FF");
  });

  it("getContextUsage 抛错时静默无事件（旧 CLI 降级，与既有约定一致）", async () => {
    const events: ChatEvent[] = [];
    const { worker, release } = makeUsageWorker(events, async () => {
      throw new Error("unsupported");
    });
    void worker.startLoop("C:/tmp-ws");
    // 负断言：等 query 真正跑进 getContextUsage 抛错路径（与 makeUsageWorker
    // 的 result yield 时机一致）后再收，避免慢机上事件晚到假阴。
    await new Promise((r) => setTimeout(r, 150));
    await flushPromises();
    worker.stop();
    release();
    await flushPromises();

    expect(events.some((e) => e.type === "context_usage")).toBe(false);
  });
});
