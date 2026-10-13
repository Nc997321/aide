import { describe, expect, it, vi } from "vitest";

import { handleBridgeMessage, hostKindOf, projectTreeChange, type BridgeHost } from "./appBridge";

function host(over: Partial<BridgeHost> = {}): BridgeHost {
  return {
    theme: () => ({ vars: { "--aide-accent": "#000" }, colorScheme: "dark" }),
    toast: vi.fn(),
    setBadge: vi.fn(),
    hasPermission: () => true,
    fillComposer: vi.fn(),
    openFile: vi.fn(async () => {}),
    hostKind: async () => "wsl" as const,
    hostCall: vi.fn(async () => "from-host"),
    ...over,
  };
}

const msg = (method: string, params?: unknown) => ({ aideApp: 1, id: 7, method, params });

describe("handleBridgeMessage", () => {
  it("不是桥消息的一律忽略", async () => {
    for (const data of [null, "hi", 3, {}, { aideApp: 2, id: 1, method: "x" }, { aideApp: 1, method: "x" }, { aideApp: 1, id: 1 }]) {
      expect(await handleBridgeMessage(data, host())).toBeNull();
    }
  });

  it("主题在 GUI 这边答，不去打扰 Host", async () => {
    const h = host();
    expect(await handleBridgeMessage(msg("theme.get"), h)).toEqual({
      aideApp: 1,
      id: 7,
      ok: true,
      result: { vars: { "--aide-accent": "#000" }, colorScheme: "dark" },
    });
    expect(h.hostCall).not.toHaveBeenCalled();
  });

  it("其余方法原样转给 Host，结果包成回信", async () => {
    const h = host();
    const reply = await handleBridgeMessage(msg("storage.get", { key: "a" }), h);
    expect(h.hostCall).toHaveBeenCalledWith("storage.get", { key: "a" });
    expect(reply).toEqual({ aideApp: 1, id: 7, ok: true, result: "from-host" });
  });

  it("Host 拒绝（没权限）→ 失败回信带原因，不抛到外层", async () => {
    const h = host({ hostCall: async () => Promise.reject("应用「x」没有申请权限「net」") });
    expect(await handleBridgeMessage(msg("net.fetch"), h)).toEqual({
      aideApp: 1,
      id: 7,
      ok: false,
      error: "应用「x」没有申请权限「net」",
    });
  });

  it("通知截断过长文本，空文本拒绝", async () => {
    const h = host();
    await handleBridgeMessage(msg("ui.toast", { text: "x".repeat(1000) }), h);
    expect((h.toast as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveLength(300);
    expect((await handleBridgeMessage(msg("ui.toast", { text: "  " }), h))?.ok).toBe(false);
  });

  it("角标收敛到 0–999 的整数", async () => {
    const h = host();
    for (const [input, want] of [[3.7, 3], [-5, 0], [5000, 999], ["abc", 0]] as const) {
      await handleBridgeMessage(msg("ui.setBadge", { count: input }), h);
      expect(h.setBadge).toHaveBeenLastCalledWith(want);
    }
  });

  it("往输入框填字：要 composer 权限，在 GUI 这边答，不经 Host", async () => {
    const allowed = host();
    expect((await handleBridgeMessage(msg("composer.fill", { text: "帮我看看这个接口" }), allowed))?.ok).toBe(true);
    expect(allowed.fillComposer).toHaveBeenCalledWith("帮我看看这个接口");
    expect(allowed.hostCall).not.toHaveBeenCalled();

    const denied = host({ hasPermission: () => false });
    const reply = await handleBridgeMessage(msg("composer.fill", { text: "x" }), denied);
    expect(reply).toMatchObject({ ok: false });
    expect(reply && !reply.ok && reply.error).toContain("composer");
    expect(denied.fillComposer).not.toHaveBeenCalled();

    expect((await handleBridgeMessage(msg("composer.fill", { text: "   " }), allowed))?.ok).toBe(false);
    expect((await handleBridgeMessage(msg("composer.fill", { text: 42 }), allowed))?.ok).toBe(false);
  });

  it("params 不是对象时按空对象处理", async () => {
    const h = host();
    await handleBridgeMessage(msg("storage.keys", "oops"), h);
    expect(h.hostCall).toHaveBeenCalledWith("storage.keys", {});
  });
});

import { projectSessionEvent } from "./appBridge";

describe("projectSessionEvent", () => {
  it("把内部事件投影成给应用的稳定形状", () => {
    expect(projectSessionEvent({ type: "tool_use_start", session_id: "s1", id: "t1", name: "Bash", input: { command: "ls" } })).toEqual({
      type: "tool.start",
      sessionId: "s1",
      id: "t1",
      name: "Bash",
    });
    expect(projectSessionEvent({ type: "tool_result", session_id: "s1", id: "t1", content: "secret output", is_error: true })).toEqual({
      type: "tool.end",
      sessionId: "s1",
      id: "t1",
      isError: true,
    });
    expect(projectSessionEvent({ type: "subagent_progress", session_id: "s1", id: "a1", toolName: "Read", input: {} })).toEqual({
      type: "subagent.tool",
      sessionId: "s1",
      id: "a1",
      name: "Read",
    });
    expect(projectSessionEvent({ type: "message_stop", session_id: "s1" })).toEqual({ type: "turn.end", sessionId: "s1" });
  });

  it("不带任何内容：工具入参、输出、对话文本都不出现在结果里", () => {
    const leaky = [
      { type: "tool_use_start", session_id: "s", id: "t", name: "Bash", input: { command: "cat ~/.ssh/id_rsa" } },
      { type: "tool_result", session_id: "s", id: "t", content: "PRIVATE KEY", is_error: false },
      { type: "user_message", session_id: "s", text: "my password is hunter2" },
    ];
    const out = JSON.stringify(leaky.map(projectSessionEvent));
    for (const secret of ["id_rsa", "PRIVATE KEY", "hunter2"]) expect(out).not.toContain(secret);
  });

  it("其余事件（正文增量、权限请求、心跳……）一律不给", () => {
    for (const type of ["text_delta", "thinking_delta", "permission_request", "heartbeat", "context_usage", "nope"]) {
      expect(projectSessionEvent({ type, session_id: "s" })).toBeNull();
    }
    expect(projectSessionEvent(null)).toBeNull();
    expect(projectSessionEvent({ type: "tool_use_start", session_id: "s", id: "t" })).toBeNull();
  });
});

describe("editor.open", () => {
  it("要 workspace:read，路径必须是工作区内的相对路径", async () => {
    const denied = host({ hasPermission: () => false });
    expect(await handleBridgeMessage(msg("editor.open", { path: "a.ts" }), denied)).toMatchObject({ ok: false });
    expect(denied.openFile).not.toHaveBeenCalled();

    const h = host();
    for (const path of ["", "/etc/passwd", "../x", "a/../../x", "C:/x", "a\\b", "a//b"]) {
      expect(await handleBridgeMessage(msg("editor.open", { path }), h)).toMatchObject({ ok: false });
    }
    expect(h.openFile).not.toHaveBeenCalled();
  });

  it("带行号打开；不像样的行号当没给", async () => {
    const h = host();
    expect(await handleBridgeMessage(msg("editor.open", { path: "src/a.ts", line: 42 }), h)).toMatchObject({ ok: true });
    expect(h.openFile).toHaveBeenLastCalledWith("src/a.ts", 42);
    await handleBridgeMessage(msg("editor.open", { path: "src/a.ts", line: -3 }), h);
    expect(h.openFile).toHaveBeenLastCalledWith("src/a.ts", undefined);
    expect(h.hostCall).not.toHaveBeenCalled();
  });
});

describe("Host 的种类由 GUI 补上", () => {
  it("host.info / workspace.info 的结果带上 host", async () => {
    const h = host({ hostCall: vi.fn(async () => ({ os: "linux" })) });
    expect(await handleBridgeMessage(msg("host.info"), h)).toMatchObject({ result: { os: "linux", host: "wsl" } });
    expect(await handleBridgeMessage(msg("workspace.info"), h)).toMatchObject({ result: { os: "linux", host: "wsl" } });
  });

  it("没有打开工作区（null）原样返回", async () => {
    const h = host({ hostCall: vi.fn(async () => null) });
    expect(await handleBridgeMessage(msg("workspace.info"), h)).toMatchObject({ ok: true, result: null });
  });

  it("窗口 Host 的 key 归成三种", () => {
    expect([hostKindOf("local"), hostKindOf("wsl:Debian"), hostKindOf("ssh:devbox")]).toEqual(["local", "wsl", "ssh"]);
  });
});

describe("projectTreeChange", () => {
  it("绝对目录转成相对工作区根，工作区之外的不给", () => {
    expect(projectTreeChange(["/ws/a/src", "/ws/a", "/ws/ab/x", "/other"], "/ws/a")).toEqual({ dirs: ["src", ""] });
    expect(projectTreeChange(["C:\\ws\\a\\src\\ui"], "C:\\ws\\a\\")).toEqual({ dirs: ["src/ui"] });
  });

  it("空数组 = 全量；全在别处 = 不打扰；没有工作区 = 不发", () => {
    expect(projectTreeChange([], "/ws/a")).toEqual({ full: true });
    expect(projectTreeChange(["/other/x"], "/ws/a")).toBeNull();
    expect(projectTreeChange([], "")).toBeNull();
  });
});
