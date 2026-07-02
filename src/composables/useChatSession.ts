import { computed, reactive, watch, type Ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type {
  ChatMessage,
  PermissionRequest,
  TextBlock,
  ToolCallBlock,
  ImageBlock,
} from "../types/chat";
import { useSessionState } from "./useSessionState";

export interface ImageAttachment {
  data: string;
  mediaType: string;
}

interface SessionStore {
  messages: ChatMessage[];
  isBusy: boolean;
  pendingPermission: PermissionRequest | null;
  /** 是否已从磁盘加载过历史 */
  hydrated: boolean;
}

// ── 模块级单例状态 ─────────────────────────────────────────────────────────
// 每会话独立 store：前台/后台事件走同一条写入路径，切换会话零拷贝。

const stores = reactive<Record<string, SessionStore>>({});
/** 迁移窗口期：旧 key → 新 id（Rust rename 完成前的在途事件转发） */
const aliasMap = new Map<string, string>();
/** 尚未被 SDK 确认的临时 key（纯内存，从未落盘）。resume 判定与 hydrate 跳过都靠它。 */
const pendingSids = new Set<string>();
/** 会话首次创建回调（App.vue 注册：写元数据、加入侧栏、记入最近访问） */
const sessionCreatedCallbacks = new Set<(tempId: string, realId: string) => void>();

let globalUnlisten: (() => void) | null = null;

const { setSessionState, removeSessionState, state: sessionState } = useSessionState();

function getStore(sid: string): SessionStore {
  if (!stores[sid]) {
    stores[sid] = { messages: [], isBusy: false, pendingPermission: null, hydrated: false };
  }
  return stores[sid];
}

function resolveSid(raw: string): string {
  return aliasMap.get(raw) ?? raw;
}

/** 尚未被 SDK 确认的临时 key：没有磁盘落地，resume/hydrate 都要跳过。 */
export function isPendingSession(sid: string | null | undefined): boolean {
  return !!sid && pendingSids.has(sid);
}

/** 取续写目标：最后一条消息是流式 assistant 就续写，否则新建 */
function getOrCreateAssistant(store: SessionStore): ChatMessage {
  const last = store.messages[store.messages.length - 1];
  if (last && last.role === "assistant" && last.streaming) return last;
  const msg: ChatMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    blocks: [],
    timestamp: Date.now(),
    streaming: true,
  };
  store.messages.push(msg);
  return msg;
}

function finishStreaming(store: SessionStore) {
  const last = store.messages[store.messages.length - 1];
  if (last?.streaming) last.streaming = false;
}

/** 临时 key 首次被 SDK 确认为真实 session id：原地搬迁运行时状态，
 *  再交给 App.vue 去做真正的"创建"（写元数据 / 加侧栏 / 记最近访问）。
 *  临时 key 从未落盘，这里不需要触碰任何文件。 */
async function finalizeSession(tempId: string, realId: string) {
  // 1. 前端立即换 key + 建 alias，兜住 Rust rename 完成前的在途事件
  aliasMap.set(tempId, realId);
  pendingSids.delete(tempId);
  if (stores[tempId]) {
    stores[realId] = stores[tempId];
    delete stores[tempId];
  }
  if (sessionState[tempId]) {
    setSessionState(realId, sessionState[tempId]);
    removeSessionState(tempId);
  }
  // 2. Rust 侧只需要重命名 sidecar 进程注册表（内存态，无 IO）
  try {
    await invoke("rename_sidecar_session", { oldId: tempId, newId: realId });
  } catch (e) {
    console.warn("rename_sidecar_session failed:", e);
  }
  // 3. 通知 App.vue：这是第一次创建，去写元数据、加侧栏、记最近访问
  for (const cb of sessionCreatedCallbacks) cb(tempId, realId);
}

function handleChatEvent(e: Record<string, unknown>) {
  const raw = e["session_id"] as string | undefined;
  if (!raw) return;
  const sid = resolveSid(raw);
  const store = getStore(sid);

  switch (e["type"]) {
    case "session_init": {
      const sdkSid = e["sdk_session_id"] as string | undefined;
      if (sdkSid && isPendingSession(sid) && sdkSid !== sid) {
        void finalizeSession(sid, sdkSid);
      }
      setSessionState(sid, "running");
      break;
    }
    case "text_delta": {
      const msg = getOrCreateAssistant(store);
      const last = msg.blocks[msg.blocks.length - 1];
      if (last?.type === "text") {
        (last as TextBlock).text += e["delta"] as string;
      } else {
        msg.blocks.push({ type: "text", text: e["delta"] as string });
      }
      break;
    }
    case "tool_use_start": {
      const msg = getOrCreateAssistant(store);
      msg.blocks.push({
        type: "tool_call",
        id: e["id"] as string,
        name: e["name"] as string,
        input: e["input"],
        isPending: true,
      } as ToolCallBlock);
      break;
    }
    case "tool_result": {
      const block = store.messages
        .flatMap((m) => m.blocks)
        .find(
          (b): b is ToolCallBlock =>
            b.type === "tool_call" && (b as ToolCallBlock).id === e["id"],
        );
      if (block) {
        block.result = e["content"] as string;
        block.isError = e["is_error"] as boolean;
        block.isPending = false;
      }
      break;
    }
    case "permission_request": {
      store.pendingPermission = {
        id: e["id"] as string,
        name: e["name"] as string,
        input: e["input"],
      };
      setSessionState(sid, "attention");
      break;
    }
    case "permission_cancelled": {
      if (store.pendingPermission?.id === e["id"]) {
        store.pendingPermission = null;
      }
      break;
    }
    case "message_stop": {
      finishStreaming(store);
      store.isBusy = false;
      // waiting = sidecar 存活但空闲 → 通知/横幅/变更捕获依赖 running→waiting 转换
      setSessionState(sid, "waiting");
      break;
    }
    case "error": {
      finishStreaming(store);
      store.isBusy = false;
      store.pendingPermission = null;
      store.messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        blocks: [{ type: "text", text: `Error: ${e["message"]}` }],
        timestamp: Date.now(),
      });
      setSessionState(sid, "stopped");
      break;
    }
  }
}

async function ensureGlobalListener() {
  if (globalUnlisten) return;
  globalUnlisten = await listen<Record<string, unknown>>("chat-event", (event) => {
    handleChatEvent(event.payload);
  });
}

async function hydrate(sid: string) {
  const store = getStore(sid);
  if (store.hydrated || store.messages.length > 0 || isPendingSession(sid)) {
    store.hydrated = true;
    return;
  }
  store.hydrated = true;
  try {
    const items = await invoke<Array<{ role: string; content: string; timestamp: number }>>(
      "load_messages",
      { sessionId: sid },
    );
    if (!Array.isArray(items)) return;
    // hydrate 期间可能已有实时消息进来：历史插到最前
    const history: ChatMessage[] = items.map((item) => ({
      id: crypto.randomUUID(),
      role: (item.role === "claude" ? "assistant" : item.role) as "user" | "assistant",
      blocks: [{ type: "text" as const, text: item.content }],
      timestamp: item.timestamp,
    }));
    store.messages.unshift(...history);
  } catch (e) {
    console.warn("Failed to load messages:", e);
  }
}

/** 仅测试用：清空模块级状态 */
export function __resetForTest() {
  for (const k of Object.keys(stores)) delete stores[k];
  pendingSids.clear();
  aliasMap.clear();
  sessionCreatedCallbacks.clear();
  globalUnlisten?.();
  globalUnlisten = null;
}

// ── useChatSession（App.vue 顶层单例调用）───────────────────────────────────

export function useChatSession(sessionId: Ref<string | null>) {
  void ensureGlobalListener();

  const current = computed(() => (sessionId.value ? getStore(sessionId.value) : null));

  watch(
    sessionId,
    (sid) => {
      if (sid) void hydrate(sid);
    },
    { immediate: true },
  );

  /**
   * 发消息。若当前没有 session id（"新建会话"打开的空白面板），现场生成一个
   * 纯内存临时 key 并返回给调用方——App.vue 用它更新 activeSessionId。真正的
   * "创建会话"（写元数据 / 加侧栏 / 记最近访问）推迟到 SDK 用 session_init 确认
   * 真实 id 之后才发生，见 finalizeSession。
   *
   * invoke("send_message") 不在这里 await 到底：新会话要等 Rust 侧现拉起 Node
   * 子进程，等它返回才把 sid 交给调用方会让首条消息在 UI 上有明显卡顿。这里只
   * await 到本地状态就绪，IPC 调用后台完成，失败走 .catch 兜底。
   */
  async function sendMessage(
    prompt: string,
    images?: ImageAttachment[],
    resumeId?: string,
  ): Promise<string | undefined> {
    let sid = sessionId.value;
    if (!sid) {
      sid = crypto.randomUUID();
      pendingSids.add(sid);
    }
    await ensureGlobalListener();

    const store = getStore(sid);
    store.isBusy = true;
    setSessionState(sid, "running");

    const blocks: (ImageBlock | TextBlock)[] = [
      ...(images ?? []).map((img): ImageBlock => ({
        type: "image",
        data: img.data,
        mediaType: img.mediaType,
      })),
      ...(prompt ? [{ type: "text" as const, text: prompt }] : []),
    ];
    finishStreaming(store); // 上一条 assistant 不再续写
    store.messages.push({
      id: crypto.randomUUID(),
      role: "user",
      blocks,
      timestamp: Date.now(),
    });

    // resume：显式传入 > 已被 SDK 确认的 id 本身（aide id 就是 sdk id，无需查表）
    const resolvedResumeId = resumeId ?? (isPendingSession(sid) ? undefined : sid);
    const finalSid = sid;

    invoke("send_message", {
      sessionId: finalSid,
      prompt,
      images: images?.length ? images : null,
      resumeId: resolvedResumeId ?? null,
    }).catch((e) => {
      console.warn("send_message failed:", e);
      const s = getStore(resolveSid(finalSid));
      s.isBusy = false;
      setSessionState(resolveSid(finalSid), "stopped");
    });

    return sid;
  }

  async function respondPermission(id: string, approved: boolean) {
    const sid = sessionId.value;
    if (!sid) return;
    const store = getStore(sid);
    store.pendingPermission = null;
    setSessionState(sid, "running");
    await invoke("permission_response", { sessionId: sid, id, approved });
  }

  async function interrupt() {
    const sid = sessionId.value;
    if (!sid) return;
    const store = getStore(sid);
    try {
      await invoke("interrupt_session", { sessionId: sid });
    } finally {
      store.isBusy = false;
      store.pendingPermission = null;
      finishStreaming(store);
      setSessionState(sid, "waiting"); // sidecar 仍存活
    }
  }

  async function stopSession() {
    const sid = sessionId.value;
    if (!sid) return;
    const store = getStore(sid);
    try {
      await invoke("stop_chat_session", { sessionId: sid });
    } finally {
      store.isBusy = false;
      store.pendingPermission = null;
      finishStreaming(store);
      setSessionState(sid, "stopped");
    }
  }

  function onSessionCreated(cb: (tempId: string, realId: string) => void) {
    sessionCreatedCallbacks.add(cb);
  }

  return {
    messages: computed(() => current.value?.messages ?? []),
    isBusy: computed(() => current.value?.isBusy ?? false),
    pendingPermission: computed(() => current.value?.pendingPermission ?? null),
    sendMessage,
    respondPermission,
    interrupt,
    stopSession,
    onSessionCreated,
  };
}
