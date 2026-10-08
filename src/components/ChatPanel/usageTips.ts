/**
 * 使用小提示：文案表 + 「此刻该不该说、说哪条」的纯函数（无 IO/时钟/随机，可测）。
 *
 * 两种出场方式（slot）：
 * - `thinking`：「正在思考」旁轮播——agent 在跑、用户在等，是唯一不跟输入抢注意力的时刻；
 * - 其余是**时机提示**：只在用户正需要它的那一刻出现（生成中开始打字 → /btw；
 *   @ 菜单里出现别的项目 → 跨项目……），比随机翻到有效得多。
 *
 * 退场：每条看过 maxShows 次，或用户已经用过它讲的功能（retiredBy），就不再出现——
 * 提示是教学不是广告，教会了就闭嘴。没有设置开关，靠这条规则自己安静下去。
 *
 * 加提示 = 在 TIPS 加一行。文案只写代码里确认存在的行为；`反引号` 渲染成行内代码。
 */

/** 用户「已经会了」的信号：用过一次就退役对应提示。 */
export type TipFeature =
  | "btw"
  | "cross-project"
  | "range-mention"
  | "file-mention"
  | "paste-image"
  | "perm-cycle"
  | "effort-low"
  | "slash"
  | "context-ring"
  | "compact"
  | "new-session"
  | "kb-selection"
  | "browser";

export type TipSlot =
  | "thinking"
  | "busy-typing"
  | "mention-project"
  | "project-attached"
  | "context-high";

export interface UsageTip {
  readonly id: string;
  readonly slot: TipSlot;
  readonly text: string;
  readonly retiredBy?: TipFeature;
  /** 缺省 DEFAULT_MAX_SHOWS。 */
  readonly maxShows?: number;
}

export interface TipState {
  /** 每条提示已出场次数（按 id）。 */
  readonly shown: Readonly<Record<string, number>>;
  /** 用过的功能。 */
  readonly used: readonly TipFeature[];
}

export const DEFAULT_MAX_SHOWS = 3;

export const TIPS: readonly UsageTip[] = [
  // ── 时机提示 ──
  {
    id: "busy-typing-btw",
    slot: "busy-typing",
    text: "直接发送会排队，等这一轮结束再送达；只想顺便问一句，用 `/btw` 不打断它",
    retiredBy: "btw",
  },
  {
    id: "mention-project",
    slot: "mention-project",
    text: "@ 另一个项目 = 授权它的目录，本会话里 agent 可以跨项目读改",
    retiredBy: "cross-project",
    maxShows: 5,
  },
  {
    id: "project-attached",
    slot: "project-attached",
    text: "已授权的项目整个会话有效；要解除就开新会话",
  },
  {
    id: "context-high",
    slot: "context-high",
    text: "上下文快满了，`/compact` 压缩一下，保留要点继续聊",
    retiredBy: "compact",
  },
  // ── 「正在思考」旁轮播（顺序即新用户首轮出场顺序，最值钱的排前面）──
  {
    id: "t-btw",
    slot: "thinking",
    text: "`/btw` 顺便问一下：旁问小问题，不打断主任务，也不占主对话上下文",
    retiredBy: "btw",
  },
  {
    id: "t-cross-project",
    slot: "thinking",
    text: "输入 `@` 引用文件或目录，也能 @ 其它项目让 agent 跨项目协作",
    retiredBy: "cross-project",
  },
  {
    id: "t-range-mention",
    slot: "thinking",
    text: "编辑器里选中几行，右键「添加选中到对话」只发这一段，省 token",
    retiredBy: "range-mention",
  },
  {
    id: "t-file-mention",
    slot: "thinking",
    text: "文件树右键「添加到对话」，或直接把文件拖进输入框",
    retiredBy: "file-mention",
  },
  {
    id: "t-paste-image",
    slot: "thinking",
    text: "截图可以直接粘贴进输入框",
    retiredBy: "paste-image",
  },
  {
    id: "t-perm-cycle",
    slot: "thinking",
    text: "`Shift+Tab` 切换权限模式：手动 / 自动 / 计划",
    retiredBy: "perm-cycle",
  },
  {
    id: "t-effort-low",
    slot: "thinking",
    text: "简单问题切到「快速」档，回得更快也更省",
    retiredBy: "effort-low",
  },
  {
    id: "t-slash",
    slot: "thinking",
    text: "输入 `/` 列出可用的技能和命令",
    retiredBy: "slash",
  },
  {
    id: "t-context-ring",
    slot: "thinking",
    text: "点输入框右下角的圆环，看上下文用了多少",
    retiredBy: "context-ring",
  },
  {
    id: "t-compact",
    slot: "thinking",
    text: "`/clear` 清空上下文重新开始（会先确认）；只想瘦身用 `/compact`",
    retiredBy: "compact",
  },
  {
    id: "t-kb-selection",
    slot: "thinking",
    text: "在知识库文档里圈出一段再发，agent 只会改你圈的那段",
    retiredBy: "kb-selection",
  },
  {
    id: "t-new-session",
    slot: "thinking",
    text: "`Ctrl+N` 新建会话",
    retiredBy: "new-session",
  },
  {
    id: "t-browser",
    slot: "thinking",
    text: "`Ctrl+Shift+B` 打开内置浏览器，agent 可以直接操作里面的网页",
    retiredBy: "browser",
  },
  {
    id: "t-busy-send",
    slot: "thinking",
    text: "生成中也能直接发消息，它会排队，等这一轮结束送达",
  },
];

/** 这条提示还该不该出场。 */
export function isTipActive(tip: UsageTip, state: TipState): boolean {
  if (tip.retiredBy && state.used.includes(tip.retiredBy)) return false;
  return (state.shown[tip.id] ?? 0) < (tip.maxShows ?? DEFAULT_MAX_SHOWS);
}

/** 时机提示：该 slot 第一条还在役的；没有 → null。 */
export function slotTip(slot: TipSlot, state: TipState, pool: readonly UsageTip[] = TIPS): UsageTip | null {
  return pool.find((t) => t.slot === slot && isTipActive(t, state)) ?? null;
}

/**
 * 轮播下一条：在役的 thinking 提示里出场最少的（同次数按表序）——每出场一次计数 +1，
 * 自然就轮起来了。excludeId（当前正显示的）在还有别的可选时跳过，避免原地重复。
 */
export function nextThinkingTip(
  state: TipState,
  excludeId: string | null = null,
  pool: readonly UsageTip[] = TIPS,
): UsageTip | null {
  const active = pool.filter((t) => t.slot === "thinking" && isTipActive(t, state));
  const candidates = active.length > 1 ? active.filter((t) => t.id !== excludeId) : active;
  let best: UsageTip | null = null;
  for (const t of candidates) {
    if (!best || (state.shown[t.id] ?? 0) < (state.shown[best.id] ?? 0)) best = t;
  }
  return best;
}

/** 文案切段：`反引号` 内为行内代码。 */
export function tipSegments(text: string): Array<{ code: boolean; text: string }> {
  return text
    .split("`")
    .map((s, i) => ({ code: i % 2 === 1, text: s }))
    .filter((s) => s.text.length > 0);
}
