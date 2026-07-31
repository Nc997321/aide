import { computed, reactive, ref, watch, type Ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { api } from "@/api";
import { useDiagnosticsDashboard } from "@/composables/useDiagnosticsDashboard";
import type {
  ChatMessage,
  ContextCompactionState,
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
  BgTask,
} from "../types/chat";
import { useSessionState } from "./useSessionState";
import { useSessionNames } from "./useSessionNames";
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
  /** 当前选中的 effort 档位（low/medium/high/xhigh/max 小写），随每条消息
   *  透传（与 initialModel 同语义：spawn 时是初始值，存活会话幂等）。 */
  initialEffort?: string;
  mentions?: FileMentionResolution;
  /** 当前选中的权限模式（不透明字符串，sidecar 解释语义），随每条消息透传 */
  permissionMode?: string;
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
  /** sidecar 坐实的当前 effort 档位（effort_changed 事件）；空串表示还没学到
   *  （选择器本地值为准，这个用于坐实同步/失败回滚）。 */
  currentEffort: string;
  /** effort 切换失败回执（sidecar 驳回，选择器已被回滚广播拉回旧值）——
   *  seq 单调递增，面板据此弹失败提示。 */
  effortSwitchError: { message: string; seq: number } | null;
  /** 上下文窗口用量——每轮结束后由 sidecar 刷新；null 表示还没收到过 */
  contextUsage: ContextUsage | null;
  /** 上下文压缩的短生命周期状态：只驱动活动状态条，不写入消息/历史。 */
  contextCompaction: ContextCompactionState | null;
  /** 当前任务清单——sidecar 每次变化后整体覆盖，不做增量合并 */
  tasks: TaskItem[];
  /** 后台 shell 任务列表（bg_task_* 事件累积；按 id upsert，output 增量追加）。
   *  已结束的任务不立即移除——dock 开着时留着供查看；dock 关闭时清，
   *  或 dock 关着且无运行中任务时延时自动清（见 toggleBgDock/scheduleBgDockAutoHide）。 */
  bgTasks: BgTask[];
  /** 后台任务 dock 面板是否展开（纯 UI 状态，不落盘） */
  bgDockOpen: boolean;
  /** dock 里当前选中查看输出的任务 id */
  bgDockSelectedId: string | null;
  /** 可切换的权限模式列表（sidecar 广播，纯展示字符串） */
  permissionModes: PermissionModeOption[];
  /** 当前生效的权限模式 value；空串表示还没从 sidecar 学到 */
  currentPermissionMode: string;
  /** SDK 权威 slash commands 清单；null 表示本会话还没收到过（会话未开始，
   *  或 provider 不支持该概念）。一旦非 null，下拉框数据源单向切换，不回退。 */
  slashCommands: string[] | null;
  /** 已派发、正在 sidecar 里等安全边界（当前工具跑完）的插队消息原文——
   *  仅展示用（输入区上方的"待发出"提示条），jump_promoted 后清空。 */
  pendingJumps: string[];
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
/** 诊断仪表盘句柄——必须模块级声明：handleChatEvent 是模块级函数，rate_limit /
 *  health / message_stop 三个 case 都用它累计用量/健康/速率。原先声明在
 *  useChatSession 函数内部，handleChatEvent 作用域看不到，运行时 ReferenceError
 *  中断 message_stop → store.isBusy 永远没被置 false → "思考中"常亮。 */
const diag = useDiagnosticsDashboard();
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

/** 后台任务输出在 store 里的保留上限（超出截头保尾）。 */
const BG_TASK_OUTPUT_CAP = 256 * 1024;
/** 后台任务列表上限——超出时淘汰最老的已结束项。 */
const BG_TASKS_CAP = 50;

/** 切换后台任务 dock 开合。关闭→打开的瞬间清掉「打开前就已结束」的任务（用户确认
 *  的清理规则：结束不立即移除，下次点开列表时才移除）；打开→关闭同样清掉已结束的
 *  （查看期已过，没有运行中任务时状态条随之隐藏，不留「✓ 全部完成」僵尸条）。
 *  selectedId：指定打开后选中的任务（工具卡片「后台运行中」徽章点击时带）——
 *  dock 已开着时带 selectedId 不关闭，只切选中项。 */
export function toggleBgDock(sid: string, selectedId?: string): void {
  const store = getStore(sid);
  if (store.bgDockOpen) {
    if (selectedId && store.bgTasks.some((t) => t.id === selectedId)) {
      store.bgDockSelectedId = selectedId;
    } else if (!selectedId) {
      store.bgDockOpen = false;
      store.bgTasks = store.bgTasks.filter((t) => t.status === "running");
      if (store.bgTasks.length === 0) store.bgDockSelectedId = null;
    }
    return;
  }
  clearBgDockAutoHide(sid);
  store.bgTasks = store.bgTasks.filter((t) => t.status === "running");
  store.bgDockOpen = true;
  if (selectedId && store.bgTasks.some((t) => t.id === selectedId)) {
    store.bgDockSelectedId = selectedId;
  } else if (!store.bgTasks.some((t) => t.id === store.bgDockSelectedId)) {
    // 选中项已不在列表：回退到最近一个运行中的，再退到列表末尾
    store.bgDockSelectedId =
      [...store.bgTasks].reverse().find((t) => t.status === "running")?.id ??
      store.bgTasks[store.bgTasks.length - 1]?.id ??
      null;
  }
}

/** dock 关闭状态下全部任务结束后的自动撤条延迟（「✓ 全部完成」短暂停留再消失）。 */
const BG_DOCK_AUTOHIDE_MS = 4000;
const bgDockAutoHideTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearBgDockAutoHide(sid: string): void {
  const t = bgDockAutoHideTimers.get(sid);
  if (t) {
    clearTimeout(t);
    bgDockAutoHideTimers.delete(sid);
  }
}

/** dock 关着、且没有运行中任务时，延时清掉已结束任务让状态条自己消失；
 *  期间有新任务起步或用户点开 dock 则取消（各自入口调 clearBgDockAutoHide）。 */
function scheduleBgDockAutoHide(sid: string): void {
  const store = getStore(sid);
  if (store.bgDockOpen) return;
  if (store.bgTasks.length === 0 || store.bgTasks.some((t) => t.status === "running")) return;
  clearBgDockAutoHide(sid);
  bgDockAutoHideTimers.set(
    sid,
    setTimeout(() => {
      bgDockAutoHideTimers.delete(sid);
      const s = getStore(sid);
      if (s.bgDockOpen || s.bgTasks.some((t) => t.status === "running")) return;
      s.bgTasks = [];
      s.bgDockSelectedId = null;
    }, BG_DOCK_AUTOHIDE_MS),
  );
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
      currentEffort: "",
      effortSwitchError: null,
      contextUsage: null,
      contextCompaction: null,
      tasks: [],
      bgTasks: [],
      bgDockOpen: false,
      bgDockSelectedId: null,
      permissionModes: [],
      currentPermissionMode: "",
      slashCommands: null,
      pendingJumps: [],
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
  store.contextCompaction = null;
  store.pendingPermissions = [];
  store.pendingJumps.length = 0;
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
  // 2. Runtime 内部管理 session 映射（SessionManager 的 Map），不需要 Rust 改名
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
  initialEffort?: string,
) {
  const store = getStore(sid);
  // 新轮次不能继承前一轮的压缩提示；但忙碌时这里仅登记插队消息，当前轮
  // 仍在压缩，不能提前撤掉它的状态条。真正接入下一轮时由 jump_promoted 清理。
  if (!jumpQueue) store.contextCompaction = null;
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
    // effort 选择器当前值（与 initialModel 同一条 env 通道：CLAUDE_CODE_EFFORT_LEVEL）。
    // 存活会话同值幂等；切换走 setEffort() 即时生效，这里是 deferred 兜底。
    initialEffort: initialEffort || null,
    // 每条消息都带当前选中的权限模式，sidecar 侧幂等（同值跳过）
    permissionMode: item.permissionMode || null,
    // 插队：不在这里打断，原样透传给 sidecar，由它在安全边界（当前工具调用
    // 跑完）自己决定何时真正 interrupt——见 jumpQueue 分支的调用处。
    jumpQueue: jumpQueue || null,
  }).catch((e) => {
    console.warn("send_message failed:", e);
    const s = getStore(resolveSid(sid));
    s.isBusy = false;
    s.pendingJumps.length = 0;
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
    case "effort_changed": {
      // effort 切换坐实/回滚——成功带新值，失败（sidecar 驳回）带回滚后的旧值
      //  + error。选择器据此同步（失败时弹提示并拉回旧值）。
      store.currentEffort = e["effort"] as string;
      const err = e["error"] as string | undefined;
      if (err) {
        store.effortSwitchError = {
          message: err,
          seq: (store.effortSwitchError?.seq ?? 0) + 1,
        };
      }
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
    case "context_compaction": {
      // 压缩生命周期只属于正在运行的轮次。终态之后偶发到达的旧事件不能把
      // 状态条重新挂回一个闲置会话。
      if (!store.isBusy) break;
      const stage = e["stage"];
      if (stage === "completed") {
        // 成功后立即交还给普通思考状态；实际压缩后的窗口变化仍走 context_usage。
        if (store.contextCompaction) store.contextCompaction = null;
        break;
      }
      if (stage !== "compacting" && stage !== "failed") break;

      const detail = typeof e["detail"] === "string" ? e["detail"] : undefined;
      const error = typeof e["error"] === "string" ? e["error"] : undefined;
      const previous = store.contextCompaction;
      const startedAt =
        stage === "failed" && previous
          ? previous.startedAt
          : stage === "compacting" && previous?.stage === "compacting"
            ? previous.startedAt
            : Date.now();
      const next: ContextCompactionState = {
        stage,
        startedAt,
        ...(detail ? { detail } : {}),
        ...(error ? { error } : {}),
      };
      // Sidecar 若重复报告同一阶段，保留原对象以免无意义地触发状态条重渲染。
      if (
        previous?.stage === next.stage
        && previous.detail === next.detail
        && previous.error === next.error
      ) break;
      store.contextCompaction = next;
      break;
    }
    case "tasks_update": {
      store.tasks = e["tasks"] as TaskItem[];
      break;
    }
    case "session_title": {
      // 会话自动命名：sidecar 首轮回复开始时生成的标题。是否采纳由 Rust 原子判定
      // （nameSource==manual 拒写）——返回 true 才更新名字注册表，侧栏卡片
      // 显示走注册表（SidebarLeft 模板 names[s.id] || s.name），一处更新全局生效。
      const title = e["title"] as string;
      if (title) {
        void invoke<boolean>("auto_rename_session", { id: sid, name: title }).then((adopted) => {
          if (adopted) useSessionNames().setName(sid, title);
        }).catch(() => { /* 自动命名失败静默——保留默认名 */ });
      }
      break;
    }
    case "bg_task_started": {
      // task_started 与后台回执两路信号顺序不保证——按 id upsert 合并。
      clearBgDockAutoHide(sid); // 新任务起步：取消待执行的自动撤条
      const id = e["id"] as string;
      let task = store.bgTasks.find((t) => t.id === id);
      if (!task) {
        task = { id, status: "running", output: "", startedAt: Date.now() };
        store.bgTasks.push(task);
        // 新任务自动成为 dock 里的选中项（用户最想看的是刚起来的那个）
        store.bgDockSelectedId = id;
      }
      if (e["toolUseId"]) task.toolUseId = e["toolUseId"] as string;
      if (e["command"]) task.command = e["command"] as string;
      if (e["description"]) task.description = e["description"] as string;
      break;
    }
    case "bg_task_output": {
      const task = store.bgTasks.find((t) => t.id === (e["id"] as string));
      if (!task) break;
      task.output += e["delta"] as string;
      // 截头保尾：长跑命令的输出无界增长，超出 256KB 丢掉最旧的部分
      if (task.output.length > BG_TASK_OUTPUT_CAP) {
        task.output = task.output.slice(task.output.length - BG_TASK_OUTPUT_CAP);
      }
      break;
    }
    case "bg_task_ended": {
      const task = store.bgTasks.find((t) => t.id === (e["id"] as string));
      if (!task) break;
      task.status = e["status"] as BgTask["status"];
      if (e["summary"]) task.summary = e["summary"] as string;
      task.endedAt = Date.now();
      // 结束的任务留在列表里（用户可能正看着）——dock 关着且没有运行中任务时，
      // 短暂停留后自动撤条（scheduleBgDockAutoHide）；dock 开着则等关闭时清。
      scheduleBgDockAutoHide(sid);
      // 兜底上限：淘汰最老的已结束项，运行中的不动。
      if (store.bgTasks.length > BG_TASKS_CAP) {
        const idx = store.bgTasks.findIndex((t) => t.status !== "running");
        if (idx >= 0) store.bgTasks.splice(idx, 1);
      }
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
      diag.handleRateLimitEvent(sharedRateLimit.value);
      break;
    }
    case "health": {
      diag.handleHealthEvent(e);
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
    case "subagent_nesting_warning": {
      // runtime 检测到子代理嵌套深度超阈值（warn-only，不阻止调用）——推给诊断面板显示。
      diag.handleNestingWarning({ depth: e["depth"] as number, threshold: e["threshold"] as number });
      break;
    }
    case "message_stop": {
      const usage = e["usage"] as ChatMessage["usage"] | null;
      const turnEffort = e["effort"] as string | undefined;
      if (usage || turnEffort) {
        const last = store.messages[store.messages.length - 1];
        if (last?.role === "assistant") {
          if (usage) last.usage = usage;
          // 本轮实际生效的 effort（sidecar 从 Stop hook 读到的权威值，含静默
          // 降级）——usage 行徽标的数据源；模型不支持 effort 时不带。
          if (turnEffort) last.turnEffort = turnEffort;
        }
        if (usage) diag.accumulateUsage(usage);
      }
      finishStreaming(store);
      // 失败状态留在会话尾部，直到用户真正发起下一轮，避免被紧随其后的
      // message_stop 一闪而过；进行中/成功状态仍在本轮结束时撤掉。
      if (store.contextCompaction?.stage !== "failed") store.contextCompaction = null;
      store.isBusy = false;
      setSessionState(sid, "waiting");
      break;
    }
    case "jump_queued": {
      // 插队消息已登记、在等安全边界——输入区上方显示"待发出"提示条
      store.pendingJumps.push(e["prompt"] as string);
      break;
    }
    case "jump_promoted": {
      // 待插队消息已全部接入后续轮次——清提示条。新轮次由 sidecar 直接发起、不经过
      // dispatchSend，这里把忙碌态补回来（否则按钮区会闪"发送"且没有停止按钮）。
      // 上一轮若留下失败说明，也不能覆盖已经开始的下一轮。
      store.pendingJumps.length = 0;
      store.contextCompaction = null;
      store.isBusy = true;
      setSessionState(sid, "running");
      armStalled(sid);
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
    case "image_input_rejected": {
      // sidecar 二次防线：视觉请求从未到达模型，保持当前任务快照并让纯文本可立即续发。
      resetRuntimeState(store, false);
      store.messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        blocks: [{ type: "text", text: String(e["message"]) }],
        timestamp: Date.now(),
      });
      setSessionState(sid, "waiting");
      setSessionHealth(sid, "warning");
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

  // 诊断仪表盘句柄已提升到模块级（handleChatEvent 要用）——见顶部 const diag。

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
   * 会话忙碌（上一轮还在生成）时一律走插队：带 jumpQueue 标记透传给 sidecar，
   * 由它在安全边界（当前工具调用跑完，没有工具在跑就是立刻）interrupt 当前轮
   * 再发出——不在前端 interrupt_session，那会腰斩还没跑完的工具调用。等待安全
   * 边界期间 sidecar 会发 jump_queued，输入区上方显示"待发出"提示条。
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
    // 忙碌一律插队：sidecar 在安全边界（当前工具跑完）interrupt 后优先发出。
    const jumpQueue = store.isBusy || undefined;

    // resume：显式传入 > 已被 SDK 确认的 id 本身（aide id 就是 sdk id，无需查表）
    const resolvedResumeId = opts.resumeId ?? (isPendingSession(sid) ? undefined : sid);

    // 即将 spawn（会话不存活：新会话 / stop 后续发 / 重开历史）→ 给这次会话盖戳
    // 当前全局 active provider，让模型下拉在存活期间锁定它，全局切换不影响。
    // 与 Rust `!has_session` 对齐：busy（含插队）= 存活 → 不盖戳，沿用旧绑定。
    const status = sessionState[sid];
    if (!status || status === "stopped") {
      setProvider(sid, activeProviderId.value);
    }

    dispatchSend(sid, item, resolvedResumeId, opts.initialModel, jumpQueue, opts.initialEffort);
    return sid;
  }

  /** answers：仅 AskUserQuestion 场景（问题文本 → 选中答案的不透明映射），
   *  由 PermissionDialog.vue 收集，这里只透传，语义由 sidecar 解释。 */
  async function respondPermission(
    id: string,
    approved: boolean,
    answers?: Record<string, string>,
    nextMode?: string,
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
    await invoke("permission_response", { sessionId: sid, id, approved, answers, nextMode });
  }

  async function interrupt() {
    const sid = sessionId.value;
    if (!sid) return;
    const store = getStore(sid);
    try {
      await invoke("interrupt_session", { sessionId: sid });
    } finally {
      store.isBusy = false;
      store.contextCompaction = null;
      store.pendingPermissions = [];
      store.pendingJumps.length = 0; // 用户主动打断：待插队消息一并作废（sidecar 同）
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

  /** 切 effort：存活会话立即走 sidecar applyFlagSettings（SDK 官方中途切换通道，
   *  不重启进程、实测不碰 prompt 缓存），坐实/回滚由 effort_changed 事件同步；
   *  进程没起时静默——选择随下一条消息的 env 通道带上（与 initialModel 同语义）。
   *  用户显式选择立即持久化（重开会话恢复选择器）。 */
  async function setEffort(effort: string) {
    const sid = sessionId.value;
    if (!sid) return;
    if (!isPendingSession(sid)) {
      void api.setSessionEffort(sid, effort).catch(() => {});
    }
    try {
      await api.setEffort(sid, effort);
    } catch {
      // 无活进程：等 send 携带
    }
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
    /** sidecar 坐实的当前 effort（空串 = 还没学到，选择器以本地值为准）。 */
    currentEffort: computed(() => current.value?.currentEffort ?? ""),
    /** effort 切换失败回执（含 seq），面板据此弹失败提示。 */
    effortSwitchError: computed(() => current.value?.effortSwitchError ?? null),
    contextUsage: computed(() => current.value?.contextUsage ?? null),
    /** 只驱动会话尾部的压缩状态条，不属于消息历史。 */
    contextCompaction: computed(() => current.value?.contextCompaction ?? null),
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
    pendingJumps: computed(() => current.value?.pendingJumps ?? []),
    bgTasks: computed(() => current.value?.bgTasks ?? []),
    bgDockOpen: computed(() => current.value?.bgDockOpen ?? false),
    bgDockSelectedId: computed({
      get: () => current.value?.bgDockSelectedId ?? null,
      set: (v) => {
        const s = current.value;
        if (s) s.bgDockSelectedId = v;
      },
    }),
    sendMessage,
    sendBtw,
    respondPermission,
    interrupt,
    stopSession,
    onSessionCreated,
    setModel,
    setEffort,
    setPermissionMode,
  };
}
