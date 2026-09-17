/**
 * longtask 采集器：PerformanceObserver 记录主线程 ≥50ms 的长任务。
 *
 * 浏览器原生机制，卡死期间照常记录、恢复后可读——这是前端唯一能
 * 「事后补交冻结现场」的数据源。保留最近 MAX_ENTRIES 条明细供补交，
 * 心跳周期内维护 count/max 摘要供 drain。
 *
 * 补交同样备了「直读 performance timeline」这条路（与 longFrames 同构），但真机
 * 实测（Chromium 153）：**longtask 条目根本不进 timeline 缓冲**——挂了 observer、
 * 回调也确实收到 600/900ms 两条，`getEntriesByType("longtask")` 仍是空数组。
 * 所以这里的 timeline 路在 Chromium 上恒为空，`source` 会如实报 `ring`/`none`；
 * 冻结期间回调被饿迟交的那些条目，靠补交第二趟（useDiagnostics）收进来。
 */

export interface LongTaskEntry {
  /** performance.now() 时间轴，ms */
  start: number;
  duration: number;
  /** 归因（容器类型/名字），浏览器能给多少算多少 */
  attribution?: string;
}

export interface LongTaskSummary {
  count: number;
  maxMs: number;
}

/** 全量明细的取数路：含义与 longFrames.CaptureSource 相同（两模块刻意各自独立，
 *  不互相 import——它们本是同构的两支探针）。 */
export type CaptureSource = "timeline" | "ring" | "both" | "none";

const MAX_ENTRIES = 200;

let observer: PerformanceObserver | null = null;
const entries: LongTaskEntry[] = [];
let periodCount = 0;
let periodMaxMs = 0;

function describeAttribution(entry: PerformanceEntry): string | undefined {
  // TaskAttributionTiming 不在 TS 标准 lib 里，宽松读取
  const attribution = (entry as unknown as { attribution?: Array<Record<string, string>> }).attribution;
  const first = attribution?.[0];
  if (!first) return undefined;
  const parts = [first.containerType, first.containerSrc, first.containerName]
    .filter((s) => s && s.length > 0);
  return parts.length > 0 ? parts.join(":") : undefined;
}

/** 浏览器条目 → 明细（observer 回调与 timeline 直读共用一套搬运）。
 *  时长非正/非数字 = 形状不符 → null，坏数据宁可丢掉也不进报告（同 readLongFrame）。 */
function readLongTask(entry: PerformanceEntry): LongTaskEntry | null {
  const duration = entry?.duration;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) return null;
  return {
    start: entry.startTime,
    duration: Math.round(duration),
    attribution: describeAttribution(entry),
  };
}

/** 启动采集；环境不支持 longtask 时返回 false（静默降级）。 */
export function startLongTasks(): boolean {
  if (observer !== null) return true;
  if (typeof PerformanceObserver === "undefined") return false;
  try {
    observer = new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const entry = readLongTask(raw);
        if (!entry) continue;
        periodCount += 1;
        if (entry.duration > periodMaxMs) periodMaxMs = entry.duration;
        entries.push(entry);
        if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
      }
    });
    observer.observe({ type: "longtask", buffered: true });
    return true;
  } catch {
    observer = null;
    return false;
  }
}

export function stopLongTasks(): void {
  observer?.disconnect();
  observer = null;
  entries.length = 0;
  periodCount = 0;
  periodMaxMs = 0;
}

/** 取走本周期摘要（条数 + 最长）并清零。 */
export function drainSummary(): LongTaskSummary {
  const summary = { count: periodCount, maxMs: Math.round(periodMaxMs) };
  periodCount = 0;
  periodMaxMs = 0;
  return summary;
}

/** 窗口判据：任务的结束时刻落在 `sinceMs` 之后（跨冻结起点的肇事任务要算进来）。 */
function inWindow(e: LongTaskEntry, sinceMs: number): boolean {
  return e.start + e.duration >= sinceMs;
}

/** 直读 performance timeline（Chromium 上恒为空，见模块注释；非 Chromium 引擎
 *  可能真给货，所以留着——`source` 会让读报告的人看见它到底有没有生效）。 */
function timelineTasks(sinceMs: number): LongTaskEntry[] {
  if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") return [];
  try {
    return performance
      .getEntriesByType("longtask")
      .map(readLongTask)
      .filter((e): e is LongTaskEntry => e !== null && inWindow(e, sinceMs));
  } catch {
    return []; // 老引擎不认这个 entry type：只走 ring
  }
}

/** timeline 优先（引擎原始条目），ring 兜底，按 `start` 去重。 */
function mergeByStart(ring: LongTaskEntry[], timeline: LongTaskEntry[]): LongTaskEntry[] {
  const byStart = new Map<number, LongTaskEntry>();
  for (const e of ring) byStart.set(e.start, e);
  for (const e of timeline) byStart.set(e.start, e);
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

/** 两条路各有几条货 → 来源自述（与返回的数组同源）。 */
function captureSource(timelineCount: number, ringCount: number): CaptureSource {
  if (timelineCount > 0) return ringCount > 0 ? "both" : "timeline";
  return ringCount > 0 ? "ring" : "none";
}

/** 冻结补交用：`sinceMs`（performance.now 时间轴）之后的明细 + 来源自述。 */
export function entriesSinceDetailed(sinceMs: number): {
  tasks: LongTaskEntry[];
  source: CaptureSource;
} {
  const ring = entries.filter((e) => inWindow(e, sinceMs));
  const timeline = timelineTasks(sinceMs);
  return { tasks: mergeByStart(ring, timeline), source: captureSource(timeline.length, ring.length) };
}
