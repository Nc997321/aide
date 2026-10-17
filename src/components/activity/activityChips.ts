import type { BgTask, SubagentBlock } from "@/types/chat";
import type { BtwThread } from "@/composables/useBtwSession";

/**
 * 活动带的 chip 读数（纯函数）。活动带把原先三条状态条（思考行 / 子代理条 / 后台任务条）
 * 收成一行，每类「在进行中的东西」一个 chip；点 chip 打开活动抽屉的对应 tab。
 *
 * 读数口径沿用两个 dock 状态条：有运行中的 → 运行中个数；全部结束 → 完成 / 失败。
 * 列表为空 → 没有 chip（状态条当年也是「有东西或面板开着才出现」）。
 */
export type ActivityTab = "subsession" | "subagent" | "bg";

/** chip 点开的目标：活动抽屉的某个 tab，或会话右侧的 btw 侧栏（不在抽屉里） */
export type ActivityChipTarget = ActivityTab | "btw";

/** attn = 有子会话在等你批准（黄，压过运行中的绿） */
export type ChipTone = "run" | "done" | "err" | "attn";

export interface ActivityChip {
  tab: ActivityChipTarget;
  label: string;
  /** 运行中个数；全部结束时为 null（tone 说明完成还是失败） */
  running: number | null;
  tone: ChipTone;
  /** 悬停说明：运行中那几个的名字 */
  title: string;
  open: boolean;
  /** 附注（子会话：「N 待批准」） */
  note?: string;
  /** 自定义状态字（btw：「回答中」/「有新回复」）；缺省按 running / tone 出数字或完成态 */
  stateText?: string;
}

/** 子会话的活跃度（与侧栏同一份 useSessionState）：attention = 在等权限批准。 */
export type ChildActivity = "running" | "attention" | "waiting" | "stopped";

/**
 * 子会话 chip：运行中 = 在跑 + 在等批准；等批准的单独注明（作答槽另有引导卡）。
 * 没有子会话 → 没有 chip。全部空闲时显示「已完成」，点开看回报。
 */
export function subsessionChip(
  children: readonly { id: string; title: string }[],
  activityOf: (id: string) => ChildActivity,
  open: boolean,
): ActivityChip | null {
  if (children.length === 0 && !open) return null;
  const running = children.filter((c) => {
    const a = activityOf(c.id);
    return a === "running" || a === "attention";
  });
  const waiting = children.filter((c) => activityOf(c.id) === "attention");
  return {
    tab: "subsession",
    label: "子会话",
    running: running.length > 0 ? running.length : null,
    tone: waiting.length > 0 ? "attn" : running.length > 0 ? "run" : "done",
    title: namesTitle(running.map((c) => c.title)),
    open,
    ...(waiting.length > 0 ? { note: `${waiting.length} 待批准` } : {}),
  };
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

/**
 * btw 侧边对话 chip：只在侧栏**收起**时出现，告诉你「那边还有事」——
 * 还在答 → 「回答中」；答完 / 出错但还没看 → 「有新回复」/「出错了」。
 * 点开 = 打开侧栏（落到最新一轮）。侧栏开着时什么都不显示（回复就在眼前）。
 */
export function btwChip(thread: BtwThread): ActivityChip | null {
  if (thread.open) return null;
  const pendingRound = thread.rounds.find((r) => r.status === "pending");
  const last = thread.rounds[thread.rounds.length - 1];
  if (pendingRound) {
    return { tab: "btw", label: "顺便问", running: null, tone: "run", stateText: "回答中", title: pendingRound.question, open: false };
  }
  if (thread.unread && last) {
    const failed = last.status === "error";
    return {
      tab: "btw",
      label: "顺便问",
      running: null,
      tone: failed ? "err" : "attn",
      stateText: failed ? "出错了" : "有新回复",
      title: last.question,
      open: false,
    };
  }
  return null;
}
