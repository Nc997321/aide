// 发送按钮：方形回车键，悬停弹出功能列表（2026-10-17）。
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import ChatSendButton from "./ChatSendButton.vue";
import type { QuickAction } from "@/composables/useQuickActions";

const actions: QuickAction[] = [
  { id: "btw", command: "btw", label: "顺便问一下", kind: "btw", icon: "↳" },
  { id: "compact", command: "compact", label: "压缩上下文", kind: "prompt", icon: "✦" },
];

function mountBtn(props: Record<string, unknown> = {}) {
  return mount(ChatSendButton, {
    props: { actions, ...props },
    attachTo: document.body,
    global: { directives: { tooltip: () => {} } },
  });
}

const menu = () => document.body.querySelector(".chat-send-menu");
const items = () => Array.from(document.body.querySelectorAll<HTMLButtonElement>(".chat-send-menu-item"));

async function hoverOpen(w: ReturnType<typeof mountBtn>) {
  await w.find(".chat-send").trigger("mouseenter");
  vi.advanceTimersByTime(200);
  await w.vm.$nextTick();
  await w.vm.$nextTick();
}

describe("ChatSendButton", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("点击按钮 = 发送；禁用时点击不发", async () => {
    const w = mountBtn();
    await w.find(".chat-send-btn").trigger("click");
    expect(w.emitted("send")).toHaveLength(1);
    await w.setProps({ disabled: true });
    await w.find(".chat-send-btn").trigger("click");
    expect(w.emitted("send")).toHaveLength(1);
    w.unmount();
  });

  it("悬停后弹出列表：首项是发送，其下是命令；离开后关闭", async () => {
    vi.useFakeTimers();
    const w = mountBtn();
    expect(menu()).toBeNull();
    await hoverOpen(w);
    expect(menu()).not.toBeNull();
    expect(items().map((b) => b.querySelector(".chat-send-menu-label")?.textContent)).toEqual(["发送", "顺便问一下", "压缩上下文"]);

    await w.find(".chat-send").trigger("mouseleave");
    vi.advanceTimersByTime(300);
    await w.vm.$nextTick();
    expect(menu()).toBeNull();
    w.unmount();
  });

  it("鼠标路过（没停够）不弹", async () => {
    vi.useFakeTimers();
    const w = mountBtn();
    await w.find(".chat-send").trigger("mouseenter");
    vi.advanceTimersByTime(50);
    await w.find(".chat-send").trigger("mouseleave");
    vi.advanceTimersByTime(300);
    await w.vm.$nextTick();
    expect(menu()).toBeNull();
    w.unmount();
  });

  it("输入为空也能悬停选命令；忙碌时发送项显示「排队」", async () => {
    vi.useFakeTimers();
    const w = mountBtn({ disabled: true, busy: true });
    await hoverOpen(w);
    expect(items()[0].textContent).toContain("排队");
    items()[2].click();
    expect(w.emitted("select")?.[0]).toEqual([actions[1]]);
    expect(w.emitted("send")).toBeUndefined();
    w.unmount();
  });

  it("btw 不可用时点了不选、不关列表", async () => {
    vi.useFakeTimers();
    const w = mountBtn({ btwDisabled: true });
    await hoverOpen(w);
    items()[1].click();
    await w.vm.$nextTick();
    expect(w.emitted("select")).toBeUndefined();
    expect(menu()).not.toBeNull();
    w.unmount();
  });
});
