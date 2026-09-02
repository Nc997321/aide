// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

// WorkspacePicker 是既有组件（自有测试覆盖），这里 mock 成按钮桩，聚焦 HeroWelcome 主控。
vi.mock("../../../ui/WorkspacePicker.vue", () => ({
  default: {
    name: "WorkspacePicker",
    props: { path: String },
    emits: ["select"],
    template: `<button data-test="ws-picker" @click="$emit('select', { path: 'C:/demo' })">{{ path || '未选择' }}</button>`,
  },
}));

import HeroWelcome from "./HeroWelcome.vue";

/** 固定系统时间：2026-09-01（周二）14:30 → 下午好。 */
const AFTERNOON = new Date(2026, 8, 1, 14, 30, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AFTERNOON);
  // seed 固定为 0 → 文案池第一条
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("HeroWelcome 渲染", () => {
  it("渲染时间问候 + 日期 + 轮换文案（seed=0 取池首）", () => {
    const wrapper = mount(HeroWelcome, { props: { workspacePath: "", modelName: "" } });
    const text = wrapper.text();
    expect(text).toContain("下午好。");
    expect(text).toContain("9月1日 · 星期二");
    expect(text).toContain("14:30");
    expect(text).toContain("今天想从哪块代码开始？");
    expect(text).toContain("发个目标、贴段报错，或直接指个文件——我先读代码再动手。");
  });

  it("modelName 缺省显示「默认模型」，传入则显示模型名", async () => {
    const wrapper = mount(HeroWelcome, { props: { workspacePath: "", modelName: "" } });
    expect(wrapper.text()).toContain("默认模型");

    await wrapper.setProps({ modelName: "Claude Opus" });
    expect(wrapper.text()).toContain("Claude Opus");
  });

  it("workspacePath 透传给 WorkspacePicker", () => {
    const wrapper = mount(HeroWelcome, { props: { workspacePath: "C:/demo", modelName: "" } });
    expect(wrapper.get('[data-test="ws-picker"]').text()).toContain("C:/demo");
  });

  it("WorkspacePicker 的 select 上抛为 select-workspace", async () => {
    const wrapper = mount(HeroWelcome, { props: { workspacePath: "", modelName: "" } });
    await wrapper.get('[data-test="ws-picker"]').trigger("click");
    expect(wrapper.emitted("select-workspace")?.[0]?.[0]).toEqual({ path: "C:/demo" });
  });
});

describe("HeroWelcome 跨时段翻新", () => {
  it("60s 后时钟走到 14:31（时钟不冻结）", async () => {
    const wrapper = mount(HeroWelcome, { props: { workspacePath: "", modelName: "" } });
    expect(wrapper.text()).toContain("14:30");

    vi.advanceTimersByTime(60_000);
    await nextTick();
    expect(wrapper.text()).toContain("14:31");
  });

  it("60s 后时段未变则问候不变", async () => {
    const wrapper = mount(HeroWelcome, { props: { workspacePath: "", modelName: "" } });
    expect(wrapper.text()).toContain("下午好。");

    vi.advanceTimersByTime(60_000);
    await nextTick();
    expect(wrapper.text()).toContain("下午好。");
  });

  it("跨过 18:00 边界后问候翻成「晚上好」", async () => {
    const wrapper = mount(HeroWelcome, { props: { workspacePath: "", modelName: "" } });
    expect(wrapper.text()).toContain("下午好。");

    vi.setSystemTime(new Date(2026, 8, 1, 18, 0, 0, 0));
    vi.advanceTimersByTime(60_000);
    await nextTick();
    expect(wrapper.text()).toContain("晚上好。");
  });

  it("卸载后定时器清理（F2）", () => {
    const wrapper = mount(HeroWelcome, { props: { workspacePath: "", modelName: "" } });
    expect(vi.getTimerCount()).toBe(1);
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
