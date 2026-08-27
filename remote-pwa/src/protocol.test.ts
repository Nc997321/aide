import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteClient, type ConnState } from "./protocol";

// ── Fake WebSocket：jsdom 无 WebSocket 实现，注入假实现测协议层 ──
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

function makeClient(relayUrl = "wss://relay.example.com") {
  const client = new RemoteClient(relayUrl, (url) => new FakeWebSocket(url));
  return { client, ws: () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1] };
}

function states(client: RemoteClient): ConnState[] {
  const out: ConnState[] = [];
  client.onStateChange((s) => out.push(s));
  return out;
}

describe("RemoteClient 连接与认证", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("connect 带配对码：首条消息是 relay connect，状态到 bridged", () => {
    const { client, ws } = makeClient();
    const seen = states(client);
    client.connect({ code: "123456" });
    ws().open();
    expect(ws().sent[0]).toBe('{"type":"connect","code":"123456"}');
    expect(seen).toContain("bridged");
  });

  it("connect 带 token：自动发 auth，auth_ok 后到 authed", () => {
    const { client, ws } = makeClient();
    const seen = states(client);
    client.connect({ deviceId: "dev-1", token: "tok" });
    ws().open();
    expect(ws().sent[1]).toBe('{"type":"auth","token":"tok"}');
    ws().receive('{"type":"auth_ok"}');
    expect(seen).toContain("authed");
  });

  it("pair 成功：pair_ok 返回 device_id/token，状态到 authed", async () => {
    const { client, ws } = makeClient();
    client.connect({ code: "123456" });
    ws().open();
    const p = client.pair("123456");
    ws().receive('{"type":"pair_ok","device_id":"dev-9","token":"t9"}');
    await expect(p).resolves.toEqual({ device_id: "dev-9", token: "t9" });
    expect(client.state).toBe("authed");
  });

  it("pair 在 ws 打开前调用：onopen 补发，pair_ok 成功", async () => {
    const { client, ws } = makeClient();
    client.connect({ code: "123456" }); // ws 尚未 open 就调用 pair（真实 App 流程）
    const p = client.pair("123456");
    ws().open();
    expect(JSON.parse(ws().sent[0])).toEqual({ type: "connect", code: "123456" });
    expect(JSON.parse(ws().sent[1])).toEqual({ type: "pair", code: "123456" }); // 补发
    ws().receive('{"type":"pair_ok","device_id":"dev-9","token":"t9"}');
    await expect(p).resolves.toEqual({ device_id: "dev-9", token: "t9" });
    expect(client.state).toBe("authed");
  });

  it("配对中途断线：重连后自动重发 pair 并完成配对", async () => {
    const { client, ws } = makeClient();
    client.connect({ code: "123456" });
    const p = client.pair("123456");
    ws().open();
    expect(ws().sent[1]).toBe('{"type":"pair","code":"123456"}');
    ws().serverClose(); // 配对请求发出后断线
    await expect(p).rejects.toThrow("连接断开");
    vi.advanceTimersByTime(1000);
    const ws2 = FakeWebSocket.instances[1];
    ws2.open();
    expect(ws2.sent[1]).toBe('{"type":"pair","code":"123456"}'); // 自动续配
    ws2.receive('{"type":"pair_ok","device_id":"dev-9","token":"t9"}');
    expect(client.state).toBe("authed");
  });

  it("pair 失败：auth_error 拒绝并到 needsPairing", async () => {
    const { client, ws } = makeClient();
    client.connect({ code: "123456" });
    ws().open();
    const p = client.pair("000000");
    ws().receive('{"type":"auth_error","message":"配对码无效或已过期"}');
    await expect(p).rejects.toThrow("配对码无效或已过期");
    expect(client.state).toBe("needsPairing");
  });

  it("auth 失败（token 无效）：到 needsPairing", () => {
    const { client, ws } = makeClient();
    client.connect({ deviceId: "dev-1", token: "bad" });
    ws().open();
    ws().receive('{"type":"auth_error","message":"token 无效"}');
    expect(client.state).toBe("needsPairing");
  });
});

describe("RemoteClient 消息收发", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function authed() {
    const { client, ws } = makeClient();
    client.connect({ deviceId: "dev-1", token: "tok" });
    ws().open();
    ws().receive('{"type":"auth_ok"}');
    return { client, ws };
  }

  it("sendMessage 带 session_id 序列化正确", () => {
    const { client, ws } = authed();
    client.sendMessage("s1", "你好");
    expect(JSON.parse(ws().sent[2])).toEqual({
      type: "send_message",
      session_id: "s1",
      prompt: "你好",
    });
  });

  it("sendMessage 不带 session_id 省略字段", () => {
    const { client, ws } = authed();
    client.sendMessage(null, "新会话");
    expect(JSON.parse(ws().sent[2])).toEqual({ type: "send_message", prompt: "新会话" });
  });

  it("sendMessage 带 workspace_key 序列化正确", () => {
    const { client, ws } = authed();
    client.sendMessage("s1", "你好", "C--Users-heaven-IdeaProjects-aide");
    expect(JSON.parse(ws().sent[2])).toEqual({
      type: "send_message",
      session_id: "s1",
      prompt: "你好",
      workspace_key: "C--Users-heaven-IdeaProjects-aide",
    });
  });

  it("sendMessage 不带 workspace_key 省略字段", () => {
    const { client, ws } = authed();
    client.sendMessage(null, "新会话");
    expect(JSON.parse(ws().sent[2])).toEqual({ type: "send_message", prompt: "新会话" });
  });

  it("listSessions 带 workspace_key 序列化正确", () => {
    const { client, ws } = authed();
    const p = client.listSessions("C--Users-heaven-IdeaProjects-aide");
    expect(ws().sent[2]).toBe('{"type":"list_sessions","workspace_key":"C--Users-heaven-IdeaProjects-aide"}');
    ws().receive('{"type":"sessions","sessions":[]}');
    return p;
  });

  it("listWorkspaces 收到 workspaces 应答", async () => {
    const { client, ws } = authed();
    const p = client.listWorkspaces();
    expect(ws().sent[2]).toBe('{"type":"list_workspaces"}');
    ws().receive(
      '{"type":"workspaces","workspaces":[{"key":"C--Users-heaven-IdeaProjects-aide","name":"C:\\\\Users\\\\heaven\\\\IdeaProjects\\\\aide","missing":false}]}',
    );
    await expect(p).resolves.toEqual([
      {
        key: "C--Users-heaven-IdeaProjects-aide",
        name: "C:\\Users\\<user>\\IdeaProjects\\aide",
        missing: false,
      },
    ]);
  });

  it("loadMessages 收到 messages 应答", async () => {
    const { client, ws } = authed();
    const p = client.loadMessages("s1");
    expect(ws().sent[2]).toBe('{"type":"load_messages","session_id":"s1"}');
    ws().receive(
      '{"type":"messages","messages":{"messages":[{"role":"user","blocks":[{"type":"text","text":"hi"}],"timestamp":1}],"nextOffsetBytes":0}}',
    );
    await expect(p).resolves.toEqual({
      messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }], timestamp: 1 }],
      nextOffsetBytes: 0,
    });
  });

  it("listSessions 收到 sessions 应答", async () => {
    const { client, ws } = authed();
    const p = client.listSessions();
    expect(ws().sent[2]).toBe('{"type":"list_sessions"}');
    ws().receive(
      '{"type":"sessions","sessions":[{"id":"s1","name":"会话","timestamp":1}]}',
    );
    await expect(p).resolves.toEqual([
      { id: "s1", name: "会话", timestamp: 1 },
    ]);
  });

  it("event 消息派发给 onEvent", () => {
    const { client, ws } = authed();
    const events: unknown[] = [];
    client.onEvent((e) => events.push(e));
    ws().receive('{"type":"event","event":{"type":"text_delta","session_id":"s1","delta":"hi"}}');
    expect(events).toEqual([{ type: "text_delta", session_id: "s1", delta: "hi" }]);
  });

  it("error 消息在无 pending 请求时派发给 onError", () => {
    const { client, ws } = authed();
    const errors: string[] = [];
    client.onError((m) => errors.push(m));
    ws().receive('{"type":"error","message":"出错了"}');
    expect(errors).toEqual(["出错了"]);
  });
});

describe("RemoteClient 断线重连", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("断线后指数退避重连，re-auth 成功触发 onReconnected", () => {
    const { client, ws } = makeClient();
    const reconnected: number[] = [];
    client.onReconnected(() => reconnected.push(1));
    client.connect({ deviceId: "dev-1", token: "tok" });
    ws().open();
    ws().receive('{"type":"auth_ok"}');
    expect(client.state).toBe("authed");

    ws().serverClose();
    expect(client.state).toBe("offline");

    vi.advanceTimersByTime(1000); // 第一次退避 1s
    const ws2 = FakeWebSocket.instances[1];
    ws2.open();
    expect(ws2.sent[0]).toBe('{"type":"connect","device_id":"dev-1","token":"tok"}');
    ws2.receive('{"type":"auth_ok"}');
    expect(client.state).toBe("authed");
    expect(reconnected).toEqual([1]);
  });

  it("重连退避翻倍封顶 30s", () => {
    const { client, ws } = makeClient();
    client.connect({ deviceId: "dev-1", token: "tok" });
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
    const { client, ws } = makeClient();
    client.connect({ deviceId: "dev-1", token: "bad" });
    ws().open();
    ws().receive('{"type":"auth_ok"}');
    ws().serverClose();
    vi.advanceTimersByTime(1000);
    const ws2 = FakeWebSocket.instances[1];
    ws2.open();
    ws2.receive('{"type":"auth_error","message":"token 无效"}');
    expect(client.state).toBe("needsPairing");
    vi.advanceTimersByTime(60000);
    expect(FakeWebSocket.instances.length).toBe(2); // 不再重连
  });

  it("disconnect 停止重连并回 idle", () => {
    const { client, ws } = makeClient();
    client.connect({ deviceId: "dev-1", token: "tok" });
    ws().open();
    ws().receive('{"type":"auth_ok"}');
    client.disconnect();
    expect(client.state).toBe("idle");
    vi.advanceTimersByTime(60000);
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it("断线时 pending 请求被拒绝", async () => {
    const { client, ws } = makeClient();
    client.connect({ deviceId: "dev-1", token: "tok" });
    ws().open();
    ws().receive('{"type":"auth_ok"}');
    const p = client.loadMessages("s1");
    ws().serverClose();
    await expect(p).rejects.toThrow("连接断开");
  });
});
