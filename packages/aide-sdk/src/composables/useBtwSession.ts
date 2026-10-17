import { ref } from "vue";
import { api } from "../api";
import type { ActionBlock } from "../types/chat";

/** btw 侧边对话的 store——**按主会话一条线程**（2026-10-17 侧栏化）。
 *
 *  执行路径不变：每问一条 `api.btwAsk` 命令出去（走**存活主会话进程内**的官方
 *  side_question 通道，不起新进程），正文经 `btw_answer` 事件广播回来。这里没有
 *  事件分流、没有临时 session id、没有进程清理——发起端只把命令发出去，然后等事件。
 *
 *  一条线程 = 一个主会话的全部支线问答（侧栏里按时间排的气泡）+ 侧栏开合 + 未读。
 *  侧栏是**看回复的固定地点**；主对话里每轮一条批注只当书签（点开定位到这一轮）。
 *  同一线程一次只有一问在途（侧栏输入在等答复时置灰）；不同主会话的线程互不干扰。
 *
 *  btw_answer 事件按 `session_id` 找线程、按 `question` 认领在途那一轮。 */
export type BtwRoundStatus = "pending" | "done" | "error";

export interface BtwRound {
  id: string;
  question: string;
  answer: string | null;
  error: string | null;
  status: BtwRoundStatus;
  /** 官方兜底答复：照常展示，但不喂回 history（对齐官方"只把真实回答喂给 history"） */
  synthetic: boolean;
}

export interface BtwThread {
  rounds: BtwRound[];
  /** 侧栏开着（按主会话记：切走再切回，侧栏还在） */
  open: boolean;
  /** 侧栏关着时有答复 / 错误到达，还没看——活动带据此亮「有新回复」 */
  unread: boolean;
  /** 要滚到并高亮的那一轮（批注书签点进来时设），侧栏消费后清空 */
  focusRoundId: string | null;
  /** 递增 = 请侧栏把光标放进输入框（/btw、快捷菜单打开时） */
  focusInputTick: number;
}

const threads = ref<Record<string, BtwThread>>({});
const EMPTY_THREAD: BtwThread = Object.freeze({ ...emptyThreadShape(), rounds: Object.freeze([]) as unknown as BtwRound[] });

/** 喂给官方通道的跨问记忆封顶（与官方一致）；侧栏展示另有更宽的上限防病态累积。 */
const BTW_HISTORY_ROUNDS_CAP = 20;
const BTW_DISPLAY_ROUNDS_CAP = 100;

function emptyThreadShape(): BtwThread {
  return { rounds: [], open: false, unread: false, focusRoundId: null, focusInputTick: 0 };
}

function threadOf(owner: string): BtwThread {
  let t = threads.value[owner];
  if (!t) {
    threads.value[owner] = emptyThreadShape();
    t = threads.value[owner];
  }
  return t;
}

let onDoneCb: ((owner: string, block: ActionBlock) => void) | null = null;

/** 结论回插主对话（批注书签）的出口：由 useChatSession 注册（按 owner 找对应会话 store）。 */
function setOnDone(cb: (owner: string, block: ActionBlock) => void) {
  onDoneCb = cb;
}

/** useChatSession.handleChatEvent 调：btw_answer 事件按主会话 id 路由到这里。 */
function handleBtwAnswer(e: Record<string, unknown>) {
  const owner = e["session_id"];
  if (typeof owner !== "string") return;
  const t = threads.value[owner];
  if (!t) return;
  const round = t.rounds.find((r) => r.status === "pending" && r.question === e["question"]);
  if (!round) return; // 不是本端发起的（或已被清掉的）那一问

  const err = e["error"] as string | undefined;
  if (err) {
    round.status = "error";
    round.error = err;
    if (!t.open) t.unread = true; // 出错也要露出来：活动带亮提示
    return;
  }

  const answer = e["response"] as string | undefined;
  if (!answer) return; // 既无正文又无错误：协议异常，保持 pending 等后续帧

  round.status = "done";
  round.answer = answer;
  round.synthetic = e["synthetic"] === true;
  if (!t.open) t.unread = true;

  onDoneCb?.(owner, {
    type: "action",
    actionId: "btw",
    label: round.question,
    icon: "↳",
    foldable: true,
    body: answer,
    btwRoundId: round.id,
  });
}

/** 喂给官方通道的 history：已答完的真实回答（不含兜底、失败轮），最近 20 轮。
 *  形状转换：本地 {question, answer} → 线上 {question, response}。 */
function historyOf(t: BtwThread): { question: string; response: string }[] {
  return t.rounds
    .filter((r) => r.status === "done" && !r.synthetic && r.answer)
    .slice(-BTW_HISTORY_ROUNDS_CAP)
    .map((r) => ({ question: r.question, response: r.answer as string }));
}

/** btw **没有自己的一套模型/档位**：官方 side_question 通道只收 question/history，支线一律
 *  继承主会话的模型与档位（cache-safe fork 必须与父会话同前缀才吃得到缓存）。 */
interface AskOpts {
  /** 主会话 sid：命令的路由键，也是线程 key。 */
  ownerSid: string;
  question: string;
}

/** 问一句：打开侧栏、追加一轮在途气泡、发命令。线程里已有在途的一问时拒绝（返回 false）。 */
async function ask(opts: AskOpts): Promise<boolean> {
  const t = threadOf(opts.ownerSid);
  if (t.rounds.some((r) => r.status === "pending")) return false;
  const history = historyOf(t);
  t.rounds.push({
    id: crypto.randomUUID(),
    question: opts.question,
    answer: null,
    error: null,
    status: "pending",
    synthetic: false,
  });
  if (t.rounds.length > BTW_DISPLAY_ROUNDS_CAP) t.rounds.splice(0, t.rounds.length - BTW_DISPLAY_ROUNDS_CAP);
  t.open = true;
  t.unread = false;
  // 取响应式代理：直接改 push 进去的原对象绕过代理，侧栏收不到变更
  const round = t.rounds[t.rounds.length - 1];
  try {
    await api.btwAsk({ sessionId: opts.ownerSid, question: opts.question, history });
    // 命令已受理；正文等 btw_answer 事件（fire-and-forget，与用户气泡同构）
  } catch (e) {
    // 命令没写进 sidecar（Runtime 不可用等）：这一轮进 error，原因在侧栏里展示，不静默吞
    round.status = "error";
    round.error = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  }
  return true;
}

/** 打开侧栏（看过即清未读）。focusInput：把光标放进侧栏输入框。 */
function openPanel(owner: string, opts: { focusInput?: boolean } = {}) {
  const t = threadOf(owner);
  t.open = true;
  t.unread = false;
  if (opts.focusInput) t.focusInputTick++;
}

function closePanel(owner: string) {
  const t = threads.value[owner];
  if (t) t.open = false;
}

/** 主对话里的批注书签：打开它所在线程的侧栏并定位到这一轮。找不到（线程已清）返回 false。 */
function openRound(roundId: string): boolean {
  for (const [owner, t] of Object.entries(threads.value)) {
    if (t.rounds.some((r) => r.id === roundId)) {
      openPanel(owner);
      t.focusRoundId = roundId;
      return true;
    }
  }
  return false;
}

function hasRound(roundId: string): boolean {
  return Object.values(threads.value).some((t) => t.rounds.some((r) => r.id === roundId));
}

/** 侧栏滚到目标轮后调用，清掉一次性的定位请求。 */
function consumeFocusRound(owner: string) {
  const t = threads.value[owner];
  if (t) t.focusRoundId = null;
}

/** 主会话 tempId→realId 定名跟随：线程整体迁到 realId，否则侧栏与记忆永久失绑。
 *  由 useChatSession.finalizeSession 调。 */
function rebindOwner(tempId: string, realId: string) {
  const t = threads.value[tempId];
  if (!t) return;
  delete threads.value[tempId];
  threads.value[realId] = t;
}

/** 关 tab / 删会话时清理该主会话的支线线程（owner 已关，无人消费）。 */
export function clearBtwHistory(ownerSid: string) {
  delete threads.value[ownerSid];
}

export function useBtwSession() {
  return {
    /** 某主会话的线程（响应式读取；没有则返回共享的空线程，不会因读取而创建）。
     *  组件里包一层 computed 用：`computed(() => btw.threadFor(props.sessionId))`。 */
    threadFor: (owner: string | null | undefined): BtwThread =>
      (owner && threads.value[owner]) || EMPTY_THREAD,
    ask,
    handleBtwAnswer,
    openPanel,
    closePanel,
    openRound,
    hasRound,
    consumeFocusRound,
    rebindOwner,
    setOnDone,
    clearBtwHistory,
  };
}

export function __resetBtwForTest() {
  threads.value = {};
  onDoneCb = null;
}
