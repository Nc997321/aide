/**
 * longtask 采集器：PerformanceObserver 记录主线程 ≥50ms 的长任务。
 *
 * 浏览器原生机制，卡死期间照常记录、恢复后可读——这是前端唯一能
 * 「事后补交冻结现场」的数据源。保留最近 MAX_ENTRIES 条明细供补交，
 * 心跳周期内维护 count/max 摘要供 drain。
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

/** 启动采集；环境不支持 longtask 时返回 false（静默降级）。 */
export function startLongTasks(): boolean {
  if (observer !== null) return true;
  if (typeof PerformanceObserver === "undefined") return false;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        periodCount += 1;
        if (entry.duration > periodMaxMs) periodMaxMs = entry.duration;
        entries.push({
          start: entry.startTime,
          duration: Math.round(entry.duration),
          attribution: describeAttribution(entry),
        });
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

/** 冻结补交用：返回 `sinceMs`（performance.now 时间轴）之后的明细。 */
export function entriesSince(sinceMs: number): LongTaskEntry[] {
  return entries.filter((e) => e.start + e.duration >= sinceMs);
}
