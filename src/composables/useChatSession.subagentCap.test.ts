import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref, nextTick } from "vue";

// ── Tauri mocks（复用 useChatSession.test.ts / evict.test.ts 模式）──
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
import { useSessionState } from "./useSessionState";
import type { SubagentBlock, SubagentEntry } from "@/types/chat";

const CAP = 256 * 1024; // SUBAGENT_ENTRY_CAP

function emit(e: Record<string, unknown>) {
  chatEventHandler?.({ payload: e });
}
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

function findSubagent(msgs: ReturnType<typeof useChatSession>["messages"]["value"], id: string): SubagentBlock | undefined {
  for (const m of msgs) {
    const b = m.blocks.find((x) => x.type === "subagent" && "id" in x && (x as { id: string }).id === id);
    if (b) return b as SubagentBlock;
  }
  return undefined;
}

function startSubagent(id: string) {
  emit({ type: "subagent_start", id, agentName: "general-purpose", description: "d", session_id: "uuid-a" });
}

describe("P2-1 子代理 entries 文本上限（写入时截断）", () => {
  beforeEach(() => {
    __resetForTest();
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
    const { state, removeSessionState } = useSessionState();
    for (const k of Object.keys(state)) removeSessionState(k);
  });

  it("text delta 累积超上限 → 截头保尾 + truncated 标记", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    startSubagent("a1");
    const delta = "A".repeat(CAP * 2 + 100_000); // 612,288 > 2×CAP → 触发截断
    emit({ type: "subagent_text_delta", id: "a1", delta, session_id: "uuid-a" });
    await flush();

    const sa = findSubagent(chat.messages.value, "a1");
    expect(sa?.entries).toHaveLength(1);
    const entry = sa!.entries[0] as Extract<SubagentEntry, { type: "text" }>;
    expect(entry.text.length).toBe(CAP); // 保尾到上限
    expect(entry.text).toBe("A".repeat(CAP)); // 保留的是尾部
    expect(entry.truncated?.kind).toBe("text");
    expect(entry.truncated?.originalBytes).toBe((delta.length - CAP) * 2);
  });

  it("截断后继续累积 → 摊还再截、originalBytes 累加", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    startSubagent("a1");
    // 第一段 2×CAP+1：严格超限（边界是 >2×CAP）→ 截保尾
    emit({ type: "subagent_text_delta", id: "a1", delta: "A".repeat(CAP * 2 + 1), session_id: "uuid-a" });
    await flush();
    // 第二段追加 CAP+1：尾部是 A 保尾 + B 段又超 2×CAP → 再截保尾，最终全 B
    emit({ type: "subagent_text_delta", id: "a1", delta: "B".repeat(CAP + 1), session_id: "uuid-a" });
    await flush();

    const sa = findSubagent(chat.messages.value, "a1");
    const entry = sa!.entries[0] as Extract<SubagentEntry, { type: "text" }>;
    expect(entry.text.length).toBe(CAP);
    expect(entry.text).toBe("B".repeat(CAP)); // 最新内容在尾部，保住
    expect(entry.truncated?.kind).toBe("text");
    // 每次省略量 = 超限长度 − CAP（字节 ×2），累加：(2CAP+1−CAP)×2 ×2 次
    expect(entry.truncated?.originalBytes).toBe((CAP + 1) * 2 * 2);
  });

  it("thinking delta 同套截断逻辑", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    startSubagent("a1");
    emit({ type: "subagent_thinking_delta", id: "a1", delta: "T".repeat(CAP * 2 + 1), session_id: "uuid-a" });
    await flush();

    const sa = findSubagent(chat.messages.value, "a1");
    const entry = sa!.entries[0] as Extract<SubagentEntry, { type: "thinking" }>;
    expect(entry.text.length).toBe(CAP);
    expect(entry.truncated?.kind).toBe("thinking");
  });

  it("tool result 回填超上限 → result 截保尾 + entry.truncated(kind=tool_result)", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    startSubagent("a1");
    emit({ type: "subagent_progress", id: "a1", toolUseId: "st1", toolName: "Bash", input: {}, session_id: "uuid-a" });
    const big = "X".repeat(CAP * 2 + 50_000);
    emit({ type: "subagent_tool_result", id: "a1", toolUseId: "st1", content: big, is_error: false, session_id: "uuid-a" });
    await flush();

    const sa = findSubagent(chat.messages.value, "a1");
    const entry = sa!.entries[0] as Extract<SubagentEntry, { type: "tool" }>;
    expect(entry.result?.length).toBe(CAP);
    expect(entry.truncated?.kind).toBe("tool_result");
    expect(entry.truncated?.originalBytes).toBe((big.length - CAP) * 2);
  });

  it("subagent_end 最终产出超上限 → result 截保尾 + resultTruncated 标记", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    startSubagent("a1");
    const big = "Z".repeat(CAP * 2 + 10_000);
    emit({ type: "subagent_end", id: "a1", result: big, is_error: false, session_id: "uuid-a" });
    await flush();

    const sa = findSubagent(chat.messages.value, "a1");
    expect(sa?.result?.length).toBe(CAP);
    expect(sa?.result).toBe("Z".repeat(CAP));
    expect(sa?.resultTruncated?.kind).toBe("subagent_result");
    expect(sa?.resultTruncated?.originalBytes).toBe((big.length - CAP) * 2);
    expect(sa?.isPending).toBe(false);
  });

  it("未超上限：正常累积、无 truncated 字段", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    startSubagent("a1");
    emit({ type: "subagent_text_delta", id: "a1", delta: "hello ", session_id: "uuid-a" });
    emit({ type: "subagent_text_delta", id: "a1", delta: "world", session_id: "uuid-a" });
    emit({ type: "subagent_tool_result", id: "a1", toolUseId: "st1", content: "small", is_error: false, session_id: "uuid-a" });
    emit({ type: "subagent_end", id: "a1", result: "done", is_error: false, session_id: "uuid-a" });
    await flush();

    const sa = findSubagent(chat.messages.value, "a1");
    const textEntry = sa!.entries[0] as Extract<SubagentEntry, { type: "text" }>;
    expect(textEntry.text).toBe("hello world");
    expect(textEntry.truncated).toBeUndefined();
    expect(sa?.result).toBe("done");
    expect(sa?.resultTruncated).toBeUndefined();
  });
});
