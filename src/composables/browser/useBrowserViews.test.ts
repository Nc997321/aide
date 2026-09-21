// 常驻订阅层的回归：面板是懒挂载的，agent 可能在它挂载之前就开 tab / 请求 focus——
// 这两类载荷必须有人接住（缓冲），否则"agent 开了 tab 但面板里什么都没有"。
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { useRightPanel, __resetRightPanelForTest } from "../useRightPanel";
import { __resetBrowserViewsForTest, useBrowserViews } from "./useBrowserViews";
import type { ViewEventDto } from "./useEmbeddedBrowser";

beforeEach(() => {
  __resetRightPanelForTest();
  __resetBrowserViewsForTest();
});

function viewEvent(over: Partial<ViewEventDto> = {}): ViewEventDto {
  return { id: "browser-9", kind: "created", label: null, origin: "agent", displayed: false, ...over };
}

describe("focus 请求：幂等展开 + 记 pending，消费即清", () => {
  it("收起状态下请求 → 展开右栏到浏览器", () => {
    const v = useBrowserViews();
    v.__handleFocusForTest({ id: "browser-9" });

    expect(useRightPanel().collapsed.value).toBe(false);
    expect(useRightPanel().tab.value).toBe("browser");
    expect(v.pendingFocusViewId.value).toBe("browser-9");
  });

  it("用户正看着浏览器时请求 → 不收起面板（ensureBrowserShown 不是 toggle）", () => {
    const p = useRightPanel();
    p.select("browser");
    const v = useBrowserViews();
    v.__handleFocusForTest({ id: "browser-9" });

    expect(p.collapsed.value).toBe(false);
  });

  it("消费一次即清空；重复消费回 false", () => {
    const v = useBrowserViews();
    v.__handleFocusForTest({ id: "browser-9" });

    expect(v.consumePendingFocus("browser-9")).toBe(true);
    expect(v.pendingFocusViewId.value).toBeNull();
    expect(v.consumePendingFocus("browser-9")).toBe(false);
  });
});

describe("增量缓冲", () => {
  it("取走即清空（面板消费一次就够）", () => {
    const v = useBrowserViews();
    v.__handleViewForTest(viewEvent());

    expect(v.takeViewEvents()).toHaveLength(1);
    expect(v.takeViewEvents()).toHaveLength(0);
  });

  it("整数组替换：watch 才能被唤醒（原地 push 不会触发）", () => {
    const v = useBrowserViews();
    const before = v.buffered.value;
    v.__handleViewForTest(viewEvent());
    expect(v.buffered.value).not.toBe(before);
  });

  it("视图被关掉时清掉同 id 的 pending（别再等一个不存在的视图）", () => {
    const v = useBrowserViews();
    v.__handleFocusForTest({ id: "browser-9" });
    v.__handleViewForTest(viewEvent({ kind: "closed", displayed: false }));

    expect(v.pendingFocusViewId.value).toBeNull();
    expect(v.takeViewEvents()).toHaveLength(1); // 关闭事件照样要送达面板
  });
});
