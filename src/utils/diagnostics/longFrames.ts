/**
 * 长动画帧（LoAF）采集器：唯一能**把一帧拆成「脚本 / 样式布局 / 其余」并点名到函数**
 * 的数据源。
 *
 * 为什么要它（2026-09-14 取证复盘）：现有四个采集器全是**计量表**——longTasks 只给
 * 时长、eventLoopLag 只给滞后、breadcrumbs 只记点击。
 * 真机一次 19.7 秒冻结里，渲染进程主线程 ~100% 忙、而 trail 上几乎没有事件：
 * **谁都定不到**——因为时间花在框架 / 引擎 / GC 里，而计量表问不出「贵在哪」。
 *
 * LoAF 是浏览器原生的长帧归因：
 * - `duration` / `renderStart` / `styleAndLayoutStart` → 拆出脚本段与样式布局段；
 * - `scripts[].forcedStyleAndLayoutDuration` → **强制同步布局**耗时（读写回环的度量）；
 * - `scripts[].sourceURL` / `sourceFunctionName` / `sourceCharPosition` → **点名到函数**。
 *
 * 三者合起来正好回答一直没答上的二选一：**布局 还是 JS**。帧时长减去脚本与样式布局，
 * 剩下的既不是 JS 也不是布局——那部分（GC / 空闲 / 光栅化）才是「第三个嫌疑人」。
 *
 * 与 longTasks 同构：环形缓冲 + 周期 drain + 捕获期监听。环境不支持（非 Chromium，
 * 或版本过老）时静默降级返回 false——诊断永不影响业务。
 *
 * 全量明细有**两条**取数路（2026-09-17 补）：
 * - `ring`：observer 回调攒下的环形缓冲（心跳 drain 用）；
 * - `timeline`：`performance.getEntriesByType("long-animation-frame")` 直读。
 *   冻结补交必须走这条——回调和别的任务一样会被饿死，实测一次 8.2 秒冻结里
 *   50 个长任务只喂到 ring 里 2 条，而时间线上的条目是引擎在条目生成那刻就写进
 *   缓冲的，恢复后直读一条不少。所以 timeline 是**权威来源**，ring 只是兜底。
 */

/** 一个长帧内耗时最靠前的脚本（本地最小接口：lib.dom 尚未收录 LoAF）。 */
export interface LongFrameScript {
  /** 调用者类型：event-listener / user-callback / script / promise-then… */
  invoker: string;
  /** 源码位置（只留文件名末段，控 payload 体积） */
  source: string;
  /** 函数名（匿名 / 内联时为空） */
  func: string;
  /** 该脚本总耗时 */
  durationMs: number;
  /** 其中**强制同步布局**的耗时——读写回环直接量出来 */
  forcedLayoutMs: number;
}

/** 一个长动画帧的归因分解。 */
export interface LongFrameEntry {
  /** performance.now() 时间轴，ms */
  t: number;
  /** 帧总时长 */
  durationMs: number;
  /** 脚本总耗时（各 script 之和） */
  scriptMs: number;
  /** 样式 + 布局耗时 */
  styleLayoutMs: number;
  /** 既非脚本也非布局的余量 —— GC / 空闲 / 光栅化的嫌疑区 */
  restMs: number;
  /** 全部脚本的强制同步布局之和 */
  forcedLayoutMs: number;
  /** 阻塞时长（含排队任务） */
  blockingMs: number;
  /** 耗时前 N 的脚本 */
  scripts: LongFrameScript[];
}

export interface LongFrameSummary {
  count: number;
  maxMs: number;
}

/** 全量明细的取数路：`timeline` 直读时间线（权威，冻结期不丢），`ring` 只有
 *  observer 回调攒下的（回调被饿就缺条），`both` 两条都有货，`none` 都没有。
 *  读报告的人必须先看这一位：`none` + 空数组 ≠「没有长帧」。 */
export type CaptureSource = "timeline" | "ring" | "both" | "none";

/** 环形缓冲容量：LoAF 条目比 longtask 大，给 50 条够覆盖撞墙前十几秒。 */
const MAX_ENTRIES = 50;
/** 每帧只留耗时前 N 的脚本——payload 要小，且头几名就够点名。 */
const TOP_SCRIPTS = 3;
/** performance timeline 缓冲容量：长帧与资源/用户计时条目共用同一个引擎缓冲
 * （默认 250 条），长会话里密集的资源条目会把长帧挤出缓冲——直读那条路就白修。 */
const TIMELINE_BUFFER = 1000;

/** 源码 URL 压成末段文件名（带 query/hash 的一并剥掉），控 payload 体积。 */
export function shortenSource(url: string): string {
  if (!url) return "";
  const noQuery = url.split(/[?#]/)[0];
  const parts = noQuery.split(/[\\/]/);
  return parts[parts.length - 1] || noQuery;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** 未收录的 LoAF 条目：按本地接口读，缺字段由 num/str 兜底。 */
interface RawLoaf {
  duration: number;
  startTime: number;
  styleAndLayoutStart: number;
  blockingDuration: number;
  scripts: Array<Record<string, unknown>>;
}

/** 浏览器条目 → 本地 LoAF 形状。收 `unknown` 再收窄（边界数据不信任），
 *  字段缺失/形状不符返回 null——坏数据宁可丢掉也不进报告。 */
export function readLongFrame(e: unknown): LongFrameEntry | null {
  // lib.dom（TS 5.7）没有 LoAF 类型；unknown → Partial<RawLoaf> 是单次收窄，
  // 每个字段仍由 num/str 兜底。非对象（null/undefined）直接丢——**这里绝不能抛**：
  // 调用方在补交路径上，一次抛错会连坐整趟现场（timeline 直读那段的 catch 会把
  // 「坏了一条」放大成「这条路全空」）。
  if (!e || typeof e !== "object") return null;
  const raw = e as Partial<RawLoaf>;
  const durationMs = num(raw.duration);
  if (durationMs <= 0) return null;

  // styleAndLayoutStart 是**绝对时间戳**（相对 time origin，与 renderStart/startTime
  // 同一基准），不是帧内偏移——2026-09-17 在真机 Chromium 153 上实测：一条 251ms
  // 的帧里该值 − startTime = 241ms，而它自身的读数远大于帧时长。原实现按偏移算
  // （`duration - styleAndLayoutStart`）在真机上恒为负 → 被 Math.max 钳成 0 →
  // 布局耗时整段并进 restMs，报告把「布局」读成「GC/空闲」——恰是本采集器要回答
  // 的那一问被答反。0 表示这一帧没走到样式布局段。
  const styleLayoutStart = num(raw.styleAndLayoutStart);
  const layoutOffset = styleLayoutStart > 0 ? Math.max(0, styleLayoutStart - num(raw.startTime)) : -1;
  const styleLayoutMs = layoutOffset >= 0 ? Math.max(0, durationMs - layoutOffset) : 0;

  const all: LongFrameScript[] = (Array.isArray(raw.scripts) ? raw.scripts : [])
    // 非对象项（引擎怪异形状）剔掉：下面要按键取值，null 会抛
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({
      invoker: str(s["invoker"]),
      source: shortenSource(str(s["sourceURL"])),
      func: str(s["sourceFunctionName"]),
      durationMs: Math.round(num(s["duration"])),
      forcedLayoutMs: Math.round(num(s["forcedStyleAndLayoutDuration"])),
    }));

  // 求和必须过**全量**脚本。只汇总保留的头几条，会把长尾的耗时误算进 restMs——
  // 于是「很多个小脚本」被读成「GC/空闲」，正是这个采集器要回答的那个问题被答反。
  // 截断只作用于展示用的 scripts 列表（payload 体积）。
  const scriptMs = all.reduce((sum, s) => sum + s.durationMs, 0);
  const forcedLayoutMs = all.reduce((sum, s) => sum + s.forcedLayoutMs, 0);
  const scripts = [...all].sort((a, b) => b.durationMs - a.durationMs).slice(0, TOP_SCRIPTS);

  return {
    t: Math.round(num(raw.startTime)),
    durationMs: Math.round(durationMs),
    scriptMs,
    styleLayoutMs: Math.round(styleLayoutMs),
    restMs: Math.round(Math.max(0, durationMs - scriptMs - styleLayoutMs)),
    forcedLayoutMs,
    blockingMs: Math.round(num(raw.blockingDuration)),
    scripts,
  };
}

let observer: PerformanceObserver | null = null;
const entries: LongFrameEntry[] = [];
let periodWorst: LongFrameEntry | null = null;
let periodCount = 0;
/** 本环境是否真的起来了 LoAF。报告里必须能区分「没长帧」与「没支持」——
 *  否则 count 恒 0 会被读成"渲染没问题"，而真相是这个探针根本没装。 */
let supported = false;

/** 采集是否生效。心跳把它带进报告，与 count 一起读。 */
export function isLongFramesSupported(): boolean {
  return supported;
}

/** 抬 timeline 缓冲容量；拿不到这个方法（老引擎）就沿用默认容量，不抛。 */
function reserveTimelineBuffer(): void {
  if (typeof performance === "undefined") return;
  const set = performance.setResourceTimingBufferSize;
  if (typeof set !== "function") return;
  try {
    set.call(performance, TIMELINE_BUFFER);
  } catch {
    return; // 容量设不上只是少了保险，采集本身不受影响
  }
}

/** 启动采集；环境不支持 LoAF 时返回 false（静默降级，但支持状态会进报告）。 */
export function startLongFrames(): boolean {
  reserveTimelineBuffer(); // 与 supported 无关：直读路径同样受益，先备好
  if (observer !== null) return true;
  if (typeof PerformanceObserver === "undefined") return false;
  // 特性探测**不能**只看 observe 是否抛异常：Node 对未知 type 静默接受（本文件
  // 的测试实测），于是 supported 会谎报 true 而 count 恒 0 —— 正是这一位要防的
  // 那种混淆（"没支持"被读成"渲染健康"）。supportedEntryTypes 才是权威清单；
  // 清单本身缺失（老环境）时才退回"试了再说"。
  const types: unknown = PerformanceObserver.supportedEntryTypes;
  if (Array.isArray(types) && !types.includes("long-animation-frame")) {
    supported = false;
    return false;
  }
  try {
    observer = new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const entry = readLongFrame(raw);
        if (!entry) continue;
        periodCount += 1;
        if (!periodWorst || entry.durationMs > periodWorst.durationMs) periodWorst = entry;
        entries.push(entry);
        if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
      }
    });
    observer.observe({ type: "long-animation-frame", buffered: true });
    supported = true;
    return true;
  } catch {
    observer = null; // 旧版本 Chromium 不认识这个 type —— 降级，不抛
    supported = false;
    return false;
  }
}

export function stopLongFrames(): void {
  observer?.disconnect();
  observer = null;
  entries.length = 0;
  periodWorst = null;
  periodCount = 0;
  supported = false;
}

/** 取走本周期摘要（条数 + 最长一帧的完整分解 + 采集是否生效）并清零。
 *  心跳每 500ms 发一次，只带「最长那一帧」——它才是撞墙的肇事帧，整周期明细体积
 *  不可控。`supported` 必须一起走：读报告的人要能区分「没长帧」与「探针没装」。 */
export function drainWorstFrame(): {
  count: number;
  worst: LongFrameEntry | null;
  supported: boolean;
} {
  const out = { count: periodCount, worst: periodWorst, supported };
  periodCount = 0;
  periodWorst = null;
  return out;
}

/** 帧窗口判据：帧的结束时刻落在 `sinceMs` 之后——跨冻结起点的肇事帧要算进来。 */
function inWindow(e: LongFrameEntry, sinceMs: number): boolean {
  return e.t + e.durationMs >= sinceMs;
}

/** 直读 performance timeline（收窄用 readLongFrame，坏条目直接丢）。 */
function timelineFrames(sinceMs: number): LongFrameEntry[] {
  if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") return [];
  try {
    return performance
      .getEntriesByType("long-animation-frame")
      .map(readLongFrame)
      .filter((e): e is LongFrameEntry => e !== null && inWindow(e, sinceMs));
  } catch {
    return []; // 老引擎不认这个 entry type：只走 ring
  }
}

/** 两条路按 `t` 合并（timeline 是引擎原始条目，同 t 时覆盖 ring 那份转写），升序。 */
function mergeByT(ring: LongFrameEntry[], timeline: LongFrameEntry[]): LongFrameEntry[] {
  const byT = new Map<number, LongFrameEntry>();
  for (const e of ring) byT.set(e.t, e);
  for (const e of timeline) byT.set(e.t, e);
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/** 两条路各有几条货 → 来源自述（与返回的数组同源，杜绝「报了 timeline 却是空数组」）。 */
function captureSource(timelineCount: number, ringCount: number): CaptureSource {
  if (timelineCount > 0) return ringCount > 0 ? "both" : "timeline";
  return ringCount > 0 ? "ring" : "none";
}

/** 冻结补交用：`sinceMs`（performance.now 时间轴）之后的长帧明细 + 来源自述。
 *
 * 两条路都取：`timeline` 直读（权威——冻结期引擎照写缓冲，恢复后一条不少），
 * `ring` 兜底（回调迟到、或引擎不认这个 entry type 时还有它）。按 `t` 去重，
 * 同一条以 timeline 那份为准。 */
export function framesSinceDetailed(sinceMs: number): {
  frames: LongFrameEntry[];
  source: CaptureSource;
} {
  const ring = entries.filter((e) => inWindow(e, sinceMs));
  const timeline = timelineFrames(sinceMs);
  return { frames: mergeByT(ring, timeline), source: captureSource(timeline.length, ring.length) };
}

/** 测试辅助：重置模块状态。 */
export function resetLongFramesForTest(): void {
  entries.length = 0;
  periodWorst = null;
  periodCount = 0;
  supported = false;
}
