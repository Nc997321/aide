// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { mount, enableAutoUnmount } from "@vue/test-utils";
import ContextUsageSegments from "./ContextUsageSegments.vue";
import type { ContextUsage, ContextUsageCategory } from "@/types/chat";

// 分段彩条的渲染层验收：段宽基准=完整窗、保留区条纹段、deferred 半透明、
// 零 token 过滤、无 categories 的空态。

enableAutoUnmount(afterEach);

function cat(name: string, tokens: number, isDeferred?: boolean): ContextUsageCategory {
  return isDeferred === undefined ? { name, tokens } : { name, tokens, isDeferred };
}

/** 原型口径的会话：total 125.5K / max 160K / raw 200K。 */
function usage(categories: ContextUsageCategory[], over: Partial<ContextUsage> = {}): ContextUsage {
  return {
    totalTokens: 125_500,
    maxTokens: 160_000,
    percentage: 62.8,
    rawMaxTokens: 200_000,
    categories,
    ...over,
  };
}

function mountSegments(categories: ContextUsageCategory[], over: Partial<ContextUsage> = {}) {
  return mount(ContextUsageSegments, { props: { usage: usage(categories, over) } });
}

describe("ContextUsageSegments", () => {
  it("每类一段，宽度按完整窗基准（11K/200K=5.5%）", () => {
    const w = mountSegments([cat("System prompt", 11_000), cat("MCP tools", 220)]);
    const segs = w.findAll(".usage-segments__seg");
    expect(segs).toHaveLength(2);
    expect(segs[0]!.attributes("style")).toContain("width: 5.5%");
  });

  it("零 token 分类被过滤，不占段位", () => {
    const w = mountSegments([cat("Tools", 0), cat("Messages", 79_500)]);
    expect(w.findAll(".usage-segments__seg")).toHaveLength(1);
  });

  it("deferred 分类标记半透明类", () => {
    const w = mountSegments([cat("Skills", 4_100, true)]);
    expect(w.find(".usage-segments__seg").classes()).toContain("usage-segments__seg--deferred");
  });

  it("rawMax > max 时画保留区条纹段，宽度=差值占比（20%）", () => {
    const w = mountSegments([cat("Tools", 30_700)]);
    const reserved = w.find(".usage-segments__reserved");
    expect(reserved.exists()).toBe(true);
    expect(reserved.attributes("style")).toContain("width: 20%");
  });

  it("缺 rawMaxTokens（旧数据降级）不画条纹段；无 categories 渲染空白轨道", () => {
    const noRaw = mountSegments([cat("Tools", 30_700)], { rawMaxTokens: undefined });
    expect(noRaw.find(".usage-segments__reserved").exists()).toBe(false);

    const noCats = mount(ContextUsageSegments, {
      props: { usage: usage([], { rawMaxTokens: undefined, categories: undefined }) },
    });
    expect(noCats.find(".usage-segments__seg").exists()).toBe(false);
    expect(noCats.find(".usage-segments__reserved").exists()).toBe(false);
    expect(noCats.find(".usage-segments").exists()).toBe(true);
  });
});