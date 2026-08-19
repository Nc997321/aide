// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { defineComponent, h, ref } from "vue";
import { mount } from "@vue/test-utils";
import { nearestScrollableAncestor, useChatScroll } from "./useChatScroll";
import type { ChatMessage } from "@/types/chat";
import { resetScrollTrailForTest, snapshotScrollTrail } from "../utils/diagnostics/scrollTrail";

function oneMessage(): ChatMessage[] {
  return [
    {
      id: "m0",
      role: "user",
      blocks: [{ type: "text", text: "hi" }],
      timestamp: 0,
    },
  ];
}

/** 挂一个用 useChatScroll 的组件：scrollEl 高 200px、内容 2000px（可滚），按 target
 *  选项在内容里塞一个可滚的嵌套块或纯文本，返回 wrapper 与 scrollEl DOM。 */
function mountScroll(target: "plain-text" | "nested-scroller") {
  const messages = ref(oneMessage());
  const sessionId = ref("s1");
  const Comp = defineComponent({
    setup() {
      const { scrollEl, contentEl } = useChatScroll(
        () => messages.value,
        () => sessionId.value,
      );
      return { scrollEl, contentEl };
    },
    render() {
      // contentEl 是 RO 观察 + 消息容器；scrollEl 是滚动容器（overflow-y:auto）
      const inner =
        target === "nested-scroller"
          ? h(
              "div",
              { class: "nested", style: "overflow-y:auto; max-height:100px; height:100px" },
              [h("div", { class: "nested-inner", style: "height:500px" }, "x")],
            )
          : h("p", { class: "plain" }, "正文");
      return h(
        "div",
        { ref: "scrollEl" as any, class: "chat-messages", style: "overflow-y:auto; height:200px" },
        [h("div", { ref: "contentEl" as any, style: "height:2000px" }, [inner])],
      );
    },
  });
  const wrapper = mount(Comp, { attachTo: document.body });
  const scrollEl = wrapper.find(".chat-messages").element as HTMLElement;
  return { wrapper, scrollEl };
}

/** jsdom 不做布局，scrollHeight/clientHeight 恒 0，手动 mock 嵌套块几何以测 atScrollEdge 边界判定。 */
function setGeometry(el: HTMLElement, g: { scrollTop?: number; clientHeight?: number; scrollHeight?: number }) {
  if (g.scrollTop !== undefined) el.scrollTop = g.scrollTop;
  if (g.clientHeight !== undefined) Object.defineProperty(el, "clientHeight", { value: g.clientHeight, configurable: true });
  if (g.scrollHeight !== undefined) Object.defineProperty(el, "scrollHeight", { value: g.scrollHeight, configurable: true });
}

describe("nearestScrollableAncestor", () => {
  it("自身可滚时返回自身", () => {
    const el = document.createElement("div");
    el.style.overflowY = "auto";
    document.body.appendChild(el);
    expect(nearestScrollableAncestor(el)).toBe(el);
  });

  it("向上找第一个 overflow-y:auto/scroll 祖先", () => {
    document.body.innerHTML = `<div class="outer" style="overflow-y:auto"><div class="mid"><p class="leaf">x</p></div></div>`;
    const leaf = document.querySelector(".leaf")!;
    expect(nearestScrollableAncestor(leaf)).toBe(document.querySelector(".outer"));
  });

  it("死区：一路无可滚祖先返回 null", () => {
    document.body.innerHTML = `<div><p class="x">x</p></div>`;
    expect(nearestScrollableAncestor(document.querySelector(".x"))).toBeNull();
  });
});

describe("useChatScroll 滚轮接管", () => {
  it("光标在正文（最近可滚祖先是 chat-messages）：preventDefault + scrollTop += deltaY", () => {
    resetScrollTrailForTest();
    const { wrapper, scrollEl } = mountScroll("plain-text");
    const before = scrollEl.scrollTop;
    const evt = new WheelEvent("wheel", { deltaY: 100, deltaMode: 0, bubbles: true, cancelable: true });
    scrollEl.querySelector(".plain")!.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(scrollEl.scrollTop).toBe(before + 100);
    // 诊断环留痕
    const takeover = snapshotScrollTrail().filter((e) => e.kind === "wheelTakeover");
    expect(takeover).toHaveLength(1);
    wrapper.unmount();
  });

  it("光标在嵌套可滚块：放行原生链式，不 preventDefault、不动 scrollTop", () => {
    resetScrollTrailForTest();
    const { wrapper, scrollEl } = mountScroll("nested-scroller");
    const before = scrollEl.scrollTop;
    const evt = new WheelEvent("wheel", { deltaY: 100, deltaMode: 0, bubbles: true, cancelable: true });
    scrollEl.querySelector(".nested-inner")!.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    expect(scrollEl.scrollTop).toBe(before);
    expect(snapshotScrollTrail().filter((e) => e.kind === "wheelTakeover")).toHaveLength(0);
    wrapper.unmount();
  });

  it("嵌套块在顶 + 上滚：到边界，接管对话区走 JS（补链式分支）", () => {
    resetScrollTrailForTest();
    const { wrapper, scrollEl } = mountScroll("nested-scroller");
    const nested = scrollEl.querySelector(".nested") as HTMLElement;
    setGeometry(nested, { scrollTop: 0, clientHeight: 100, scrollHeight: 500 }); // 嵌套块在顶
    scrollEl.scrollTop = 500; // 对话区不在顶，才能观察到上滚位移
    const evt = new WheelEvent("wheel", { deltaY: -100, deltaMode: 0, bubbles: true, cancelable: true });
    scrollEl.querySelector(".nested-inner")!.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(scrollEl.scrollTop).toBe(400); // 500 + (-100)，链式移交对话区
    expect(snapshotScrollTrail().filter((e) => e.kind === "wheelTakeover")).toHaveLength(1);
    wrapper.unmount();
  });

  it("嵌套块未到顶 + 上滚：未到边界，放行原生滚嵌套块本身", () => {
    resetScrollTrailForTest();
    const { wrapper, scrollEl } = mountScroll("nested-scroller");
    const nested = scrollEl.querySelector(".nested") as HTMLElement;
    setGeometry(nested, { scrollTop: 100, clientHeight: 100, scrollHeight: 500 }); // 未到顶
    const before = scrollEl.scrollTop;
    const evt = new WheelEvent("wheel", { deltaY: -100, deltaMode: 0, bubbles: true, cancelable: true });
    scrollEl.querySelector(".nested-inner")!.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    expect(scrollEl.scrollTop).toBe(before);
    expect(snapshotScrollTrail().filter((e) => e.kind === "wheelTakeover")).toHaveLength(0);
    wrapper.unmount();
  });

  it("嵌套块在底 + 下滚：到边界，接管对话区走 JS", () => {
    resetScrollTrailForTest();
    const { wrapper, scrollEl } = mountScroll("nested-scroller");
    const nested = scrollEl.querySelector(".nested") as HTMLElement;
    setGeometry(nested, { scrollTop: 400, clientHeight: 100, scrollHeight: 500 }); // 在底 400+100=500
    const before = scrollEl.scrollTop;
    const evt = new WheelEvent("wheel", { deltaY: 100, deltaMode: 0, bubbles: true, cancelable: true });
    scrollEl.querySelector(".nested-inner")!.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(scrollEl.scrollTop).toBe(before + 100);
    expect(snapshotScrollTrail().filter((e) => e.kind === "wheelTakeover")).toHaveLength(1);
    wrapper.unmount();
  });

  it("deltaMode 非 pixel（触控板 line/page）：放行原生不接管", () => {
    resetScrollTrailForTest();
    const { wrapper, scrollEl } = mountScroll("plain-text");
    const before = scrollEl.scrollTop;
    const evt = new WheelEvent("wheel", { deltaY: 3, deltaMode: 1, bubbles: true, cancelable: true });
    scrollEl.querySelector(".plain")!.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    expect(scrollEl.scrollTop).toBe(before);
    wrapper.unmount();
  });

  it("卸载后 wheel 监听移除（无泄漏）", () => {
    resetScrollTrailForTest();
    const { wrapper, scrollEl } = mountScroll("plain-text");
    wrapper.unmount();
    const before = scrollEl.scrollTop;
    const evt = new WheelEvent("wheel", { deltaY: 100, deltaMode: 0, bubbles: true, cancelable: true });
    scrollEl.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    expect(scrollEl.scrollTop).toBe(before);
  });
});