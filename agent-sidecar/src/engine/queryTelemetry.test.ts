import { describe, it, expect, vi, afterEach } from "vitest";
import { emitContextUsage, RateLimitReporter } from "./queryTelemetry.js";
import type { ChatEvent } from "./types.js";
import type { Query } from "@anthropic-ai/claude-agent-sdk";

function collect() {
  const events: ChatEvent[] = [];
  return { events, emit: (e: ChatEvent) => events.push(e) };
}

describe("emitContextUsage", () => {
  it("DTO 拍平：categories 只留 name/tokens/isDeferred（color 不透传）", async () => {
    const q = {
      getContextUsage: async () => ({
        totalTokens: 100,
        maxTokens: 200,
        percentage: 50,
        rawMaxTokens: 210,
        categories: [{ name: "system", tokens: 40, isDeferred: false, color: "brand-red" }],
      }),
    } as unknown as Query;
    const { events, emit } = collect();
    await emitContextUsage(q, emit);
    expect(events[0]).toEqual({
      type: "context_usage",
      total_tokens: 100,
      max_tokens: 200,
      percentage: 50,
      raw_max_tokens: 210,
      categories: [{ name: "system", tokens: 40, isDeferred: false }],
    });
  });

  it("getContextUsage 抛错（旧 CLI）→ 静默无事件", async () => {
    const q = { getContextUsage: async () => { throw new Error("unsupported"); } } as unknown as Query;
    const { events, emit } = collect();
    await emitContextUsage(q, emit);
    expect(events).toHaveLength(0);
  });
});

describe("RateLimitReporter", () => {
  afterEach(() => vi.useRealTimers());

  function fakeUsageQuery() {
    return {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
        subscription_type: "pro",
        rate_limits_available: false,
      }),
    } as unknown as Query;
  }

  it("首次上报发 rate_limit；15s 内节流不再发；过窗后恢复", async () => {
    vi.useFakeTimers();
    const r = new RateLimitReporter();
    const { events, emit } = collect();
    await r.report(fakeUsageQuery(), emit);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "rate_limit", subscription: "pro" });
    await r.report(fakeUsageQuery(), emit); // 节流窗内
    expect(events).toHaveLength(1);
    vi.advanceTimersByTime(15_001);
    await r.report(fakeUsageQuery(), emit);
    expect(events).toHaveLength(2);
  });

  it("实验方法缺席（旧 CLI 二进制）→ 静默跳过", async () => {
    const r = new RateLimitReporter();
    const { events, emit } = collect();
    await r.report({} as Query, emit);
    expect(events).toHaveLength(0);
  });

  it("usage 调用抛错 → 静默且节流窗不推进（下次仍尝试）", async () => {
    const r = new RateLimitReporter();
    const { events, emit } = collect();
    const bad = {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { throw new Error("boom"); },
    } as unknown as Query;
    await r.report(bad, emit);
    expect(events).toHaveLength(0);
    await r.report(fakeUsageQuery(), emit); // 未节流，立即再试成功
    expect(events).toHaveLength(1);
  });
});
