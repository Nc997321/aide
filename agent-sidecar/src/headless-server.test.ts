import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  startHeadlessServer,
  SessionEventRouter,
  validateInvokeBody,
  type HeadlessServerHandle,
} from "./headless-server.js";
import type { ChatEvent, SidecarCommand } from "./engine/types.js";
import { get as httpGet } from "node:http";

// ---- 核心层直测（纯逻辑，无 IO） ----

describe("validateInvokeBody", () => {
  it("非对象 body 拒绝", () => {
    expect(validateInvokeBody(null).ok).toBe(false);
    expect(validateInvokeBody("send")).toEqual(expect.objectContaining({ ok: false }));
    expect(validateInvokeBody(42)).toEqual(expect.objectContaining({ ok: false }));
  });

  it("未知命令 / 桌面扩展通道命令拒绝", () => {
    expect(validateInvokeBody({ cmd: "codegraph_result", session_id: "s1" }).ok).toBe(false);
    expect(validateInvokeBody({ cmd: "update_permission_policy", session_id: "s1" })).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(validateInvokeBody({ cmd: 42, session_id: "s1" })).toEqual(expect.objectContaining({ ok: false }));
  });

  it("session_id 缺失 / 空 / 非字符串拒绝", () => {
    expect(validateInvokeBody({ cmd: "send", prompt: "hi" })).toEqual(expect.objectContaining({ ok: false }));
    expect(validateInvokeBody({ cmd: "send", prompt: "hi", session_id: "" })).toEqual(expect.objectContaining({ ok: false }));
    expect(validateInvokeBody({ cmd: "send", prompt: "hi", session_id: 1 })).toEqual(expect.objectContaining({ ok: false }));
  });

  it("send：prompt 缺失 / 空拒绝；合法时关键字段透传", () => {
    expect(validateInvokeBody({ cmd: "send", session_id: "s1" })).toEqual(expect.objectContaining({ ok: false }));
    expect(validateInvokeBody({ cmd: "send", session_id: "s1", prompt: "" })).toEqual(expect.objectContaining({ ok: false }));
    const ok = validateInvokeBody({
      cmd: "send",
      session_id: "s1",
      prompt: "查台账",
      cwd: "C:/x",
    });
    if (!ok.ok) throw new Error("expected ok");
    expect(ok.command).toHaveProperty("cmd", "send");
    expect(ok.command).toHaveProperty("session_id", "s1");
    expect(ok.command).toHaveProperty("prompt", "查台账");
    expect(ok.command).toHaveProperty("cwd", "C:/x");
  });

  it("permission_response：id 缺失 / approved 非 boolean 拒绝；合法通过", () => {
    expect(validateInvokeBody({ cmd: "permission_response", session_id: "s1", approved: true })).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(validateInvokeBody({ cmd: "permission_response", session_id: "s1", id: "p1", approved: "yes" })).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(validateInvokeBody({ cmd: "permission_response", session_id: "s1", id: "p1", approved: true }).ok).toBe(true);
  });

  it("set_permission_mode / set_model / set_effort 各自字段缺失拒绝；合法路径通过", () => {
    expect(validateInvokeBody({ cmd: "set_permission_mode", session_id: "s1" })).toEqual(expect.objectContaining({ ok: false }));
    expect(validateInvokeBody({ cmd: "set_model", session_id: "s1" })).toEqual(expect.objectContaining({ ok: false }));
    expect(validateInvokeBody({ cmd: "set_effort", session_id: "s1" })).toEqual(expect.objectContaining({ ok: false }));
    expect(validateInvokeBody({ cmd: "set_permission_mode", session_id: "s1", mode: "acceptEdits" }).ok).toBe(true);
    expect(validateInvokeBody({ cmd: "set_model", session_id: "s1", model: "claude-sonnet-5" }).ok).toBe(true);
    expect(validateInvokeBody({ cmd: "set_effort", session_id: "s1", effort: "high" }).ok).toBe(true);
  });

  it("interrupt / session_stop 仅需 session_id", () => {
    expect(validateInvokeBody({ cmd: "interrupt", session_id: "s1" })).toEqual(expect.objectContaining({ ok: true }));
    expect(validateInvokeBody({ cmd: "session_stop", session_id: "s1" })).toEqual(expect.objectContaining({ ok: true }));
  });
});

// ---- SessionEventRouter：按会话隔离 ----

/** 测试桩：只实现 dispatch 用到的 write/writableEnded（res 为重型 http 类型，桩可辩护）。 */
function stubRes(): { write: ReturnType<typeof vi.fn>; writableEnded: boolean } {
  const write = vi.fn();
  return { write, writableEnded: false };
}

describe("SessionEventRouter", () => {
  it("dispatch 只投匹配会话的订阅者，帧带 sessionId", () => {
    const router = new SessionEventRouter();
    const a = stubRes();
    const b = stubRes();
    router.subscribe("s1", a as never);
    router.subscribe("s2", b as never);
    router.dispatch("s1", { type: "text_delta", delta: "x" } as ChatEvent);
    expect(a.write).toHaveBeenCalledTimes(1);
    expect(b.write).not.toHaveBeenCalled();
    expect(a.write.mock.calls[0]?.[0] as string).toContain('"sessionId":"s1"');
  });

  it("无订阅者 dispatch 静默（订阅制语义）", () => {
    const router = new SessionEventRouter();
    expect(() => router.dispatch("ghost", { type: "text_delta" } as ChatEvent)).not.toThrow();
  });

  it("unsubscribe 摘除后不再投递；未注册连接返回 false", () => {
    const router = new SessionEventRouter();
    const a = stubRes();
    router.subscribe("s1", a as never);
    expect(router.unsubscribe(a as never)).toBe(true);
    expect(router.unsubscribe(a as never)).toBe(false); // 已摘除
    router.dispatch("s1", { type: "text_delta" } as ChatEvent);
    expect(a.write).not.toHaveBeenCalled();
  });

  it("写失败时摘除死连接并记录错误（N1：失败可见）", () => {
    const router = new SessionEventRouter();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const dead = stubRes();
    dead.write.mockImplementation(() => {
      throw new Error("EPIPE");
    });
    router.subscribe("s1", dead as never);
    router.dispatch("s1", { type: "text_delta" } as ChatEvent);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("writableEnded 的连接跳过写帧", () => {
    const router = new SessionEventRouter();
    const a = stubRes();
    a.writableEnded = true;
    router.subscribe("s1", a as never);
    router.dispatch("s1", { type: "text_delta" } as ChatEvent);
    expect(a.write).not.toHaveBeenCalled();
  });

  it("heartbeat 给所有订阅连接写注释行心跳", () => {
    const router = new SessionEventRouter();
    const a = stubRes();
    const b = stubRes();
    router.subscribe("s1", a as never);
    router.subscribe("s2", b as never);
    router.heartbeat();
    expect(a.write).toHaveBeenCalledWith(": ping\n\n");
    expect(b.write).toHaveBeenCalledWith(": ping\n\n");
  });

  it("closeAll 断开所有订阅连接并清空路由表", () => {
    const router = new SessionEventRouter();
    const a = stubRes();
    router.subscribe("s1", a as never);
    router.closeAll();
    expect(a.write).not.toHaveBeenCalled(); // closeAll 只 end 不写帧
    router.dispatch("s1", { type: "text_delta" } as ChatEvent);
    expect(a.write).not.toHaveBeenCalled();
  });

  it("同一连接重复订阅同会话：set 复用，摘除后表回收到空", () => {
    const router = new SessionEventRouter();
    const a = stubRes();
    router.subscribe("s1", a as never);
    router.subscribe("s1", a as never); // set 已存在分支：add 幂等
    expect(router.unsubscribe(a as never)).toBe(true);
    // 摘除后 bySession 表清空（同会话仅此一个订阅者），无泄漏
    router.dispatch("s1", { type: "text_delta" } as ChatEvent);
    expect(a.write).not.toHaveBeenCalled();
  });

  it("同会话多订阅者：摘除一个后其余仍收事件", () => {
    const router = new SessionEventRouter();
    const a = stubRes();
    const b = stubRes();
    router.subscribe("s1", a as never);
    router.subscribe("s1", b as never);
    router.unsubscribe(a as never);
    router.dispatch("s1", { type: "text_delta", delta: "still-alive" } as ChatEvent);
    expect(a.write).not.toHaveBeenCalled();
    expect(b.write).toHaveBeenCalledTimes(1);
  });

  it("同一连接跨会话重订阅：旧会话键摘干净，事件不再投给旧订阅", () => {
    const router = new SessionEventRouter();
    const a = stubRes();
    router.subscribe("s1", a as never);
    router.subscribe("s2", a as never); // 改订阅：旧键必须先摘
    router.dispatch("s1", { type: "text_delta", delta: "s1-event" } as ChatEvent);
    expect(a.write).not.toHaveBeenCalled(); // 不跨会话泄漏
    router.dispatch("s2", { type: "text_delta", delta: "s2-event" } as ChatEvent);
    expect(a.write).toHaveBeenCalledTimes(1);
  });
});

// ---- HTTP/SSE 集成（真实端口 + node18+ 内置 fetch） ----

describe("startHeadlessServer (http/sse integration)", () => {
  let handle: HeadlessServerHandle;
  const commands: SidecarCommand[] = [];
  let emitRef: (sessionId: string, event: ChatEvent) => void = () => {};
  let shutdownCalled = 0;
  let baseUrl = "";

  beforeEach(async () => {
    commands.length = 0;
    emitRef = () => {};
    shutdownCalled = 0;
    handle = await startHeadlessServer({
      port: 0,
      createManager: (dispatch) => {
        emitRef = dispatch;
        return {
          handleCommand: (cmd: SidecarCommand) => {
            commands.push(cmd);
          },
          shutdown: () => { shutdownCalled++; },
        };
      },
    });
    baseUrl = `http://127.0.0.1:${handle.port}`;
  });

  afterEach(async () => {
    await handle.close();
  });

  it("POST /invoke 合法命令入队（manager.handleCommand 收到 SidecarCommand）", async () => {
    const res = await fetch(`${baseUrl}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "send", session_id: "s1", prompt: "hi", cwd: "/tmp" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ cmd: "send", session_id: "s1", prompt: "hi" });
  });

  it("POST /invoke 非法 body 400 且 manager 未收到命令", async () => {
    const res = await fetch(`${baseUrl}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "send", prompt: "hi" }), // 无 session_id
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(expect.objectContaining({ ok: false }));
    expect(commands).toHaveLength(0);
  });

  it("未知路径 404", async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });

  it("GET /events 缺 sessionId 查询参数 → 400", async () => {
    const res = await fetch(`${baseUrl}/events`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(expect.objectContaining({ ok: false }));
  });

  it("POST /invoke 非 JSON body → 400（promise 链解析失败路径）", async () => {
    const res = await fetch(`${baseUrl}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json{{{",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(expect.objectContaining({ ok: false }));
    expect(commands).toHaveLength(0);
  });

  it("POST /invoke 超限 body → 400（readBody 大小约束）", async () => {
    const big = "x".repeat(1024 * 1024 + 100);
    const res = await fetch(`${baseUrl}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "send", session_id: "s1", prompt: big }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(expect.objectContaining({ ok: false }));
    expect(commands).toHaveLength(0);
  });

  it("manager.handleCommand 同步抛错 → 500 且带上下文（N1）", async () => {
    const h = await startHeadlessServer({
      port: 0,
      createManager: () => ({
        handleCommand: () => {
          throw new Error("boom-dispatch");
        },
        shutdown: () => {},
      }),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${h.port}/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cmd: "send", session_id: "s1", prompt: "hi" }),
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining("boom") }));
    } finally {
      await handle.close();
    }
  });

  it("SSE 按会话隔离：各订阅者只收自己会话的事件", async () => {
    // 原生 http 客户端：data 事件直接给帧（undici body 流的 cancel 语义在这里更绕）
    const open = (sessionId: string): Promise<{ frames: () => string; destroy: () => void }> =>
      new Promise((resolve, reject) => {
        const req = httpGet(`${baseUrl}/events?sessionId=${sessionId}`, (res) => {
          const chunks: string[] = [];
          res.on("data", (c: Buffer) => chunks.push(c.toString()));
          res.on("error", reject);
          resolve({ frames: () => chunks.join(""), destroy: () => req.destroy() });
        });
        req.on("error", reject);
      });
    const c1 = await open("s1");
    const c2 = await open("s2");

    emitRef("s1", { type: "text_delta", delta: "hello-s1" } as ChatEvent);
    emitRef("s2", { type: "text_delta", delta: "hello-s2" } as ChatEvent);
    // 等一拍让事件送达
    await new Promise((r) => setTimeout(r, 200));
    const t1 = c1.frames();
    const t2 = c2.frames();
    c1.destroy();
    c2.destroy();
    expect(t1).toContain("hello-s1");
    expect(t1).not.toContain("hello-s2");
    expect(t2).toContain("hello-s2");
    expect(t2).not.toContain("hello-s1");
  });

  it("close() 调 manager.shutdown", async () => {
    await handle.close();
    expect(shutdownCalled).toBeGreaterThan(0);
  });
});

// ---- 安全基线 ----

describe("startHeadlessServer security baseline", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("不鉴权 + 非回环监听 = 启动即拒绝", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      startHeadlessServer({
        port: 0,
        host: "0.0.0.0",
        createManager: () => ({ handleCommand: () => {}, shutdown: () => {} }),
      }),
    ).rejects.toThrow(/loopback/);
    errSpy.mockRestore();
  });

  it("端口被占用 → 监听 error 走 on(error) 兜底不崩进程（N4）", async () => {
    // 先占住一个端口
    const blocker = await startHeadlessServer({
      port: 0,
      createManager: () => ({ handleCommand: () => {}, shutdown: () => {} }),
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        startHeadlessServer({
          port: blocker.port, // 同端口：第二个 server 触发 EADDRINUSE → on(error) 回调
          createManager: () => ({ handleCommand: () => {}, shutdown: () => {} }),
        }),
      ).rejects.toThrow();
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      await blocker.close();
    }
  });

  it("token 模式：无 token 401、错 token 401、对 token 200", async () => {
    const handle = await startHeadlessServer({
      port: 0,
      token: "secret-token",
      createManager: () => ({ handleCommand: () => {}, shutdown: () => {} }),
    });
    const url = `http://127.0.0.1:${handle.port}/invoke`;
    try {
      const noAuth = await fetch(url, { method: "POST", body: JSON.stringify({ cmd: "send", session_id: "s", prompt: "p" }) });
      expect(noAuth.status).toBe(401);
      const badAuth = await fetch(url, {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
        body: JSON.stringify({ cmd: "send", session_id: "s", prompt: "p" }),
      });
      expect(badAuth.status).toBe(401);
      const goodAuth = await fetch(url, {
        method: "POST",
        headers: { authorization: "Bearer secret-token" },
        body: JSON.stringify({ cmd: "send", session_id: "s", prompt: "p" }),
      });
      expect(goodAuth.status).toBe(200);
    } finally {
      await handle.close();
    }
  });
});