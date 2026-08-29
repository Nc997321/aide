// @vitest-environment jsdom
// jsdom：FakeWebSocket 用 CloseEvent/Event 构造器，node 环境没有。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteTransport, type ConnState } from "./remote";

// ── Fake WebSocket：注入假实现测协议层（移植自原 remote-pwa protocol.test.ts）──
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0; // CONNECTING
  sent: string[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  }

  // 测试辅助
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  receive(raw: string) {
    this.onmessage?.({ data: raw } as MessageEvent);
  }

  serverClose() {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  }
}

function makeTransport(relayUrl = "wss://relay.example.com") {
  const t = new RemoteTransport(relayUrl, (url) => new FakeWebSocket(url));
  return { t, ws: () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1] };
}

function states(t: RemoteTransport): ConnState[] {
  const out: ConnState[] = [];
  t.onStateChange((s) => out.push(s));
  return out;
}

describe("RemoteTransport 连接与认证", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("connect 带配对码：首条消息是 relay connect，状态到 bridged", () => {
    const { t, ws } = makeTransport();
    const seen = states(t);
    t.connect({ code: "123456" });
    ws().open();
    expect(ws().sent[0]).toBe('{"type":"connect","code":"123456"}');
    expect(seen).toContain("bridged");
  });

  it("connect 带 token：自动发 auth，auth_ok 后到 authed", () => {
    const { t, ws } = makeTransport();
    const seen = states(t);
    t.connect({ deviceId: "dev-1", token: "tok" });
    ws().open();
    expect(ws().sent[1]).toBe('{"type":"auth","token":"tok"}');
    ws().receive('{"type":"auth_ok"}');
    expect(seen).toContain("authed");
  });

  it("pair 成功：pair_ok 返回 device_id/token，状态到 authed", async () => {
    const { t, ws } = makeTransport();
    t.connect({ code: "123456" });
    ws().open();
    const p = t.pair("123456");
    ws().receive('{"type":"pair_ok","device_id":"dev-9","token":"t9"}');
    await expect(p).resolves.toEqual({ device_id: "dev-9", token: "t9" });
    expect(t.state).toBe("authed");
  });

  it("pair 在 ws 打开前调用：onopen 补发，pair_ok 成功", async () => {
    const { t, ws } = makeTransport();
    t.connect({ code: "123456" });
    const p = t.pair("123456");
    ws().open();
    expect(JSON.parse(ws().sent[0])).toEqual({ type: "connect", code: "123456" });
    expect(JSON.parse(ws().sent[1])).toEqual({ type: "pair", code: "123456" }); // 补发
    ws().receive('{"type":"pair_ok","device_id":"dev-9","token":"t9"}');
    await expect(p).resolves.toEqual({ device_id: "dev-9", token: "t9" });
    expect(t.state).toBe("authed");
  });

  it("配对中途断线：重连后自动重发 pair 并完成配对", async () => {
    const { t, ws } = makeTransport();
    t.connect({ code: "123456" });
    const p = t.pair("123456");
    ws().open();
    expect(ws().sent[1]).toBe('{"type":"pair","code":"123456"}');
    ws().serverClose();
    await expect(p).rejects.toThrow("连接断开");
    vi.advanceTimersByTime(1000);
    const ws2 = FakeWebSocket.instances[1];
    ws2.open();
    expect(ws2.sent[1]).toBe('{"type":"pair","code":"123456"}'); // 自动续配
    ws2.receive('{"type":"pair_ok","device_id":"dev-9","token":"t9"}');
    expect(t.state).toBe("authed");
  });

  it("pair 失败：auth_error 拒绝并到 needsPairing", async () => {
    const { t, ws } = makeTransport();
    t.connect({ code: "123456" });
    ws().open();
    const p = t.pair("000000");
    ws().receive('{"type":"auth_error","message":"配对码无效或已过期"}');
    await expect(p).rejects.toThrow("配对码无效或已过期");
    expect(t.state).toBe("needsPairing");
  });

  it("auth 失败（token 无效）：到 needsPairing", () => {
    const { t, ws } = makeTransport();
    t.connect({ deviceId: "dev-1", token: "bad" });
    ws().open();
    ws().receive('{"type":"auth_error","message":"token 无效"}');
    expect(t.state).toBe("needsPairing");
  });
});

describe("RemoteTransport 通用 RPC", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function authed() {
    const { t, ws } = makeTransport();
    t.connect({ deviceId: "dev-1", token: "tok" });
    ws().open();
    ws().receive('{"type":"auth_ok"}');
    return { t, ws };
  }

  it("invoke 序列化为 id 对号请求；invoke_ok 按 id 应答", async () => {
    const { t, ws } = authed();
    const p = t.invoke("list_sessions");
    expect(JSON.parse(ws().sent[2])).toEqual({ type: "invoke", id: 1, command: "list_sessions", params: {} });
    ws().receive('{"type":"invoke_ok","id":1,"payload":[{"id":"s1","name":"会话","timestamp":1}]}');
    await expect(p).resolves.toEqual([{ id: "s1", name: "会话", timestamp: 1 }]);
  });

  it("invoke 带参数；并发两请求按各自 id 应答不乱序", async () => {
    const { t, ws } = authed();
    const p1 = t.invoke("load_messages", { sessionId: "s1" });
    const p2 = t.invoke("load_messages", { sessionId: "s2" });
    expect(JSON.parse(ws().sent[2]).id).toBe(1);
    expect(JSON.parse(ws().sent[3]).id).toBe(2);
    // 乱序回包：id 对号，后发的先回也不串
    ws().receive('{"type":"invoke_ok","id":2,"payload":{"messages":["b"]}}');
    ws().receive('{"type":"invoke_ok","id":1,"payload":{"messages":["a"]}}');
    await expect(p1).resolves.toEqual({ messages: ["a"] });
    await expect(p2).resolves.toEqual({ messages: ["b"] });
  });

  it("invoke_err 按 id 拒绝对应请求", async () => {
    const { t, ws } = authed();
    const p = t.invoke("unknown_cmd");
    ws().receive('{"type":"invoke_err","id":1,"error":"未知命令（不在远程白名单）: unknown_cmd"}');
    await expect(p).rejects.toThrow("未知命令");
  });

  it("invoke_err 找不到 pending 时落到 onError", () => {
    const { t, ws } = authed();
    const errors: string[] = [];
    t.onError((m) => errors.push(m));
    ws().receive('{"type":"invoke_err","id":99,"error":"孤儿错误"}');
    expect(errors).toEqual(["孤儿错误"]);
  });

  it("未连接时 invoke 立即拒绝", async () => {
    const { t } = makeTransport();
    await expect(t.invoke("list_sessions")).rejects.toThrow("未连接");
  });
});

describe("RemoteTransport 事件 listen", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function authed() {
    const { t, ws } = makeTransport();
    t.connect({ deviceId: "dev-1", token: "tok" });
    ws().open();
    ws().receive('{"type":"auth_ok"}');
    return { t, ws };
  }

  it("event 消息派发给 chat-event 监听者（{payload} 形状）", async () => {
    const { t, ws } = authed();
    const events: unknown[] = [];
    await t.listen("chat-event", (e) => events.push(e.payload));
    ws().receive('{"type":"event","event":{"type":"text_delta","session_id":"s1","delta":"hi"}}');
    expect(events).toEqual([{ type: "text_delta", session_id: "s1", delta: "hi" }]);
  });

  it("unlisten 后不再收事件", async () => {
    const { t, ws } = authed();
    const events: unknown[] = [];
    const un = await t.listen("chat-event", (e) => events.push(e.payload));
    un();
    ws().receive('{"type":"event","event":{"type":"text_delta","delta":"x"}}');
    expect(events).toEqual([]);
  });

  it("非 chat-event 的监听降级 no-op 并告警", async () => {
    const { t } = authed();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const un = await t.listen("lsp-server-dead", () => {});
    expect(warn).toHaveBeenCalledOnce();
    un(); // no-op 不炸
    warn.mockRestore();
  });
});

describe("RemoteTransport 断线重连", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("断线后指数退避重连，re-auth 成功触发 onReconnected", () => {
    const { t, ws } = makeTransport();
    const reconnected: number[] = [];
    t.onReconnected(() => reconnected.push(1));
    t.connect({ deviceId: "dev-1", token: "tok" });
    ws().open();
    ws().receive('{"type":"auth_ok"}');
    expect(t.state).toBe("authed");

    ws().serverClose();
    expect(t.state).toBe("offline");

    vi.advanceTimersByTime(1000); // 第一次退避 1s
    const ws2 = FakeWebSocket.instances[1];
    ws2.open();
    expect(ws2.sent[0]).toBe('{"type":"connect","device_id":"dev-1","token":"tok"}');
    ws2.receive('{"type":"auth_ok"}');
    expect(t.state).toBe("authed");
    expect(reconnected).toEqual([1]);
  });

  it("重连退避翻倍", () => {
    const { t, ws } = makeTransport();
    t.connect({ deviceId: "dev-1", token: "tok" });
    ws().open();
    ws().receive('{"type":"auth_ok"}');
    ws().serverClose();
    vi.advanceTimersByTime(1000);
    FakeWebSocket.instances[1].serverClose(); // 第二次断
    vi.advanceTimersByTime(2000); // 退避翻倍
    expect(FakeWebSocket.instances.length).toBe(3);
    FakeWebSocket.instances[2].serverClose();
    vi.advanceTimersByTime(4000);
    expect(FakeWebSocket.instances.length).toBe(4);
  });

  it("重连时 auth 失败 → needsPairing，不再自动重连", () => {
    const { t, ws } = makeTransport();
    t.connect({ deviceId: "dev-1", token: "bad" });
    ws().open();
    ws().receive('{"type":"auth_ok"}');
    ws().serverClose();
    vi.advanceTimersByTime(1000);
    const ws2 = FakeWebSocket.instances[1];
    ws2.open();
    ws2.receive('{"type":"auth_error","message":"token 无效"}');
    expect(t.state).toBe("needsPairing");
    vi.advanceTimersByTime(60000);
    expect(FakeWebSocket.instances.length).toBe(2); // 不再重连
  });

  it("disconnect 停止重连并回 idle", () => {
    const { t, ws } = makeTransport();
    t.connect({ deviceId: "dev-1", token: "tok" });
    ws().open();
    ws().receive('{"type":"auth_ok"}');
    t.disconnect();
    expect(t.state).toBe("idle");
    vi.advanceTimersByTime(60000);
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it("断线时 pending invoke 全部拒绝", async () => {
    const { t, ws } = makeTransport();
    t.connect({ deviceId: "dev-1", token: "tok" });
    ws().open();
    ws().receive('{"type":"auth_ok"}');
    const p = t.invoke("load_messages", { sessionId: "s1" });
    ws().serverClose();
    await expect(p).rejects.toThrow("连接断开");
  });
});
