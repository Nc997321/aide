import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  crumb,
  drainPending,
  snapshotAll,
  resetBreadcrumbsForTest,
  describeClickTarget,
} from "./breadcrumbs";

describe("breadcrumbs 面包屑", () => {
  beforeEach(() => {
    resetBreadcrumbsForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-08T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drainPending 取走增量并清空", () => {
    crumb("click", "btn");
    crumb("key", "Enter");
    expect(drainPending().length).toBe(2);
    expect(drainPending().length).toBe(0);
  });

  it("snapshotAll 返回全量且不影响 pending", () => {
    crumb("click", "a");
    crumb("click", "b");
    expect(snapshotAll().length).toBe(2);
    expect(drainPending().length).toBe(2);
  });

  it("detail 超长被截断", () => {
    crumb("click", "x".repeat(80));
    const c = drainPending()[0];
    expect(c.detail.endsWith("…")).toBe(true);
    expect(c.detail.length).toBeLessThan(80);
  });

  it("单次 drain 最多带走 MAX_PER_DRAIN 条", () => {
    for (let i = 0; i < 30; i++) crumb("click", `c${i}`);
    expect(drainPending().length).toBe(20);
    // 剩下的在 pending 里，下次 drain 继续带
    expect(drainPending().length).toBe(10);
  });

  it("describeClickTarget 非 Element 返回占位", () => {
    expect(describeClickTarget(null)).toBe("?");
  });

  it("describeClickTarget 提取 aria-label 优先", () => {
    class FakeEl {
      tagName = "BUTTON";
      getAttribute(name: string) {
        if (name === "aria-label") return "发送";
        return null;
      }
      textContent = "send";
      closest() {
        return this;
      }
    }
    expect(describeClickTarget(new FakeEl() as unknown as EventTarget)).toBe("button[发送]");
  });
});