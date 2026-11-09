export const HISTORY_LIMIT = 200;

export type BrowserRecordTarget = { kind: "session" | "draft"; key: string };
export type CreationMode = "create" | "edit";

interface RecentBase {
  title: string;
  visitedAt: number;
}

export type BrowserRecent = RecentBase & (
  | { kind: "web"; url: string }
  | { kind: "creation"; target: BrowserRecordTarget; mode: CreationMode }
  | { kind: "media"; target: BrowserRecordTarget; path: string }
);
export type RecentInput = BrowserRecent extends infer Entry
  ? Entry extends BrowserRecent ? Omit<Entry, "visitedAt"> : never
  : never;

export interface BrowserHistorySnapshot {
  version: 1;
  records: BrowserRecent[];
  showBookmarkBar: boolean;
}

export function recentKey(record: BrowserRecent): string {
  if (record.kind === "web") return JSON.stringify([record.kind, record.url]);
  const source = record.kind === "media" ? record.path : record.mode;
  return JSON.stringify([record.kind, record.target.kind, record.target.key, source]);
}

export function mergeRecents(records: BrowserRecent[]): BrowserRecent[] {
  const sorted = [...records].sort((a, b) => b.visitedAt - a.visitedAt);
  const unique = new Map<string, BrowserRecent>();
  for (const record of sorted) {
    const key = recentKey(record);
    if (!unique.has(key)) unique.set(key, record);
    if (unique.size === HISTORY_LIMIT) break;
  }
  return [...unique.values()];
}

/** 私有播放器 URL 含一次性凭据；历史只保存媒体源文件，不留这类能力链接。 */
export function historyUrl(raw: string): string | null {
  if (raw.length > 8192) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:", "file:"].includes(url.protocol) || url.username || url.password) return null;
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (loopback && /^\/media\/[a-f\d]{48}(?:\/|$)/i.test(url.pathname)) return null;
    return url.href;
  } catch {
    return null; // 导航状态可能来自旧版或损坏记录；非法 URL 不成为可恢复历史。
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit;
}

function parseTarget(value: unknown): BrowserRecordTarget | null {
  if (!isObject(value) || value.kind !== "session" || !validText(value.key, 512)) return null;
  return { kind: "session", key: value.key };
}

function parseRecent(value: unknown): BrowserRecent | null {
  if (!isObject(value) || !validText(value.title, 512) || typeof value.visitedAt !== "number"
    || !Number.isFinite(value.visitedAt) || value.visitedAt <= 0 || value.visitedAt > 8.64e15) return null;
  const base = { title: value.title, visitedAt: value.visitedAt };
  if (value.kind === "web" && validText(value.url, 8192)) {
    const url = historyUrl(value.url);
    return url ? { ...base, kind: "web", url } : null;
  }
  const target = parseTarget(value.target);
  if (!target) return null;
  if (value.kind === "creation" && (value.mode === "create" || value.mode === "edit")) {
    return { ...base, kind: "creation", target, mode: value.mode };
  }
  if (value.kind === "media" && validText(value.path, 4096)) return { ...base, kind: "media", target, path: value.path };
  return null;
}

export function parseHistory(raw: string | null): BrowserHistorySnapshot {
  if (!raw) return { version: 1, records: [], showBookmarkBar: false };
  const value: unknown = JSON.parse(raw);
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.records)
    || typeof value.showBookmarkBar !== "boolean") throw new Error("历史记录格式不兼容，未覆盖原记录");
  const records = value.records.slice(0, HISTORY_LIMIT).map(parseRecent);
  if (records.some((record) => record === null)) throw new Error("历史记录含无效条目，未覆盖原记录");
  return { version: 1, records: mergeRecents(records.filter((record) => record !== null)), showBookmarkBar: value.showBookmarkBar };
}

export function persistentHistory(records: BrowserRecent[]): BrowserRecent[] {
  return records.filter((record) => record.kind === "web" || record.target.kind === "session");
}
