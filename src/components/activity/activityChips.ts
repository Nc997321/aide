import type { BgTask, SubagentBlock } from "@/types/chat";

/**
 * 活动带的 chip 读数（纯函数）。活动带把原先三条状态条（思考行 / 子代理条 / 后台任务条）
 * 收成一行，每类「在进行中的东西」一个 chip；点 chip 打开活动抽屉的对应 tab。
 *
 * 读数口径沿用两个 dock 状态条：有运行中的 → 运行中个数；全部结束 → 完成 / 失败。
 * 列表为空 → 没有 chip（状态条当年也是「有东西或面板开着才出现」）。
 */
export type ActivityTab = "subagent" | "bg";

export type ChipTone = "run" | "done" | "err";

export interface ActivityChip {
  tab: ActivityTab;
  label: string;
  /** 运行中个数；全部结束时为 null（tone 说明完成还是失败） */
  running: number | null;
  tone: ChipTone;
  /** 悬停说明：运行中那几个的名字 */
  title: string;
  open: boolean;
}

/** 名字列表 → 悬停说明（第一个 + 余量）。 */
function namesTitle(names: string[]): string {
  if (names.length === 0) return "";
  const first = names[0].length > 60 ? `${names[0].slice(0, 60)}…` : names[0];
  return names.length > 1 ? `${first} 等 ${names.length} 个` : first;
}

export function subagentChip(subagents: readonly SubagentBlock[], open: boolean): ActivityChip | null {
  if (subagents.length === 0 && !open) return null;
  const running = subagents.filter((s) => s.isPending);
  const failed = subagents.some((s) => !s.isPending && s.isError);
  return {
    tab: "subagent",
    label: "子代理",
    running: running.length > 0 ? running.length : null,
    tone: running.length > 0 ? "run" : failed ? "err" : "done",
    title: namesTitle(running.map((s) => s.description || s.agentName)),
    open,
  };
}

export function bgTaskChip(tasks: readonly BgTask[], open: boolean): ActivityChip | null {
  if (tasks.length === 0 && !open) return null;
  const running = tasks.filter((t) => t.status === "running");
  const failed = tasks.some((t) => t.status === "failed");
  return {
    tab: "bg",
    label: "后台",
    running: running.length > 0 ? running.length : null,
    tone: running.length > 0 ? "run" : failed ? "err" : "done",
    title: namesTitle(running.map((t) => t.command || t.description || t.id)),
    open,
  };
}
