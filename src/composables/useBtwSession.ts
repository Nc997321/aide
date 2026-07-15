import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { ActionBlock } from "../types/chat";

/** btw 支线对话的轻量 store——单例:同一时间只一个 btw(v1)。 */
interface BtwState {
  messages: string[]; // 累积的 assistant 文本(纯展示)
  isBusy: boolean;
  done: boolean;
  error: string | null;
  question: string;
}

const state = ref<BtwState>({ messages: [], isBusy: false, done: false, error: null, question: "" });
let btwTempId: string | null = null;
let btwRealId: string | null = null; // session_init 后的 fork id
let onDoneCb: ((block: ActionBlock) => void) | null = null;

function resetState(question: string) {
  state.value = { messages: [], isBusy: true, done: false, error: null, question };
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
  resetState(opts.prompt);
  await invoke("start_btw_session", {
    btwId: opts.tempId,
    forkFrom: opts.forkFrom,
    prompt: opts.prompt,
    cwd: opts.cwd,
    lightweight: opts.lightweight,
    permissionMode: opts.permissionMode ?? null,
  });
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
      state.value.error = e["message"] as string;
      break;
    }
    case "session_dead": {
      state.value.isBusy = false;
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
}

export function useBtwSession() {
  return {
    store: computed(() => state.value),
    isBtwSid,
    startBtw,
    handleBtwEvent,
    cleanup,
    setOnDone,
  };
}

export function __resetBtwForTest() {
  state.value = { messages: [], isBusy: false, done: false, error: null, question: "" };
  btwTempId = null;
  btwRealId = null;
  onDoneCb = null;
}
