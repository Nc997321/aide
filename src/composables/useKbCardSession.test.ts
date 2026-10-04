// @vitest-environment jsdom
// 知识库卡片对话：一篇文档一个会话。线程是消息 store 的视图；新会话必须落在日常、
// 临时 id 一分配就登记到文档名下（早于 sidecar 的第一条事件）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick } from "vue";

let chatEventHandler: ((e: { payload: Record<string, unknown> }) => void) | null = null;
const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_n: string, cb: (e: { payload: Record<string, unknown> }) => void) => {
    chatEventHandler = cb;
    return () => {
      chatEventHandler = null;
    };
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { __resetForTest } from "@aide/sdk/composables/useChatSession";
import { __resetDailyWorkspaceForTest, setDailyWorkspace } from "@aide/sdk/utils/dailyWorkspace";
import { useSessionNames } from "@aide/sdk/composables/useSessionNames";
import type { ChatMessage, KbRef } from "@aide/sdk/types/chat";
import {
  __reloadMapForTest,
  __resetKbCardSessionsForTest,
  cardSessionAlive,
  pinnedSettings,
  buildCardThread,
  cardSessionTitle,
  editSelectionRequest,
  parseSidMap,
  useKbCardSession,
} from "./useKbCardSession";

const ref1: KbRef = {
  selectionId: "s1", documentId: "doc-1", title: "发布流程", baseVersion: 3,
  start: 12, end: 19, text: "切流量到旧版本", comment: "写具体些",
  lineStart: 3, lineEnd: 3, precise: true,
};
const msg = (role: ChatMessage["role"], blocks: ChatMessage["blocks"], extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: crypto.randomUUID(), role, blocks, timestamp: 0, ...extra,
});

beforeEach(() => {
  __resetForTest();
  __resetDailyWorkspaceForTest();
  __resetKbCardSessionsForTest();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

describe("buildCardThread：只取人话", () => {
  it("用户意见 + AI 文字回复；工具调用 / 思考 / 空文本都不进卡片", () => {
    const t = buildCardThread([
      msg("user", [{ type: "text", text: "更简洁" }, { type: "kbref", ...ref1 }]),
      msg("assistant", [{ type: "thinking", text: "…" } as never, { type: "text", text: "改好了。" }]),
      msg("assistant", [{ type: "tool_call" } as never]),
    ]);
    expect(t.map((x) => [x.role, x.text])).toEqual([["user", "更简洁"], ["ai", "改好了。"]]);
    expect(t[0]!.refs).toBe(1);
  });

  it("浮窗里写的意见随圈选（kbref.comment）发出、正文为空：气泡显示那条意见", () => {
    const t = buildCardThread([
      msg("user", [{ type: "kbref", ...ref1 }, { type: "kbref", ...ref1, selectionId: "s2", comment: "再口语些" }]),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0]!.text).toBe("写具体些；再口语些");
    expect(t[0]!.refs).toBe(2);
  });

  it("没写意见的发送显示占位，气泡不会凭空消失", () => {
    const t = buildCardThread([msg("user", [{ type: "kbref", ...ref1, comment: "  " }])]);
    expect(t).toHaveLength(1);
    expect(t[0]!.text).toContain("只让 AI 看这一段");
  });

  it("页折叠占位不进线程；streaming 标记透传", () => {
    const t = buildCardThread([
      msg("user", [{ type: "text", text: "↑ 更早的 3 条" }], { markerFor: "p1" }),
      msg("assistant", [{ type: "text", text: "正在…" }], { streaming: true }),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0]!.streaming).toBe(true);
  });
});

describe("editSelectionRequest", () => {
  it("认出 edit_selection（含 MCP 前缀），取出选区 id 与新文本", () => {
    const r = editSelectionRequest({ id: "p", name: "mcp__aide-knowledge__edit_selection", input: { selectionId: "s1", newText: "新" } });
    expect(r).toEqual({ selectionId: "s1", newText: "新" });
  });
  it("别的工具 / 入参畸形 / null → null", () => {
    expect(editSelectionRequest({ id: "p", name: "Bash", input: {} })).toBeNull();
    expect(editSelectionRequest({ id: "p", name: "edit_selection", input: { selectionId: 1 } })).toBeNull();
    expect(editSelectionRequest(null)).toBeNull();
  });
});

describe("映射与标题", () => {
  it("parseSidMap 容错：坏 JSON / 数组 / 非字符串值都丢弃", () => {
    expect(parseSidMap(null)).toEqual({});
    expect(parseSidMap("{bad")).toEqual({});
    expect(parseSidMap("[1]")).toEqual({});
    expect(parseSidMap('{"a":"s1","b":2,"c":""}')).toEqual({ a: "s1" });
  });
  it("标题带文档名；没标题给兜底", () => {
    expect(cardSessionTitle("发布流程")).toBe("知识库 · 发布流程");
    expect(cardSessionTitle("  ")).toBe("知识库 · 未命名文档");
  });
});

describe("send：新会话落日常、临时号先登记", () => {
  it("首发：归属 = 日常；映射与标题在派发前就位；已有会话不再带归属", async () => {
    setDailyWorkspace("daily-key", "/home/u/.aide/workspace");
    const scope = effectScope();
    const card = scope.run(() => useKbCardSession(() => ({ id: "doc-1", title: "发布流程" })))!;
    expect(card.sid.value).toBeNull();

    const sid = await card.send([ref1], "写具体些");
    await nextTick();
    expect(sid).toBeTruthy();
    expect(card.sid.value).toBe(sid);
    expect(useSessionNames().takePendingTitle(sid!)).toBe("知识库 · 发布流程");
    const call = invokeMock.mock.calls.find((c) => c[0] === "send_message");
    expect(JSON.stringify(call![1])).toContain("/home/u/.aide/workspace");

    // 第二次：沿用同一条会话，不新开
    invokeMock.mockClear();
    const again = await card.send([ref1], "再短一点");
    expect(again).toBe(sid);
    scope.stop();
  });

  it("映射指向的会话已被删除：忘掉旧映射，按新会话开在日常，不去续一个不存在的 id", async () => {
    setDailyWorkspace("daily-key", "/home/u/.aide/workspace");
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "session_workspace" ? null : undefined));
    localStorage.setItem("aide.kbCardSessions.v1", JSON.stringify({ "doc-1": "gone-sid" }));
    __reloadMapForTest();
    const scope = effectScope();
    const card = scope.run(() => useKbCardSession(() => ({ id: "doc-1", title: "发布流程" })))!;
    expect(card.sid.value).toBe("gone-sid");

    const sid = await card.send([ref1], "写具体些");
    expect(sid).toBeTruthy();
    expect(sid).not.toBe("gone-sid");
    expect(card.sid.value).toBe(sid);
    expect(JSON.stringify(invokeMock.mock.calls.find((c) => c[0] === "send_message")![1])).toContain("/home/u/.aide/workspace");
    scope.stop();
  });

  it("会话还在（档案有归属）：沿用，不新开", async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "session_workspace" ? { wsPath: "/home/u/.aide/workspace", wsKey: "daily-key" } : undefined);
    localStorage.setItem("aide.kbCardSessions.v1", JSON.stringify({ "doc-1": "live-sid" }));
    __reloadMapForTest();
    const scope = effectScope();
    const card = scope.run(() => useKbCardSession(() => ({ id: "doc-1", title: "发布流程" })))!;
    expect(await card.send([ref1], "再短一点")).toBe("live-sid");
    scope.stop();
  });

  it("读档案失败（传输出错）：按「还在」处理，不丢对话映射", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "session_workspace") throw new Error("transport down");
      return undefined;
    });
    expect(await cardSessionAlive("any-sid")).toBe(true);
    warn.mockRestore();
  });

  it("拿不到日常目录就不发（绝不静默落到活动工作区）", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "daily_workspace") throw new Error("no such command");
      return undefined;
    });
    const scope = effectScope();
    const card = scope.run(() => useKbCardSession(() => ({ id: "doc-2", title: "x" })))!;
    expect(await card.send([ref1], "改")).toBeUndefined();
    expect(card.sendError.value).toContain("日常目录");
    expect(invokeMock.mock.calls.some((c) => c[0] === "send_message")).toBe(false);
    scope.stop();
  });
});

describe("模型与档位：卡片没有选择器，永远沿用会话自己的（不弹发送前确认，也不悄悄变）", () => {
  const sendArgs = () => invokeMock.mock.calls.find((c) => c[0] === "send_message")![1] as Record<string, unknown>;

  it("pinnedSettings：会话记下的优先；没记就取 sidecar 坐实的当前值；都没有就什么都不传（不退成默认）", async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "session_model" ? "kimi" : cmd === "session_effort" ? "high" : undefined));
    expect(await pinnedSettings("s", { model: "x", effort: "low" })).toEqual({ model: "kimi", effort: "high" });

    invokeMock.mockImplementation(async () => null);
    expect(await pinnedSettings("s", { model: "live-m", effort: "max" })).toEqual({ model: "live-m", effort: "max" });
    expect(await pinnedSettings("s", { model: "", effort: "" })).toEqual({});
  });

  it("读会话记录失败也不抛：回落到当前坐实值", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "session_model" || cmd === "session_effort") throw new Error("down");
      return undefined;
    });
    expect(await pinnedSettings("s", { model: "m", effort: "e" })).toEqual({ model: "m", effort: "e" });
  });

  it("已有会话：发送带的是会话自己的模型与档位——用户在聊天里调高的档位不会被卡片压回「快速」", async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "session_workspace" ? { wsPath: "/w", wsKey: "k" } : cmd === "session_model" ? "kimi" : cmd === "session_effort" ? "high" : undefined);
    localStorage.setItem("aide.kbCardSessions.v1", JSON.stringify({ "doc-1": "live-sid" }));
    __reloadMapForTest();
    const scope = effectScope();
    const card = scope.run(() => useKbCardSession(() => ({ id: "doc-1", title: "发布流程" })))!;
    await card.send([ref1], "再短一点");
    const a = sendArgs();
    expect(a.initialModel).toBe("kimi");
    expect(a.initialEffort).toBe("high");
    scope.stop();
  });

  it("新会话：档位用日常的快速，模型不指定（走供应商默认）", async () => {
    setDailyWorkspace("daily-key", "/home/u/.aide/workspace");
    const scope = effectScope();
    const card = scope.run(() => useKbCardSession(() => ({ id: "doc-9", title: "x" })))!;
    await card.send([ref1], "改");
    const a = sendArgs();
    expect(a.initialEffort).toBe("low");
    expect(a.initialModel == null).toBe(true);
    scope.stop();
  });
});
