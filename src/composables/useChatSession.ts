import { computed, reactive, ref, watch, type Ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type {
  ChatMessage,
  ContextUsage,
  ModelOption,
  ModelSwitchResult,
  PermissionModeOption,
  PermissionRequest,
  RateLimitInfo,
  SubagentBlock,
  SubagentEntry,
  TaskItem,
  TextBlock,
  ToolCallBlock,
  ImageBlock,
  ActionBlock,
} from "../types/chat";
import { useSessionState } from "./useSessionState";
import { useSessionWorkspaces } from "./useSessionWorkspaces";
import { useSessionProviders } from "./useSessionProviders";
import { useProviders } from "./useProviders";
import { splitMentionSections, type FileMentionResolution } from "../utils/fileMentions";
import type { HistoryBlock } from "../types";
import { useBtwSession } from "./useBtwSession";

export interface ImageAttachment {
  data: string;
  mediaType: string;
}

/** 一次发送的完整负载——sendMessage 直发与忙碌排队共用同一形状。 */
export interface SendOptions {
  images?: ImageAttachment[];
  resumeId?: string;
  initialModel?: string;
  mentions?: FileMentionResolution;
  /** 当前选中的权限模式（不透明字符串，sidecar 解释语义），随每条消息透传 */
  permissionMode?: string;
  /** 忙碌时置真=插队：不会立刻打断当前这一轮——sidecar 会等到安全边界（当前
   *  正在执行的工具调用跑完，没有工具在跑就是立刻）才真正 interrupt，本轮已
   *  产出的内容不会被丢弃，只是"抢在这轮结束之后、其余排队消息之前"发出；
   *  缺省/假=普通排队，跟其余排队消息一样等这轮自然结束后合并续发。 */
  jumpQueue?: boolean;
  /** 工具栏快捷操作（压缩/清空上下文）：存在时用户气泡渲染成动作胶囊（见
   *  ActionBlock），而发给 sidecar 的 prompt 仍是 opts 对应的斜杠命令——显示
   *  与命令解耦。 */
  action?: { id: string; label: string; icon?: string };
}

interface QueuedSend {
  prompt: string;
  images?: ImageAttachment[];
  mentions?: FileMentionResolution;
  permissionMode?: string;
  action?: { id: string; label: string; icon?: string };
}

interface SessionStore {
  messages: ChatMessage[];
  isBusy: boolean;
  /** 挂起的权限请求队列（FIFO，弹窗永远显示队头）。必须是队列而不是单槽：
   *  模型并行调用多个工具时，sidecar 的 canUseTool 会被并发调用、同时发来
   *  多条 permission_request——单槽覆盖会让先到的请求永远失去 UI 载体，
   *  sidecar 侧对应的 Promise 永不 resolve，整轮卡死（并行 Read 卡死事故）。 */
  pendingPermissions: PermissionRequest[];
  /** 是否已从磁盘加载过历史 */
  hydrated: boolean;
  /** 可切换的模型列表（provider 决定，纯展示字符串） */
  models: ModelOption[];
  /** 当前选中的模型 value；空串表示跟随 provider 默认 */
  currentModel: string;
  /** 最近一次模型切换的坐实回执（sidecar model_switch_result）；null 表示
   *  本会话还没切过。seq 单调递增，连续相同结果也能触发 watcher。 */
  modelSwitchResult: ModelSwitchResult | null;
  /** 上下文窗口用量——每轮结束后由 sidecar 刷新；null 表示还没收到过 */
  contextUsage: ContextUsage | null;
  /** 当前任务清单——sidecar 每次变化后整体覆盖，不做增量合并 */
  tasks: TaskItem[];
  /** 可切换的权限模式列表（sidecar 广播，纯展示字符串） */
  permissionModes: PermissionModeOption[];
  /** 当前生效的权限模式 value；空串表示还没从 sidecar 学到 */
  currentPermissionMode: string;
  /** SDK 权威 slash commands 清单；null 表示本会话还没收到过（会话未开始，
   *  或 provider 不支持该概念）。一旦非 null，下拉框数据源单向切换，不回退。 */
  slashCommands: string[] | null;
  /** 忙碌时排队的待发消息——message_stop 后按序自动续发 */
  queued: QueuedSend[];
}

// ── 模块级单例状态 ─────────────────────────────────────────────────────────
// 每会话独立 store：前台/后台事件走同一条写入路径，切换会话零拷贝。

const stores = reactive<Record<string, SessionStore>>({});
/** 模型列表是 provider/账号级别的事实，不是某个会话独有的——同一次 app
 *  运行里，任意一个会话第一次连上 SDK 学到的列表，其他还没起进程的
 *  会话/新面板都能直接借用，不用每个会话各自重新学一遍。 */
const sharedModels = ref<ModelOption[]>([]);
/** 权限模式清单同理是 sidecar 实现级别的事实，跨会话共享。 */
const sharedPermissionModes = ref<PermissionModeOption[]>([]);
/** 订阅额度/速率是账号级别的事实，跨会话共享——任意会话收到的最新一条即当前状态。
 *  null 表示还没收到过（非订阅计费或 provider 不报配额时永远为 null，UI 隐藏）。 */
const sharedRateLimit = ref<RateLimitInfo | null>(null);
/** 迁移窗口期：旧 key → 新 id（Rust rename 完成前的在途事件转发） */
const aliasMap = new Map<string, string>();
/** 尚未被 SDK 确认的临时 key（纯内存，从未落盘）。resume 判定与 hydrate 跳过都靠它。 */
const pendingSids = new Set<string>();
/** 每会话最近一次派发的用户提问文本——变更面板给轮次做标题用（见
 *  useConversationChanges.captureChanges）。只读快照，纯展示。 */
const lastDispatchedPrompt: Record<string, string> = {};

/** 取某会话最近派发的用户提问（无则空串）。 */
export function getLastDispatchedPrompt(sid: string): string {
  return lastDispatchedPrompt[sid] ?? "";
}
/** 会话首次创建回调（App.vue 注册：写元数据、加入侧栏、记入最近访问） */
const sessionCreatedCallbacks = new Set<(tempId: string, realId: string) => void>();

let globalUnlisten: (() => void) | null = null;
/** 注册中/已注册的监听 promise——防重入必须存 promise 而不是存结果：
 *  多个 useChatSession 实例（App.vue + 各分屏组）同一 tick 并发调用时，
 *  只判 globalUnlisten 会在首个 await listen() 完成前全部穿过空检查，
 *  重复注册监听器 → 每条流式事件被处理多遍（消息内容成对重复事故）。 */
let listenerPromise: Promise<() => void> | null = null;

const {
  setSessionState,
  setSessionHealth,
  removeSessionState,
  armStalled,
  state: sessionState,
  health: sessionHealth,
} = useSessionState();

// 会话 → spawn 时 provider 绑定：存活会话锁定初始 provider，全局切换不影响它；
// stop_session 清绑定，下次发消息才用新 provider。见 useSessionProviders 注释。
const { setProvider, clearProvider, migrateProvider } = useSessionProviders();
// 当前全局 active provider id——仅用于在 spawn 前（会话不存活时）给新会话盖戳。
const { activeProviderId } = useProviders();

function getStore(sid: string): SessionStore {
  if (!stores[sid]) {
    stores[sid] = {
      messages: [],
      isBusy: false,
      pendingPermissions: [],
      hydrated: false,
      models: [],
      currentModel: "",
      modelSwitchResult: null,
      contextUsage: null,
      tasks: [],
      permissionModes: [],
      currentPermissionMode: "",
      slashCommands: null,
      queued: [],
    };
  }
  return stores[sid];
}

function resolveSid(raw: string): string {
  return aliasMap.get(raw) ?? raw;
}

/**
 * 把忙碌期间攒下的多条排队消息合并成一次派发——本轮指令结束后作为「同一轮对话」
 * 一次性交给模型，而不是一条条各起一轮（后者慢且把一段连续意图割裂成多次问答）。
 *
 * - prompt（用户气泡显示原文）与 sendText（发给模型，已含 @文件展开内容）分别按
 *   空行拼接，各自保持自己那条的展开结果。
 * - resolved（@文件折叠卡片）、images 直接顺序合并。
 * - permissionMode 取最后一条里显式带的（最近一次选择优先）。
 */
function mergeQueued(items: QueuedSend[]): QueuedSend {
  if (items.length === 1) return items[0];
  const SEP = "\n\n";
  const prompt = items.map((i) => i.prompt).filter((t) => t).join(SEP);
  const sendText = items.map((i) => i.mentions?.sendText ?? i.prompt).filter((t) => t).join(SEP);
  const resolved = items.flatMap((i) => i.mentions?.resolved ?? []);
  const images = items.flatMap((i) => i.images ?? []);
  const permissionMode = [...items].reverse().find((i) => i.permissionMode)?.permissionMode;
  return {
    prompt,
    images: images.length ? images : undefined,
    mentions: { sendText, resolved },
    permissionMode,
  };
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

/** 把 sidecar 盖在块事件上的真实模型（wire id + 展示建议）盖到消息上——
 *  一轮多个块事件只有首个带（后续不带），已盖过就不再覆盖。 */
function stampMessageModel(msg: ChatMessage, e: Record<string, unknown>) {
  if (msg.model || !e["model"]) return;
  msg.model = e["model"] as string;
  msg.modelLabel = (e["modelLabel"] as string) || (e["model"] as string);
}

function finishStreaming(store: SessionStore) {
  const last = store.messages[store.messages.length - 1];
  if (last?.streaming) last.streaming = false;
}

/** 会话终止时重置运行态：流式收尾 + 清忙碌/权限/排队/任务列表。
 *
 *  三处终止路径（stopSession / session_dead / error fatal:true）共用，让
 *  「会话停止时该清什么」只有一处定义。尤其 store.tasks——sidecar 进程死后
 *  不再发 tasks_update，若不清，顶部 in_progress TODO 会冻结在最后一条快照、
 *  一直脉冲（TaskListPanel 的 pulse 只看 status），误导用户以为还在跑。
 *
 *  error 的可恢复分支（fatal:false）进程仍活、任务可能继续更新，传
 *  clearTasks=false 保留任务列表；缺省/true 一律清。
 */
function resetRuntimeState(store: SessionStore, clearTasks = true) {
  finishStreaming(store);
  store.isBusy = false;
  store.pendingPermissions = [];
  store.queued.length = 0;
  if (clearTasks) store.tasks = [];
}

/** 子代理逐字增量累积：跟主线程 text_delta 同一套模式——最后一项同类型就原地追加，
 *  否则另起一项（类型切换，或被一次工具调用打断了连续的文本/thinking 段落）。 */
function appendSubagentTextEntry(block: SubagentBlock, kind: "text" | "thinking", delta: string) {
  const last = block.entries[block.entries.length - 1];
  if (kind === "text") {
    if (last && last.type === "text") {
      last.text += delta;
      return;
    }
    block.entries.push({ type: "text", text: delta });
    return;
  }
  if (last && last.type === "thinking") {
    last.text += delta;
    return;
  }
  block.entries.push({ type: "thinking", text: delta });
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
  if (lastDispatchedPrompt[tempId] !== undefined) {
    lastDispatchedPrompt[realId] = lastDispatchedPrompt[tempId];
    delete lastDispatchedPrompt[tempId];
  }
  if (sessionState[tempId]) {
    setSessionState(realId, sessionState[tempId]);
    if (sessionHealth[tempId]) setSessionHealth(realId, sessionHealth[tempId]);
    removeSessionState(tempId);
  }
  // provider 绑定也跟着搬迁：临时 id 在 sendMessage 时已盖戳，拿到真实 id 后不能丢
  migrateProvider(tempId, realId);
  // 2. Rust 侧只需要重命名 sidecar 进程注册表（内存态，无 IO）
  try {
    await invoke("rename_sidecar_session", { oldId: tempId, newId: realId });
  } catch (e) {
    console.warn("rename_sidecar_session failed:", e);
  }
  // 3. 通知 App.vue：这是第一次创建，去写元数据、加侧栏、记最近访问
  for (const cb of sessionCreatedCallbacks) cb(tempId, realId);
}

/**
 * 把一条消息真正推进 UI 并发给 Rust——sendMessage 直发和忙碌队列 flush 走同一条
 * 路径，保证两种入口的渲染/状态副作用完全一致。
 *
 * invoke("send_message") 不 await 到底：新会话要等 Rust 侧现拉起 Node 子进程，
 * 等它返回会让首条消息在 UI 上有明显卡顿。这里只做本地状态就绪，IPC 后台完成，
 * 失败走 .catch 兜底。
 */
function dispatchSend(
  sid: string,
  item: QueuedSend,
  resumeId?: string,
  initialModel?: string,
  jumpQueue?: boolean,
) {
  const store = getStore(sid);
  store.isBusy = true;
  // 记下本次派发的用户提问，供变更面板给轮次做标题（图片消息无文本时兜底占位）。
  // 动作胶囊用 label 做标题更可读，底层 prompt 是 /compact 这种斜杠命令。
  lastDispatchedPrompt[sid] =
    item.action?.label || item.prompt || (item.images?.length ? "[图片]" : "");
  setSessionState(sid, "running");
  // 新一轮开始：清掉上轮可能残留的 warning（红点），并起软超时表。
  setSessionHealth(sid, "ok");
  armStalled(sid);

  // 动作胶囊：用户气泡只放一个 ActionBlock（胶囊显示 label/icon），不再混文本/
  // 图片/引用——发给 sidecar 的仍是 item.prompt（/compact /clear），显示与命令解耦。
  // 普通消息：@path 引用展开出来的文件内容不进用户气泡的文本——渲染成独立的、
  // 类似工具调用的折叠卡片（复用 ToolCallBlock.vue 对 name:"Read" 的现有渲染），
  // 避免用户自己打的字和引用文件内容混在一个气泡里。发给模型的内容仍然
  // 完整（mentions.sendText），只是本地显示时拆开。
  const blocks: (ImageBlock | TextBlock | ToolCallBlock | ActionBlock)[] = item.action
    ? [{
        type: "action",
        actionId: item.action.id,
        label: item.action.label,
        icon: item.action.icon,
      }]
    : [
        ...(item.images ?? []).map((img): ImageBlock => ({
          type: "image",
          data: img.data,
          mediaType: img.mediaType,
        })),
        ...(item.prompt ? [{ type: "text" as const, text: item.prompt }] : []),
        ...(item.mentions?.resolved ?? []).map((m): ToolCallBlock => ({
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

  const sendText = item.mentions?.sendText ?? item.prompt;
  // 混合 tab：会话可能归属别的工作区，sidecar 必须在它自己的项目目录里跑。
  // 注册表没有记录（新会话）时传 null，Rust 侧回落当前活动工作区。
  const sessionWs = useSessionWorkspaces().workspaceOf(sid);
  invoke("send_message", {
    sessionId: sid,
    prompt: sendText,
    workspaceRoot: sessionWs?.wsPath || null,
    images: item.images?.length ? item.images : null,
    resumeId: resumeId ?? null,
    // 只在这个 sidecar 进程还没起来时（第一条消息）有意义，Rust 侧只在
    // spawn 分支用它覆盖 provider 默认模型；之后切模型走 setModel()。
    initialModel: initialModel || null,
    // 每条消息都带当前选中的权限模式，sidecar 侧幂等（同值跳过）
    permissionMode: item.permissionMode || null,
    // 插队：不在这里打断，原样透传给 sidecar，由它在安全边界（当前工具调用
    // 跑完）自己决定何时真正 interrupt——见 jumpQueue 分支的调用处。
    jumpQueue: jumpQueue || null,
  }).catch((e) => {
    console.warn("send_message failed:", e);
    const s = getStore(resolveSid(sid));
    s.isBusy = false;
    s.queued.length = 0;
    setSessionState(resolveSid(sid), "stopped");
  });
}

function handleChatEvent(e: Record<string, unknown>) {
  const raw = e["session_id"] as string | undefined;
  if (!raw) return;
  // btw 事件路由到独立 store,不进主对话 store(隔离红线)
  const btw = useBtwSession();
  if (btw.isBtwSid(raw)) {
    btw.handleBtwEvent(e);
    return;
  }
  const sid = resolveSid(raw);
  const store = getStore(sid);

  switch (e["type"]) {
    case "session_init": {
      const sdkSid = e["sdk_session_id"] as string | undefined;
      if (sdkSid && isPendingSession(sid) && sdkSid !== sid) {
        // 临时 key 首次被 SDK 确认：finalizeSession 同步段已把 running 盖到 realId
        // 并 removeSessionState(tempId)。这里不能再 setSessionState(sid, ...)——
        // sid 是过期的 tempId，写回去会在 sessionStateMap 里留下孤儿条目，
        // 右上角"活跃会话"因此出现一个点进去空白的会话。realId 的 running 由
        // finalizeSession 负责，本分支直接结束。
        void finalizeSession(sid, sdkSid);
        break;
      }
      setSessionState(sid, "running");
      break;
    }
    case "text_delta": {
      const msg = getOrCreateAssistant(store);
      stampMessageModel(msg, e);
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
      stampMessageModel(msg, e);
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
      store.pendingPermissions.push({
        id: e["id"] as string,
        name: e["name"] as string,
        input: e["input"],
        alwaysAllowLabel: e["alwaysAllowLabel"] as string | undefined,
        fromSubagent: e["fromSubagent"] as { id: string; agentName: string } | undefined,
      });
      setSessionState(sid, "attention");
      break;
    }
    case "permission_cancelled": {
      store.pendingPermissions = store.pendingPermissions.filter((p) => p.id !== e["id"]);
      break;
    }
    case "models_available": {
      store.models = e["models"] as ModelOption[];
      store.currentModel = e["current"] as string;
      sharedModels.value = store.models;
      // 注意：坐实模型的持久化不在这里做——current 可能是 sidecar 解析出的
      // Claude 别名（第三方 wire id → "haiku"/"sonnet"），不经验证落盘会污染
      // 会话记忆。持久化在 ChatPanel 的 currentModel watcher：只记在当前
      // 可选项列表里的值（恢复得出来的值才值得记）。
      break;
    }
    case "model_switch_result": {
      // 模型切换坐实回执——只有用户显式切换才收到（init/assistant 坐实不发），
      // 交给面板弹瞬时提示。seq 单调递增：连续两次切同一个模型也触发 watcher。
      store.modelSwitchResult = {
        ok: e["ok"] as boolean,
        model: e["model"] as string,
        display: (e["display"] as string) || (e["model"] as string),
        error: e["error"] as string | undefined,
        seq: (store.modelSwitchResult?.seq ?? 0) + 1,
        at: Date.now(),
      };
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
    case "rate_limit": {
      // 账号级配额，跨会话共享——最新一条即当前状态；windows 空表示非订阅/不报配额。
      const rawWindows = (e["windows"] as Array<Record<string, unknown>> | undefined) ?? [];
      sharedRateLimit.value = {
        subscription: (e["subscription"] as string | null) ?? null,
        windows: rawWindows.map((w) => ({
          key: w["key"] as string,
          label: w["label"] as string,
          utilization: w["utilization"] as number,
          resetsAt: (w["resets_at"] as number | null) ?? null,
        })),
      };
      break;
    }
    case "permission_modes_available": {
      store.permissionModes = e["modes"] as PermissionModeOption[];
      store.currentPermissionMode = e["current"] as string;
      sharedPermissionModes.value = store.permissionModes;
      break;
    }
    case "slash_commands_available": {
      store.slashCommands = e["commands"] as string[];
      break;
    }
    case "subagent_start": {
      const msg = getOrCreateAssistant(store);
      stampMessageModel(msg, e);
      msg.blocks.push({
        type: "subagent",
        id: e["id"] as string,
        agentName: e["agentName"] as string,
        description: e["description"] as string,
        // task prompt 非空才带（主代理派发时塞进 Agent 工具 input 的完整任务描述）
        prompt: e["prompt"] ? (e["prompt"] as string) : undefined,
        entries: [],
        isPending: true,
      } as SubagentBlock);
      break;
    }
    case "subagent_text_delta":
    case "subagent_thinking_delta": {
      const block = store.messages
        .flatMap((m) => m.blocks)
        .find((b): b is SubagentBlock => b.type === "subagent" && (b as SubagentBlock).id === e["id"]);
      if (block) {
        appendSubagentTextEntry(block, e["type"] === "subagent_text_delta" ? "text" : "thinking", e["delta"] as string);
      }
      break;
    }
    case "subagent_async_launched": {
      const block = store.messages
        .flatMap((m) => m.blocks)
        .find((b): b is SubagentBlock => b.type === "subagent" && (b as SubagentBlock).id === e["id"]);
      if (block) {
        block.asyncLaunched = { agentId: e["agentId"] as string, outputFile: e["outputFile"] as string };
      }
      break;
    }
    case "subagent_progress": {
      const block = store.messages
        .flatMap((m) => m.blocks)
        .find((b): b is SubagentBlock => b.type === "subagent" && (b as SubagentBlock).id === e["id"]);
      if (block) {
        block.entries.push({
          type: "tool",
          toolUseId: e["toolUseId"] as string,
          toolName: e["toolName"] as string,
          input: e["input"],
        });
        if (e["model"]) block.model = e["model"] as string;
      }
      break;
    }
    case "subagent_tool_result": {
      // 子代理内部某次工具的产出，按 toolUseId 回填到对应步骤——让步骤能显示输出，
      // 不只是工具名+入参摘要。找不到对应步骤（tool_use 没采到/乱序）时静默丢弃。
      const block = store.messages
        .flatMap((m) => m.blocks)
        .find((b): b is SubagentBlock => b.type === "subagent" && (b as SubagentBlock).id === e["id"]);
      if (block) {
        const toolUseId = e["toolUseId"] as string;
        const entry = block.entries.find(
          (en): en is Extract<SubagentEntry, { type: "tool" }> =>
            en.type === "tool" && en.toolUseId === toolUseId,
        );
        if (entry) {
          entry.result = e["content"] as string;
          entry.isError = e["is_error"] as boolean;
        }
      }
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
      const usage = e["usage"] as ChatMessage["usage"] | null;
      if (usage) {
        const last = store.messages[store.messages.length - 1];
        if (last?.role === "assistant") last.usage = usage;
      }
      finishStreaming(store);
      // 忙碌期间排队的消息：这一轮结束立即把「全部」排队消息合并成一条续发
      // （当成同一轮对话，效率更高、意图更连贯），状态保持 running 不落 waiting
      // （通知/横幅依赖 running→waiting 转换，排队续发中不该触发"已完成"通知）。
      if (store.queued.length > 0) {
        const items = store.queued.splice(0);
        // 动作（/compact /clear）必须独占一轮——斜杠命令只在它是整条用户消息时
        // 才被 SDK 拦截，与文本合并会失效。队列里含动作时逐条独发，纯文本仍合并。
        if (items.some((i) => i.action)) {
          for (const it of items) {
            dispatchSend(sid, it, isPendingSession(sid) ? undefined : sid);
          }
        } else {
          const merged = mergeQueued(items);
          dispatchSend(sid, merged, isPendingSession(sid) ? undefined : sid);
        }
        break;
      }
      store.isBusy = false;
      // waiting = sidecar 存活但空闲 → 通知/横幅/变更捕获依赖 running→waiting 转换
      setSessionState(sid, "waiting");
      break;
    }
    case "notification": {
      // 非致命通知（如供应商切换后会话迁移提示）
      store.messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        blocks: [{ type: "text", text: `${e["message"]}` }],
        timestamp: Date.now(),
      });
      break;
    }
    case "error": {
      // fatal:false = 可恢复错误，sidecar 进程仍存活等下一条 → 保留任务列表（可能继续更新）；
      // 缺省/true 按致命处理（进程已死）→ 清任务，兼容未重建的旧 bundle。
      resetRuntimeState(store, e["fatal"] !== false);
      store.messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        blocks: [{ type: "text", text: `Error: ${e["message"]}` }],
        timestamp: Date.now(),
      });
      // fatal:false 落 waiting + 红点，不再谎报 stopped（灰点）。
      if (e["fatal"] === false) {
        setSessionState(sid, "waiting");
        setSessionHealth(sid, "warning");
      } else {
        setSessionState(sid, "stopped");
      }
      break;
    }
    case "session_dead": {
      // 进程真的没了（Rust 侧 reader EOF 或心跳看门狗超时合成）。
      resetRuntimeState(store);
      const reason = e["reason"] as string | undefined;
      const detail = e["detail"] as string | undefined;
      const label =
        reason === "heartbeat_timeout"
          ? "会话无响应，已终止进程"
          : "会话进程已退出";
      store.messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        blocks: [{ type: "text", text: detail ? `${label}\n${detail}` : label }],
        timestamp: Date.now(),
      });
      setSessionState(sid, "stopped");
      break;
    }
  }

  // 任意事件到达都证伪“卡住”：清掉 stalled 橙点（warning 红点不在此清，只在下条消息清）。
  if (sessionHealth[sid] === "stalled") setSessionHealth(sid, "ok");
  // running 期间据事件重置软超时；连续静默 STALLED_MS 才会重新判 stalled。
  if (sessionState[sid] === "running") armStalled(sid);
}

function ensureGlobalListener(): Promise<() => void> {
  if (!listenerPromise) {
    listenerPromise = listen<Record<string, unknown>>("chat-event", (event) => {
      handleChatEvent(event.payload);
    }).then((unlisten) => {
      globalUnlisten = unlisten;
      return unlisten;
    });
  }
  return listenerPromise;
}

async function hydrate(sid: string) {
  const store = getStore(sid);
  if (store.hydrated || store.messages.length > 0 || isPendingSession(sid)) {
    store.hydrated = true;
    return;
  }
  store.hydrated = true;
  try {
    const items = await invoke<Array<{ role: string; blocks: HistoryBlock[]; timestamp: number }>>(
      "load_messages",
      { sessionId: sid },
    );
    if (!Array.isArray(items)) return;
    // hydrate 期间可能已有实时消息进来：历史插到最前
    const history: ChatMessage[] = items.map((item) => ({
      id: crypto.randomUUID(),
      role: (item.role === "claude" ? "assistant" : item.role) as "user" | "assistant",
      blocks: item.blocks.flatMap((b) => historyBlockToContentBlocks(b, item.role === "user")),
      timestamp: item.timestamp,
    }));
    store.messages.unshift(...history);
  } catch (e) {
    console.warn("Failed to load messages:", e);
  }
}

/** Rust 侧重建的历史 block → 前端渲染用的 ContentBlock。tool_call 历史消息永远是
 *  "已完成"状态（isPending: false）——它来自一份早就落盘的 transcript，不会再有
 *  新的 tool_result 追上来。
 *
 *  user 文本块要额外拆引用段：transcript 落盘的用户消息是 sendText（原文 +
 *  @mention 展开的文件内容，见 fileMentions.ts），不拆的话整个文件原文会灌进
 *  用户气泡。拆回「原文 text 块 + N 个 Read 附件卡片」，与直发路径
 *  （dispatchSend 里 mentions.resolved 的渲染）保持同一形状。 */
function historyBlockToContentBlocks(
  block: HistoryBlock,
  isUser: boolean,
): (TextBlock | ToolCallBlock)[] {
  if (block.type === "tool_call") {
    return [{
      type: "tool_call",
      id: block.id,
      name: block.name,
      input: block.input,
      result: block.result ?? undefined,
      isError: block.isError ?? undefined,
      isPending: false,
    }];
  }
  if (!isUser) return [{ type: "text", text: block.text }];
  const { displayText, sections } = splitMentionSections(block.text);
  return [
    ...(displayText ? [{ type: "text" as const, text: displayText }] : []),
    ...sections.map((s): ToolCallBlock => ({
      type: "tool_call",
      id: crypto.randomUUID(),
      name: "Read",
      input: { file_path: s.path },
      result: s.content,
      isError: false,
      isPending: false,
    })),
  ];
}

/** 仅测试用：清空模块级状态 */
export function __resetForTest() {
  for (const k of Object.keys(stores)) delete stores[k];
  pendingSids.clear();
  aliasMap.clear();
  sessionCreatedCallbacks.clear();
  sharedModels.value = [];
  sharedPermissionModes.value = [];
  globalUnlisten?.();
  globalUnlisten = null;
  listenerPromise = null;
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
   * 会话忙碌（上一轮还在生成）时不打断：进排队队列，本轮 message_stop 后把「全部」
   * 排队消息合并成一条一次性续发（当成同一轮对话，见 mergeQueued）——排队期间用户
   * 仍可在输入区看到并撤回它们。
   */
  async function sendMessage(prompt: string, opts: SendOptions = {}): Promise<string | undefined> {
    let sid = sessionId.value;
    if (!sid) {
      sid = crypto.randomUUID();
      pendingSids.add(sid);
    }
    await ensureGlobalListener();

    const store = getStore(sid);
    const item: QueuedSend = {
      prompt,
      images: opts.images,
      mentions: opts.mentions,
      permissionMode: opts.permissionMode,
      action: opts.action,
    };
    if (store.isBusy && !opts.jumpQueue) {
      store.queued.push(item);
      return sid;
    }
    // 插队：不在前端直接 interrupt_session——那会立刻腰斩当前这一轮，可能砍在
    // 一次还没跑完的工具调用中间（丢弃本轮已产出内容）。改成把 jumpQueue 标记
    // 原样透传给 sidecar，由它在安全边界（当前工具调用跑完）自己判断何时真正
    // 打断，见 dispatchSend → send_message → agent-sidecar/src/index.ts 的
    // jump_queue 处理。此前已排队的消息保留，会在插队这轮结束后照常合并续发。

    // resume：显式传入 > 已被 SDK 确认的 id 本身（aide id 就是 sdk id，无需查表）
    const resolvedResumeId = opts.resumeId ?? (isPendingSession(sid) ? undefined : sid);

    // 即将 spawn（会话不存活：新会话 / stop 后续发 / 重开历史）→ 给这次会话盖戳
    // 当前全局 active provider，让模型下拉在存活期间锁定它，全局切换不影响。
    // 与 Rust `!has_session` 对齐：busy（含插队）= 存活 → 不盖戳，沿用旧绑定。
    const status = sessionState[sid];
    if (!status || status === "stopped") {
      setProvider(sid, activeProviderId.value);
    }

    dispatchSend(sid, item, resolvedResumeId, opts.initialModel, opts.jumpQueue);
    return sid;
  }

  /** answers：仅 AskUserQuestion 场景（问题文本 → 选中答案的不透明映射），
   *  由 PermissionDialog.vue 收集，这里只透传，语义由 sidecar 解释。 */
  async function respondPermission(
    id: string,
    approved: boolean,
    always?: boolean,
    answers?: Record<string, string>,
  ) {
    const sid = sessionId.value;
    if (!sid) return;
    const store = getStore(sid);
    store.pendingPermissions = store.pendingPermissions.filter((p) => p.id !== id);
    // 并发权限请求逐条确认：队列还有剩余时保持 attention（弹窗随队头自动切到
    // 下一条），全部清空才回到 running。
    if (store.pendingPermissions.length === 0) {
      setSessionState(sid, "running");
      armStalled(sid); // 权限批准后恢复生成 → 重启软超时计时
    }
    await invoke("permission_response", { sessionId: sid, id, approved, always, answers });
  }

  async function interrupt() {
    const sid = sessionId.value;
    if (!sid) return;
    const store = getStore(sid);
    try {
      await invoke("interrupt_session", { sessionId: sid });
    } finally {
      store.isBusy = false;
      store.pendingPermissions = [];
      store.queued.length = 0; // 用户主动打断：排队消息一并作废
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
      resetRuntimeState(store);
      setSessionState(sid, "stopped");
      // 释放 provider 绑定：下拉随即回落到全局 active provider，体现"stop 后供应商
      // 才改变"；下次发消息会重新盖戳当前 active provider 并用它 spawn。
      clearProvider(sid);
    }
  }

  function onSessionCreated(cb: (tempId: string, realId: string) => void) {
    sessionCreatedCallbacks.add(cb);
  }

  /** 切换模型只影响下一条消息，SDK 原生保证；不做本地乐观更新，
   *  显示状态靠 sidecar 主动回发的 models_available 事件同步。回执提示两条路：
   *  进程活着 → sidecar 运行时坐实后发 model_switch_result；进程没起 →
   *  Rust 返回 false，这里本地合成 deferred 回执（选择随下一条消息的
   *  initialModel 生效）——两条路都给用户可见反馈，不允许静默。
   *  用户显式选择立即持久化（停止中的会话没有广播渠道，靠这次写入记住）。 */
  async function setModel(model: string) {
    const sid = sessionId.value;
    if (!sid) return;
    if (!isPendingSession(sid)) {
      void invoke("set_session_model", { id: sid, model }).catch(() => {});
    }
    let delivered = false;
    try {
      delivered = await invoke<boolean>("set_model", { sessionId: sid, model });
    } catch {
      // has_session 到 send 之间进程刚好死掉：视同 deferred，下一条消息 respawn
      // 时 initialModel 照样带上，提示语义不变
    }
    if (!delivered) {
      const store = getStore(sid);
      store.modelSwitchResult = {
        ok: true,
        model,
        display: store.models.find((m) => m.value === model)?.displayName ?? model,
        deferred: true,
        seq: (store.modelSwitchResult?.seq ?? 0) + 1,
        at: Date.now(),
      };
    }
  }

  /** 切权限模式：进程活着就即时生效（sidecar 回发事件同步下拉），进程还没
   *  起来时静默失败——模式会随下一条消息的 permission_mode 字段带过去。 */
  async function setPermissionMode(mode: string) {
    const sid = sessionId.value;
    if (!sid) return;
    try {
      await invoke("set_permission_mode", { sessionId: sid, mode });
    } catch {
      // 无活进程：等 send 携带
    }
  }

  /** 撤掉一条还没发出去的排队消息。 */
  function removeQueued(index: number) {
    const store = current.value;
    if (store) store.queued.splice(index, 1);
  }

  /** 顺便问一下:fork 当前主会话开一个隔离子对话。一次性——发送后由 ChatPanel
   *  负责复位 btw 模式视觉。结论以 ActionBlock(actionId:'btw')回插本会话 store
   *  末尾(前端可见、不进 SDK resume 上下文,见 ChatMessage 渲染)。 */
  async function sendBtw(prompt: string, opts: { lightweight: boolean; permissionMode?: string; model?: string } = { lightweight: true }) {
    const sid = sessionId.value;
    if (!sid) {
      // 无主会话可 fork:ChatPanel 已在 !sessionId 时禁用 btw 切换项,正常走不到这里。
      // 兜底(在已启动会话切了 btw 模式后,又切到空白 tab 发送):静默 no-op——
      // 不弹误导性 toast(乐观 toast 已移除),也不拉单例抽屉污染其它窗口。
      console.warn("sendBtw 需要一个存活的主会话作为 fork 源");
      return;
    }
    const btwId = crypto.randomUUID();
    // btw 事件经 isBtwSid(btwpTempId) 路由,不参与主对话的 pending/finalize 流程,
    // 故不进 pendingSids(此前 add 后成功路径从不 delete,是残余泄漏)。
    const sessionWs = useSessionWorkspaces().workspaceOf(sid);
    const cwd = sessionWs?.wsPath || "";
    const store = getStore(sid);
    const btw = useBtwSession();
    btw.setOnDone((block) => {
      // 结论回插主对话:作为一条只含 ActionBlock 的用户消息(与 /compact /clear 同形),
      // ChatMessage 检测 actionId==='btw' 渲染为页边批注。
      store.messages.push({
        id: crypto.randomUUID(),
        role: "user",
        blocks: [block],
        timestamp: Date.now(),
      });
    });
    // startBtw 内部把 fork 失败(主会话未就绪 / spawn 失败)转成 store.status="error",
    // 由抽屉展示原因——不抛、不静默 cleanup(那会抹掉失败只剩误导性 toast)。
    await btw.startBtw({ tempId: btwId, forkFrom: sid, prompt, cwd, lightweight: opts.lightweight, permissionMode: opts.permissionMode, model: opts.model });
  }

  return {
    messages: computed(() => current.value?.messages ?? []),
    isBusy: computed(() => current.value?.isBusy ?? false),
    /** 弹窗只显示队头一条；确认后队列前移，下一条自动顶上。 */
    pendingPermission: computed(() => current.value?.pendingPermissions[0] ?? null),
    /** 挂起的权限请求总数（含队头）——弹窗用它提示"后面还排着 N 条"。 */
    pendingPermissionCount: computed(() => current.value?.pendingPermissions.length ?? 0),
    // 这个会话自己学到的列表优先；还没连上真实 SDK 时借用别的会话学到的缓存。
    models: computed(() => {
      const own = current.value?.models;
      return own?.length ? own : sharedModels.value;
    }),
    currentModel: computed(() => current.value?.currentModel ?? ""),
    /** 模型切换坐实回执（含 seq），面板据此弹成功/失败提示；null 表示没切过。 */
    modelSwitchResult: computed(() => current.value?.modelSwitchResult ?? null),
    contextUsage: computed(() => current.value?.contextUsage ?? null),
    tasks: computed(() => current.value?.tasks ?? []),
    permissionModes: computed(() => {
      const own = current.value?.permissionModes;
      return own?.length ? own : sharedPermissionModes.value;
    }),
    currentPermissionMode: computed(() => current.value?.currentPermissionMode ?? ""),
    /** null 表示本会话还没收到过 SDK 权威清单——不做跨会话共享兜底
     *  （跟 models/permissionModes 不同：这里的兜底走 ChatPanel 里的
     *  useSlashCommands 本地扫描，而不是借用别的会话学到的列表）。 */
    slashCommands: computed(() => current.value?.slashCommands ?? null),
    /** 账号级订阅额度/速率——跨会话共享，null 时 UI 隐藏。 */
    rateLimit: computed(() => sharedRateLimit.value),
    queuedPrompts: computed(() => (current.value?.queued ?? []).map((q) => q.prompt)),
    sendMessage,
    sendBtw,
    respondPermission,
    interrupt,
    stopSession,
    onSessionCreated,
    setModel,
    setPermissionMode,
    removeQueued,
  };
}
