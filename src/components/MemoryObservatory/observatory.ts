// 记忆观测台纯函数层：状态归类 / 演化推导 / 格式化。全部可直测，不碰 API。
import type { MemoryTopic, MemoryScanResult } from "@aide/sdk/api";

export type TopicStatus = "indexed" | "edge" | "orphan";

/** 索引内（窗口内）/ 窗口外（截断线外，实际不可达）/ 孤儿（无索引引用）。 */
export function statusOf(t: MemoryTopic): TopicStatus {
  if (!t.indexed) return "orphan";
  return t.withinWindow ? "indexed" : "edge";
}

export const STATUS_META: Record<TopicStatus, { label: string }> = {
  indexed: { label: "索引内" },
  edge: { label: "窗口外" },
  orphan: { label: "孤儿" },
};

export interface GrowthPoint {
  /** YYYY-MM-DD */
  day: string;
  count: number;
}

/** 生长曲线：按创建日（缺失退修改日）累积。 */
export function growthCurve(topics: MemoryTopic[]): GrowthPoint[] {
  const byDay = new Map<string, number>();
  for (const t of topics) {
    const ms = t.createdMs ?? t.modifiedMs;
    if (ms == null) continue;
    const day = dayKey(ms);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const days = [...byDay.keys()].sort();
  let acc = 0;
  return days.map((day) => {
    acc += byDay.get(day)!;
    return { day, count: acc };
  });
}

export interface ChangeItem {
  op: "created" | "modified";
  name: string;
  ts: number;
}

/** 最近变化：近 N 天（默认 7）按时间倒序。created==modified 视为新增。 */
export function recentChanges(topics: MemoryTopic[], withinDays = 7, now = Date.now()): ChangeItem[] {
  const cutoff = now - withinDays * 86400_000;
  const items: ChangeItem[] = [];
  for (const t of topics) {
    if (t.createdMs != null && t.createdMs >= cutoff) items.push({ op: "created", name: t.name, ts: t.createdMs });
    if (t.modifiedMs != null && t.modifiedMs >= cutoff && t.modifiedMs !== t.createdMs)
      items.push({ op: "modified", name: t.name, ts: t.modifiedMs });
  }
  return items.sort((a, b) => b.ts - a.ts);
}

/** 停滞：最近一次新记忆距今天数；无记忆为 null。 */
export function daysSinceLatest(topics: MemoryTopic[], now = Date.now()): number | null {
  const latest = topics.reduce<number | null>((acc, t) => {
    const ms = t.createdMs ?? t.modifiedMs;
    return ms != null && (acc == null || ms > acc) ? ms : acc;
  }, null);
  return latest == null ? null : Math.max(0, Math.floor((now - latest) / 86400_000));
}

/** 索引余量占比（0~1，取行/字节两维的较高者）。 */
export function indexUsage(scan: MemoryScanResult): { linePct: number; bytePct: number; pct: number } {
  const linePct = scan.index ? scan.index.lines / scan.limits.maxLines : 0;
  const bytePct = scan.index ? scan.index.bytes / scan.limits.maxBytes : 0;
  return { linePct, bytePct, pct: Math.max(linePct, bytePct) };
}

// ── 事件台账聚合（Influence tab 的 16 行功能数据源）──

import type { MemoryEvent } from "@aide/sdk/api";

/**
 * 索引文件不算「记忆」：MEMORY.md 每会话自动加载前 200 行，把它计入使用统计
 * 会淹没 topic 笔记的真实被读。使用口径（使用次数/TOP5/趋势/本周使用/本次任务）
 * 一律剔除；它只出现在 recentActivity 全量 feed 里做审计痕迹。
 */
export const INDEX_FILE = "MEMORY.md";

function isTopicEvent(e: MemoryEvent): boolean {
  return e.memoryId !== INDEX_FILE;
}

export interface UsageStat {
  reads: number;
  lastTs: number;
}

/** memory_id → 使用统计（read 事件数 + 最近使用时间）。索引文件不计。 */
export function usageByMemory(events: MemoryEvent[]): Map<string, UsageStat> {
  const m = new Map<string, UsageStat>();
  for (const e of events) {
    if (e.op !== "read" || !isTopicEvent(e)) continue;
    const cur = m.get(e.memoryId);
    m.set(e.memoryId, { reads: (cur?.reads ?? 0) + 1, lastTs: Math.max(cur?.lastTs ?? 0, e.ts) });
  }
  return m;
}

/** 最常用记忆 TOP N。 */
export function topUsed(events: MemoryEvent[], n = 5): { memoryId: string; reads: number; lastTs: number }[] {
  return [...usageByMemory(events).entries()]
    .map(([memoryId, s]) => ({ memoryId, ...s }))
    .sort((a, b) => b.reads - a.reads || b.lastTs - a.lastTs)
    .slice(0, n);
}

/** 本周（周一起）新增 / 使用计数。索引文件不计。 */
export function weeklyCounts(events: MemoryEvent[], now = Date.now()): { created: number; used: number } {
  const d = new Date(now);
  const dow = (d.getDay() + 6) % 7; // 周一 = 0
  const weekStart = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow).getTime();
  let created = 0;
  let used = 0;
  for (const e of events) {
    if (e.ts < weekStart || !isTopicEvent(e)) continue;
    if (e.op === "read") used++;
    else if (e.op === "created") created++;
  }
  return { created, used };
}

export interface DayCount {
  day: string;
  count: number;
}

/** 按天统计指定 op 集合（使用趋势 = ["read"]，Learning 趋势 = ["created","updated"]）。索引文件不计。 */
export function dailyCounts(events: MemoryEvent[], ops: string[]): DayCount[] {
  const byDay = new Map<string, number>();
  for (const e of events) {
    if (!ops.includes(e.op) || !isTopicEvent(e)) continue;
    const day = dayKey(e.ts);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day, count }));
}

/** 最近活动：四类事件按时间倒序混排。 */
export function recentActivity(events: MemoryEvent[], limit = 10): MemoryEvent[] {
  return [...events].sort((a, b) => b.ts - a.ts).slice(0, limit);
}

/** 某 session 用了哪些 memory（去重，索引文件不计）；反过来传 memoryId 过滤即是「被哪些 session 用过」。 */
export function sessionMemoryIds(events: MemoryEvent[], sessionId: string): Set<string> {
  const s = new Set<string>();
  for (const e of events) {
    if (e.sessionId === sessionId && isTopicEvent(e) && (e.op === "read" || e.op === "created" || e.op === "updated")) s.add(e.memoryId);
  }
  return s;
}

export function sessionsOfMemory(events: MemoryEvent[], memoryId: string): Set<string> {
  const s = new Set<string>();
  for (const e of events) {
    if (e.memoryId === memoryId && e.op === "read" && e.sessionId) s.add(e.sessionId);
  }
  return s;
}

// ── 可达性分级（纯 scan 推导，无需事件）──

export interface ReachLevels {
  /** L0 常驻条数（CLAUDE.md + 窗口内索引条目）。 */
  l0: number;
  l1: MemoryTopic[];
  l2: MemoryTopic[];
  l3: MemoryTopic[];
}

export function reachLevels(scan: MemoryScanResult): ReachLevels {
  const l1: MemoryTopic[] = [];
  const l2: MemoryTopic[] = [];
  const l3: MemoryTopic[] = [];
  for (const t of scan.topics) {
    if (!t.indexed) l3.push(t);
    else if (t.withinWindow) l1.push(t);
    else l2.push(t);
  }
  const windowEntries = scan.index
    ? scan.index.entries.filter((e) => e.line <= scan.limits.maxLines && e.byteOffset < scan.limits.maxBytes).length
    : 0;
  return { l0: windowEntries + (scan.claudeMd ? 1 : 0), l1, l2, l3 };
}

/** P2 跨项目可达性汇总：L0 = 各项目窗口内索引条目之和 + 全局 CLAUDE.md 一条（只算一次）。 */
export function sumReachLevels(scans: MemoryScanResult[], hasClaudeMd: boolean): ReachLevels {
  let l0 = 0;
  const l1: MemoryTopic[] = [];
  const l2: MemoryTopic[] = [];
  const l3: MemoryTopic[] = [];
  for (const s of scans) {
    const r = reachLevels(s);
    l0 += r.l0 - (s.claudeMd ? 1 : 0); // per-project scan 正常不含 claudeMd，防御性剔除
    l1.push(...r.l1);
    l2.push(...r.l2);
    l3.push(...r.l3);
  }
  return { l0: l0 + (hasClaudeMd ? 1 : 0), l1, l2, l3 };
}

export function dayKey(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fmtDay(ms: number | null): string {
  if (ms == null) return "—";
  return dayKey(ms).slice(5); // MM-DD
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}K`;
}
