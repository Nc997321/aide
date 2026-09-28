import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref, nextTick } from "vue";

// ── Tauri mocks（复用 useChatSession.test.ts 模式）──
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

import { useChatSession, __resetForTest, __setEvictThresholdsForTest } from "./useChatSession";
import { useSessionState } from "./useSessionState";
import type { ToolCallBlock, SubagentBlock } from "../types/chat";

function emit(e: Record<string, unknown>) {
  chatEventHandler?.({ payload: e });
}
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

/** 找消息流里指定类型+id 的 block。 */
function findBlock<T extends ToolCallBlock | SubagentBlock>(
  msgs: ReturnType<typeof useChatSession>["messages"]["value"],
  type: T["type"],
  id: string,
): T | undefined {
  for (const m of msgs) {
    const b = m.blocks.find((x) => x.type === type && "id" in x && (x as { id: string }).id === id);
    if (b) return b as T;
  }
  return undefined;
}

describe("P0-3 旧消息淘汰 maybeEvict", () => {
  beforeEach(() => {
    __resetForTest();
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
    const { state, removeSessionState } = useSessionState();
    for (const k of Object.keys(state)) removeSessionState(k);
    // KB 级阈值快测：store 100 字节、block 20 字节
    __setEvictThresholdsForTest(100, 20);
  });

  it("超 store 阈值时降级最早消息的大 tool_result", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({ type: "tool_use_start", id: "t1", name: "Bash", input: { command: "ls" }, session_id: "uuid-a" });
    emit({ type: "tool_result", id: "t1", content: "x".repeat(500), is_error: false, session_id: "uuid-a" });
    emit({ type: "message_stop", stop_reason: "end_turn", total_cost_usd: null, usage: null, session_id: "uuid-a" });
    await flush();
    const tool = findBlock<ToolCallBlock>(chat.messages.value, "tool_call", "t1");
    expect(tool?.truncated).toBeDefined();
    expect(tool?.truncated?.kind).toBe("tool_result");
    expect(tool?.truncated?.originalBytes).toBe(500 * 2);
    expect(tool?.result).toContain("内容已省略");
    expect(tool?.isPending).toBe(false);
  });

  it("subagent entries 超阈值降级：entries 清空 + result 摘要 + truncated", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({
      type: "subagent_start",
      id: "a1",
      agentName: "general-purpose",
      description: "d",
      session_id: "uuid-a",
    });
    emit({ type: "subagent_end", id: "a1", result: "y".repeat(500), is_error: false, session_id: "uuid-a" });
    emit({ type: "message_stop", stop_reason: "end_turn", total_cost_usd: null, usage: null, session_id: "uuid-a" });
    await flush();
    const sa = findBlock<SubagentBlock>(chat.messages.value, "subagent", "a1");
    expect(sa?.truncated?.kind).toBe("subagent_entries");
    expect(sa?.entries).toEqual([]);
  });

  it("store 超阈值但 block 全小于块阈值 → 不降级、不崩、内容不变", async () => {
    __setEvictThresholdsForTest(4, 100); // store 4 字节即触发，但块阈值 100（"abc"=6 < 100 不降级）
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({ type: "text_delta", delta: "abc", session_id: "uuid-a" });
    await flush();
    // 不崩；无任何 block 被降级
    const allBlocks = chat.messages.value.flatMap((m) => m.blocks);
    expect(allBlocks.every((b) => !("truncated" in b && b.truncated))).toBe(true);
    // assistant 文本原样（非用户气泡 "q"）
    const assistantText = chat.messages.value
      .find((m) => m.role === "assistant")
      ?.blocks.find((b) => b.type === "text");
    expect(assistantText && "text" in assistantText ? assistantText.text : "").toBe("abc");
  });

  it("pending 块消息整体跳过降级（回填中的块永不被替换）", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({ type: "tool_use_start", id: "t1", name: "Bash", input: { command: "ls" }, session_id: "uuid-a" });
    await flush();
    // tool_result 未到达 → isPending=true → maybeEvict 跳过
    const tool = findBlock<ToolCallBlock>(chat.messages.value, "tool_call", "t1");
    expect(tool?.isPending).toBe(true);
    expect(tool?.truncated).toBeUndefined();
  });

  it("streaming 消息跳过降级（正在生成的块永不被替换成占位）", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({ type: "text_delta", delta: "x".repeat(500), session_id: "uuid-a" });
    await flush();
    const msg = chat.messages.value.find((m) => m.role === "assistant");
    expect(msg?.streaming).toBe(true);
    const text = msg?.blocks.find((b) => b.type === "text");
    expect(text && "truncated" in text ? text.truncated : undefined).toBeUndefined();
  });

  it("节流：同一 tick 第二次不降级，500ms 后恢复", async () => {
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(1000); // 起始 t=1000，避开「last=0,now=0 首次误节流」
      const sid = ref<string | null>("uuid-a");
      const chat = useChatSession(sid);
      await flush();
      await chat.sendMessage("q");
      const emitTurn = (id: string, content: string) => {
        emit({ type: "tool_use_start", id, name: "Bash", input: {}, session_id: "uuid-a" });
        emit({ type: "tool_result", id, content, is_error: false, session_id: "uuid-a" });
        emit({ type: "message_stop", stop_reason: "end_turn", total_cost_usd: null, usage: null, session_id: "uuid-a" });
      };
      const big = "x".repeat(500);
      // A：t=1000，message_stop 结束 streaming → 降级 t1，占配额 last=1000
      emitTurn("t1", big);
      await flush();
      // B：同 tick t=1000，message_stop 的 maybeEvict 被节流 → t2 不降级
      emitTurn("t2", big);
      await flush();
      expect(findBlock<ToolCallBlock>(chat.messages.value, "tool_call", "t1")?.truncated).toBeDefined();
      expect(findBlock<ToolCallBlock>(chat.messages.value, "tool_call", "t2")?.truncated).toBeUndefined();
      // 推进 500ms → t=1500，C 的 message_stop 不节流 → 降级最早非 pending 大块 t2
      vi.advanceTimersByTime(500);
      emitTurn("t3", big);
      await flush();
      expect(findBlock<ToolCallBlock>(chat.messages.value, "tool_call", "t2")?.truncated).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("降级后 messages.length 不变（决策 B：消息不移除，窗口层零改动前提）", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({ type: "tool_use_start", id: "t1", name: "Bash", input: {}, session_id: "uuid-a" });
    emit({ type: "tool_result", id: "t1", content: "x".repeat(500), is_error: false, session_id: "uuid-a" });
    await flush();
    const lenBefore = chat.messages.value.length;
    emit({ type: "text_delta", delta: "more", session_id: "uuid-a" });
    await flush();
    expect(chat.messages.value.length).toBe(lenBefore);
  });

  it("hydrate 大历史超阈值：unshift 后降级", async () => {
    invokeMock.mockResolvedValueOnce({
      messages: [
        {
          role: "claude",
          timestamp: 0,
          blocks: [{ type: "tool_call", id: "ht1", name: "Bash", input: { command: "ls" }, result: "x".repeat(500), isError: false }],
        },
      ],
      nextOffsetBytes: 0,
    });
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await flush();
    const tool = chat.messages.value.flatMap((m) => m.blocks).find((b) => b.type === "tool_call");
    expect(tool && "truncated" in tool ? tool.truncated : undefined).toBeDefined();
  });

  it("大 thinking 块超阈值降级（message_stop 结束 streaming 后）", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({ type: "thinking_delta", delta: "x".repeat(500), session_id: "uuid-a" });
    emit({ type: "message_stop", stop_reason: "end_turn", total_cost_usd: null, usage: null, session_id: "uuid-a" });
    await flush();
    const thinking = chat.messages.value.flatMap((m) => m.blocks).find((b) => b.type === "thinking");
    expect(thinking && "truncated" in thinking ? thinking.truncated : undefined).toBeDefined();
    expect(thinking && "truncated" in thinking ? thinking.truncated?.kind : undefined).toBe("thinking");
  });

  it("大 image 块超阈值降级（用户气泡里的图片）", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    const bigImage = { data: "x".repeat(500), mediaType: "image/png" };
    await chat.sendMessage("看图", { images: [bigImage] });
    // 气泡由 sidecar 的 user_message 渲染（方案 C），display 回灌图片块后才会被淘汰
    emit({
      type: "user_message",
      text: "看图",
      session_id: "uuid-a",
      display: [{ type: "image", ...bigImage }],
    });
    await flush();
    const image = chat.messages.value.flatMap((m) => m.blocks).find((b) => b.type === "image");
    expect(image && "truncated" in image ? image.truncated : undefined).toBeDefined();
    expect(image && "truncated" in image ? image.truncated?.kind : undefined).toBe("image_data");
    expect(image && "data" in image ? image.data : "x").toBe("");
  });

  it("小 block 不降级：同条消息里小 thinking + 小 subagent + 大 tool_result", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({ type: "thinking_delta", delta: "hi", session_id: "uuid-a" }); // 小 thinking（4 字节）
    emit({ type: "tool_use_start", id: "t1", name: "Bash", input: {}, session_id: "uuid-a" });
    emit({ type: "subagent_start", id: "a1", agentName: "general-purpose", description: "d", session_id: "uuid-a" });
    emit({ type: "tool_result", id: "t1", content: "x".repeat(500), is_error: false, session_id: "uuid-a" });
    emit({ type: "subagent_end", id: "a1", result: "", is_error: false, session_id: "uuid-a" }); // 小 subagent（entries 空 + result 空）
    emit({ type: "message_stop", stop_reason: "end_turn", total_cost_usd: null, usage: null, session_id: "uuid-a" });
    await flush();
    // 大 tool_result 降级
    const tool = findBlock<ToolCallBlock>(chat.messages.value, "tool_call", "t1");
    expect(tool?.truncated).toBeDefined();
    // 小 thinking / 小 subagent 不降级
    const thinking = chat.messages.value.flatMap((m) => m.blocks).find((b) => b.type === "thinking");
    expect(thinking && "truncated" in thinking ? thinking.truncated : undefined).toBeUndefined();
    const sa = findBlock<SubagentBlock>(chat.messages.value, "subagent", "a1");
    expect(sa?.truncated).toBeUndefined();
  });

  it("二阶段兜底：块全小（①落空）仍超阈值 → 释放最老已加载页", async () => {
    // store 阈值 100B（必超）、block 阈值 100KB（① 永不降级）→ 落到阶段②
    __setEvictThresholdsForTest(100, 100 * 1024);
    // 三页：preserveNewest=2 豁免最新两页，最老页应被释放成骨架。
    //
    // ⚠️ 夹具要求：**已加载页总字节必须越过页上界**（RECYCLE_BYTES_BUDGET = 2MB），
    // 否则阶段② 的预算（现与 recycle 同尺度）不会被触发。这正是本条用例曾经失真的
    // 地方：2026-09-28 之前阶段② 的预算是 store 尺度的派生值（100B × 0.8 = 80B），
    // 于是"1000 字节的页"就能触发它——用例一直是绿的，而**生产路径恒返回 0**
    // （真实预算 25.6MB vs 页上界 2MB，见 useChatSession.evictPhase2.test.ts）。
    // 现在页上界是硬约束：真实页 ≤256KB（读取 limit 所限），所以生产上要 ≥9 页越界
    // 才会走到这里；本夹具把最老页放大到 2.2MB 以免铺 9 次 loadOlder。
    // 偏移仍保持相邻页首尾相接（ledger 不变式）。
    const mk = (prefix: string, start: number, end: number) => ({
      messages: [{ role: "claude", timestamp: 0, blocks: [{ type: "text" as const, text: `${prefix}${"x".repeat(80)}` }] }],
      nextOffsetBytes: start,
      endOffsetBytes: end,
    });
    invokeMock.mockResolvedValueOnce(mk("p0", 2_201_000, 2_202_000)); // hydrate 尾部页
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await flush();
    const { loadOlderPage } = await import("./useChatSession");
    invokeMock.mockResolvedValueOnce(mk("p1", 2_200_000, 2_201_000));
    await loadOlderPage("uuid-a", 64 * 1024);
    invokeMock.mockResolvedValueOnce(mk("p2", 0, 2_200_000)); // 最老页：2.2MB，越界
    await loadOlderPage("uuid-a", 64 * 1024);
    const { pageLedgers } = await import("./useChatSession/state");
    const ledger = pageLedgers.get("uuid-a")!;
    expect(ledger.length).toBe(3);
    // 阶段②：最老页（ledger[0] = p2 之前 unshift 的次序，[0] 是最早）被释放
    expect(ledger[0].loaded).toBe(false);
    expect(ledger[0].heightPx).toBeGreaterThan(0); // 无 DOM → 估算高已记账
    expect(ledger[1].loaded).toBe(true);
    expect(ledger[2].loaded).toBe(true);
    // 释放的页消息从 store 消失（3 页各 1 条 → 剩 2 条）
    expect(chat.messages.value.length).toBe(2);
    // ① 未降级任何块（块全小）
    expect(chat.messages.value.flatMap((m) => m.blocks).every((b) => !("truncated" in b && b.truncated))).toBe(true);
  });
});