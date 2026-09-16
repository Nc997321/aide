import { describe, it, expect, vi, afterAll } from "vitest";
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
 * 2026-09-14 事故回归：「余额不足（HTTP 402）」等错误终态之后重发，界面永远停在
 * 「正在思考」，CLI 起来了却一句话不说。
 *
 * 现场形态：错误终态让循环 break 退出，但本轮输入迭代器仍挂在 MessageQueue 的
 * resolveNext 上成了孤儿。用户重发时 startLoop 先在 prepareQueryContext 处 await
 * （新迭代器还没建），pushUserMessage 已经把消息落进共享队列 → 唤醒的是孤儿 →
 * 消息被它 shift 走，新 query 的输入流永远是空的 → CLI 干等 stdin，一条事件都不发。
 * 与 2026-08-21「abort 后注入丢失」是同一机制，当时只让回滚注入绕开共享队列，
 * 正常续发路径一直裸奔。
 */
describe("SessionWorker — 错误终态后的孤儿输入迭代器", () => {
  /** 轮询到条件成立或超时——失败要给断言差异，不是挂死等超时。 */
  async function until(pred: () => boolean, ms = 1500): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!pred() && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    return pred();
  }

  it("错误终止后重发：消息必须到达新 query（不得被上一轮的孤儿迭代器吞掉）", async () => {
    const received: string[] = [];
    let round = 0;
    const worker = new SessionWorker("s1", () => {}, {
      // 真 SDK 输入泵的形态：收下一条后继续挂着等输入。刻意不用 for await——
      // 它退出时会自动 return() 把迭代器收干净，而现场是「没人收的孤儿」。
      queryFn: ((args: any) => (async function* () {
        round += 1;
        const myRound = round;
        const input = (args.prompt as AsyncIterable<any>)[Symbol.asyncIterator]();
        const first = await input.next();
        received.push(`r${myRound}:${first.value.message.content}`);
        if (myRound === 1) {
          void input.next();                  // 挂着等输入 → 停在 resolveNext
          throw new Error("query 异常终止（等价 402 错误终态）");
        }
        void input.next();
      })()) as any,
    });

    worker.handleCommand({ cmd: "send", session_id: "s1", prompt: "第一条", cwd: "/tmp" } as any);
    await until(() => received.length >= 1);

    worker.handleCommand({ cmd: "send", session_id: "s1", prompt: "继续", cwd: "/tmp" } as any);
    await until(() => received.length >= 2);

    expect(received).toEqual(["r1:第一条", "r2:继续"]);
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

describe("SessionWorker — 一次性会话回合结束自毁（automation）", () => {
  // 回归：一次性 worker 跑完不退出 → claude.exe 永远挂着 → CLI pid 元数据被
  // list_sessions 扫成侧栏幽灵空会话且白占几百 MB（2026-08-02 实锤）。
  // 侧问（btw）现在跑在主会话进程内、没有独立 worker，这里只剩 automation 形态。
  it("automation worker self-stops after the single turn's result", async () => {
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
      queryFn: hangingQuery,
      onSelfStop: (w) => { selfStopped = w; resolveStopped(w); },
    });

    worker.handleCommand({
      cmd: "send", session_id: "btw-temp", prompt: "问一句", cwd: "/tmp",
      env: {},
      automation: { task_id: "t", run_id: "r", tools: ["*"], mcp_allowlist: [] },
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
        queryFn: hangingQuery,
        onSelfStop: (w) => { selfStopped = w; },
      });

      worker.handleCommand({
        cmd: "send", session_id: "btw-temp", prompt: "提交", cwd: "/tmp",
        env: {},
        // session_dir 指到本用例的临时配置根：注册条目清理跟随它
        automation: {
          task_id: "t", run_id: "r", tools: ["*"], mcp_allowlist: [],
          session_dir: regDir,
        },
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
    await vi.waitFor(() => expect(captured).toBeDefined());
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
        queryFn: fakeQuery,
        cwd: "/proj",
      });
      worker.handleCommand({
        cmd: "send", session_id: "s-cg-off", prompt: "你好", cwd: "/proj", env: {}, auto_title: false,
      } as any);
      await vi.waitFor(() => expect(captured).toBeDefined());
      worker.stop();
      expect(captured?.mcpServers?.["aide-codegraph"]).toBeUndefined();
    } finally {
      delete process.env.AIDE_CODEGRAPH_TOOLS;
    }
  });
});

/**
 * knowledge MCP 放行规则：**工具级**（mcp__aide-knowledge__xxx）而非 server 级
 * （mcp__aide-knowledge）。server 级规则会把 P2 的写工具一起放行，破坏「写必弹窗」
 * （设计 spec §7）——P1 只有读工具，这条断言就是 P2 的防回归网。
 */
describe("SessionWorker — knowledge MCP 放行规则（工具级）", () => {
  it("knowledge 写工具不在 allowedTools（写必弹窗）", async () => {
    // 复用上面 lightweight btw 用例的捕获方式
    let captured: any;
    const fakeQuery = ((args: any) => {
      captured = args?.options ?? args;
      return (async function* () {})();
    }) as any;
    const worker = new SessionWorker("kb-write-rule", () => {}, { queryFn: fakeQuery, cwd: "/proj" });
    worker.handleCommand({
      cmd: "send", session_id: "kb-write-rule", prompt: "你好", cwd: "/proj", env: {}, codegraph_enabled: true,
    } as any);
    await vi.waitFor(() => expect(captured).toBeDefined());
    worker.stop();
    const rules: string[] = captured?.allowedTools ?? [];
    for (const r of rules) expect(r).not.toBe("mcp__aide-knowledge");
    expect(rules).not.toContain("mcp__aide-knowledge__create_document");
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
    worker.permMgr.resolve(req.id, { kind: "approve" });
    const out: any = await pending;
    expect(out.behavior).toBe("allow");
  });

  it("policy ask 的应答点：canUseTool 拒绝后 deny，理由包进官方外框（绝不裸传）", async () => {
    const { worker, events } = makeWorker();
    const cb = worker._testCanUseTool();
    const withReason = cb("Bash", { command: "ls" }, {} as any);
    await flushPromises();
    const req1: any = events.find((e: any) => e.type === "permission_request");
    worker.permMgr.resolve(req1.id, { kind: "deny", message: "别删目录" });
    const deny: any = await withReason;
    expect(deny.behavior).toBe("deny");
    expect(deny.decisionClassification).toBe("user_reject");
    expect(deny.message).toBe(userDenyMessage("别删目录"));

    // 无理由时同样带完整外框（STOP 变体）。裸传空串或中文兜底都会让模型把
    // tool_result 正文读成工具输出（正是 2026-09-08 事故的形态）。
    const noReason = cb("Bash", { command: "ls" }, {} as any);
    await flushPromises();
    const reqs = events.filter((e: any) => e.type === "permission_request");
    worker.permMgr.resolve(reqs[reqs.length - 1].id, { kind: "deny" });
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
    worker.permMgr.resolve(req.id, { kind: "answer", answers: { q: "a" } });
    const out: any = await pending;
    expect(out.behavior).toBe("allow");
    expect(out.updatedInput).toEqual({ questions: input.questions, answers: { q: "a" } });
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

  // ---- 标签形态（官方推荐；headless 网关用）走完整命令通道 ----

  it("标签形态 unanswered：走官方非人工外框、不冒充用户，且不发 error 帧", async () => {
    const { worker, events } = makeWorker();
    const cb = worker._testCanUseTool();
    const pending = cb("Bash", { command: "ls" }, {} as any);
    await flushPromises();
    const req = events.find((e: any) => e.type === "permission_request");
    worker.handleCommand({
      cmd: "permission_response",
      session_id: "test-sid",
      id: req.id,
      response: { kind: "unanswered", reason: "确认超时，操作未执行" },
    } as any);
    const out: any = await pending;
    expect(out.behavior).toBe("deny");
    expect(out.message).toContain("requires interactive approval");
    expect(out.message).toContain("确认超时，操作未执行");
    // 不冒充用户：SDK 类型只有 user_* 三值，省略而不是填 user_reject
    expect(out.decisionClassification).toBeUndefined();
    expect(events.filter((e: any) => e.type === "error")).toEqual([]);
  });

  it("标签形态 answer：作答重塑进 updatedInput（完整通道）", async () => {
    const { worker, events } = makeWorker();
    const cb = worker._testCanUseTool();
    const input = { questions: [{ question: "q", options: [{ label: "a" }] }] };
    const pending = cb("AskUserQuestion", input, {} as any);
    await flushPromises();
    const req = events.find((e: any) => e.type === "permission_request");
    worker.handleCommand({
      cmd: "permission_response",
      session_id: "test-sid",
      id: req.id,
      response: { kind: "answer", answers: { q: "a" } },
    } as any);
    const out: any = await pending;
    expect(out.behavior).toBe("allow");
    expect(out.updatedInput).toEqual({ questions: input.questions, answers: { q: "a" } });
  });

  it("标签形态 approve + sessionRules：规则入库（标签与扁平走同一条附随路径）", async () => {
    const { worker, events } = makeWorker();
    worker._testApplyPermissionPolicy(rule("ask", "Edit"));
    const cb = worker._testCanUseTool();
    const first = cb("Edit", { file_path: "/tmp/x.ts" }, {} as any);
    await flushPromises();
    const req = events.find((e: any) => e.type === "permission_request");
    worker.handleCommand({
      cmd: "permission_response",
      session_id: "test-sid",
      id: req.id,
      response: {
        kind: "approve",
        sessionRules: [
          { effect: "allow" as const, tool: "Edit", matcher: { kind: "path" as const, field: "file_path" as const, file: "/tmp/x.ts" } },
        ],
      },
    } as any);
    expect(((await first) as any).behavior).toBe("allow");
    // 第二次同文件：规则已入库 → hook 直接放行，不再弹权限请求
    const hook = worker._testPolicyHook("/tmp");
    const out: any = await hook({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/x.ts" },
    } as any);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("类别不匹配（answer × Bash）：工具被拒 + 非致命 error 帧让对端看见（N1）", async () => {
    const { worker, events } = makeWorker();
    const cb = worker._testCanUseTool();
    const pending = cb("Bash", { command: "ls" }, {} as any);
    await flushPromises();
    const req = events.find((e: any) => e.type === "permission_request");
    worker.handleCommand({
      cmd: "permission_response",
      session_id: "test-sid",
      id: req.id,
      response: { kind: "answer", answers: { q: "a" } },
    } as any);
    const out: any = await pending;
    // fail-closed：语义不成立的应答绝不放行工具
    expect(out.behavior).toBe("deny");
    expect(out.message).toContain("requires interactive approval");
    const err = events.find((e: any) => e.type === "error") as any;
    expect(err).toBeDefined();
    expect(err.fatal).toBe(false); // 非致命：会话仍可用
    expect(err.message).toContain("permission_response");
  });

  it("未知 / 迟到 id 的标签应答保持静默（幂等，不当错误报）", async () => {
    const { worker, events } = makeWorker();
    worker.handleCommand({
      cmd: "permission_response",
      session_id: "test-sid",
      id: "never",
      response: { kind: "deny" },
    } as any);
    expect(events.filter((e: any) => e.type === "error")).toEqual([]);
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
    await vi.waitFor(() => expect(captured).toBeDefined());
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
});

describe("SessionWorker — 输出样式（send.output_style → 建 query 后 applyFlagSettings）", () => {
  /** 伪 query 挂 applyFlagSettings 探针，并按时间顺序记录「应用样式」与「CLI 开始
   *  拉取首条 prompt」两个时刻——只断言 spawn 选项不够：本特性整条链的失效模式是
   *  「静默不生效」，必须证明控制请求真的发出去了、且早于首轮。 */
  async function captureOutputStyle(cmd: any) {
    const applied: any[] = [];
    const order: string[] = [];
    let captured: any;
    const fakeQuery = ((args: any) => {
      captured = args?.options ?? args;
      const prompt = args.prompt;
      const gen: any = (async function* () {
        order.push("prompt-pulled");
        // 只标记拉取时刻，不消费语义（真实消费由 startLoop 的消息循环负责）
        for await (const _msg of prompt) { /* 空体：仅为触发拉取 */ }
      })();
      gen.applyFlagSettings = async (settings: any) => {
        order.push("apply-style");
        applied.push(settings);
      };
      return gen;
    }) as any;
    const worker = new SessionWorker("s-os", () => {}, { queryFn: fakeQuery, cwd: "/proj" });
    worker.handleCommand({
      cmd: "send", session_id: "s-os", prompt: "hi", cwd: "/proj", env: {},
      ...cmd,
    } as any);
    await vi.waitFor(() => expect(captured).toBeDefined());
    await flushPromises();
    worker.stop();
    return { applied, order };
  }

  it("output_style:Explanatory → applyFlagSettings({ outputStyle })", async () => {
    const { applied } = await captureOutputStyle({ output_style: "Explanatory" });
    expect(applied).toEqual([{ outputStyle: "Explanatory" }]);
  });

  it("默认值 / 值域外 / 缺省 → 一次都不调（不发控制请求）", async () => {
    // 三条都归一到 null：默认值不下发、未知值当默认、缺席即默认。
    expect((await captureOutputStyle({ output_style: "default" })).applied).toEqual([]);
    expect((await captureOutputStyle({ output_style: "Turbo" })).applied).toEqual([]);
    expect((await captureOutputStyle({})).applied).toEqual([]);
  });

  it("时序：样式在建 query 时应用，早于 CLI 拉走首条 prompt", async () => {
    // 这条把「不能挪到 session_init 之后」从注释变成可回归的不变式——晚一步则
    // 第一条消息吃不到样式（整条链唯一难自查的失败模式）。
    const { order } = await captureOutputStyle({ output_style: "Learning" });
    expect(order).toEqual(["apply-style", "prompt-pulled"]);
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

/**
 * F3：错误终态（in-band error result）终止 query 循环——存活 query 的 env/注入头
 * 随 spawn 固化，续发只会喂僵尸 CLI（死端点 error 后同 worker 续发永不重连 MCP）。
 * 良性打断豁免：interrupt 后原 query 必须存活（B5 契约）。
 */
describe("SessionWorker — 错误终态终止循环（F3）", () => {
  function makeQuery(behavior: "error" | "benign") {
    const state = { spawns: 0, closes: 0 };
    const queryFn = (() => {
      state.spawns++;
      const gen = (async function* () {
        yield behavior === "error"
          ? { type: "result", subtype: "error_during_execution", is_error: true, errors: ["API Error: 500"] }
          : { type: "result", subtype: "error_during_execution" }; // 无错误细节 = 良性打断形状
        await new Promise(() => {}); // 模拟 streaming-input CLI 挂住不自退
      })();
      (gen as any).close = () => { state.closes++; };
      return gen;
    }) as any;
    return { state, queryFn };
  }
  const send = (sid: string, prompt: string) =>
    ({ cmd: "send", session_id: sid, prompt, cwd: "/tmp", env: {}, auto_title: false }) as any;

  it("error result → 错误帧发出 + close 旧 query + currentQuery 置空；下一条 send 重启新 query", async () => {
    const { state, queryFn } = makeQuery("error");
    const events: ChatEvent[] = [];
    const worker = new SessionWorker("s-f3", (e) => events.push(e), { queryFn });
    worker.handleCommand(send("s-f3", "一"));
    await vi.waitFor(() => expect(state.closes).toBe(1));
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(worker._testIsStopped()).toBe(false); // worker 存活，等续发
    expect(worker.isActive()).toBe(false);
    worker.handleCommand(send("s-f3", "二"));
    await vi.waitFor(() => expect(state.spawns).toBe(2)); // 重启点：新 query 重新定装 env/头
    worker.stop();
  });

  it("良性打断 result 不终止：query 存活，续发不重启（B5 契约）", async () => {
    const { state, queryFn } = makeQuery("benign");
    const events: ChatEvent[] = [];
    const worker = new SessionWorker("s-b5", (e) => events.push(e), { queryFn });
    worker.handleCommand(send("s-b5", "一"));
    await vi.waitFor(() => expect(events.some((e) => e.type === "message_stop")).toBe(true));
    expect(state.closes).toBe(0);
    worker.handleCommand(send("s-b5", "二"));
    await new Promise((r) => setImmediate(r));
    expect(state.spawns).toBe(1); // 消息喂进原 query，不重启
    worker.stop();
  });
});

describe("SessionWorker — result 时插队 promote 的 continue 臂（循环不退出）", () => {
  it("第一条 result 接入插队 → continue：不 close 不重启，循环继续消费后续消息", async () => {
    const state = { spawns: 0, closes: 0 };
    const queryFn = (() => {
      state.spawns++;
      const gen = (async function* () {
        yield { type: "result", subtype: "success" }; // 第一条：promote 插队 → continue
        yield { type: "result", subtype: "success" }; // 第二条：无插队 → 正常分派
        await new Promise(() => {}); // 模拟 streaming-input CLI 挂住
      })();
      (gen as any).close = () => { state.closes++; };
      return gen;
    }) as any;
    const events: ChatEvent[] = [];
    const worker = new SessionWorker("s-jump", (e) => events.push(e), { queryFn });
    worker.jumpQueueCtl.request({ prompt: "插队消息" }); // 启动前挂上插队
    worker.handleCommand({ cmd: "send", session_id: "s-jump", prompt: "一", cwd: "/tmp", env: {}, auto_title: false } as any);
    await vi.waitFor(() => expect(events.some((e) => e.type === "jump_promoted")).toBe(true));
    expect(state.closes).toBe(0);   // continue 臂：循环存活
    expect(state.spawns).toBe(1);   // 未重启
    expect(events.filter((e) => e.type === "message_stop").length).toBeGreaterThanOrEqual(1); // 第二条 result 正常收轮
    worker.stop();
  });
});

describe("SessionWorker — btw 侧问（官方 side_question 通道）", () => {
  /** 假 query：可迭代（startLoop 需要）+ 可选挂载 askSideQuestion（模拟 SDK 运行时方法）。 */
  function makeFakeQuery(impl?: (q: string, opts: any) => Promise<any>) {
    const gen = (async function* () {
      await new Promise(() => {}); // 挂住输入流（streaming-input CLI 形态）
    })();
    if (impl) (gen as any).askSideQuestion = impl;
    return gen;
  }
  /** 等 startLoop 把 currentQuery 装上（builtin_hooks_manifest 在赋值之后同步发）。 */
  async function startWorker(sid: string, impl?: (q: string, opts: any) => Promise<any>) {
    const events: ChatEvent[] = [];
    const worker = new SessionWorker(sid, (e) => events.push(e), {
      queryFn: (() => makeFakeQuery(impl)) as any,
    });
    void worker.startLoop();
    await vi.waitFor(() => expect(events.some((e) => e.type === "builtin_hooks_manifest")).toBe(true));
    return { worker, events };
  }

  it("没有存活 query 时拒绝，且不发事件", async () => {
    const { worker, events } = makeWorker("btw-guard-1");
    const r = await worker.askSideQuestion("问一句", []);
    expect(r.ok).toBe(false);
    expect(events).toEqual([]);
  });

  it("SDK 句柄缺 askSideQuestion（版本漂移）时拒绝并广播 error", async () => {
    const { worker, events } = await startWorker("btw-guard-2");
    const r = await worker.askSideQuestion("问一句", []);
    expect(r.ok).toBe(false);
    const ans = events.filter((e) => e.type === "btw_answer") as any[];
    expect(ans).toHaveLength(1);
    expect(ans[0].error).toContain("引擎不支持");
    expect(ans[0].sessionId).toBe("btw-guard-2");
  });

  it("成功路径：广播 response，返回值不含正文", async () => {
    const seen: any[] = [];
    const { worker, events } = await startWorker("btw-ok", async (q, opts) => {
      seen.push({ q, opts });
      return { response: "答案是石榴", synthetic: false };
    });
    const r = await worker.askSideQuestion("问一句", [{ question: "旧问", response: "旧答" }]);
    expect(r).toEqual({ ok: true }); // ← 正文不进返回值
    expect(seen[0].q).toBe("问一句");
    expect(seen[0].opts).toEqual({ history: [{ question: "旧问", response: "旧答" }] });
    const ans = events.filter((e) => e.type === "btw_answer") as any[];
    expect(ans).toHaveLength(1);
    expect(ans[0]).toMatchObject({ question: "问一句", response: "答案是石榴", synthetic: false });
  });

  it("空 history 不传 opts（对齐官方：调用方不传就没有连续性）", async () => {
    const seen: any[] = [];
    const { worker } = await startWorker("btw-nohistory", async (q, opts) => {
      seen.push({ q, opts });
      return { response: "ok", synthetic: false };
    });
    await worker.askSideQuestion("问一句", []);
    expect(seen[0].opts).toBeUndefined();
  });

  it("synthetic 兜底答复照常广播并标记", async () => {
    const { worker, events } = await startWorker("btw-synth", async () => ({
      response: "兜底答复",
      synthetic: true,
    }));
    await worker.askSideQuestion("问一句", []);
    const ans = events.filter((e) => e.type === "btw_answer") as any[];
    expect(ans[0].synthetic).toBe(true);
    expect(ans[0].response).toBe("兜底答复");
  });

  it("SDK 返回 null 时广播 error 并拒绝", async () => {
    const { worker, events } = await startWorker("btw-null", async () => null);
    const r = await worker.askSideQuestion("问一句", []);
    expect(r.ok).toBe(false);
    const ans = events.filter((e) => e.type === "btw_answer") as any[];
    expect(ans[0].error).toBeTruthy();
  });

  it("SDK 抛异常时广播 error 并拒绝（关会话中的 Session is shutting down 走这条）", async () => {
    const { worker, events } = await startWorker("btw-throw", async () => {
      throw new Error("Session is shutting down");
    });
    const r = await worker.askSideQuestion("问一句", []);
    expect(r.ok).toBe(false);
    const ans = events.filter((e) => e.type === "btw_answer") as any[];
    expect(ans[0].error).toContain("shutting down");
  });
});

// 图片附件的线形状归一：接线与**失败可见**。
//
// 归一点在 handleSend 入口，下游（buildUserMessage / 插队队列 / display）只认识
// 内嵌形式——这件事由类型系统钉死（把 wire 形状直接传给 pushUserMessage 编不过）。
// 这里钉的是运行时那一半：坏路径必须报成非致命 error 帧（N1：失败要让对端看见），
// 而不是静默丢消息。守卫本身的用例见 imageAttachments.test.ts。
describe("SessionWorker — send 的图片附件归一（接线与失败可见）", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "worker-img-"));
  const pngPath = path.join(dir, "photo.png");
  writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("路径读不到：报非致命 error 帧、该条 send 拒发、不推进队列", async () => {
    const { worker, events } = makeWorker();
    worker.handleCommand({
      cmd: "send",
      session_id: "test-sid",
      prompt: "看看这张图",
      cwd: dir,
      images: [{ path: path.join(dir, "missing.jpg") }],
    } as any);
    // 文件读走 libuv 线程池，不是 microtask——固定 flush 等不到（既有纪律：一律 vi.waitFor）
    await vi.waitFor(() => {
      expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    });
    const err = events.find((e: any) => e.type === "error") as any;
    expect(err.fatal).toBe(false);
    expect(err.message).toContain("图片读取失败");
    expect(worker._testQueueLength()).toBe(0);
  });

  it("路径读得到：读出并归一后照常入队，无 error 帧", async () => {
    let releaseQuery!: () => void;
    const gate = new Promise<void>((r) => {
      releaseQuery = r;
    });
    const events: any[] = [];
    const worker = new SessionWorker("sid-img", (e) => events.push(e), {
      queryFn: (() =>
        (async function* () {
          await gate;
          throw new Error("query cancelled");
        })()) as any,
    });
    worker.handleCommand({
      cmd: "send",
      session_id: "sid-img",
      prompt: "看看这张图",
      cwd: dir,
      images: [{ path: pngPath }],
    } as any);
    // 入队即证明「读文件 + 嗅探 + 归一」全过（否则会走上面那条 error 帧分支）
    await vi.waitFor(() => {
      expect(worker._testQueueLength()).toBe(1);
    });
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    releaseQuery();
  });
});
