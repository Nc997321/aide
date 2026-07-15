import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { ActionBlock } from "../types/chat";

/** btw 支线对话的轻量 store——单例:同一时间只一个 btw(v1)。
 *  status 生命周期:idle(无)→starting(已发 fork 命令)→running(sidecar 应答中)
 *  →done(结论已插入批注)/error(起不来或中途死)。UI 据此决定抽屉可见性、
 *  且只在 running 才向用户确认"已切回主对话"(失败不弹误导性成功提示)。 */
type BtwStatus = "idle" | "starting" | "running" | "error" | "done";

interface BtwState {
  messages: string[]; // 累积的 assistant 文本(纯展示)
  isBusy: boolean;
  done: boolean;
  error: string | null;
  question: string;
  status: BtwStatus;
}

const IDLE: BtwState = { messages: [], isBusy: false, done: false, error: null, question: "", status: "idle" };
const state = ref<BtwState>({ ...IDLE });
let btwTempId: string | null = null;
let btwRealId: string | null = null; // session_init 后的 fork id
let onDoneCb: ((block: ActionBlock) => void) | null = null;

function resetState(question: string) {
  state.value = { messages: [], isBusy: true, done: false, error: null, question, status: "starting" };
}

/** 预置失败(无存活主会话等前置不满足):不 spawn,直接进 error 态让抽屉展示原因。 */
function failBtw(question: string, msg: string) {
  btwTempId = null;
  btwRealId = null;
  state.value = { messages: [], isBusy: false, done: false, error: msg, question, status: "error" };
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
}

async function startBtw(opts: StartBtwOpts) {
  // 单实例:新开先清掉旧的(kill 进程、丢 store)
  if (btwTempId) await cleanup();
  btwTempId = opts.tempId;
  btwRealId = null;
  resetState(opts.prompt); // status="starting":抽屉已可见,显示问题
  try {
    await invoke("start_btw_session", {
      btwId: opts.tempId,
      forkFrom: opts.forkFrom,
      prompt: opts.prompt,
      cwd: opts.cwd,
      lightweight: opts.lightweight,
      permissionMode: opts.permissionMode ?? null,
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
          hint: "不进上下文",
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
    failBtw,
    handleBtwEvent,
    cleanup,
    setOnDone,
  };
}

export function __resetBtwForTest() {
  state.value = { ...IDLE };
  btwTempId = null;
  btwRealId = null;
  onDoneCb = null;
}
