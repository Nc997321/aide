import { describe, it, expect } from "vitest";
import type { ContextUsageMcpTool } from "@/types/chat";
import {
  chartVarFor,
  formatTokens,
  clampPct,
  sortByTokensDesc,
  sumTokens,
  groupMcpByServer,
} from "./contextUsage";

/**
 * 上下文用量纯逻辑层的分支覆盖：归桶优先级、未知名兜底、格式口径、钳制边界。
 */

describe("chartVarFor — 分类名归桶", () => {
  it("命中各槽位（宽匹配不挑大小写）", () => {
    expect(chartVarFor("System prompt")).toBe("var(--aide-chart1)");
    expect(chartVarFor("Tools")).toBe("var(--aide-chart2)");
    expect(chartVarFor("system tools")).toBe("var(--aide-chart2)");
    expect(chartVarFor("Messages (stable)")).toBe("var(--aide-chart3)");
    expect(chartVarFor("MCP tools")).toBe("var(--aide-chart4)");
    expect(chartVarFor("Skills")).toBe("var(--aide-chart5)");
  });

  it("桶序优先：mcp 在 prompt 前——'MCP prompt' 类命名落 mcp 桶", () => {
    expect(chartVarFor("MCP tools & prompts")).toBe("var(--aide-chart4)");
  });

  it("未知名 / 溢出分类落兜底灰", () => {
    expect(chartVarFor("Custom agents")).toBe("var(--aide-chart-fallback)");
    expect(chartVarFor("Memory files")).toBe("var(--aide-chart-fallback)");
    expect(chartVarFor("")).toBe("var(--aide-chart-fallback)");
  });
});

describe("formatTokens — 紧凑口径", () => {
  it("进 K 一位小数；不足 1K 原样", () => {
    expect(formatTokens(11_000)).toBe("11.0K");
    expect(formatTokens(125_500)).toBe("125.5K");
    expect(formatTokens(1000)).toBe("1.0K");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(220)).toBe("220");
    expect(formatTokens(0)).toBe("0");
  });
});

describe("clampPct — 轨道守卫", () => {
  it("正常值原样、下溢归 0、上溢归 100", () => {
    expect(clampPct(62.8)).toBe(62.8);
    expect(clampPct(0)).toBe(0);
    expect(clampPct(100)).toBe(100);
    expect(clampPct(-5)).toBe(0);
    expect(clampPct(150)).toBe(100);
  });
});

describe("sortByTokensDesc / sumTokens — 明细排序与合计", () => {
  it("降序排列，且不就地改调用方的数组", () => {
    const src = [{ tokens: 1 }, { tokens: 30 }, { tokens: 7 }];
    expect(sortByTokensDesc(src).map((i) => i.tokens)).toEqual([30, 7, 1]);
    expect(src.map((i) => i.tokens)).toEqual([1, 30, 7]);
  });

  it("合计；空数组为 0", () => {
    expect(sumTokens([{ tokens: 1 }, { tokens: 2 }])).toBe(3);
    expect(sumTokens([])).toBe(0);
  });
});

describe("groupMcpByServer — MCP 按 server 归组", () => {
  function tool(name: string, serverName: string, tokens: number): ContextUsageMcpTool {
    return { name, serverName, tokens };
  }

  it("组间按合计降序、组内按工具占用降序、组合计=组内之和", () => {
    const groups = groupMcpByServer([
      tool("browser_read", "aide-browser", 150),
      tool("start_search", "desktop-commander", 1760),
      tool("start_process", "desktop-commander", 1420),
      tool("browser_eval", "aide-browser", 250),
    ]);
    expect(groups.map((g) => g.serverName)).toEqual(["desktop-commander", "aide-browser"]);
    expect(groups[0]).toEqual({
      serverName: "desktop-commander",
      tokens: 3180,
      tools: [
        tool("start_search", "desktop-commander", 1760),
        tool("start_process", "desktop-commander", 1420),
      ],
    });
    expect(groups[1]?.tokens).toBe(400);
  });

  it("同名 server 合并成一组；空输入不造空壳组", () => {
    const groups = groupMcpByServer([
      tool("a", "aide-docs", 1),
      tool("b", "aide-docs", 2),
      tool("c", "aide-docs", 3),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.tools).toHaveLength(3);
    expect(groupMcpByServer([])).toEqual([]);
  });
});