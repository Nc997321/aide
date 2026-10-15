import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { REWARM_AFTER_MS, _resetLspWarmForTest, isLspWarm, resolveLspResult, syncLspWarmth } from "./lspClient.js";
import type { ChatEvent } from "../engine/types.js";

/** 每条 send 的预热同步：按开关决定预热与就绪记录（见 lspClient.syncLspWarmth）。 */
describe("syncLspWarmth", () => {
  let sent: Array<Extract<ChatEvent, { type: "lsp_query" }>>;
  const emit = (e: ChatEvent) => {
    if (e.type === "lsp_query") sent.push(e);
  };
  beforeEach(() => {
    _resetLspWarmForTest();
    sent = [];
  });

  it("开关开着：发一发 warm；进行中不重复发（单飞）", () => {
    syncLspWarmth("/ws", true, true, emit);
    syncLspWarmth("/ws", true, true, emit);
    expect(sent.map((e) => e.tool)).toEqual(["warm"]);
  });

  it("预热答 ready 后不再发；关闭开关后就绪作废、且不发任何查询", () => {
    syncLspWarmth("/ws", true, true, emit);
    resolveLspResult({ request_id: sent[0].request_id, ok: true, status: "ready" });
    expect(isLspWarm("/ws")).toBe(true);
    syncLspWarmth("/ws", true, true, emit);
    expect(sent).toHaveLength(1);
    syncLspWarmth("/ws", false, true, emit);
    expect(isLspWarm("/ws")).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("预热没就绪（休眠后 / 失败）结束后，下一条 send 再发", async () => {
    syncLspWarmth("/ws", true, true, emit);
    resolveLspResult({ request_id: sent[0].request_id, ok: false, status: "indexing" });
    await Promise.resolve();
    await Promise.resolve();
    syncLspWarmth("/ws", true, true, emit);
    expect(sent).toHaveLength(2);
  });

  it("任何查询回 disabled（会话中途被关）→ 就绪作废", () => {
    syncLspWarmth("/ws", true, true, emit);
    resolveLspResult({ request_id: sent[0].request_id, ok: true, status: "ready" });
    syncLspWarmth("/other", true, true, emit);
    resolveLspResult({ request_id: sent[1].request_id, ok: false, status: "disabled" });
    expect(isLspWarm("/ws")).toBe(true);
    expect(isLspWarm("/other")).toBe(false);
  });

  it("就绪记录过了复查期 → 下一条 send 再确认一次（Host 可能已把空闲 server 休眠）", async () => {
    vi.useFakeTimers();
    try {
      syncLspWarmth("/ws", true, true, emit);
      resolveLspResult({ request_id: sent[0].request_id, ok: true, status: "ready" });
      await Promise.resolve();
      await Promise.resolve(); // 预热结束（finally 清「进行中」）
      vi.advanceTimersByTime(REWARM_AFTER_MS - 1000);
      syncLspWarmth("/ws", true, true, emit);
      expect(sent).toHaveLength(1);
      vi.advanceTimersByTime(2000);
      syncLspWarmth("/ws", true, true, emit);
      expect(sent).toHaveLength(2);
      expect(isLspWarm("/ws")).toBe(true); // 复查期间顺带作答照常
    } finally {
      vi.useRealTimers();
    }
  });

  it("没有可用语言：不预热", () => {
    syncLspWarmth("/ws", true, false, emit);
    expect(sent).toHaveLength(0);
  });
});
