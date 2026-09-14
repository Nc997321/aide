import { describe, it, expect, beforeEach } from "vitest";
import {
  drainWorstFrame,
  framesSince,
  isLongFramesSupported,
  readLongFrame,
  resetLongFramesForTest,
  shortenSource,
  startLongFrames,
  stopLongFrames,
  type LongFrameEntry,
} from "./longFrames";

/** 造一个 LoAF 形状的条目。readLongFrame 收 unknown，普通对象直接喂即可。 */
function loaf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    startTime: 1000,
    duration: 500,
    styleAndLayoutStart: 300, // 样式布局从 300ms 处开始 → 布局 200ms
    blockingDuration: 480,
    scripts: [],
    ...over,
  };
}

describe("longFrames 长动画帧归因", () => {
  beforeEach(() => {
    resetLongFramesForTest();
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
    expect(e.styleLayoutMs).toBe(200); // 500 - 300
    expect(e.restMs).toBe(100); // 500 - 200 - 200 ← 既非脚本也非布局 → GC/空闲嫌疑区
    expect(e.scriptMs + e.styleLayoutMs + e.restMs).toBe(e.durationMs);
    expect(e.forcedLayoutMs).toBe(80);
    expect(e.blockingMs).toBe(480);
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

  it("drainWorstFrame：取本周期最长的一帧并清零；framesSince 按窗口过滤", () => {
    // 直接喂 observer 回调的路径不好造，改测环形/汇总的契约：
    // drain 前为空 → count 0 / worst null / supported false
    expect(drainWorstFrame()).toEqual({ count: 0, worst: null, supported: false });

    // framesSince 在无条目时返回空数组
    expect(framesSince(0)).toEqual([]);
    expect(framesSince(1e9)).toEqual([]);
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
