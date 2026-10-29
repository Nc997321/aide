import { describe, it, expect, vi, afterEach } from "vitest";
import { emitContextUsage, RateLimitReporter } from "./queryTelemetry.js";
import type { ChatEvent } from "./types.js";
import type { Query, SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";

function collect() {
  const events: ChatEvent[] = [];
  return { events, emit: (e: ChatEvent) => events.push(e) };
}

/**
 * SDK getContextUsage 返回体的**全字段** fixture——刻意带全 19 个顶层字段（含本端
 * 刻意裁剪的那些），并**标注 SDK 真名返回类型**：这样 SDK 新增**必填**字段时 tsc
 * 会在本函数处直接报错，把人逼回 queryTelemetry.ts 的裁剪清单表态。
 *
 * 边界（如实说明）：新增**可选**字段不会触发任何机械检查，仍要靠人工发现——
 * 那份清单的唯一完备保障是 review，不是这里的断言。
 */
function fullUsage(): SDKControlGetContextUsageResponse {
  return {
    categories: [{ name: "MCP tools", tokens: 19_700, isDeferred: false, color: "#7B61FF" }],
    totalTokens: 125_500,
    maxTokens: 160_000,
    rawMaxTokens: 200_000,
    percentage: 62.8,
    model: "claude-sonnet-4-5",
    gridRows: [
      [
        {
          color: "#7B61FF",
          isFilled: true,
          categoryName: "MCP tools",
          tokens: 19_700,
          percentage: 12,
          squareFullness: 1,
        },
      ],
    ],
    memoryFiles: [{ path: "C:/ws/CLAUDE.md", type: "project", tokens: 1_200 }],
    mcpTools: [
      { name: "start_search", serverName: "desktop-commander", tokens: 1_760, isLoaded: true },
      { name: "browser_read", serverName: "aide-browser", tokens: 150 },
    ],
    deferredBuiltinTools: [{ name: "WebFetch", tokens: 300, isLoaded: false }],
    systemTools: [{ name: "Bash", tokens: 900 }],
    systemPromptSections: [{ name: "Environment", tokens: 400 }],
    agents: [{ agentType: "rust-reviewer", source: "project", tokens: 250 }],
    slashCommands: { totalCommands: 30, includedCommands: 12, tokens: 500 },
    skills: {
      totalSkills: 20,
      includedSkills: 4,
      tokens: 800,
      skillFrontmatter: [{ name: "ts", source: "project", tokens: 120 }],
    },
    autoCompactThreshold: 0.9,
    isAutoCompactEnabled: true,
    messageBreakdown: {
      toolCallTokens: 10,
      toolResultTokens: 20,
      attachmentTokens: 0,
      assistantMessageTokens: 30,
      userMessageTokens: 40,
      redirectedContextTokens: 0,
      unattributedTokens: 0,
      toolCallsByType: [],
      attachmentsByType: [],
    },
    apiUsage: {
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

describe("emitContextUsage", () => {
  it("DTO 拍平：categories 与 breakdown 六组只留白名单字段", async () => {
    const q = { getContextUsage: async () => fullUsage() } as unknown as Query;
    const { events, emit } = collect();
    await emitContextUsage(q, emit);
    expect(events[0]).toEqual({
      type: "context_usage",
      total_tokens: 125_500,
      max_tokens: 160_000,
      percentage: 62.8,
      raw_max_tokens: 200_000,
      categories: [{ name: "MCP tools", tokens: 19_700, isDeferred: false }],
      breakdown: {
        mcpTools: [
          { name: "start_search", serverName: "desktop-commander", tokens: 1_760 },
          { name: "browser_read", serverName: "aide-browser", tokens: 150 },
        ],
        systemTools: [{ name: "Bash", tokens: 900 }],
        deferredBuiltinTools: [{ name: "WebFetch", tokens: 300 }],
        systemPromptSections: [{ name: "Environment", tokens: 400 }],
        memoryFiles: [{ path: "C:/ws/CLAUDE.md", type: "project", tokens: 1_200 }],
        agents: [{ agentType: "rust-reviewer", source: "project", tokens: 250 }],
      },
    });
  });

  it("裁剪清单：brand 色 / isLoaded / 聚合标量 / 消息统计都不进 wire", async () => {
    const q = { getContextUsage: async () => fullUsage() } as unknown as Query;
    const { events, emit } = collect();
    await emitContextUsage(q, emit);
    const ev = events[0] as Extract<ChatEvent, { type: "context_usage" }>;

    // 组是封闭的六组：SDK 新增分组必须同时改实现与这里的期望
    expect(Object.keys(ev.breakdown ?? {})).toEqual([
      "mcpTools",
      "systemTools",
      "deferredBuiltinTools",
      "systemPromptSections",
      "memoryFiles",
      "agents",
    ]);
    // 顶层裁剪字段一个都不许漏进来
    for (const dropped of [
      "model",
      "gridRows",
      "slashCommands",
      "skills",
      "autoCompactThreshold",
      "isAutoCompactEnabled",
      "messageBreakdown",
      "apiUsage",
    ]) {
      expect(ev).not.toHaveProperty(dropped);
    }
    // 嵌套裁剪字段：品牌色（顶层 gridRows + categories）与 isLoaded / skillFrontmatter
    const wire = JSON.stringify(ev);
    expect(wire).not.toContain("7B61FF");
    expect(wire).not.toContain("isLoaded");
    expect(wire).not.toContain("skillFrontmatter");
  });

  it("六组全空（旧 CLI / provider 未提供明细）→ breakdown 整个不出现", async () => {
    const q = {
      getContextUsage: async () => ({
        totalTokens: 100,
        maxTokens: 200,
        percentage: 50,
        rawMaxTokens: 210,
        categories: [],
        mcpTools: [],
        memoryFiles: [],
        agents: [],
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
      categories: [],
      breakdown: undefined,
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
