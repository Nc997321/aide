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

describe("ThinkingLine · 在不在可视区（直接量）", () => {
  function rect(top: number, height: number) {
    return { top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON() {} } as DOMRect;
  }

  function mountInRoot(lineTop: { v: number }) {
    const root = document.createElement("div");
    root.className = "chat-messages";
    root.getBoundingClientRect = () => rect(0, 400);
    document.body.appendChild(root);
    const w = mount(ThinkingLine, { props: { active: true, elapsedSeconds: 1, tip: null }, attachTo: root });
    (w.find(".tline").element as HTMLElement).getBoundingClientRect = () => rect(lineTop.v, 28);
    return w;
  }

  it("看得见报 true，翻走了报 false；只在变化时发", async () => {
    const top = { v: 1000 };
    const w = mountInRoot(top); // 挂载那一刻还没装矩形桩 → jsdom 全 0 → 看不见
    top.v = 360;
    await w.setProps({ elapsedSeconds: 2 });
    await w.setProps({ elapsedSeconds: 3 });
    top.v = 900;
    await w.setProps({ elapsedSeconds: 4 });
    expect(w.emitted("in-view")).toEqual([[false], [true], [false]]);
    w.unmount();
  });

  it("漏了滚动事件也会在下一秒计时时自愈", async () => {
    const top = { v: 2000 };
    const w = mountInRoot(top);
    await w.setProps({ elapsedSeconds: 2 });
    expect(w.emitted("in-view")!.at(-1)).toEqual([false]);
    top.v = 300; // 滚回来了，但没收到任何事件
    await w.setProps({ elapsedSeconds: 3 });
    expect(w.emitted("in-view")!.at(-1)).toEqual([true]);
    w.unmount();
  });
});
