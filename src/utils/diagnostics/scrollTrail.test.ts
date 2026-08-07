// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  nearestGestureScroller,
  resetScrollTrailForTest,
  snapshotScrollTrail,
  startScrollTrail,
  trail,
} from "./scrollTrail";

describe("scrollTrail 滚动诊断环", () => {
  beforeEach(() => {
    resetScrollTrailForTest();
    document.body.innerHTML = "";
  });

  it("trail 记录并按 96 字符截断 detail", () => {
    trail("scroll", "top=10 sh=2000 ch=800");
    trail("x", "a".repeat(200));
    const snap = snapshotScrollTrail();
    expect(snap).toHaveLength(2);
    expect(snap[0].kind).toBe("scroll");
    expect(snap[0].detail).toBe("top=10 sh=2000 ch=800");
    expect(snap[1].detail.length).toBe(97); // 96 + 省略号
    expect(snap[1].detail.endsWith("…")).toBe(true);
  });

  it("ring 超限淘汰最旧（保留最新 3000 条）", () => {
    for (let i = 0; i < 3005; i++) trail("wheel", `dy=${i}`);
    const snap = snapshotScrollTrail();
    expect(snap).toHaveLength(3000);
    expect(snap[0].detail).toBe("dy=5");
    expect(snap[snap.length - 1].detail).toBe("dy=3004");
  });

  it("snapshot 返回拷贝，调用方改动不污染 ring", () => {
    trail("a", "1");
    const snap = snapshotScrollTrail();
    snap.length = 0;
    expect(snapshotScrollTrail()).toHaveLength(1);
  });

  it("wheel 监听：记录方向 + 目标 + 最近手势可滚祖先", () => {
    document.body.innerHTML =
      `<div class="chat-messages" style="overflow-y:auto">` +
      `<div class="msg-turn"><span class="txt">hi</span></div></div>`;
    startScrollTrail();
    document.querySelector(".txt")!.dispatchEvent(
      new WheelEvent("wheel", { deltaY: 240, bubbles: true, cancelable: true }),
    );
    const snap = snapshotScrollTrail();
    expect(snap).toHaveLength(1);
    expect(snap[0].kind).toBe("wheel");
    expect(snap[0].detail).toContain("dy=240");
    expect(snap[0].detail).toContain("tgt=span.txt");
    expect(snap[0].detail).toContain("sa=div.chat-messages");
  });

  it("嵌套内滚块：sa 指向内层消费者而非对话区", () => {
    document.body.innerHTML =
      `<div class="chat-messages" style="overflow-y:auto">` +
      `<div class="thinking-body" style="overflow-y:auto"><p class="c">x</p></div></div>`;
    startScrollTrail();
    document.querySelector(".c")!.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -120, bubbles: true }),
    );
    expect(snapshotScrollTrail()[0].detail).toContain("sa=div.thinking-body");
  });

  it("死区：一路无手势可滚祖先时 sa=none", () => {
    document.body.innerHTML = `<div class="perm-dock"><button class="b">x</button></div>`;
    startScrollTrail();
    document.querySelector(".b")!.dispatchEvent(
      new WheelEvent("wheel", { deltaY: 120, bubbles: true }),
    );
    expect(snapshotScrollTrail()[0].detail).toContain("sa=none");
  });

  it("startScrollTrail 幂等，wheel 只记一次", () => {
    startScrollTrail();
    startScrollTrail();
    document.body.dispatchEvent(new WheelEvent("wheel", { deltaY: 10, bubbles: true }));
    expect(snapshotScrollTrail()).toHaveLength(1);
  });

  it("nearestGestureScroller 直接可用：自身即消费者", () => {
    const el = document.createElement("div");
    el.className = "xterm-viewport";
    el.style.overflowY = "scroll";
    document.body.appendChild(el);
    expect(nearestGestureScroller(el)).toBe("div.xterm-viewport");
  });

  it("probeRebuildChatScrollers 重建滚动容器并留标记", async () => {
    const { probeRebuildChatScrollers } = await import("./scrollTrail");
    document.body.innerHTML = `<div class="chat-messages"></div><div class="chat-messages"></div>`;
    const n = probeRebuildChatScrollers();
    expect(n).toBe(2);
    const markers = snapshotScrollTrail().filter((e) => e.kind === "probe");
    expect(markers).toHaveLength(2);
    expect(markers[0].detail).toContain("rebuild");
    // 探针不破坏元素的内联样式残留（display 已还原）
    expect((document.querySelector(".chat-messages") as HTMLElement).style.display).toBe("");
  });
});
