import { computed, reactive, ref, watch, type Ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type {
  ChatMessage,
  ContextUsage,
  ModelOption,
  PermissionRequest,
  SubagentBlock,
  TaskItem,
  TextBlock,
  ToolCallBlock,
  ImageBlock,
} from "../types/chat";
import { useSessionState } from "./useSessionState";
import type { FileMentionResolution } from "../utils/fileMentions";

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
  /** 可切换的模型列表（provider 决定，纯展示字符串） */
  models: ModelOption[];
  /** 当前选中的模型 value；空串表示跟随 provider 默认 */
  currentModel: string;
  /** 本会话累计费用（美元） */
  totalCostUsd: number;
  /** 上下文窗口用量——每轮结束后由 sidecar 刷新；null 表示还没收到过 */
  contextUsage: ContextUsage | null;
  /** 当前任务清单——sidecar 每次变化后整体覆盖，不做增量合并 */
  tasks: TaskItem[];
}

// ── 模块级单例状态 ─────────────────────────────────────────────────────────
// 每会话独立 store：前台/后台事件走同一条写入路径，切换会话零拷贝。

const stores = reactive<Record<string, SessionStore>>({});
/** 模型列表是 provider/账号级别的事实，不是某个会话独有的——同一次 app
 *  运行里，任意一个会话第一次连上 SDK 学到的列表，其他还没起进程的
 *  会话/新面板都能直接借用，不用每个会话各自重新学一遍。 */
const sharedModels = ref<ModelOption[]>([]);
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
    stores[sid] = {
      messages: [],
      isBusy: false,
      pendingPermission: null,
      hydrated: false,
      models: [],
      currentModel: "",
      totalCostUsd: 0,
      contextUsage: null,
      tasks: [],
    };
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
    case "models_available": {
      store.models = e["models"] as ModelOption[];
      store.currentModel = e["current"] as string;
      sharedModels.value = store.models;
      break;
    }
    case "context_usage": {
      store.contextUsage = {
        totalTokens: e["total_tokens"] as number,
        maxTokens: e["max_tokens"] as number,
        percentage: e["percentage"] as number,
      };
      break;
    }
    case "tasks_update": {
      store.tasks = e["tasks"] as TaskItem[];
      break;
    }
    case "subagent_start": {
      const msg = getOrCreateAssistant(store);
      msg.blocks.push({
        type: "subagent",
        id: e["id"] as string,
        agentName: e["agentName"] as string,
        description: e["description"] as string,
        isPending: true,
      } as SubagentBlock);
      break;
    }
    case "subagent_end": {
      const block = store.messages
        .flatMap((m) => m.blocks)
        .find((b): b is SubagentBlock => b.type === "subagent" && (b as SubagentBlock).id === e["id"]);
      if (block) {
        block.result = e["result"] as string;
        block.isError = e["is_error"] as boolean;
        block.isPending = false;
      }
      break;
    }
    case "message_stop": {
      const totalCostUsd = e["total_cost_usd"] as number | null;
      if (totalCostUsd !== null && totalCostUsd !== undefined) {
        store.totalCostUsd = totalCostUsd;
      }
      const usage = e["usage"] as ChatMessage["usage"] | null;
      if (usage) {
        const last = store.messages[store.messages.length - 1];
        if (last?.role === "assistant") last.usage = usage;
      }
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
  sharedModels.value = [];
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
    initialModel?: string,
    mentions?: FileMentionResolution,
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

    // @path 引用展开出来的文件内容不进用户气泡的文本——渲染成独立的、类似
    // 工具调用的折叠卡片（复用 ToolCallBlock.vue 对 name:"Read" 的现有渲染），
    // 避免用户自己打的字和引用文件内容混在一个气泡里。发给模型的内容仍然
    // 完整（mentions.sendText），只是本地显示时拆开。
    const blocks: (ImageBlock | TextBlock | ToolCallBlock)[] = [
      ...(images ?? []).map((img): ImageBlock => ({
        type: "image",
        data: img.data,
        mediaType: img.mediaType,
      })),
      ...(prompt ? [{ type: "text" as const, text: prompt }] : []),
      ...(mentions?.resolved ?? []).map((m): ToolCallBlock => ({
        type: "tool_call",
        id: crypto.randomUUID(),
        name: "Read",
        input: { file_path: m.path },
        result: m.content,
        isError: false,
        isPending: false,
      })),
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
    const sendText = mentions?.sendText ?? prompt;

    invoke("send_message", {
      sessionId: finalSid,
      prompt: sendText,
      images: images?.length ? images : null,
      resumeId: resolvedResumeId ?? null,
      // 只在这个 sidecar 进程还没起来时（第一条消息）有意义，Rust 侧只在
      // spawn 分支用它覆盖 provider 默认模型；之后切模型走 setModel()。
      initialModel: initialModel || null,
    }).catch((e) => {
      console.warn("send_message failed:", e);
      const s = getStore(resolveSid(finalSid));
      s.isBusy = false;
      setSessionState(resolveSid(finalSid), "stopped");
    });

    return sid;
  }

  async function respondPermission(id: string, approved: boolean, always?: boolean) {
    const sid = sessionId.value;
    if (!sid) return;
    const store = getStore(sid);
    store.pendingPermission = null;
    setSessionState(sid, "running");
    await invoke("permission_response", { sessionId: sid, id, approved, always });
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

  /** 切换模型只影响下一条消息，SDK 原生保证；不做本地乐观更新，
   *  显示状态靠 sidecar 主动回发的 models_available 事件同步。 */
  async function setModel(model: string) {
    const sid = sessionId.value;
    if (!sid) return;
    await invoke("set_model", { sessionId: sid, model });
  }

  return {
    messages: computed(() => current.value?.messages ?? []),
    isBusy: computed(() => current.value?.isBusy ?? false),
    pendingPermission: computed(() => current.value?.pendingPermission ?? null),
    // 这个会话自己学到的列表优先；还没连上真实 SDK 时借用别的会话学到的缓存。
    models: computed(() => {
      const own = current.value?.models;
      return own?.length ? own : sharedModels.value;
    }),
    currentModel: computed(() => current.value?.currentModel ?? ""),
    totalCostUsd: computed(() => current.value?.totalCostUsd ?? 0),
    contextUsage: computed(() => current.value?.contextUsage ?? null),
    tasks: computed(() => current.value?.tasks ?? []),
    sendMessage,
    respondPermission,
    interrupt,
    stopSession,
    onSessionCreated,
    setModel,
  };
}
