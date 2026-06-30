import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { timeAgo } from "./time";

describe("timeAgo", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("minutes ago", () => {
    vi.setSystemTime(new Date(2026, 5, 30, 12, 0, 0));
    expect(timeAgo(Date.now() - 5 * 60000)).toBe("5分钟前");
  });

  it("hours ago", () => {
    vi.setSystemTime(new Date(2026, 5, 30, 12, 0, 0));
    expect(timeAgo(Date.now() - 3 * 3600000)).toBe("3小时前");
  });

  it("days ago", () => {
    vi.setSystemTime(new Date(2026, 5, 30, 12, 0, 0));
    expect(timeAgo(Date.now() - 2 * 86400000)).toBe("2天前");
  });

  it("weeks ago", () => {
    vi.setSystemTime(new Date(2026, 5, 30, 12, 0, 0));
    expect(timeAgo(Date.now() - 14 * 86400000)).toBe("2周前");
  });
});
