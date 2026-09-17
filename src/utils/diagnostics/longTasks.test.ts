import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  startLongTasks,
  stopLongTasks,
  drainSummary,
  entriesSinceDetailed,
} from "./longTasks";

// 最小 PerformanceObserver mock：回调收集的 entry 构造成 PerformanceEntry。
function makeEntry(startTime: number, duration: number): PerformanceEntry {
  return { startTime, duration, name: "longtask", entryType: "longtask" } as PerformanceEntry;
}

/** 把 performance timeline 的直读路换成给定条目（其余 entry type 一律空）。 */
function stubTimeline(entries: unknown[]): void {
  vi.spyOn(performance, "getEntriesByType").mockImplementation((type: string) =>
    (type === "longtask" ? entries : []) as unknown as PerformanceEntryList,
  );
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
    vi.restoreAllMocks();
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

  it("补交明细按 start+duration ≥ since 过滤，来源如实报 ring", () => {
    startLongTasks();
    observerCb({ getEntries: () => [makeEntry(50, 30), makeEntry(10, 20), makeEntry(100, 10)] } as never);
    // 任务区间 [start, start+duration)：50→[50,80)、10→[10,30)、100→[100,110)
    const out = entriesSinceDetailed(40);
    expect(out.tasks.map((e) => e.start).sort((a, b) => a - b)).toEqual([50, 100]);
    // Chromium 实测：longtask 不进 timeline 缓冲，所以这里只可能是 ring
    expect(out.source).toBe("ring");
  });

  it("超过上限时淘汰最旧明细", () => {
    startLongTasks();
    for (let i = 0; i < 210; i++) {
      observerCb({ getEntries: () => [makeEntry(i, 60)] } as never);
    }
    // 上限 200：最早的 10 条被淘汰
    expect(entriesSinceDetailed(0).tasks.length).toBe(200);
    // 第 10 条（start=10）应在、第 9 条不在
    expect(entriesSinceDetailed(0).tasks.map((e) => e.start)).toContain(10);
    expect(entriesSinceDetailed(0).tasks.map((e) => e.start)).not.toContain(9);
  });

  it("两条路都有货：按 start 去重、timeline 那份胜，source 报 both", () => {
    startLongTasks();
    observerCb({ getEntries: () => [makeEntry(100, 120)] } as never);
    const timelineEntry = {
      startTime: 100,
      duration: 130,
      name: "longtask",
      entryType: "longtask",
      attribution: [{ containerType: "iframe", containerSrc: "x", containerName: "y" }],
    };
    stubTimeline([timelineEntry]);
    const { tasks, source } = entriesSinceDetailed(0);
    expect(source).toBe("both");
    expect(tasks.length).toBe(1); // 同 start 合并不重复
    expect(tasks[0].duration).toBe(130); // 引擎原始那份胜
    expect(tasks[0].attribution).toBe("iframe:x:y");
  });

  it("timeline 直读路：坏条目（缺时长/时长为 0）丢掉，不写 NaN 进报告", () => {
    startLongTasks();
    stubTimeline([makeEntry(500, 90), { startTime: 700 }, makeEntry(900, 0), null]);
    const { tasks, source } = entriesSinceDetailed(0);
    expect(source).toBe("timeline");
    expect(tasks.map((t) => t.start)).toEqual([500]);
    expect(tasks[0].duration).toBe(90);
  });

  it("环境无 PerformanceObserver 时返回 false 不抛", () => {
    vi.unstubAllGlobals();
    // @ts-expect-error 删除全局模拟不支持
    delete globalThis.PerformanceObserver;
    expect(startLongTasks()).toBe(false);
  });
});