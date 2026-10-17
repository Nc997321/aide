// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

// 光带图是 vite 公共资源，jsdom 下导入会崩，标记组件换成占位
vi.mock("../activity/ThinkingMark.vue", () => ({ default: { name: "ThinkingMark", template: "<span class='tm-stub' />" } }));

import ThinkingLine from "./ThinkingLine.vue";

const on = (w: ReturnType<typeof mount>) => w.find(".tline-row").classes().includes("tline-row--on");

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ThinkingLine · 防闪", () => {
  it("槽位常驻：不在想时也渲染那一格（高度不因它变化），只是不亮", () => {
    const w = mount(ThinkingLine, { props: { active: false, elapsedSeconds: 0, tip: null } });
    expect(w.find(".tline").exists()).toBe(true);
    expect(on(w)).toBe(false);
  });

  it("出现稍等一下：一闪而过的忙不亮", async () => {
    const w = mount(ThinkingLine, { props: { active: false, elapsedSeconds: 0, tip: null } });
    await w.setProps({ active: true });
    await vi.advanceTimersByTimeAsync(100);
    await w.setProps({ active: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(on(w)).toBe(false);
  });

  it("两轮之间短暂不忙：不灭了又亮", async () => {
    const w = mount(ThinkingLine, { props: { active: true, elapsedSeconds: 3, tip: null } });
    await vi.advanceTimersByTimeAsync(200);
    expect(on(w)).toBe(true);
    await w.setProps({ active: false });
    await vi.advanceTimersByTimeAsync(300);
    expect(on(w)).toBe(true);
    await w.setProps({ active: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(on(w)).toBe(true);
  });

  it("真结束了：稍后淡出，槽位还在", async () => {
    const w = mount(ThinkingLine, { props: { active: true, elapsedSeconds: 3, tip: null } });
    await vi.advanceTimersByTimeAsync(200);
    await w.setProps({ active: false });
    await vi.advanceTimersByTimeAsync(500);
    expect(on(w)).toBe(false);
    expect(w.find(".tline").exists()).toBe(true);
  });
});
