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

import {
  useChatSession,
  __resetForTest,
  __setEvictThresholdsForTest,
  loadOlderPage,
  hasMoreOlder,
  resetPaginationForRevert,
} from "./useChatSession";
import { useSessionState } from "./useSessionState";
import type { TextBlock } from "../types/chat";

function emit(e: Record<string, unknown>) {
  chatEventHandler?.({ payload: e });
}
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

/** 造一页 load_messages 应答：N 条 user/claude 交替 text 消息。
 *  endOffsetBytes = 本次读取的排他末尾字节（生产 Rust 恒返回；缺省给个正常值）。 */
function pageResponse(n: number, prefix: string, nextOffsetBytes = 0, text?: string, endOffsetBytes = 4096) {
  return {
    messages: Array.from({ length: n }, (_, i) => ({
      role: i % 2 ? "claude" : "user",
      timestamp: i,
      blocks: [{ type: "text" as const, text: text ?? `${prefix}-${i}` }],
    })),
    nextOffsetBytes,
    endOffsetBytes,
  };
}

function loadMessagesCalls() {
  return invokeMock.mock.calls.filter((c) => c[0] === "load_messages");
}

describe("P1 双向分页", () => {
  beforeEach(() => {
    __resetForTest();
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
    const { state, removeSessionState } = useSessionState();
    for (const k of Object.keys(state)) removeSessionState(k);
    // 快测阈值：store 100KB、block 20 字节（复用 evict.test.ts 惯例）
    __setEvictThresholdsForTest(100 * 1024, 20);
  });

  it("hydrate 只取尾部一页（limit=256KB 字节预算），记录下一页游标", async () => {
    invokeMock.mockResolvedValueOnce(pageResponse(30, "tail", 1234));
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await flush();
    const call = loadMessagesCalls().find((c) => c[1]?.sessionId === "uuid-a");
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({ sessionId: "uuid-a", offsetBytes: null, limit: 256 * 1024 });
    expect(chat.messages.value.length).toBe(30);
    expect(hasMoreOlder("uuid-a")).toBe(true);
  });

  it("hydrate 已到文件头（nextOffsetBytes=0）：hasMoreOlder false", async () => {
    invokeMock.mockResolvedValueOnce(pageResponse(10, "tail", 0));
    const sid = ref<string | null>("uuid-a");
    useChatSession(sid);
    await flush();
    await flush();
    expect(hasMoreOlder("uuid-a")).toBe(false);
  });

  it("loadOlderPage 按游标取回更早页 unshift，游标前移", async () => {
    invokeMock.mockResolvedValueOnce(pageResponse(30, "tail", 1000));
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await flush();
    invokeMock.mockResolvedValueOnce(pageResponse(20, "older", 200));
    const count = await loadOlderPage("uuid-a", 20);
    expect(count).toBe(20);
    expect(chat.messages.value.length).toBe(50);
    expect((chat.messages.value[0].blocks[0] as TextBlock).text).toBe("older-0");
    const call = loadMessagesCalls().pop();
    expect(call![1]).toMatchObject({ sessionId: "uuid-a", offsetBytes: 1000, limit: 20 });
    // 游标前移到更早位置，仍有更早页
    expect(hasMoreOlder("uuid-a")).toBe(true);
  });

  it("loadOlderPage 无更早页（tailOffset=0）时返回 0 且不 invoke", async () => {
    invokeMock.mockResolvedValueOnce(pageResponse(10, "tail", 0));
    const sid = ref<string | null>("uuid-a");
    useChatSession(sid);
    await flush();
    await flush();
    const callsBefore = loadMessagesCalls().length;
    const count = await loadOlderPage("uuid-a", 20);
    expect(count).toBe(0);
    expect(loadMessagesCalls().length).toBe(callsBefore);
  });





  it("resetPaginationForRevert 清游标（revertRound 截断后旧游标失效）", async () => {
    invokeMock.mockResolvedValueOnce(pageResponse(30, "tail", 1234));
    const sid = ref<string | null>("uuid-a");
    useChatSession(sid);
    await flush();
    await flush();
    expect(hasMoreOlder("uuid-a")).toBe(true);
    resetPaginationForRevert("uuid-a");
    expect(hasMoreOlder("uuid-a")).toBe(false);
    // 清后 loadOlderPage 返回 0（不 invoke）
    const callsBefore = loadMessagesCalls().length;
    const count = await loadOlderPage("uuid-a", 20);
    expect(count).toBe(0);
    expect(loadMessagesCalls().length).toBe(callsBefore);
  });

  // ── 页台账（recycle 的账本）──

  it("hydrate 建页台账首条：尾部页 loaded + 字节区间来自应答", async () => {
    invokeMock.mockResolvedValueOnce(pageResponse(30, "tail", 1234, undefined, 5000));
    const sid = ref<string | null>("uuid-a");
    useChatSession(sid);
    await flush();
    await flush();
    const { pageLedgers } = await import("./useChatSession/state");
    const ledger = pageLedgers.get("uuid-a");
    expect(ledger).toBeDefined();
    expect(ledger!.length).toBe(1);
    expect(ledger![0]).toMatchObject({
      startOffset: 1234,
      endOffset: 5000,
      count: 30,
      loaded: true,
      restorable: true,
    });
  });

  it("loadOlderPage 台账头插新页：与相邻页首尾相接", async () => {
    invokeMock.mockResolvedValueOnce(pageResponse(30, "tail", 1000, undefined, 5000));
    const sid = ref<string | null>("uuid-a");
    useChatSession(sid);
    await flush();
    await flush();
    invokeMock.mockResolvedValueOnce(pageResponse(20, "older", 200, undefined, 1000));
    await loadOlderPage("uuid-a", 20);
    const { pageLedgers } = await import("./useChatSession/state");
    const ledger = pageLedgers.get("uuid-a")!;
    expect(ledger.length).toBe(2);
    expect(ledger[0]).toMatchObject({ startOffset: 200, endOffset: 1000, count: 20 });
    expect(ledger[1]).toMatchObject({ startOffset: 1000, endOffset: 5000, count: 30 });
    // 首尾相接：旧页的 startOffset = 新页的 endOffset
    expect(ledger[0].endOffset).toBe(ledger[1].startOffset);
  });

  it("resetPaginationForRevert 连页台账一起清（骨架随截断失效）", async () => {
    invokeMock.mockResolvedValueOnce(pageResponse(30, "tail", 1234, undefined, 5000));
    const sid = ref<string | null>("uuid-a");
    useChatSession(sid);
    await flush();
    await flush();
    const { pageLedgers } = await import("./useChatSession/state");
    expect(pageLedgers.get("uuid-a")!.length).toBe(1);
    resetPaginationForRevert("uuid-a");
    expect(pageLedgers.has("uuid-a")).toBe(false);
  });

  it("应答缺 endOffsetBytes（版本错配防御）：页标记不可重取、不释放", async () => {
    // 无 endOffsetBytes 字段的应答（旧后端/版本错配）
    invokeMock.mockResolvedValueOnce({
      messages: pageResponse(10, "tail", 0).messages,
      nextOffsetBytes: 0,
    });
    const sid = ref<string | null>("uuid-a");
    useChatSession(sid);
    await flush();
    await flush();
    const { pageLedgers } = await import("./useChatSession/state");
    const { releasePage } = await import("./useChatSession/recycle");
    const ledger = pageLedgers.get("uuid-a")!;
    expect(ledger.length).toBe(1);
    expect(ledger[0].restorable).toBe(false);
    // 不可重取的页不释放（驻留现状，防数据丢失）
    expect(releasePage("uuid-a", 0)).toBe(0);
    expect(ledger[0].loaded).toBe(true);
  });

  it("store 有数据但游标缺失（活动会话/历史遗留）：hydrate 补探测游标恢复上滚", async () => {
    invokeMock.mockResolvedValueOnce(pageResponse(10, "tail", 5000));
    const sid = ref<string | null>("uuid-a");
    useChatSession(sid);
    await flush();
    await flush();
    expect(hasMoreOlder("uuid-a")).toBe(true);
    // 模拟游标丢失（store 保留）：resetPaginationForRevert 只清分页不动 store
    resetPaginationForRevert("uuid-a");
    expect(hasMoreOlder("uuid-a")).toBe(false);
    // 切走（uuid-b hydrate 消化默认应答）→ 切回：hydrate 重跑 → store 有数据
    // （跳过全量加载）→ 探测补游标
    sid.value = "uuid-b";
    await flush();
    await flush();
    invokeMock.mockResolvedValueOnce(pageResponse(1, "probe", 300));
    sid.value = "uuid-a";
    await flush();
    await flush();
    expect(hasMoreOlder("uuid-a")).toBe(true);
    // 探测 = 最小页（limit 1 字节，只拿游标不 unshift 消息）
    const probe = loadMessagesCalls().find((c) => c[1]?.sessionId === "uuid-a" && c[1]?.limit === 1);
    expect(probe).toBeDefined();
  });

  it("hydrate 兼容 mock 返回 undefined（防御分支）", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await flush();
    expect(chat.messages.value.length).toBe(0);
    expect(hasMoreOlder("uuid-a")).toBe(false);
  });
});
