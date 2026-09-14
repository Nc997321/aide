/**
 * 长动画帧（LoAF）采集器：唯一能**把一帧拆成「脚本 / 样式布局 / 其余」并点名到函数**
 * 的数据源。
 *
 * 为什么要它（2026-09-14 取证复盘）：现有四个采集器全是**计量表**——longTasks 只给
 * 时长、eventLoopLag 只给滞后、breadcrumbs 只记点击、scrollTrail 只记我们自己的调用。
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

/** 环形缓冲容量：LoAF 条目比 longtask 大，给 50 条够覆盖撞墙前十几秒。 */
const MAX_ENTRIES = 50;
/** 每帧只留耗时前 N 的脚本——payload 要小，且头几名就够点名。 */
const TOP_SCRIPTS = 3;

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
  // 每个字段仍由 num/str 兜底。
  const raw = e as Partial<RawLoaf>;
  const durationMs = num(raw.duration);
  if (durationMs <= 0) return null;

  const styleLayoutStart = num(raw.styleAndLayoutStart);
  // styleAndLayoutStart 是相对帧起点的偏移；为 0 表示这一帧没走到样式布局段。
  const styleLayoutMs = styleLayoutStart > 0 ? Math.max(0, durationMs - styleLayoutStart) : 0;

  const all: LongFrameScript[] = (Array.isArray(raw.scripts) ? raw.scripts : []).map((s) => ({
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

/** 启动采集；环境不支持 LoAF 时返回 false（静默降级，但支持状态会进报告）。 */
export function startLongFrames(): boolean {
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

/** 冻结补交用：返回 `sinceMs`（performance.now 时间轴）之后的长帧明细。 */
export function framesSince(sinceMs: number): LongFrameEntry[] {
  return entries.filter((e) => e.t + e.durationMs >= sinceMs);
}

/** 测试辅助：重置模块状态。 */
export function resetLongFramesForTest(): void {
  entries.length = 0;
  periodWorst = null;
  periodCount = 0;
  supported = false;
}
