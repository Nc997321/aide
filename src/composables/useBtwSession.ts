import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { ActionBlock } from "../types/chat";
import { useCodeGraphProgress } from "./useCodeGraphProgress";

/** btw 支线对话的轻量 store——单例:同一时间只一个 btw(v1)。
 *  status 生命周期:idle(无)→starting(已发 fork 命令)→running(sidecar 应答中)
 *  →done(结论已插入批注)/error(起不来或中途死)。UI 据此决定抽屉可见性、
 *  且只在 running 才向用户确认"已切回主对话"(失败不弹误导性成功提示)。
 *
 *  ownerSessionId:这个 btw 是从哪个主会话 fork 出来的。抽屉是 per-ChatPanel
 *  挂载的,但 store 是全局单例——若可见性只看 status,任何一个窗口触发都会让
 *  所有窗口的抽屉一起弹出。用 ownerSessionId 把抽屉绑回触发它的那个会话窗口:
 *  只有当前活动会话 === ownerSessionId 的 ChatPanel 才显示抽屉。 */
type BtwStatus = "idle" | "starting" | "running" | "error" | "done";

interface BtwState {
  messages: string[]; // 累积的 assistant 文本(纯展示)
  isBusy: boolean;
  done: boolean;
  error: string | null;
  question: string;
  status: BtwStatus;
  ownerSessionId: string | null; // 被 fork 的主会话 sid;null=idle
  model: string; // 这条支线实际跑的模型别名(抽屉展示用);空串=idle
  effort: string; // 这条支线实际跑的 effort 档位(抽屉 pill 展示——直发不进输入模式时选择器看不到它);空串=idle
  minimized: boolean; // 用户点了「关闭」=最小化:抽屉收起,但 sidecar 继续后台跑,
  // 跑完结论照样经 onDone 插进主对话。最小化不杀进程;真正的 teardown 是 cleanup。
  taskId: string; // btw 任务支线标识(git-commit);空串=问答支线。抽屉据此隐藏轻量/完整切换。
  taskLabel: string; // 任务支线的批注标题(问答支线用问题原文,任务支线没有"问题")
  taskIcon: string; // 任务支线批注图标
}

const IDLE: BtwState = { messages: [], isBusy: false, done: false, error: null, question: "", status: "idle", ownerSessionId: null, model: "", effort: "", minimized: false, taskId: "", taskLabel: "", taskIcon: "" };
const state = ref<BtwState>({ ...IDLE });
let btwTempId: string | null = null;
let btwRealId: string | null = null; // session_init 后的 fork id
let onDoneCb: ((block: ActionBlock) => void) | null = null;

/** 支线问答记忆：按主会话 id 记全部历史轮次（内存态，app 重启即忘——btw 本来就是
 *  阅后即弃的临时物）。下一轮 btw 拼进 prompt，支线就能引用此前的问答（2026-08-02）。
 *  不设轮数/字符上限：正常用法一个会话就几轮，每轮大头开销本是 fork 主会话上下文，
 *  为假想的病态累积写截断特殊处理不值得。 */
interface BtwRound {
  question: string;
  answer: string;
}
const historyByOwner = new Map<string, BtwRound[]>();

/** 把该主会话此前的支线问答拼进本轮 prompt；无历史则原样返回。 */
function composePrompt(ownerSid: string, prompt: string): string {
  const history = historyByOwner.get(ownerSid);
  if (!history?.length) return prompt;
  const digest = history
    .map((r, i) => `Q${i + 1}: ${r.question}\nA${i + 1}: ${r.answer}`)
    .join("\n\n");
  return `[本次对话此前的支线问答]\n${digest}\n\n[本轮问题]\n${prompt}`;
}

function resetState(question: string) {
  // 新支线:show drawer(最小化标志清掉),starting 态。ownerSessionId/model/effort/task 由 startBtw 补。
  state.value = { messages: [], isBusy: true, done: false, error: null, question, status: "starting", ownerSessionId: null, model: "", effort: "", minimized: false, taskId: "", taskLabel: "", taskIcon: "" };
}

/** useChatSession.handleChatEvent 调:判断事件是否属于当前 btw。 */
function isBtwSid(raw: string): boolean {
  return !!btwTempId && (raw === btwTempId || (btwRealId !== null && raw === btwRealId));
}

interface StartBtwOpts {
  tempId: string;
  /** fork 源会话 sid;空串 = 不 fork,全新会话(btw 任务支线——不背主会话历史)。 */
  forkFrom: string;
  /** 抽屉绑定的主会话 sid + 支线问答记忆 key。省略 = forkFrom(问答支线常态);
   *  任务支线(forkFrom 空)必须显式给,否则抽屉不显示、结论批注无处回插。 */
  ownerSid?: string;
  prompt: string;
  cwd: string;
  lightweight: boolean;
  permissionMode?: string;
  model?: string;
  effort?: string; // 支线档位（默认 low），骑 env 通道到 sidecar 作初始 effort
  /** btw 任务支线(git-commit):工具白名单 + session 级权限白名单快照。 */
  task?: { id: string; label: string; icon: string; tools: string[]; policy: unknown };
}

async function startBtw(opts: StartBtwOpts) {
  // 单实例:新开先清掉旧的(kill 进程、丢 store)
  if (btwTempId) await cleanup();
  btwTempId = opts.tempId;
  btwRealId = null;
  resetState(opts.prompt); // status="starting":抽屉已可见,显示问题
  state.value.ownerSessionId = opts.ownerSid ?? opts.forkFrom; // 抽屉只绑回这个主会话所在窗口
  state.value.model = opts.model ?? ""; // 抽屉展示这条支线用的模型
  state.value.effort = opts.effort ?? ""; // 抽屉 pill 展示这条支线实际跑的档位
  if (opts.task) {
    state.value.taskId = opts.task.id;
    state.value.taskLabel = opts.task.label;
    state.value.taskIcon = opts.task.icon;
  }
  try {
    await invoke("start_btw_session", {
      btwId: opts.tempId,
      forkFrom: opts.forkFrom || null, // 空串 → None → 不 fork,全新会话
      // 带上本主会话此前的支线问答（无历史则原样）；抽屉展示的仍是原始问题。
      // 任务支线不 fork 主会话,没有"此前问答"的语境,composePrompt 原样返回。
      prompt: opts.forkFrom ? composePrompt(opts.ownerSid ?? opts.forkFrom, opts.prompt) : opts.prompt,
      cwd: opts.cwd,
      lightweight: opts.lightweight,
      permissionMode: opts.permissionMode ?? null,
      model: opts.model ?? null,
      effort: opts.effort ?? null,
      tools: opts.task?.tools ?? null,
      permissionPolicy: opts.task?.policy ?? null,
    });
    state.value.status = "running"; // sidecar 已接收命令,确认 fork 成功
  } catch (e) {
    // fork 失败(主会话未就绪 / spawn 失败等):进 error 态让抽屉展示原因,不静默吞
    // ——此前是 sendBtw 里 catch 后 cleanup(),会把失败抹掉只剩一个误导性"已切回"toast
    state.value.isBusy = false;
    state.value.status = "error";
    state.value.error = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  }
}

function setOnDone(cb: (block: ActionBlock) => void) {
  onDoneCb = cb;
}

/** 「关闭」=最小化:抽屉收起,但 sidecar 继续在后台跑(不杀进程)。跑完结论照样经
 *  onDone 插进主对话,用户在主对话的批注里看到结果。真正的 teardown(杀进程+清
 *  store)是 cleanup——只在开新 btw(单实例替换)时调,最小化期间绝不调。 */
function minimize() {
  state.value.minimized = true;
}

/** 重展抽屉:最小化的逆操作。用户点了浮标想再看流式输出时调。仅清标志、不动进程。 */
function reopen() {
  state.value.minimized = false;
}

function handleBtwEvent(e: Record<string, unknown>) {
  switch (e["type"]) {
    case "session_init": {
      const sdkSid = e["sdk_session_id"] as string | undefined;
      if (sdkSid && btwTempId && sdkSid !== btwTempId) {
        btwRealId = sdkSid;
        // Runtime 内部管理 session 映射，无需 Rust 侧 rename
        // 注意:btw 不触发 onSessionCreated(不写元数据/不进侧栏)——与主对话 finalizeSession 的区别
      }
      break;
    }
    case "text_delta": {
      state.value.messages.push(e["delta"] as string);
      break;
    }
    case "message_stop": {
      state.value.isBusy = false;
      state.value.done = true;
      state.value.status = "done";
      // btw 支线也可能改了文件——同主对话，防抖增量重扫保持索引新鲜。
      useCodeGraphProgress().scheduleRescan();
      const conclusion = state.value.messages.join("");
      // 记入支线记忆（只记有结论的成功轮次；出错/空轮不记，免得污染后续 prompt）。
      // 任务支线(git-commit)不记——它是全新会话的固定任务,结论回插主对话即可,
      // 混入问答记忆只会污染后续轻量 btw 的 prompt。
      if (conclusion && state.value.ownerSessionId && !state.value.taskId) {
        const rounds = historyByOwner.get(state.value.ownerSessionId) ?? [];
        rounds.push({ question: state.value.question, answer: conclusion });
        historyByOwner.set(state.value.ownerSessionId, rounds);
      }
      if (onDoneCb && conclusion) {
        const isTask = !!state.value.taskId;
        const block: ActionBlock = {
          type: "action",
          actionId: isTask ? state.value.taskId : "btw",
          label: isTask ? state.value.taskLabel : state.value.question,
          icon: isTask ? state.value.taskIcon : "↳",
          foldable: true,
          body: conclusion,
        };
        onDoneCb(block);
      }
      break;
    }
    case "error": {
      state.value.isBusy = false;
      state.value.status = "error";
      state.value.error = e["message"] as string;
      state.value.minimized = false; // 出错必须露出来:别让最小化把错误吞掉
      break;
    }
    case "session_dead": {
      state.value.isBusy = false;
      state.value.status = "error";
      state.value.error = "支线进程已退出";
      state.value.minimized = false;
      break;
    }
  }
}

async function cleanup() {
  if (!btwTempId) return;
  const killId = btwRealId ?? btwTempId;
  try {
    await invoke("stop_chat_session", { sessionId: killId });
  } catch {
    // ignore — process may already be dead
  }
  btwTempId = null;
  btwRealId = null;
  state.value = { ...IDLE };
}

export function useBtwSession() {
  return {
    store: computed(() => state.value),
    isBtwSid,
    startBtw,
    handleBtwEvent,
    cleanup,
    minimize,
    reopen,
    setOnDone,
  };
}

export function __resetBtwForTest() {
  state.value = { ...IDLE };
  btwTempId = null;
  btwRealId = null;
  onDoneCb = null;
  historyByOwner.clear();
}
