// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

vi.mock("./ThinkingMark.vue", () => ({ default: { name: "ThinkingMark", template: "<span class='tm-stub' />" } }));

import ActivityStrip from "./ActivityStrip.vue";

const base = { compaction: null, thinking: true, elapsedSeconds: 5, tip: null, chips: [] };

describe("ActivityStrip · 思考字样", () => {
  it("消息流末尾那行看得见：「思考中」不占位，中断照样在", () => {
    const w = mount(ActivityStrip, { props: { ...base, thinkingLabel: false }, global: { directives: { tooltip: () => {} } } });
    expect(w.find(".astrip-thinking").exists()).toBe(false);
    expect(w.html()).toMatch(/interrupt|中断/i);
  });

  it("消息流末尾那行看得见：后台 chip 靠左、不带分隔线", () => {
    const chip = { tab: "bg", label: "后台", tone: "run", running: 1, open: false, title: "" };
    const w = mount(ActivityStrip, {
      props: { ...base, thinkingLabel: false, chips: [chip] as never },
      global: { directives: { tooltip: () => {} } },
    });
    expect(w.find(".astrip-chips").classes()).toContain("astrip-chips--alone");
  });

  it("往上翻走了：亮出「思考中」", () => {
    const w = mount(ActivityStrip, { props: { ...base, thinkingLabel: true }, global: { directives: { tooltip: () => {} } } });
    expect(w.find(".astrip-thinking").exists()).toBe(true);
    expect(w.text()).toContain("思考中");
  });
});
