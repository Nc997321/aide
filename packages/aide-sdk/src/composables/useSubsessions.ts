import { reactive } from "vue";
import type { Session } from "../types";
import type { SubsessionListItem, SubsessionReport } from "../types/chat";

/**
 * 子会话的前端视图（docs/superpowers/specs/2026-10-16-subsessions-design.md）。
 *
 * **父子关系的权威在 Host 档案**（子会话的 `parentId`）；这里是可回种的缓存，来源三条：
 * 会话列表（`Session.parentId`）、`subsession_started` 事件、`list_subsessions`（活动抽屉回种）。
 * 别造第三份来源——这里也不存子会话的运行状态：在跑 / 等批准看 useSessionState（与侧栏同一份）。
 *
 * 模块级单例（同 useSessionState），跨 ChatPanel / 侧栏 / 活动抽屉共享。
 */
/** 子会话路由键前缀（Host `subsession.rs` 的 ROUTING_PREFIX + "_"）：它的 session_init 是改名。 */
export const SUBSESSION_ROUTING_PREFIX = "subsess_";
/** 每个父会话同时在跑的子会话上限（Host `subsession.rs` 的 MAX_RUNNING_CHILDREN；判定在 Host，这里只做提前提示）。 */
export const SUBSESSION_MAX_RUNNING = 4;

export interface SubsessionEntry {
  id: string;
  title: string;
  /** 派发时的任务说明（只有本端看到 subsession_started 时才有） */
  task?: string;
  /** 最近一次回报（父会话收到的 subsession_report 块） */
  lastReport?: { status: string; firstLine: string };
}

const parentOf = reactive<Record<string, string>>({});
const childrenOf = reactive<Record<string, SubsessionEntry[]>>({});
/** 自动回报被暂停的父会话 → 暂停时攒着的回报条数 */
const paused = reactive<Record<string, number>>({});
/** 「子会话」tab 开着的父会话（纯 UI 状态，不落盘） */
const drawerOpen = reactive<Record<string, boolean>>({});

function upsertChild(parent: string, entry: SubsessionEntry): void {
  parentOf[entry.id] = parent;
  const list = childrenOf[parent] ?? (childrenOf[parent] = []);
  const hit = list.find((c) => c.id === entry.id);
  if (hit) {
    if (entry.title) hit.title = entry.title;
    if (entry.task) hit.task = entry.task;
    if (entry.lastReport) hit.lastReport = entry.lastReport;
  } else {
    list.push({ ...entry });
  }
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line.trim();
}

/** 事件：父会话派出了一个子会话（Host 在子会话 session_init 定名、档案落盘之后才发）。 */
export function noteSubsessionStarted(parent: string, child: string, title: string, task?: string): void {
  upsertChild(parent, { id: child, title, task });
}

/** 父会话收到回报（user_message 的 subsession_report 块）：记下每个子会话的最近回报。 */
export function noteSubsessionReports(parent: string, reports: SubsessionReport[]): void {
  for (const r of reports) {
    upsertChild(parent, { id: r.childId, title: r.title, lastReport: { status: r.status, firstLine: firstLine(r.text) } });
  }
}

export function noteSubsessionPaused(parent: string, pending: number): void {
  paused[parent] = pending;
}

export function noteSubsessionResumed(parent: string): void {
  delete paused[parent];
}

/** 会话列表回种（侧栏拉到的 Session 带 parentId）。 */
export function seedFromSessions(sessions: readonly Session[]): void {
  for (const s of sessions) {
    if (s.parentId) upsertChild(s.parentId, { id: s.id, title: s.name });
  }
}

/** `list_subsessions` 回种（活动抽屉打开时）。 */
export function seedChildren(parent: string, list: readonly SubsessionListItem[]): void {
  for (const c of list) {
    upsertChild(parent, {
      id: c.id,
      title: c.title,
      ...(c.last_report ? { lastReport: { status: "done", firstLine: c.last_report } } : {}),
    });
  }
}

/** 子会话删掉 / 升为顶层：从缓存里摘掉。 */
export function forgetSubsession(child: string): void {
  const parent = parentOf[child];
  if (!parent) return;
  delete parentOf[child];
  const list = childrenOf[parent];
  if (list) {
    const i = list.findIndex((c) => c.id === child);
    if (i >= 0) list.splice(i, 1);
  }
}

/** 定名改 id（极少：路由键阶段不会进这张表，这里只为完整性）。 */
export function rekeySubsession(oldId: string, newId: string): void {
  const parent = parentOf[oldId];
  if (!parent) return;
  delete parentOf[oldId];
  parentOf[newId] = parent;
  const hit = childrenOf[parent]?.find((c) => c.id === oldId);
  if (hit) hit.id = newId;
}

export function toggleSubsessionDrawer(parent: string, open?: boolean): void {
  drawerOpen[parent] = open ?? !drawerOpen[parent];
}

export function useSubsessions() {
  return {
    parentOf,
    childrenOf,
    paused,
    drawerOpen,
    parentIdOf: (sid: string | null | undefined): string | null => (sid ? (parentOf[sid] ?? null) : null),
    childrenOfSession: (sid: string | null | undefined): SubsessionEntry[] => (sid ? (childrenOf[sid] ?? []) : []),
  };
}

/** 测试用：清空模块状态。 */
export function __resetSubsessionsForTest(): void {
  for (const k of Object.keys(parentOf)) delete parentOf[k];
  for (const k of Object.keys(childrenOf)) delete childrenOf[k];
  for (const k of Object.keys(paused)) delete paused[k];
  for (const k of Object.keys(drawerOpen)) delete drawerOpen[k];
}
