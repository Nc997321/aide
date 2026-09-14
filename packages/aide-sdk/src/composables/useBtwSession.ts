import { ref, computed } from "vue";
import { api } from "../api";
import type { ActionBlock } from "../types/chat";
import { useCodeGraphProgress } from "./useCodeGraphProgress";

/** btw 支线对话的轻量 store——单例:同一时间只一个 btw(v1)。
 *
 *  执行路径：一条 `api.btwAsk` 命令出去（走**存活主会话进程内**的官方
 *  side_question 通道，不起新进程），正文经 `btw_answer` 事件广播回来。
 *  所以这里**没有**事件分流、没有临时 session id、没有进程清理——发起端只把
 *  命令发出去，然后等事件。
 *
 *  status 生命周期:idle(无)→starting(命令在途)→running(命令已受理,等事件)
 *  →done(结论已插入批注)/error(命令被拒或事件带 error)。UI 据此决定抽屉可见性，
 *  且只在 running 才向用户确认"已切回主对话"(失败不弹误导性成功提示)。
 *
 *  ownerSessionId:这条 btw 挂在哪个主会话上。抽屉是 per-ChatPanel 挂载的,store
 *  是全局单例——若可见性只看 status,任何一个窗口触发都会让所有窗口的抽屉一起
 *  弹出。用 ownerSessionId 绑回触发它的那个会话窗口。
 *  btw_answer 事件按 `session_id === ownerSessionId` + `question` 双重匹配落账，
 *  后者用于同一会话多条 btw 之间消歧。 */
type BtwStatus = "idle" | "starting" | "running" | "error" | "done";

interface BtwState {
  messages: string[]; // 累积的 assistant 文本(纯展示)
  isBusy: boolean;
  done: boolean;
  error: string | null;
  question: string;
  status: BtwStatus;
  ownerSessionId: string | null; // 主会话 sid;null=idle
  model: string; // 这条支线实际跑的模型别名(抽屉展示用);空串=idle
  effort: string; // 这条支线实际跑的 effort 档位;空串=idle
  minimized: boolean; // 用户点了「关闭」=最小化:抽屉收起,答案到达后照样插批注。
}

const IDLE: BtwState = {
  messages: [],
  isBusy: false,
  done: false,
  error: null,
  question: "",
  status: "idle",
  ownerSessionId: null,
  model: "",
  effort: "",
  minimized: false,
};
const state = ref<BtwState>({ ...IDLE });

/** 每次重置都重建 messages 数组——{...IDLE} 是浅拷贝，共享那个空数组会让每轮的
 *  push 累积到常量上（跨轮污染，测试与运行时都会中招）。 */
function freshState(): BtwState {
  return { ...IDLE, messages: [] };
}

let onDoneCb: ((block: ActionBlock) => void) | null = null;

/** 支线问答记忆：按主会话 id 记全部轮次（内存态，app 重启即忘——btw 本来就是
 *  阅后即弃的临时物）。不再拼进 prompt——作为 `history` 参数下发给官方通道
 *  （调用方不传就没有连续性，官方语义如此）。封顶 20 轮防病态累积，与官方一致。
 *
 *  注意形状：本地存 `{question, answer}`，线上要 `{question, response}`——转换在
 *  startBtw 里显式做，别直接把本地数组丢过去（字段名不匹配会静默失效）。 */
interface BtwRound {
  question: string;
  answer: string;
}
const historyByOwner = new Map<string, BtwRound[]>();
const BTW_HISTORY_ROUNDS_CAP = 20;

/** useChatSession.handleChatEvent 调:btw_answer 事件按主会话 id 路由到这里。 */
function handleBtwAnswer(e: Record<string, unknown>) {
  if (e["session_id"] !== state.value.ownerSessionId) return;
  if (e["question"] !== state.value.question) return; // 同会话多条 btw 消歧

  const err = e["error"] as string | undefined;
  if (err) {
    state.value.isBusy = false;
    state.value.status = "error";
    state.value.error = err;
    state.value.minimized = false; // 出错必须露出来:别让最小化把错误吞掉
    return;
  }

  const answer = e["response"] as string | undefined;
  if (!answer) return; // 既无正文又无错误：协议异常，保持 running 等后续帧

  state.value.messages.push(answer);
  state.value.isBusy = false;
  state.value.done = true;
  state.value.status = "done";

  // btw 是只读侧问，但主会话可能同时在改文件——同主对话，防抖增量重扫保持索引新鲜。
  useCodeGraphProgress().scheduleRescan();

  // 记入支线记忆：只记真实回答（synthetic 兜底答复渲染但不记，对齐官方"只把真实
  // 回答喂给 history"）；失败轮走不到这里。
  if (e["synthetic"] !== true && state.value.ownerSessionId) {
    const owner = state.value.ownerSessionId;
    const rounds = historyByOwner.get(owner) ?? [];
    rounds.push({ question: state.value.question, answer });
    if (rounds.length > BTW_HISTORY_ROUNDS_CAP) {
      rounds.splice(0, rounds.length - BTW_HISTORY_ROUNDS_CAP);
    }
    historyByOwner.set(owner, rounds);
  }

  onDoneCb?.({
    type: "action",
    actionId: "btw",
    label: state.value.question,
    icon: "↳",
    foldable: true,
    body: answer,
  });
}

interface StartBtwOpts {
  /** 主会话 sid：既作命令的路由键，也作抽屉绑定与记忆 key。 */
  ownerSid: string;
  question: string;
  model?: string;
  effort?: string;
}

async function startBtw(opts: StartBtwOpts) {
  // 单实例：新开直接覆盖旧 store（旧 btw 的事件会被 owner/question 匹配挡掉）
  state.value = {
    ...freshState(),
    isBusy: true,
    question: opts.question,
    status: "starting",
    ownerSessionId: opts.ownerSid,
    model: opts.model ?? "",
    effort: opts.effort ?? "",
  };
  try {
    await api.btwAsk({
      sessionId: opts.ownerSid,
      question: opts.question,
      // 形状转换：本地 {question, answer} → 线上 {question, response}
      history: (historyByOwner.get(opts.ownerSid) ?? []).map((r) => ({
        question: r.question,
        response: r.answer,
      })),
    });
    // 命令已受理；正文等 btw_answer 事件（fire-and-forget，与用户气泡同构）
    state.value.status = "running";
  } catch (e) {
    // 命令没写进 sidecar（Runtime 不可用等）：进 error 态让抽屉展示原因，不静默吞
    state.value.isBusy = false;
    state.value.status = "error";
    state.value.error = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  }
}

function setOnDone(cb: (block: ActionBlock) => void) {
  onDoneCb = cb;
}

/** 「关闭」=最小化:抽屉收起，答案到达后照样经 onDone 插进主对话。 */
function minimize() {
  state.value.minimized = true;
}

/** 重展抽屉:最小化的逆操作。 */
function reopen() {
  state.value.minimized = false;
}

/** 主会话 tempId→realId 定名跟随:主会话 finalize 改名后，抽屉绑定与记忆 key
 *  一起迁到 realId，否则可见性判定永久失绑。由 useChatSession.finalizeSession 调。 */
function rebindOwner(tempId: string, realId: string) {
  if (state.value.ownerSessionId === tempId) state.value.ownerSessionId = realId;
  const rounds = historyByOwner.get(tempId);
  if (rounds) {
    historyByOwner.delete(tempId);
    historyByOwner.set(realId, rounds);
  }
}

export function useBtwSession() {
  return {
    store: computed(() => state.value),
    startBtw,
    handleBtwAnswer,
    minimize,
    reopen,
    rebindOwner,
    setOnDone,
    clearBtwHistory,
  };
}

/** 关 tab / 删会话时清理该主会话的支线问答记忆（owner 已关，记忆无人消费）。 */
export function clearBtwHistory(ownerSid: string) {
  historyByOwner.delete(ownerSid);
}

export function __resetBtwForTest() {
  state.value = freshState();
  onDoneCb = null;
  historyByOwner.clear();
}
