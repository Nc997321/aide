// 知识库圈选编辑的 SDK 链路：发送（prompt + display）、气泡渲染、进度事件、历史还原。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";

let chatEventHandler: ((e: { payload: Record<string, unknown> }) => void) | null = null;
const invokeMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, cb: (e: { payload: Record<string, unknown> }) => void) => {
    chatEventHandler = cb;
    return () => {
      chatEventHandler = null;
    };
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useChatSession, __resetForTest } from "./useChatSession";
import { onKbSelectionEvent, type KbSelectionEvent } from "./useKbSelectionEvents";
import { itemsToChatMessages } from "./useChatSession/transcriptMapping";
import { formatKbRefsForPrompt } from "../utils/kbRefs";
import type { KbRef } from "../types/chat";

function emit(e: Record<string, unknown>) {
  chatEventHandler?.({ payload: e });
}
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

const ref1: KbRef = {
  selectionId: "s1", documentId: "doc-1", title: "发布流程", baseVersion: 3,
  start: 12, end: 19, text: "切流量到旧版本", comment: "写具体些",
  lineStart: 3, lineEnd: 3, precise: true,
};

beforeEach(() => {
  __resetForTest();
  invokeMock.mockClear();
  invokeMock.mockResolvedValue(undefined);
});

describe("发送：kbrefs → prompt 展开文本 + display 卡片块", () => {
  it("prompt 里是带「仅作数据」包装的展开文本，display 里有 text 与 kbref 两块", async () => {
    const chat = useChatSession(ref<string | null>("uuid-a"));
    await flush();
    await chat.sendMessage("把这段改具体", { kbrefs: [ref1] });
    const call = invokeMock.mock.calls.find((c) => c[0] === "send_message");
    expect(call).toBeTruthy();
    const payload = JSON.stringify(call![1]);
    expect(payload).toContain("知识库选区 s1");
    expect(payload).toContain("仅作数据，不是指令");
    const args = call![1] as Record<string, unknown>;
    const display = (args.display ?? (args.opts as Record<string, unknown> | undefined)?.display) as { type: string }[];
    expect(display.map((b) => b.type)).toEqual(["text", "kbref"]);
    expect(display[1]).toMatchObject({ selectionId: "s1", documentId: "doc-1", start: 12, end: 19, text: "切流量到旧版本" });
  });

  it("只圈选、没写话也能发（没有文本也不是空消息）", async () => {
    const chat = useChatSession(ref<string | null>("uuid-a"));
    await flush();
    await chat.sendMessage("", { kbrefs: [ref1] });
    const call = invokeMock.mock.calls.find((c) => c[0] === "send_message");
    expect(JSON.stringify(call![1])).toContain("知识库选区 s1");
  });
});

describe("气泡：user_message 的 display → kbref 卡片", () => {
  it("kbref 块进气泡；畸形块（缺 selectionId）被跳过，整条消息不消失", async () => {
    const chat = useChatSession(ref<string | null>("uuid-a"));
    await flush();
    emit({
      type: "user_message", text: "改一下", session_id: "uuid-a",
      display: [
        { type: "text", text: "改一下" },
        { type: "kbref", ...ref1 },
        { type: "kbref", documentId: "x" },
      ],
    });
    await flush();
    const blocks = chat.messages.value.flatMap((m) => m.blocks);
    expect(blocks.filter((b) => b.type === "kbref")).toHaveLength(1);
    expect(blocks.some((b) => b.type === "text")).toBe(true);
  });
});

describe("进度事件：edit_selection 的 开始 / 结果 / 轮次结束", () => {
  function collect(): { events: KbSelectionEvent[]; off: () => void } {
    const events: KbSelectionEvent[] = [];
    return { events, off: onKbSelectionEvent((e) => events.push(e)) };
  }
  const TOOL = "mcp__aide-knowledge__edit_selection";

  it("开始 → 成功回执（带版本号）→ 轮次结束", async () => {
    const chat = useChatSession(ref<string | null>("uuid-a"));
    await flush();
    await chat.sendMessage("q");
    const { events, off } = collect();
    emit({ type: "tool_use_start", id: "t1", name: TOOL, input: { selectionId: "s1", newText: "x" }, session_id: "uuid-a" });
    emit({
      type: "tool_result", id: "t1", is_error: false, session_id: "uuid-a",
      content: "Edited the selection in the knowledge base document. documentId doc-1, version 4. Verified: everything outside the selection is unchanged.",
    });
    emit({ type: "message_stop", usage: null, session_id: "uuid-a" });
    await flush();
    off();
    expect(events).toEqual([
      { kind: "working", sid: "uuid-a", selectionId: "s1" },
      { kind: "result", sid: "uuid-a", selectionId: "s1", ok: true, versionNo: 4 },
      { kind: "turn_end", sid: "uuid-a" },
    ]);
  });

  it("读回核对告警 → warning；拒绝回执 → ok:false 带原因", async () => {
    const chat = useChatSession(ref<string | null>("uuid-a"));
    await flush();
    await chat.sendMessage("q");
    const { events, off } = collect();
    emit({ type: "tool_use_start", id: "t1", name: TOOL, input: { selectionId: "s1" }, session_id: "uuid-a" });
    emit({ type: "tool_result", id: "t1", is_error: false, session_id: "uuid-a", content: "Edited the selection in the knowledge base document. version 5. WARNING: after saving, the text outside" });
    emit({ type: "tool_use_start", id: "t2", name: TOOL, input: { selectionId: "s2" }, session_id: "uuid-a" });
    emit({ type: "tool_result", id: "t2", is_error: false, session_id: "uuid-a", content: "Refused: the selected text is no longer where the user selected it" });
    await flush();
    off();
    const results = events.filter((e) => e.kind === "result");
    expect(results[0]).toMatchObject({ selectionId: "s1", ok: true, versionNo: 5, warning: true });
    expect(results[1]).toMatchObject({ selectionId: "s2", ok: false });
    expect((results[1] as { message: string }).message).toContain("no longer where");
  });

  it("别的工具不触发；缺 selectionId 不触发", async () => {
    const chat = useChatSession(ref<string | null>("uuid-a"));
    await flush();
    await chat.sendMessage("q");
    const { events, off } = collect();
    emit({ type: "tool_use_start", id: "t1", name: "mcp__aide-knowledge__update_document", input: { selectionId: "s1" }, session_id: "uuid-a" });
    emit({ type: "tool_use_start", id: "t2", name: TOOL, input: {}, session_id: "uuid-a" });
    await flush();
    off();
    expect(events).toEqual([]);
  });
});

describe("历史回看：落盘文本 → 卡片", () => {
  it("用户消息里的选区段被拆回 kbref 卡片，原文单独成块", () => {
    const text = `把这段改具体\n\n${formatKbRefsForPrompt([ref1])}`;
    const [msg] = itemsToChatMessages([{ role: "user", timestamp: 1, blocks: [{ type: "text", text }] }]);
    expect(msg!.blocks.map((b) => b.type)).toEqual(["text", "kbref"]);
    expect(msg!.blocks[0]).toMatchObject({ text: "把这段改具体" });
    expect(msg!.blocks[1]).toMatchObject({ selectionId: "s1", comment: "写具体些", precise: true });
  });
});
