// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { enableAutoUnmount, mount, type VueWrapper } from "@vue/test-utils";
import type { ContextUsageBreakdown as Breakdown } from "@/types/chat";
import ContextUsageBreakdown from "./ContextUsageBreakdown.vue";

enableAutoUnmount(afterEach);

/** 组件与数据类型同名：组件文件里只 import 类型、面板里只 import 组件，
 *  测试是唯一同时需要两者的地方，用别名分开。 */
function mountBreakdown(breakdown: Breakdown) {
  return mount(ContextUsageBreakdown, { props: { breakdown } });
}

/** 只取折叠头（section 行）的标签——明细行不算。 */
function sectionLabels(w: VueWrapper): string[] {
  return w.findAll(".usage-breakdown__row--head .usage-breakdown__label").map((n) => n.text());
}

function sectionValues(w: VueWrapper): string[] {
  return w.findAll(".usage-breakdown__row--head .usage-breakdown__value").map((n) => n.text());
}

const fullBreakdown: Breakdown = {
  mcpTools: [
    { name: "start_search", serverName: "desktop-commander", tokens: 1760 },
    { name: "start_process", serverName: "desktop-commander", tokens: 1420 },
    { name: "browser_read", serverName: "aide-browser", tokens: 150 },
  ],
  // 刻意乱序：组件负责按占用降序，内置工具里 Read(300) 应排在 Bash(900) 之后
  systemTools: [
    { name: "Read", tokens: 300 },
    { name: "Bash", tokens: 900 },
  ],
  memoryFiles: [{ path: "C:/ws/CLAUDE.md", type: "project", tokens: 1200 }],
  agents: [{ agentType: "rust-reviewer", source: "project", tokens: 250 }],
};

describe("ContextUsageBreakdown — 分组与合计", () => {
  it("全组缺席 → 整块不渲染（不是空壳）", () => {
    const w = mountBreakdown({});
    expect(w.find(".usage-breakdown").exists()).toBe(false);
  });

  it("只渲染有数据的组，表头即合计（含 MCP 组内之和）", () => {
    const w = mountBreakdown(fullBreakdown);
    // deferredBuiltinTools / systemPromptSections 缺席 → 无对应 section
    expect(sectionLabels(w)).toEqual(["MCP 工具", "内置工具", "记忆文件", "子代理"]);
    expect(sectionValues(w)).toEqual(["3.3K", "1.2K", "1.2K", "250"]);
  });

  it("默认全收起：不点开就没有任何明细行", () => {
    const w = mountBreakdown(fullBreakdown);
    expect(w.findAll(".usage-breakdown__row:not(.usage-breakdown__row--head)")).toHaveLength(0);
  });
});

describe("ContextUsageBreakdown — 两级展开", () => {
  it("点 section 头展开：MCP 先出 server 汇总行（不直接铺工具）", async () => {
    const w = mountBreakdown(fullBreakdown);
    await w.get(".usage-breakdown__row--head").trigger("click");

    const rows = w.findAll(".usage-breakdown__row:not(.usage-breakdown__row--head)");
    expect(rows.map((r) => r.find(".usage-breakdown__label").text())).toEqual([
      "desktop-commander",
      "aide-browser",
    ]);
    expect(rows[0]?.find(".usage-breakdown__value").text()).toBe("3.2K");
    // server 行本身是可展开的（带 aria-expanded），工具行还没出现
    const servers = w.findAll(".usage-breakdown__row[aria-expanded]:not(.usage-breakdown__row--head)");
    expect(servers).toHaveLength(2);
    expect(servers[0]?.attributes("aria-expanded")).toBe("false");
    expect(w.text()).not.toContain("start_search");
  });

  it("再点 server 行才铺出工具，且按占用降序", async () => {
    const w = mountBreakdown(fullBreakdown);
    await w.get(".usage-breakdown__row--head").trigger("click");
    await w.get(".usage-breakdown__row[aria-expanded]:not(.usage-breakdown__row--head)").trigger("click");

    // 只看 MCP 区（首个 section）内的行序：组头 → server → 该 server 的工具
    const labels = w
      .findAll(".usage-breakdown__section:first-child .usage-breakdown__row")
      .map((r) => r.find(".usage-breakdown__label").text());
    expect(labels).toEqual(["MCP 工具", "desktop-commander", "start_search", "start_process", "aide-browser"]);
    // 子行缩进用 depth 类表达层级
    expect(w.findAll(".usage-breakdown__row--d1")).toHaveLength(2);
    // 收回去
    await w.get(".usage-breakdown__row[aria-expanded]:not(.usage-breakdown__row--head)").trigger("click");
    expect(w.text()).not.toContain("start_search");
  });

  it("平铺组按占用降序，来源标签作尾注", async () => {
    const w = mountBreakdown(fullBreakdown);
    await w.findAll(".usage-breakdown__row--head")[1]?.trigger("click"); // 内置工具
    expect(
      w.findAll(".usage-breakdown__row--d0:not(.usage-breakdown__row--head)").map((r) => r.find(".usage-breakdown__label").text()),
    ).toEqual(["Bash", "Read"]);

    await w.findAll(".usage-breakdown__row--head")[2]?.trigger("click"); // 记忆文件
    expect(w.find(".usage-breakdown__note").text()).toBe("project");
    // 长路径靠原生 title 兜底（截断时可见全量）
    expect(w.find(".usage-breakdown__row[title='C:/ws/CLAUDE.md']").exists()).toBe(true);
  });
});
