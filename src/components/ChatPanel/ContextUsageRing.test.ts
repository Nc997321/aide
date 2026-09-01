// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { mount, enableAutoUnmount } from "@vue/test-utils";
import ContextUsageRing from "./ContextUsageRing.vue";
import type { ContextUsage } from "@/types/chat";

// 环形指示的三臂状态联动（ok/warning/danger）与 open 事件转发的渲染层验收。

enableAutoUnmount(afterEach);

function usage(percentage: number): ContextUsage {
  return { totalTokens: 1000, maxTokens: 2000, percentage };
}

describe("ContextUsageRing", () => {
  it.each([
    [62.8, "usage-ring--ok"],
    [80, "usage-ring--warning"],
    [99.9, "usage-ring--warning"],
    [100, "usage-ring--danger"],
    [150, "usage-ring--danger"], // 越界值钳到 100 后落 danger 臂
  ])("percentage %i → 状态类 %s", (pct, cls) => {
    const w = mount(ContextUsageRing, { props: { usage: usage(pct) } });
    expect(w.classes()).toContain(cls);
  });

  it("进度弧 dashoffset 随 percentage 收缩（0% = 满周长）", () => {
    const w = mount(ContextUsageRing, { props: { usage: usage(0) } });
    const arc = w.find(".usage-ring__arc");
    expect(arc.attributes("stroke-dashoffset")).toBe(String(2 * Math.PI * 15));
  });

  it("点击发射 open（open-only 语义由父实现）", async () => {
    const w = mount(ContextUsageRing, { props: { usage: usage(50) } });
    await w.trigger("click");
    expect(w.emitted("open")).toHaveLength(1);
  });
});