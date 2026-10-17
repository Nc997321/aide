// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

vi.mock("./ThinkingMark.vue", () => ({ default: { name: "ThinkingMark", template: "<span class='tm-stub' />" } }));

import ActivityStrip from "./ActivityStrip.vue";

const base = { compaction: null, thinking: true, elapsedSeconds: 5, tip: null, chips: [] };

describe("ActivityStrip · 思考字样", () => {
  it("消息流末尾那行看得见：字样淡出但位置还在，中断照样在", () => {
    const w = mount(ActivityStrip, { props: { ...base, thinkingLabel: false }, global: { directives: { tooltip: () => {} } } });
    const t = w.find(".astrip-thinking");
    expect(t.exists()).toBe(true);
    expect(t.classes()).toContain("astrip-thinking--quiet");
    expect(w.html()).toMatch(/interrupt|中断/i);
  });

  it("往上翻走了：亮出「思考中」", () => {
    const w = mount(ActivityStrip, { props: { ...base, thinkingLabel: true }, global: { directives: { tooltip: () => {} } } });
    expect(w.find(".astrip-thinking").classes()).not.toContain("astrip-thinking--quiet");
    expect(w.text()).toContain("思考中");
  });
});
