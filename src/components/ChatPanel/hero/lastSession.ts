/**
 * hero「接着上次」那一行的数据：最近一场日常对话。
 *
 * 取数走日常归属 + 会话列表这条既有通路（与侧栏「日常」分区同源），失败 / 没有日常概念
 * （远程端）/ 一场都没聊过 → null，那一行就不出现——宁可空着，也不摆一个点了没反应的假入口。
 */
import { api } from "@aide/sdk/api";
import { dailyWorkspaceBind, ensureDailyWorkspace } from "@aide/sdk/utils/dailyWorkspace";
import type { Session } from "@/types";

/** 列表里时间最新的一场（不假设后端的排序）。 */
export function latestOf(sessions: readonly Session[]): Session | null {
  let top: Session | null = null;
  for (const s of sessions) {
    if (!top || s.timestamp > top.timestamp) top = s;
  }
  return top;
}

export async function loadLastDailySession(): Promise<Session | null> {
  try {
    if (!(await ensureDailyWorkspace())) return null;
    const bind = dailyWorkspaceBind();
    if (!bind) return null;
    return latestOf(await api.listSessionsForWorkspace(bind.wsKey));
  } catch {
    return null;
  }
}
