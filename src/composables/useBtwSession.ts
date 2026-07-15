import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { ActionBlock } from "../types/chat";

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
  minimized: boolean; // 用户点了「关闭」=最小化:抽屉收起,但 sidecar 继续后台跑,
  // 跑完结论照样经 onDone 插进主对话。最小化不杀进程;真正的 teardown 是 cleanup。
}

const IDLE: BtwState = { messages: [], isBusy: false, done: false, error: null, question: "", status: "idle", ownerSessionId: null, model: "", minimized: false };
const state = ref<BtwState>({ ...IDLE });
let btwTempId: string | null = null;
let btwRealId: string | null = null; // session_init 后的 fork id
let onDoneCb: ((block: ActionBlock) => void) | null = null;

function resetState(question: string) {
  // 新支线:show drawer(最小化标志清掉),starting 态。ownerSessionId/model 由 startBtw 补。
  state.value = { messages: [], isBusy: true, done: false, error: null, question, status: "starting", ownerSessionId: null, model: "", minimized: false };
}

/** useChatSession.handleChatEvent 调:判断事件是否属于当前 btw。 */
function isBtwSid(raw: string): boolean {
  return !!btwTempId && (raw === btwTempId || (btwRealId !== null && raw === btwRealId));
}

interface StartBtwOpts {
  tempId: string;
  forkFrom: string;
  prompt: string;
  cwd: string;
  lightweight: boolean;
  permissionMode?: string;
  model?: string;
}

async function startBtw(opts: StartBtwOpts) {
  // 单实例:新开先清掉旧的(kill 进程、丢 store)
  if (btwTempId) await cleanup();
  btwTempId = opts.tempId;
  btwRealId = null;
  resetState(opts.prompt); // status="starting":抽屉已可见,显示问题
  state.value.ownerSessionId = opts.forkFrom; // 抽屉只绑回这个主会话所在窗口
  state.value.model = opts.model ?? ""; // 抽屉展示这条支线用的模型
  try {
    await invoke("start_btw_session", {
      btwId: opts.tempId,
      forkFrom: opts.forkFrom,
      prompt: opts.prompt,
      cwd: opts.cwd,
      lightweight: opts.lightweight,
      permissionMode: opts.permissionMode ?? null,
      model: opts.model ?? null,
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
        // Rust 侧 rename 注册表:之后事件携带 fork id(内存态,无 IO)
        invoke("rename_sidecar_session", { oldId: btwTempId, newId: sdkSid }).catch(() => {});
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
      const conclusion = state.value.messages.join("");
      if (onDoneCb && conclusion) {
        const block: ActionBlock = {
          type: "action",
          actionId: "btw",
          label: state.value.question,
          icon: "↳",
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
      break;
    }
    case "session_dead": {
      state.value.isBusy = false;
      state.value.status = "error";
      state.value.error = "支线进程已退出";
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
}
