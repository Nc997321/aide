import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  startLongTasks,
  stopLongTasks,
  drainSummary,
  entriesSince,
} from "./longTasks";

// 最小 PerformanceObserver mock：回调收集的 entry 构造成 PerformanceEntry。
function makeEntry(startTime: number, duration: number): PerformanceEntry {
  return { startTime, duration, name: "longtask", entryType: "longtask" } as PerformanceEntry;
}

describe("longTasks 采集器", () => {
  let observerCb: (list: PerformanceObserverEntryList) => void;

  beforeEach(() => {
    vi.stubGlobal(
      "PerformanceObserver",
      class {
        constructor(cb: (list: PerformanceObserverEntryList) => void) {
          observerCb = cb;
        }
        observe() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      },
    );
    // 兜底：vitest node 环境可能没有这个全局
    if (typeof PerformanceObserver === "undefined") {
      // @ts-expect-error stub
      globalThis.PerformanceObserver = class {
        constructor(cb: (l: PerformanceObserverEntryList) => void) {
          observerCb = cb;
        }
      };
    }
  });
  afterEach(() => {
    stopLongTasks();
    vi.unstubAllGlobals();
  });

  it("start 返回 true 并汇总 count/max", () => {
    expect(startLongTasks()).toBe(true);
    observerCb({ getEntries: () => [makeEntry(10, 60), makeEntry(20, 120)] } as never);
    observerCb({ getEntries: () => [makeEntry(30, 90)] } as never);
    const s = drainSummary();
    expect(s.count).toBe(3);
    expect(s.maxMs).toBe(120);
  });

  it("drain 清零", () => {
    startLongTasks();
    observerCb({ getEntries: () => [makeEntry(10, 60)] } as never);
    drainSummary();
    expect(drainSummary().count).toBe(0);
  });

  it("entriesSince 按 start+duration ≥ since 过滤", () => {
    startLongTasks();
    observerCb({ getEntries: () => [makeEntry(50, 30), makeEntry(10, 20), makeEntry(100, 10)] } as never);
    // 任务区间 [start, start+duration)：50→[50,80)、10→[10,30)、100→[100,110)
    const out = entriesSince(40);
    expect(out.map((e) => e.start).sort((a, b) => a - b)).toEqual([50, 100]);
  });

  it("超过上限时淘汰最旧明细", () => {
    startLongTasks();
    for (let i = 0; i < 210; i++) {
      observerCb({ getEntries: () => [makeEntry(i, 60)] } as never);
    }
    // 上限 200：最早的 10 条被淘汰
    expect(entriesSince(0).length).toBe(200);
    // 第 10 条（start=10）应在、第 9 条不在
    expect(entriesSince(0).map((e) => e.start)).toContain(10);
    expect(entriesSince(0).map((e) => e.start)).not.toContain(9);
  });

  it("环境无 PerformanceObserver 时返回 false 不抛", () => {
    vi.unstubAllGlobals();
    // @ts-expect-error 删除全局模拟不支持
    delete globalThis.PerformanceObserver;
    expect(startLongTasks()).toBe(false);
  });
});