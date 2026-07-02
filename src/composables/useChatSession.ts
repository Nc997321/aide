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
/** aide_session_id → sdk_session_id（会话续接） */
const sdkSessionMap = new Map<string, string>();
/** 迁移窗口期：旧 ID → 新 ID（Rust rename 完成前的在途事件转发） */
const aliasMap = new Map<string, string>();
/** 迁移回调（App.vue 注册，更新侧栏与 activeSessionId） */
const migrationCallbacks = new Set<(oldId: string, newId: string) => void>();

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

function isDraftId(sid: string): boolean {
  return sid.startsWith("new_");
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

async function migrateStore(oldId: string, newId: string) {
  // 1. 前端立即换 key + 建 alias，兜住 Rust rename 完成前的在途事件
  aliasMap.set(oldId, newId);
  if (stores[oldId]) {
    stores[newId] = stores[oldId];
    delete stores[oldId];
  }
  if (sessionState[oldId]) {
    setSessionState(newId, sessionState[oldId]);
    removeSessionState(oldId);
  }
  const sdk = sdkSessionMap.get(oldId);
  if (sdk) {
    sdkSessionMap.set(newId, sdk);
    sdkSessionMap.delete(oldId);
  }
  // 2. Rust 侧迁移（sidecar 注册表 / 名字元数据 / 变更记录 / 最近访问）
  try {
    await invoke("migrate_session", { oldId, newId });
  } catch (e) {
    console.warn("migrate_session failed:", e);
  }
  // 3. 通知 App.vue 更新侧栏与 activeSessionId
  for (const cb of migrationCallbacks) cb(oldId, newId);
}

function handleChatEvent(e: Record<string, unknown>) {
  const raw = e["session_id"] as string | undefined;
  if (!raw) return;
  const sid = resolveSid(raw);
  const store = getStore(sid);

  switch (e["type"]) {
    case "session_init": {
      const sdkSid = e["sdk_session_id"] as string | undefined;
      if (sdkSid) {
        sdkSessionMap.set(sid, sdkSid);
        if (isDraftId(sid) && sdkSid !== sid) {
          void migrateStore(sid, sdkSid);
        }
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
  if (store.hydrated || store.messages.length > 0 || isDraftId(sid)) {
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
  sdkSessionMap.clear();
  aliasMap.clear();
  migrationCallbacks.clear();
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

  async function sendMessage(
    prompt: string,
    images?: ImageAttachment[],
    resumeId?: string,
  ) {
    const sid = sessionId.value;
    if (!sid) return;
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

    // resume 解析：显式传入 > 运行期映射 > 历史会话用自身 ID（重启后续接的关键）
    const resolvedResumeId =
      resumeId ?? sdkSessionMap.get(sid) ?? (isDraftId(sid) ? undefined : sid);

    await invoke("send_message", {
      sessionId: sid,
      prompt,
      images: images?.length ? images : null,
      resumeId: resolvedResumeId ?? null,
    });
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

  function onSessionMigrated(cb: (oldId: string, newId: string) => void) {
    migrationCallbacks.add(cb);
  }

  return {
    messages: computed(() => current.value?.messages ?? []),
    isBusy: computed(() => current.value?.isBusy ?? false),
    pendingPermission: computed(() => current.value?.pendingPermission ?? null),
    sendMessage,
    respondPermission,
    interrupt,
    stopSession,
    onSessionMigrated,
  };
}
