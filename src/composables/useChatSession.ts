import { ref, computed, watch, type Ref } from "vue";
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

// ── 模块级单例 ─────────────────────────────────────────────────────────────

// aide_session_id → sdk_session_id（用于会话续接）
const sdkSessionMap = new Map<string, string>();

// 每个会话的消息历史缓存（内存级，重启清空）
const sessionMessageCache = new Map<string, ChatMessage[]>();

// 每个运行中会话的事件处理器（模块级，不绑定到任何组件实例）
type SessionHandlers = {
  onEvent: (e: Record<string, unknown>) => void;
};
const sessionHandlers = new Map<string, SessionHandlers>();

// 全局 chat-event 监听器（只注册一次）
let globalUnlisten: (() => void) | null = null;

async function ensureGlobalListener() {
  if (globalUnlisten) return;
  globalUnlisten = await listen<Record<string, unknown>>("chat-event", (event) => {
    const e = event.payload;
    const sid = e["session_id"] as string | undefined;
    if (!sid) return;
    sessionHandlers.get(sid)?.onEvent(e);
  });
}

const { setSessionState } = useSessionState();

function deepCopyMessages(msgs: ChatMessage[]): ChatMessage[] {
  return msgs.map((msg) => ({
    ...msg,
    blocks: msg.blocks.map((b) => ({ ...b })),
  }));
}

// ── useChatSession（单例调用，在 App.vue 顶层使用）─────────────────────────

export function useChatSession(sessionId: Ref<string | null>) {
  const messages = ref<ChatMessage[]>([]);
  const isBusy = ref(false);
  const pendingPermission = ref<PermissionRequest | null>(null);
  let currentAssistantMsg: ChatMessage | null = null;

  function getOrCreateAssistant(): ChatMessage {
    if (
      !currentAssistantMsg ||
      messages.value[messages.value.length - 1] !== currentAssistantMsg
    ) {
      currentAssistantMsg = {
        id: crypto.randomUUID(),
        role: "assistant",
        blocks: [],
        timestamp: Date.now(),
      };
      messages.value.push(currentAssistantMsg);
    }
    return currentAssistantMsg;
  }

  function saveToCache(sid: string) {
    if (messages.value.length > 0) {
      sessionMessageCache.set(sid, deepCopyMessages(messages.value));
    }
  }

  async function loadFromCache(sid: string) {
    let cached = sessionMessageCache.get(sid);
    if (!cached) {
      try {
        const items = await invoke<Array<{ role: string; content: string; timestamp: number }>>(
          "load_messages", { sessionId: sid }
        );
        if (sessionId.value !== sid) return;
        cached = items.map((item) => ({
          id: crypto.randomUUID(),
          role: (item.role === "claude" ? "assistant" : item.role) as "user" | "assistant",
          blocks: [{ type: "text" as const, text: item.content }],
          timestamp: item.timestamp,
        }));
        sessionMessageCache.set(sid, cached);
      } catch (e) {
        console.warn("Failed to load messages:", e);
        if (sessionId.value !== sid) return;
        cached = [];
      }
    }
    if (sessionId.value !== sid) return;
    messages.value = deepCopyMessages(cached);
    isBusy.value = false;
    pendingPermission.value = null;
    currentAssistantMsg = null;
  }

  function registerHandlers(sid: string) {
    sessionHandlers.set(sid, {
      onEvent(e) {
        switch (e["type"]) {
          case "session_init": {
            const sdkSid = e["sdk_session_id"] as string | undefined;
            if (sdkSid) sdkSessionMap.set(sid, sdkSid);
            setSessionState(sid, "running");
            break;
          }
          case "text_delta": {
            // 只有当前展示的会话才实时更新 messages ref
            if (sessionId.value === sid) {
              const msg = getOrCreateAssistant();
              const last = msg.blocks[msg.blocks.length - 1];
              if (last?.type === "text") {
                (last as TextBlock).text += e["delta"] as string;
              } else {
                msg.blocks.push({ type: "text", text: e["delta"] as string });
              }
            } else {
              // 后台会话：直接追加到缓存
              const cached = sessionMessageCache.get(sid);
              if (cached) {
                const last = cached[cached.length - 1];
                if (last?.role === "assistant") {
                  const lastBlock = last.blocks[last.blocks.length - 1];
                  if (lastBlock?.type === "text") {
                    (lastBlock as TextBlock).text += e["delta"] as string;
                  } else {
                    last.blocks.push({ type: "text", text: e["delta"] as string });
                  }
                }
              }
            }
            break;
          }
          case "tool_use_start": {
            if (sessionId.value === sid) {
              const msg = getOrCreateAssistant();
              msg.blocks.push({
                type: "tool_call",
                id: e["id"] as string,
                name: e["name"] as string,
                input: e["input"],
                isPending: true,
              } as ToolCallBlock);
            }
            break;
          }
          case "tool_result": {
            if (sessionId.value === sid) {
              const block = messages.value
                .flatMap((m) => m.blocks)
                .find((b): b is ToolCallBlock =>
                  b.type === "tool_call" && (b as ToolCallBlock).id === e["id"]
                );
              if (block) {
                block.result = e["content"] as string;
                block.isError = e["is_error"] as boolean;
                block.isPending = false;
              }
            }
            break;
          }
          case "permission_request": {
            if (sessionId.value === sid) {
              pendingPermission.value = {
                id: e["id"] as string,
                name: e["name"] as string,
                input: e["input"],
              };
            }
            setSessionState(sid, "attention");
            break;
          }
          case "message_stop": {
            if (sessionId.value === sid) {
              currentAssistantMsg = null;
              isBusy.value = false;
            }
            setSessionState(sid, "stopped");
            saveToCache(sid);
            sessionHandlers.delete(sid);
            break;
          }
          case "error": {
            if (sessionId.value === sid) {
              currentAssistantMsg = null;
              isBusy.value = false;
              messages.value.push({
                id: crypto.randomUUID(),
                role: "assistant",
                blocks: [{ type: "text", text: `Error: ${e["message"]}` }],
                timestamp: Date.now(),
              });
            }
            setSessionState(sid, "stopped");
            saveToCache(sid);
            sessionHandlers.delete(sid);
            break;
          }
        }
      },
    });
  }

  // 切换会话时保存旧历史、加载新历史
  watch(sessionId, async (newSid, oldSid) => {
    if (oldSid) saveToCache(oldSid);
    if (newSid) {
      await loadFromCache(newSid);
      // 如果该会话仍在运行（有处理器），同步 isBusy
      if (sessionHandlers.has(newSid)) {
        isBusy.value = true;
      }
    } else {
      messages.value = [];
      isBusy.value = false;
      pendingPermission.value = null;
      currentAssistantMsg = null;
    }
  }, { immediate: true });

  async function sendMessage(
    prompt: string,
    images?: ImageAttachment[],
    resumeId?: string,
  ) {
    const sid = sessionId.value;
    if (!sid) return;

    await ensureGlobalListener();

    isBusy.value = true;
    setSessionState(sid, "running");

    // 构建消息历史块（图片在前，文字在后）
    const blocks: (ImageBlock | TextBlock)[] = [
      ...(images ?? []).map((img): ImageBlock => ({
        type: "image",
        data: img.data,
        mediaType: img.mediaType,
      })),
      ...(prompt ? [{ type: "text" as const, text: prompt }] : []),
    ];
    messages.value.push({
      id: crypto.randomUUID(),
      role: "user",
      blocks,
      timestamp: Date.now(),
    });
    currentAssistantMsg = null;

    registerHandlers(sid);
    const resolvedResumeId = resumeId ?? sdkSessionMap.get(sid);
    await invoke("send_message", {
      sessionId: sid,
      prompt,
      images: images?.length ? images : null,
      resumeId: resolvedResumeId,
    });
  }

  async function respondPermission(id: string, approved: boolean) {
    const sid = sessionId.value;
    if (!sid) return;
    pendingPermission.value = null;
    setSessionState(sid, "running");
    await invoke("permission_response", { sessionId: sid, id, approved });
  }

  async function interrupt() {
    const sid = sessionId.value;
    if (!sid) return;
    isBusy.value = false;
    currentAssistantMsg = null;
    setSessionState(sid, "stopped");
    sessionHandlers.delete(sid);
    await invoke("interrupt_session", { sessionId: sid });
  }

  return {
    messages: computed(() => messages.value),
    isBusy,
    pendingPermission,
    sendMessage,
    respondPermission,
    interrupt,
  };
}
