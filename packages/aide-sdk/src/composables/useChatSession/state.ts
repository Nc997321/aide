import { reactive, ref } from "vue";
import { api } from "../../api";
import { useDiagnosticsDashboard } from "../../composables/useDiagnosticsDashboard";
import type {
  BgTask,
  ChatMessage,
  ContextCompactionState,
  ContextUsage,
  ModelOption,
  ModelSwitchConfirmRequest,
  ModelSwitchResult,
  PermissionModeOption,
  PermissionRequest,
  RateLimitInfo,
  SubagentBlock,
  SubagentEntry,
  TaskItem,
  ToolCallBlock,
} from "../../types/chat";
import { useSessionState } from "../useSessionState";
import { useSessionNames } from "../useSessionNames";
import { useSessionWorkspaces } from "../useSessionWorkspaces";
import { useSessionIdentity } from "../../composables/sessionIdentity";
import { useBtwSession } from "../useBtwSession";

/**
 * useChatSession 的模块级单例状态与生命周期（拆分自原 2000+ 行宿主：
 * 状态归 state、淘汰归 evict、分页归 pagination、事件归 events）。
 * 每会话独立 store：前台/后台事件走同一条写入路径，切换会话零拷贝。
 */

/** 排队消息的"待发出"提示条条目——忙碌排队时消息还没真正接入模型，输入区上方
 *  显示这一条占位；sidecar 到达安全边界接入后发 jump_promoted 清空它。
 *
 *  只存提示文本、不存气泡渲染数据：气泡由 sidecar 的 user_message 事件统一渲染
 *  （方案 C 单一渲染来源）。以前这里存 blocks 供 jump_promoted 时 flush 成气泡，
 *  那样做意味着只有发起方能看见自己提的问题。 */
export interface PendingJump {
  /** 提示条显示文本（与用户气泡标题一致：action.label 优先，否则 prompt）。 */
  text: string;
}

export interface SessionStore {
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
  /** 模型切换成本确认（sidecar PreModelSwitch hook 挂起时发出）：非 null 即
   *  弹确认对话框，前端决定回传后置回 null。同一时刻至多一个挂起。 */
  modelSwitchConfirm: ModelSwitchConfirmRequest | null;
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
  /** 已派发、正在 sidecar 里等安全边界（当前工具跑完）的排队消息——忙碌排队时
   *  dispatchSend 不立即渲染成对话气泡，只暂存到这里，输入区上方显示"待发出"
   *  提示条；jump_promoted 时 flush 成用户气泡并清空。 */
  pendingJumps: PendingJump[];
  /** 图片 400 回滚后待放回输入框的文本（image_input_rollback 事件写入；空串 =
   *  无待回填）。ChatPanel 消费后经 consumeRollbackText 清空，避免重复回填。 */
  rollbackText: string;
}

export const stores = reactive<Record<string, SessionStore>>({});
/** 模型列表是 provider/账号级别的事实，不是某个会话独有的——同一次 app
 *  运行里，任意一个会话第一次连上 SDK 学到的列表，其他还没起进程的
 *  会话/新面板都能直接借用，不用每个会话各自重新学一遍。 */
export const sharedModels = ref<ModelOption[]>([]);
/** 权限模式清单同理是 sidecar 实现级别的事实，跨会话共享。 */
export const sharedPermissionModes = ref<PermissionModeOption[]>([]);
/** 订阅额度/速率是账号级别的事实，跨会话共享——任意会话收到的最新一条即当前状态。
 *  null 表示还没收到过（非订阅计费或 provider 不报配额时永远为 null，UI 隐藏）。 */
export const sharedRateLimit = ref<RateLimitInfo | null>(null);
/** 诊断仪表盘句柄——必须模块级声明：handleChatEvent 是模块级函数，rate_limit /
 *  health / message_stop 三个 case 都用它累计用量/健康/速率。原先声明在
 *  useChatSession 函数内部，handleChatEvent 作用域看不到，运行时 ReferenceError
 *  中断 message_stop → store.isBusy 永远没被置 false → "思考中"常亮。 */
export const diag = useDiagnosticsDashboard();
/** 迁移窗口期：旧 key → 新 id（Rust rename 完成前的在途事件转发） */
export const aliasMap = new Map<string, string>();
/** 已完成定名的真实 id（finalizeSession 记）。判据用途：session_title 到达时
 *  区分「会话已存在（可安全改名）」与「尚未定名的临时 id（此刻落盘必成孤儿）」——
 *  后者包括别的客户端发起、本端只是事件旁观者的情况。 */
export const finalizedSids = new Set<string>();
/** 尚未被 SDK 确认的临时 key（纯内存，从未落盘）。resume 判定与 hydrate 跳过都靠它。 */
export const pendingSids = new Set<string>();
/** 已收口销毁的会话 id——拦截一切延迟到达的流式事件 / 定时器 / 失败兜底，防止
 *  getStore 自动重建僵尸 store（sidecar 在 stop 命令送达后仍会跑一会儿，收尾
 *  事件会经 getStore 把空 store 复活）。hydrate（重开）时移除。只增不减（每条
 *  销毁记录至多一条，残留无害），无大小风险。 */
export const disposedSids = new Set<string>();
/** sid → tool_use_id → ToolCallBlock：回填 O(1) 查找，替代 flatMap.find 全表扫描。
 *  per-sid 隔离：disposeSession 整 sid 删除无残留；finalizeSession 跟随 stores 迁移
 *  tempId→realId。
 *  契约：表内存 reactive(block) 代理，不是原始对象。block 是 push 进响应式
 *  messages 的同一引用，组件经 messages→blocks 链读到的是 Vue 包装的代理——
 *  直接改原始对象会绕过 set 陷阱、不触发重渲染（tool_result 已回填但卡片停在
 *  「等待结果…」，折叠重开/切会话强制重读才显示）；reactive() 经 reactiveMap
 *  身份缓存与组件读到的是同一代理，回填即触发。 */
export const pendingToolCalls = new Map<string, Map<string, ToolCallBlock>>();
/** sid → subagent_id → SubagentBlock（同上；子代理事件跨回合，pending 期更长）。 */
export const pendingSubagents = new Map<string, Map<string, SubagentBlock>>();

/** P1 双向分页游标：只记录「下一个更早页的起点字节」——取回后前进为
 *  nextOffsetBytes，内容必然前进不重复。 */
export const sessionPagination = new Map<string, { tailOffset: number }>();

/** 页台账条目（P1 回收半边，2026-08-28 重引入）：一页 = jsonl 的一段字节区间
 *  [startOffset, endOffset)。loaded=false 时该页消息已从 store.messages 释放，
 *  渲染层以 heightPx 骨架占位；取回 = load_messages(offset=endOffset, limit=bytes)
 *  确定性重放同一区间。页边界只由磁盘 offset 决定，流式新增消息不入页（属 live 段）。 */
export interface PageEntry {
  /** 稳定行 key（v-for/测量用） */
  id: string;
  /** 页首字节（= 加载时的 nextOffsetBytes） */
  startOffset: number;
  /** 页尾排他字节（= 本次读取的 endOffsetBytes） */
  endOffset: number;
  /** 页内消息数（取回后按实际返回数更新——预算边界允许条数漂移） */
  count: number;
  /** endOffset - startOffset（重取时的 limit） */
  bytes: number;
  /** 消息是否在 store.messages 中驻留 */
  loaded: boolean;
  /** 是否可按字节区间重取（endOffsetBytes 可信）。false = 来源应答缺 endOffsetBytes
   *  （版本错配等防御场景）——永不释放（驻留现状），不参与回收。 */
  restorable: boolean;
  /** 释放时实测高度（首末消息元素 rect 差）；无 DOM 可测时估算（count×均值） */
  heightPx: number;
}

/** sid → 页台账（旧→新有序）。不变式：store.messages = Σ(loaded 页消息按页序) + live 段；
 *  相邻页 pages[i].endOffset === pages[i+1].startOffset；tailOffset === pages[0].startOffset。 */
export const pageLedgers = new Map<string, PageEntry[]>();

/** 取/建会话页台账。⚠️ 与 getStore 同一响应式陷阱：必须先 reactive() 包装再入 Map
 *  返回——返回原始数组会让调用方以非响应式引用 splice/改字段，buildRows 不重算。 */
export function getOrCreateLedger(sid: string): PageEntry[] {
  let ledger = pageLedgers.get(sid);
  if (!ledger) {
    ledger = reactive<PageEntry[]>([]);
    pageLedgers.set(sid, ledger);
  }
  return ledger;
}

export function registerToolCall(sid: string, id: string, block: ToolCallBlock): void {
  let m = pendingToolCalls.get(sid);
  if (!m) {
    m = new Map();
    pendingToolCalls.set(sid, m);
  }
  m.set(id, reactive(block));
}
export function lookupToolCall(sid: string, id: string): ToolCallBlock | undefined {
  return pendingToolCalls.get(sid)?.get(id);
}
export function unregisterToolCall(sid: string, id: string): void {
  pendingToolCalls.get(sid)?.delete(id);
}
export function registerSubagent(sid: string, id: string, block: SubagentBlock): void {
  let m = pendingSubagents.get(sid);
  if (!m) {
    m = new Map();
    pendingSubagents.set(sid, m);
  }
  m.set(id, reactive(block));
}
export function lookupSubagent(sid: string, id: string): SubagentBlock | undefined {
  return pendingSubagents.get(sid)?.get(id);
}
export function unregisterSubagent(sid: string, id: string): void {
  pendingSubagents.get(sid)?.delete(id);
}

/** 每会话最近一次派发的用户提问文本——变更面板给轮次做标题用（见
 *  useConversationChanges.captureChanges）。只读快照，纯展示。 */
export const lastDispatchedPrompt: Record<string, string> = {};

/** 取某会话最近派发的用户提问（无则空串）。 */
export function getLastDispatchedPrompt(sid: string): string {
  return lastDispatchedPrompt[sid] ?? "";
}

/** 后台任务输出在 store 里的保留上限（超出截头保尾）。 */
export const BG_TASK_OUTPUT_CAP = 256 * 1024;
/** 子代理单条 entry / 最终产出的文本保留上限（P2-1，类比 BG_TASK_OUTPUT_CAP：超出
 *  截头保尾——流式结论在尾部）。写入时收敛：不等 P0-3 的 store 超阈值整块降级，
 *  单条大产出进入内存前就被截住，单个子代理块内存有界（此前 1 个子代理 10-50MB）。 */
export const SUBAGENT_ENTRY_CAP = 256 * 1024;
/** 后台任务列表上限——超出时淘汰最老的已结束项。 */
export const BG_TASKS_CAP = 50;

/** 切换后台任务 dock 开合。关闭→打开的瞬间清掉「打开前就已结束」的任务（用户确认
 *  的清理规则：结束不立即移除，下次点开列表时才移除）；打开→关闭同样清掉已结束的
 *  （查看期已过，没有运行中任务时状态条随之隐藏，不留「✓ 全部完成」僵尸条）。
 *  selectedId：指定打开后选中的任务（工具卡片「后台运行中」徽章点击时带）——
 *  dock 已开着时带 selectedId 不关闭，只切选中项。 */
export function toggleBgDock(sid: string, selectedId?: string): void {
  if (disposedSids.has(sid)) return;
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

export function clearBgDockAutoHide(sid: string): void {
  const t = bgDockAutoHideTimers.get(sid);
  if (t) {
    clearTimeout(t);
    bgDockAutoHideTimers.delete(sid);
  }
}

export function scheduleBgDockAutoHide(sid: string): void {
  clearBgDockAutoHide(sid);
  bgDockAutoHideTimers.set(
    sid,
    setTimeout(() => {
      const store = stores[sid];
      if (store && !store.bgDockOpen && store.bgTasks.every((t) => t.status !== "running")) {
        store.bgTasks = [];
        store.bgDockSelectedId = null;
      }
      bgDockAutoHideTimers.delete(sid);
    }, BG_DOCK_AUTOHIDE_MS),
  );
}

/** 会话创建回执回调集：finalizeSession 拿到真实 id 后逐个通知（App.vue 用它
 *  写元数据 / 加侧栏 / 记最近访问）。 */
export const sessionCreatedCallbacks = new Set<(tempId: string, realId: string) => void>();

/** 会话身份（provider/model SSOT）——绑定、落盘、恢复、门控基线统一在 L2 身份层。
 *  模块级共享：events 与宿主发送链路都要用。 */
export const identity = useSessionIdentity();
export const { state: sessionState, health: sessionHealth } = useSessionState();
const { setSessionState, setSessionHealth, removeSessionState, armStalled } = useSessionState();
export { setSessionState, setSessionHealth, armStalled };

/** 取会话 store（不存在则现场建一个空 store）。事件流/组件同步读共用——空 store
 *  重建是「首次打开」的常态路径（组件标记 disposed 的会话）。
 *
 *  ⚠️ 必须返回**响应式 proxy**：`stores` 是 `reactive({})`，`stores[sid] = store`
 *  只把深转换后的 proxy 存进表里，局部变量 `store` 仍是原始对象——直接返回它
 *  会让「首次创建的 store」由调用方以原始引用写入（hydrate 的 unshift 等），
 *  不触发任何响应式通知，UI 永不更新（2026-08-26 实锤：首开会话空白、
 *  切走再切回有数据）。创建后一律以 `reactive(store)` 包装再入库、返回。 */
export function getStore(sid: string): SessionStore {
  let store = stores[sid];
  if (!store) {
    store = reactive({
      messages: [],
      isBusy: false,
      pendingPermissions: [],
      hydrated: false,
      models: [],
      currentModel: "",
      modelSwitchResult: null,
      modelSwitchConfirm: null,
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
      rollbackText: "",
    });
    stores[sid] = store;
  }
  return store;
}

/** 临时 key 归一：aliasMap 迁移窗口期把旧 key 映射到真实 id（finalizeSession
 *  建 alias 到 Rust rename 完成期间，在途事件按 tempId 到达时转 realId 查找）。 */
export function resolveSid(raw: string): string {
  return aliasMap.get(raw) ?? raw;
}

export function isPendingSession(sid: string | null | undefined): boolean {
  return sid != null && pendingSids.has(sid);
}

/** 一个 sid 对（tempId, realId）是否构成「已确认过」的合法对——switch 会话后
 *  旧面板残留的 tempId 与当前面板的 realId 都指向同一会话时，用对判断去重。 */
export function isFinalizedSessionPair(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b || a === b) return false;
  return (aliasMap.get(a) ?? a) === (aliasMap.get(b) ?? b);
}

/** 取 store 里最近一条 assistant 消息；没有则现场造一条（流式续写目标）。
 *  新建即置 streaming（流式进行中）——finishStreaming 在 message_stop / 用户
 *  气泡插入前收尾。 */
export function getOrCreateAssistant(store: SessionStore): ChatMessage {
  const last = store.messages[store.messages.length - 1];
  if (last && last.role === "assistant") return last;
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
export function stampMessageModel(msg: ChatMessage, e: Record<string, unknown>) {
  if (msg.model || !e["model"]) return;
  msg.model = e["model"] as string;
  msg.modelLabel = (e["modelLabel"] as string) || (e["model"] as string);
}

/** 流式收尾：最后一条 assistant 消息摘掉 streaming 标记。幂等（无 streaming 消息时
 *  no-op）。isBusy 交给调用方按场景置。 */
export function finishStreaming(store: SessionStore): void {
  const last = store.messages[store.messages.length - 1];
  if (last?.streaming) last.streaming = false;
}

/** 运行时状态复位（stop / 会话死 / 权限拒绝兜底共用）——不碰 messages（历史保留）。 */
export function resetRuntimeState(store: SessionStore, clearTasks = true) {
  finishStreaming(store);
  store.isBusy = false;
  store.contextCompaction = null;
  store.pendingPermissions = [];
  store.pendingJumps.length = 0;
  if (clearTasks) store.tasks = [];
}

/** 按 sessionId 停止会话进程：杀 sidecar worker + 清运行时状态 + 释放 provider 绑定。
 *  模块级、不依赖当前激活 tab——供 usePaneLayout.closeTab 在关闭任意 tab 时按该 tab
 *  的 sid 就地停止（"关闭即停止"合并语义）。try/finally 吞错：进程已死 / 通信瞬断 /
 *  管道断也不抛，finally 兜底把前端状态置 stopped（UI 以这里为准，sidecar 对不存在的
 *  worker 是 no-op，幂等）。与原闭包内 stopSession 的 finally 完全一致，只是 sid 由
 *  调用方传入而非取激活 tab。 */
export async function stopSessionById(sid: string) {
  if (disposedSids.has(sid)) return;
  const store = getStore(sid);
  try {
    await api.stopChatSession(sid);
  } finally {
    resetRuntimeState(store);
    setSessionState(sid, "stopped");
    // 释放 provider 绑定：下拉随即回落到全局 active provider，体现"stop 后供应商
    // 才改变"；下次发消息会重新盖戳当前 active provider 并用它 spawn。
    identity.releaseBinding(sid);
  }
}

/** 会话前端状态彻底收口（关 tab / 删会话 / 预览改绑共用）：
 *  1) 标记 disposed → 拦截延迟事件防 getStore 重建僵尸 store；
 *  2) 删 store 与全部 per-sid 字典；
 *  3) releaseBinding 无条件调用（幂等）——兜「删会话 race：session_dead 先到 →
 *     closeTab 跳过 stopSessionById → 原 finally 里的释放被跳过」的漏调。
 *  同步函数：调用方（closeTab）在 removeTab 后同一 tick 调用，保证 store 删除
 *  先于 Vue 渲染 flush，不产生卸载期同步复活窗口。幂等，可重复调用。
 *
 *  刻意不做：aliasMap（反查复杂、残留条目小无害）、useNotification prevStates/nameCache
 *  （残留无害）。 */
export function disposeSession(sid: string): void {
  disposedSids.add(sid);
  delete stores[sid];
  removeSessionState(sid);
  identity.releaseBinding(sid);
  clearBgDockAutoHide(sid);
  pendingSids.delete(sid);
  delete lastDispatchedPrompt[sid];
  pendingToolCalls.delete(sid);
  pendingSubagents.delete(sid);
  sessionPagination.delete(sid);
  pageLedgers.delete(sid);
  useSessionNames().removeName(sid);
  useSessionWorkspaces().removeWorkspace(sid);
  // P2-3：btw 问答记忆随 owner 收口（后台仍跑的 btw 完成时重建单轮条目，无害）
  useBtwSession().clearBtwHistory(sid);
}

/** 文本/思考 entry 的窄化联合（tool 变体无 text）。 */
type TextLikeEntry = Extract<SubagentEntry, { type: "text" | "thinking" }>;

/** 追加一段 delta 并做 P2-1 摊还截断：累积超 2×cap 才截保尾——每个 delta 一次
 *  O(cap) slice 是流式热路径上的 O(n²) 放大，摊还到每 cap 字符一次；截断标记记录
 *  累计省略的字节。 */
function appendEntryText(entry: TextLikeEntry, delta: string) {
  const next = entry.text + delta;
  if (next.length > SUBAGENT_ENTRY_CAP * 2) {
    entry.truncated = {
      kind: entry.type,
      originalBytes: (entry.truncated?.originalBytes ?? 0) + (next.length - SUBAGENT_ENTRY_CAP) * 2,
    };
    entry.text = next.slice(-SUBAGENT_ENTRY_CAP);
  } else {
    entry.text = next;
  }
}

/** 子代理逐字增量累积：跟主线程 text_delta 同一套模式——最后一项同类型就原地追加，
 *  否则另起一项（类型切换，或被一次工具调用打断了连续的文本/thinking 段落）。 */
export function appendSubagentTextEntry(block: SubagentBlock, kind: "text" | "thinking", delta: string) {
  const last = block.entries[block.entries.length - 1];
  if (kind === "text") {
    if (last && last.type === "text") {
      appendEntryText(last, delta);
      return;
    }
    const entry: Extract<SubagentEntry, { type: "text" }> = { type: "text", text: "" };
    block.entries.push(entry);
    appendEntryText(entry, delta);
    return;
  }
  if (last && last.type === "thinking") {
    appendEntryText(last, delta);
    return;
  }
  const entry: Extract<SubagentEntry, { type: "thinking" }> = { type: "thinking", text: "" };
  block.entries.push(entry);
  appendEntryText(entry, delta);
}

/** 临时 key 首次被 SDK 确认为真实 session id：原地搬迁运行时状态，
 *  再交给 App.vue 去做真正的"创建"（写元数据 / 加侧栏 / 记最近访问）。
 *  临时 key 从未落盘，这里不需要触碰任何文件。 */
export async function finalizeSession(tempId: string, realId: string) {
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
  // 回填注册表跟随 stores 迁移：在途 tool_result / subagent 事件按 realId 查找
  if (pendingToolCalls.has(tempId)) {
    pendingToolCalls.set(realId, pendingToolCalls.get(tempId)!);
    pendingToolCalls.delete(tempId);
  }
  if (pendingSubagents.has(tempId)) {
    pendingSubagents.set(realId, pendingSubagents.get(tempId)!);
    pendingSubagents.delete(tempId);
  }
  // 分页游标链跟随 stores 迁移（上滚取回/释放的 offset 记录随会话定名）
  if (sessionPagination.has(tempId)) {
    sessionPagination.set(realId, sessionPagination.get(tempId)!);
    sessionPagination.delete(tempId);
  }
  // 页台账同理（骨架/释放状态随定名保留）
  if (pageLedgers.has(tempId)) {
    pageLedgers.set(realId, pageLedgers.get(tempId)!);
    pageLedgers.delete(tempId);
  }
  // provider 绑定也跟着搬迁：临时 id 在 sendMessage 时已盖戳，拿到真实 id 后不能丢
  identity.migrateBinding(tempId, realId);
  // 工作区归属同样搬迁（sendMessage 首发时 seed 的创建时绑定快照）
  useSessionWorkspaces().migrate(tempId, realId);
  // btw 支线抽屉绑定/支线记忆 key 跟随定名（git-commit 可从 pending 会话发起，
  // ownerSid 记的是临时 id；不迁抽屉永久失绑）
  useBtwSession().rebindOwner(tempId, realId);
  // 待用标题跟随定名（session_title 早于本函数到达，暂存在 tempId 下；
  // 不迁则落盘方取不到，会话只能退回默认名「新会话 HH:MM:SS」）
  useSessionNames().migratePendingTitle(tempId, realId);
  // 2. Runtime 内部管理 session 映射（SessionManager 的 Map），不需要 Rust 改名
  finalizedSids.add(realId); // 此后到达的 session_title 属于「已存在会话」，可安全改名
  // 3. 通知 App.vue：这是第一次创建，去写元数据、加侧栏、记最近访问
  for (const cb of sessionCreatedCallbacks) cb(tempId, realId);
  // 首条 pending：onSendRequest 时 sid=null 只推进了基线没落盘（会话还没创建），
  // 这里拿到 realId 后补落盘。effectiveProvider/effectiveModel 来自 L2（currentSid 仍 null
  // → activeProvider + pendingDraft），与 onSendRequest 推进的基线同源。
  await identity.settleOnSend(realId, identity.effectiveProvider.value);
}

/** 测试钩子：重置全部模块级状态（__resetForTest 的宿主侧实现）。 */
export function resetAllState(): void {
  for (const k of Object.keys(stores)) delete stores[k];
  sessionPagination.clear();
  pageLedgers.clear();
  pendingToolCalls.clear();
  pendingSubagents.clear();
  disposedSids.clear();
  pendingSids.clear();
  aliasMap.clear();
  finalizedSids.clear();
  for (const k of Object.keys(lastDispatchedPrompt)) delete lastDispatchedPrompt[k];
  sessionCreatedCallbacks.clear();
  const { state, removeSessionState } = useSessionState();
  for (const k of Object.keys(state)) removeSessionState(k);
  useSessionWorkspaces().clearAll(); // 归属注册表同属模块级状态，一并归零
  useSessionNames().clearPendingTitles(); // 待用标题同上
}
