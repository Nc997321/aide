import { ref } from "vue";
import type { Session } from "@/types";
import { useSubsessions } from "./useSubsessions";
import { useSessionState } from "./useSessionState";

/**
 * 侧栏的父子会话缩进（子会话设计 §8.5-1），项目分区与日常分区共用。
 *
 * CC 桌面版踩过的坑（anthropics/claude-code#100216）：嵌套把正在用的子会话埋起来。所以
 * - 父会话行的流光取「自己 + 子会话」里最需要你的那个（出错 / 等批准 / 在跑往上冒）；
 * - 有子会话在等批准 / 出错、或正看着其中一个子会话时自动展开；
 * - 徽标「在跑/总数」，点它开合。
 * 子会话不在顶层出现；父会话不在同一份列表里（删了 / 别处）的子会话照常当顶层显示，不让它消失。
 */
export interface SidebarRow {
  id: string;
  name: string;
  timestamp: number;
  child: boolean;
}

/** 往上冒的色调（优先级高的在前）；子会话 stopped / waiting 不冒——那是父会话自己的事。 */
const BUBBLE_TONES = ["warning", "attention", "running"] as const;

/** 手动展开的父会话（模块级：两个分区共享，切会话不丢） */
const expanded = ref(new Set<string>());

export function useSidebarNesting(activeSessionId: () => string) {
  const subs = useSubsessions();
  const { dotTone } = useSessionState();

  /** 顶层会话：去掉父会话就在同一列表里的子会话。 */
  function topLevel(list: readonly Session[]): Session[] {
    const ids = new Set(list.map((s) => s.id));
    return list.filter((s) => {
      const parent = subs.parentIdOf(s.id) ?? s.parentId;
      return !parent || !ids.has(parent);
    });
  }

  function rowTone(id: string): string {
    const own = dotTone(id);
    const kids = subs.childrenOfSession(id).map((c) => dotTone(c.id));
    for (const t of BUBBLE_TONES) {
      if (own === t || kids.includes(t)) return t;
    }
    return own;
  }

  function childBadge(id: string): string | null {
    const kids = subs.childrenOfSession(id);
    if (!kids.length) return null;
    const running = kids.filter((c) => {
      const t = dotTone(c.id);
      return t === "running" || t === "attention";
    }).length;
    return `${running}/${kids.length}`;
  }

  function isExpanded(id: string): boolean {
    if (expanded.value.has(id)) return true;
    return subs.childrenOfSession(id).some((c) => {
      const t = dotTone(c.id);
      return t === "attention" || t === "warning" || c.id === activeSessionId();
    });
  }

  function toggle(id: string) {
    const next = new Set(expanded.value);
    if (next.has(id) || isExpanded(id)) next.delete(id);
    else next.add(id);
    expanded.value = next;
  }

  /** 渲染行：顶层会话 + 展开的父会话下面紧跟它的子会话（同一个列表里平铺，TransitionGroup 照用）。 */
  function rows(list: readonly Session[], flat = false): SidebarRow[] {
    const out: SidebarRow[] = [];
    for (const s of list) {
      out.push({ id: s.id, name: s.name, timestamp: s.timestamp, child: false });
      if (flat || !isExpanded(s.id)) continue;
      for (const c of subs.childrenOfSession(s.id)) {
        out.push({ id: c.id, name: c.title, timestamp: s.timestamp, child: true });
      }
    }
    return out;
  }

  return { topLevel, rowTone, childBadge, isExpanded, toggle, rows };
}
