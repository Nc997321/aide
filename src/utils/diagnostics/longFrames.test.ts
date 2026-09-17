import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  drainWorstFrame,
  framesSinceDetailed,
  isLongFramesSupported,
  readLongFrame,
  resetLongFramesForTest,
  shortenSource,
  startLongFrames,
  stopLongFrames,
  type LongFrameEntry,
} from "./longFrames";

/** 造一个 LoAF 形状的条目。readLongFrame 收 unknown，普通对象直接喂即可。
 *  styleAndLayoutStart 是**绝对时间戳**（相对 time origin）：帧起点 1000 + 偏移
 *  300 = 1300 → 样式布局段 200ms（真机实测语义，见 readLongFrame 注释）。 */
function loaf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    startTime: 1000,
    duration: 500,
    styleAndLayoutStart: 1300,
    blockingDuration: 480,
    scripts: [],
    ...over,
  };
}

/** 把 performance timeline 的直读路换成给定条目（其余 entry type 一律空）。 */
function stubTimeline(entries: unknown[]): void {
  vi.spyOn(performance, "getEntriesByType").mockImplementation((type: string) =>
    (type === "long-animation-frame" ? entries : []) as unknown as PerformanceEntryList,
  );
}

/** 装一个能收 LoAF 的假 observer（node 环境本不支持 LoAF，起不来 ring）。 */
function stubLoafObserver(): (list: PerformanceObserverEntryList) => void {
  let cb: (list: PerformanceObserverEntryList) => void = () => {};
  class FakeObserver {
    static supportedEntryTypes = ["long-animation-frame", "longtask"];
    constructor(fn: (list: PerformanceObserverEntryList) => void) {
      cb = fn;
    }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("PerformanceObserver", FakeObserver);
  return (list) => cb(list);
}

const entryList = (entries: unknown[]): PerformanceObserverEntryList =>
  ({ getEntries: () => entries }) as PerformanceObserverEntryList;

describe("longFrames 长动画帧归因", () => {
  beforeEach(() => {
    resetLongFramesForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    stopLongFrames();
  });

  it("三项分解相加 = 帧时长（脚本 + 样式布局 + 其余）", () => {
    const e = readLongFrame(
      loaf({
        scripts: [
          { invoker: "event-listener", sourceURL: "/a/chat.js", sourceFunctionName: "onScroll", duration: 120, forcedStyleAndLayoutDuration: 80 },
          { invoker: "script", sourceURL: "/a/app.js", sourceFunctionName: "tick", duration: 80, forcedStyleAndLayoutDuration: 0 },
        ],
      }),
    )!;
    expect(e.durationMs).toBe(500);
    expect(e.scriptMs).toBe(200); // 120 + 80
    expect(e.styleLayoutMs).toBe(200); // 500 - (1300 - 1000)
    expect(e.restMs).toBe(100); // 500 - 200 - 200 ← 既非脚本也非布局 → GC/空闲嫌疑区
    expect(e.scriptMs + e.styleLayoutMs + e.restMs).toBe(e.durationMs);
    expect(e.forcedLayoutMs).toBe(80);
    expect(e.blockingMs).toBe(480);
  });

  it("styleAndLayoutStart 是绝对时间戳：减去帧起点才是布局段起点", () => {
    // 真机形态（Chromium 153 实测）：帧起点在 12 万 ms 的会话中段，样式布局段在
    // 帧内 40ms 处开始 → 布局 160ms。按「帧内偏移」读会把 120040 当成偏移 → 负值
    // 被钳成 0 → 布局整段并进 restMs，报告把「布局」读成「GC/空闲」。
    const e = readLongFrame(
      loaf({ startTime: 120000, duration: 200, styleAndLayoutStart: 120040, scripts: [] }),
    )!;
    expect(e.styleLayoutMs).toBe(160);
    expect(e.restMs).toBe(40);
  });

  it("styleAndLayoutStart 为 0（这一帧没走到样式布局段）→ 布局耗时为 0", () => {
    const e = readLongFrame(loaf({ styleAndLayoutStart: 0, scripts: [] }))!;
    expect(e.styleLayoutMs).toBe(0);
    expect(e.restMs).toBe(500); // 全归"其余"——纯 JS 或纯阻塞
  });

  it("scripts 只留前 3 展示，但 scriptMs / forcedLayoutMs 必须过全量", () => {
    const e = readLongFrame(
      loaf({
        scripts: [10, 90, 50, 70, 30].map((d, i) => ({
          invoker: "script",
          sourceURL: `/x/f${i}.js`,
          sourceFunctionName: `f${i}`,
          duration: d,
          forcedStyleAndLayoutDuration: 1,
        })),
      }),
    )!;
    expect(e.scripts.map((s) => s.durationMs)).toEqual([90, 70, 50]); // 展示截断
    // 求和必须过全量：只汇总头三条（210）会把长尾的 40ms 误算进 restMs ——
    // 那是把「很多个小脚本」读成「GC/空闲」，正好答反了这个采集器要回答的问题。
    expect(e.scriptMs).toBe(250); // 10+90+50+70+30
    expect(e.forcedLayoutMs).toBe(5); // 全量 5 条各 1ms
    expect(e.restMs).toBe(50); // 500 - 250 - 200，没被长尾灌水
  });

  it("点名到函数：invoker / 源文件末段 / 函数名都带出来", () => {
    const e = readLongFrame(
      loaf({
        scripts: [
          {
            invoker: "user-callback",
            sourceURL: "https://example.com/assets/deep/path/render.js?ver=123#x",
            sourceFunctionName: "renderRows",
            duration: 200,
            forcedStyleAndLayoutDuration: 150,
          },
        ],
      }),
    )!;
    expect(e.scripts[0]).toEqual({
      invoker: "user-callback",
      source: "render.js", // query/hash 与目录都剥掉
      func: "renderRows",
      durationMs: 200,
      forcedLayoutMs: 150,
    });
  });

  it("形状不符 / 缺 duration → null（防御，不污染报告）", () => {
    expect(readLongFrame(loaf({ duration: 0 }))).toBeNull();
    expect(readLongFrame(loaf({ duration: undefined }))).toBeNull();
    expect(readLongFrame(loaf({ duration: -1 }))).toBeNull();
  });

  it("scripts 缺失或非数组 → 空脚本表，不抛", () => {
    const e = readLongFrame(loaf({ scripts: undefined }))!;
    expect(e.scripts).toEqual([]);
    expect(e.scriptMs).toBe(0);
  });

  it("shortenSource：反斜杠路径、裸文件名、空串都稳", () => {
    expect(shortenSource("C:\\Users\\x\\src\\App.vue")).toBe("App.vue");
    expect(shortenSource("App.vue")).toBe("App.vue");
    expect(shortenSource("")).toBe("");
  });

  it("drainWorstFrame：取本周期最长的一帧并清零；无条目时补交为空", () => {
    // 直接喂 observer 回调的路径不好造，改测环形/汇总的契约：
    // drain 前为空 → count 0 / worst null / supported false
    expect(drainWorstFrame()).toEqual({ count: 0, worst: null, supported: false });

    // 两条路都没货：空数组 + source 如实报 none（不是「没有长帧」）
    expect(framesSinceDetailed(0)).toEqual({ frames: [], source: "none" });
    expect(framesSinceDetailed(1e9)).toEqual({ frames: [], source: "none" });
  });

  it("直读 performance timeline：不靠 observer 回调，冻结期的帧一条不少", () => {
    // 冻结的真相就是这条：回调被饿死时 ring 是空的，但时间线里 50 条都在。
    stubTimeline([loaf({ startTime: 1000 }), loaf({ startTime: 2000, duration: 300 })]);
    const { frames, source } = framesSinceDetailed(500);
    expect(source).toBe("timeline");
    expect(frames.map((f) => f.t)).toEqual([1000, 2000]); // 按 t 升序
    expect(frames[1].durationMs).toBe(300);
  });

  it("observer ring 兜底：timeline 没货（老引擎/被清）时仍有货，source 报 ring", () => {
    const feed = stubLoafObserver();
    expect(startLongFrames()).toBe(true);
    feed(entryList([loaf({ startTime: 5000 })]));
    stubTimeline([]);
    const { frames, source } = framesSinceDetailed(0);
    expect(source).toBe("ring");
    expect(frames.map((f) => f.t)).toEqual([5000]);
  });

  it("两条路都有货：按 t 去重、timeline 那份胜，source 报 both", () => {
    const feed = stubLoafObserver();
    expect(startLongFrames()).toBe(true);
    feed(entryList([loaf({ startTime: 1000, duration: 400 })]));
    // 同一条帧（t 相同）在时间线里的原始时长是 450：报告该用引擎原始那份
    stubTimeline([loaf({ startTime: 1000, duration: 450 }), loaf({ startTime: 1500 })]);
    const { frames, source } = framesSinceDetailed(500);
    expect(source).toBe("both");
    expect(frames.length).toBe(2); // 同 t 合并不重复
    expect(frames[0].durationMs).toBe(450);
  });

  it("窗口过滤：帧结束时刻早于 since 的丢掉（跨起点的肇事帧留下）", () => {
    stubTimeline([
      loaf({ startTime: 100, duration: 200 }), // 结束于 300 < 1000 → 丢
      loaf({ startTime: 900, duration: 400 }), // 结束于 1300 ≥ 1000 → 留（跨起点）
    ]);
    const { frames } = framesSinceDetailed(1000);
    expect(frames.map((f) => f.t)).toEqual([900]);
  });

  it("坏条目（duration ≤ 0 / 非 LoAF 形状）不进报告，也不把这一趟弄崩", () => {
    stubTimeline([null, {}, { startTime: 700, duration: 0 }, loaf({ startTime: 800 })]);
    const { frames, source } = framesSinceDetailed(0);
    expect(source).toBe("timeline");
    expect(frames.map((f) => f.t)).toEqual([800]);
  });

  it("环境不支持 LoAF 时：started 返回 false，且 supported 如实为 false（不是「没长帧」）", () => {
    // node 环境的 PerformanceObserver 不认识 long-animation-frame → 走 catch 降级。
    // 这条钉的是「静默降级但状态可见」：报告必须能区分探针没装 与 渲染健康。
    expect(isLongFramesSupported()).toBe(false);
    const ok = startLongFrames();
    expect(ok).toBe(false);
    expect(isLongFramesSupported()).toBe(false);
    expect(drainWorstFrame().supported).toBe(false);
    stopLongFrames();
  });

  it("LongFrameEntry 的字段是纯数字/字符串，可安全 JSON 序列化（进心跳）", () => {
    const e = readLongFrame(loaf({ scripts: [{ duration: 10, forcedStyleAndLayoutDuration: 5 }] }))!;
    const round: LongFrameEntry = JSON.parse(JSON.stringify(e));
    expect(round.durationMs).toBe(e.durationMs);
    expect(round.scripts[0].durationMs).toBe(10);
  });
});
