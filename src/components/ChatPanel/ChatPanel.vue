<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, onUnmounted } from "vue";
import ChatRow from "./ChatRow.vue";
import AppLogo from "../AppLogo.vue";
import Icon from "../Icon.vue";
import ContextCompactionStatus from "../ContextCompactionStatus.vue";
import TaskListPanel from "../TaskListPanel.vue";
import InterruptButton from "../InterruptButton.vue";
import PermissionDialog from "../PermissionDialog.vue";
import BgTaskDock from "../BgTaskDock.vue";
import HeroWelcome from "./hero/HeroWelcome.vue";
import ChatInputBox from "./ChatInputBox.vue";
import ModelSwitchConfirm from "./ModelSwitchConfirm.vue";
import BtwDrawer from "../BtwDrawer.vue";
import type { BgTask, ChatMessage as ChatMessageType, ContextCompactionState, ContextUsage, ModelOption, ModelSwitchResult, PermissionModeOption, PermissionRequest, RateLimitInfo, TaskItem } from "@/types/chat";
import type { WorkspaceInfo } from "@/types";
import { api } from "@/api";
import { deriveSessionFileRules } from "@/utils/permissionRuleDerivation";
import { trail } from "../../utils/diagnostics/scrollTrail";
import type { PermissionRuleDraft, PermissionScope } from "@/types/permissions";
import {
  usePermissionRememberContext,
  type RememberPersistResult,
} from "@/composables/usePermissionRememberContext";
import type { PendingJump, SendOptions } from "@/composables/useChatSession";
import { useChatScroll } from "@/composables/useChatScroll";
import { useProviders } from "@/composables/useProviders";
import type { ProviderConfig } from "@/types";
import { setChatPaneRect } from "@/composables/useChatPaneWidth";
import { useBtwSession } from "@/composables/useBtwSession";
import { useSessionIdentity, buildConfirmDecision, type ConfirmDecision } from "@/composables/sessionIdentity";
import {
  isPendingSession,
  toggleBgDock,
  loadOlderPage,
  hasMoreOlder,
} from "@/composables/useChatSession";
import { useToast } from "@/composables/useToast";
import { effortLabel } from "@aide/sdk/utils/effort";

const props = defineProps<{
  sessionId: string | null;
  workspacePath?: string;
  /** 父层经模板自动解包后传入的纯值（PaneGroup 传 useChatSession computed，模板解包成数组） */
  messages: ChatMessageType[];
  isBusy: boolean;
  models?: ModelOption[];
  currentModel?: string;
  /** 模型切换坐实回执（sidecar 运行时路径发出）——据此弹成功/失败瞬时提示 */
  modelSwitchResult?: ModelSwitchResult | null;
  /** sidecar 坐实的当前 effort（effort_changed 事件）；空串 = 还没学到 */
  currentEffort?: string;
  /** effort 切换失败回执（sidecar 驳回，选择器已被回滚拉回旧值）——据此弹失败提示 */
  effortSwitchError?: { message: string; seq: number } | null;
  contextUsage?: ContextUsage | null;
  /** 当前会话的短生命周期压缩状态；不属于消息历史。 */
  contextCompaction?: ContextCompactionState | null;
  /** 账号级订阅额度/速率；null 时不显示 */
  rateLimit?: RateLimitInfo | null;
  tasks?: TaskItem[];
  permissionModes?: PermissionModeOption[];
  currentPermissionMode?: string;
  /** 忙碌时排队、正在 sidecar 里等安全边界的消息（顺序即发出顺序）；jump_promoted 后清空 */
  pendingJumps?: PendingJump[];
  /** 后台 shell 任务列表 + dock 开合状态（useChatSession store 透传） */
  bgTasks?: BgTask[];
  /** 父层恒传（PaneGroup 的 useChatSession computed 透传），非可选 */
  bgDockOpen: boolean;
  bgDockSelectedId?: string | null;
  /** 本会话待确认的权限/提问请求——渲染在消息区和输入框之间（见模板），
   *  不是浮层，见 PermissionDialog.vue 顶部注释。 */
  permission?: PermissionRequest | null;
  permissionQueueCount?: number;
  /** 图片 400 回滚后待放回输入框的文本（useChatSession 透传；空串 = 无待回填）。
   *  回填后 emit rollback-text-consumed 清空，避免重复回填。 */
  rollbackText?: string;
  /** 父层恒传（PaneGroup 的聚焦判定 computed），非可选 */
  focused: boolean;
}>();

const emit = defineEmits<{
  send: [prompt: string, opts: SendOptions];
  "send-btw": [prompt: string, opts: { lightweight: boolean; model?: string; effort?: string }];
  "send-btw-task": [opts: { taskId: string }];
  interrupt: [];
  "set-model": [model: string];
  "set-effort": [effort: string];
  "set-permission-mode": [mode: string];
  /** 权限/提问请求的放行结果：req 具名对象（nextMode/reason 相邻 string 不再错位），
   *  sessionRules 为会话级规则草稿（「允许」文件工具时前端推导，随放行透传） */
  "respond-permission": [req: { id: string; approved: boolean; answers?: Record<string, string>; nextMode?: string; reason?: string }, sessionRules?: PermissionRuleDraft[]];
  "update:bgDockSelectedId": [id: string];
  /** hero 归属选择：选中的是会话归属，不是活动工作区（PaneGroup 据此改 pendingWs/defaultWs） */
  "select-workspace": [ws: WorkspaceInfo];
  /** 图片 400 回滚文本已回填进输入框（父组件据此清空 store.rollbackText） */
  "rollback-text-consumed": [];
}>();

const rootEl = ref<HTMLElement | null>(null);
let widthObserver: ResizeObserver | null = null;

function reportWidth() {
  if (props.focused && rootEl.value) {
    const r = rootEl.value.getBoundingClientRect();
    setChatPaneRect(r.left, r.width);
  }
}

onMounted(() => {
  reportWidth();
  if (typeof ResizeObserver !== "undefined") {
    widthObserver = new ResizeObserver(() => reportWidth());
    if (rootEl.value) widthObserver.observe(rootEl.value);
  }
});
onUnmounted(() => { widthObserver?.disconnect(); widthObserver = null; });
watch(() => props.focused, () => reportWidth());

const { allProviders, systemDefault, SYSTEM_DEFAULT_ID } = useProviders();
const identity = useSessionIdentity();

// 会话所属 provider：存活会话锁定它 spawn 那一刻的 provider（存在 useSessionProviders
// 注册表里），全局切换供应商不影响已启动会话的模型下拉；没有绑定（新会话/已 stop/
// 重开历史）时回落到全局 active provider——这正是"stop_session 后供应商才改变"的
// 体现。下拉的选项列表与默认选中都跟 sessionProvider 走，不再跟 activeProvider。
const sessionProvider = computed<ProviderConfig>(() => {
  const id = identity.effectiveProvider.value;
  if (id === SYSTEM_DEFAULT_ID) return systemDefault.value;
  return allProviders.value.find((p) => p.id === id) ?? systemDefault.value;
});

// 会话身份（L2 SSOT）+ 发送前确认门控（L3 gate）。identity 持 provider/model 绑定、
// 落盘、恢复、门控基线；buildConfirmDecision 纯函数判定要不要弹确认。

// 发送前确认（变体 C）：当 performSend 检测到本次发送的 provider/模型与会话上次不同
// （停止/重开会话 respawn，fork/冷缓存代价）时，不立即发送，构造一份合成的
// PermissionRequest（name="__sendConfirm__"）交给 PermissionDialog 渲染确认形态，
// pendingSend 暂存待发的 prompt+opts。确认 → resumeSend：清输入并 emit send；取消 →
// clearSendConfirm：保留输入（内容回退到对话框）。
interface SendConfirmState {
  /** 合成的确认请求（其 id 即 PermissionDialog respond 回传的 id，匹配用）。 */
  request: PermissionRequest;
  pendingSend: { prompt: string; opts: SendOptions };
  /** 本次发送将生效的供应商/模型——确认后用它推进 continuity.lastUsed 基线。 */
  effectiveProvider: string;
  effectiveModel: string;
}
const sendConfirm = ref<SendConfirmState | null>(null);
/** PermissionDialog 显示的请求：发送前确认优先于真实权限请求（两者互斥——发送时
 *  不会有 sidecar 权限请求在排队）。 */
const displayedPermission = computed<PermissionRequest | null>(
  () => sendConfirm.value?.request ?? props.permission ?? null,
);

/** 构造发送前确认的合成请求（变体 C）：仅供应商 respawn 维度（模型维度的切换
 *  确认在 PreModelSwitch hook 的切换前弹窗，不在发送门控）。复用 PermissionDialog
 *  的 AskUserQuestion 视觉语言渲染。input 全前端字段，不进 sidecar。 */
function buildSendConfirmRequest(decision: ConfirmDecision, effectiveModel: string): PermissionRequest {
  const newProviderName = sessionProvider.value.name || decision.effective;
  const oldProviderName = decision.last
    ? (allProviders.value.find((p) => p.id === decision.last)?.name ?? decision.last)
    : "";
  return {
    id: `send-confirm-${crypto.randomUUID()}`,
    name: "__sendConfirm__",
    input: {
      title: "本次发送将切换供应商",
      chip: "切换确认",
      question: `将以 ${newProviderName}/${effectiveModel} 发送（原 ${oldProviderName}）`,
      info: `切换供应商会重新拉起会话进程，提示缓存失效；对话历史将迁移到新会话继续。模型身份由进程坐实事件记录，无需在此确认。`,
      confirmLabel: `继续发送 · ${effectiveModel}`,
    },
  };
}

// 会话还没开始时没有活的 sidecar 进程，SDK 的 models_available 事件还没发生，
// props.models 是空的——依次退化：provider 设置里配置的 knownModels（用户自己
// 填的） > 静态默认列表（读本地文件，不起进程，见 get_default_models），
// 让用户进会话就能选模型，不用等发完第一条消息。
const defaultPermissionModes = ref<PermissionModeOption[]>([]);
onMounted(async () => {
  // 系统默认静态兜底模型列表归 L2（identity.refreshDefaultModels）；权限模式仍在此读。
  void identity.refreshDefaultModels();
  try {
    defaultPermissionModes.value = await api.getDefaultPermissionModes();
  } catch {
    // 读不到就用内置默认，不影响其他功能
  }
});

// 当前会话下拉选项（第三方 providerModelList / 系统默认 SDK 动态列表）统一归 L2 身份层。
const displayModels = computed<ModelOption[]>(() => identity.displayModels.value);

const { toastState, showToast } = useToast();


// ── 「允许并记住」上下文 ──
// 快照拉取/竞态守卫/落盘全部收口在 usePermissionRememberContext（显式三态
// loading/ready/failed + 代际号），ChatPanel 只透传 state 给弹窗、按落盘
// 回执分派 toast。注意 requestId 钉在 props.permission（真实权限请求）上而非
// displayedPermission——sendConfirm 是本地合成请求，不该触发权限快照拉取。
// workspacePath prop 是弹窗所属会话自己的工作区（PaneGroup 按会话注册解析，
// 不随活动工作区变化）——「记住」的可用性判定与落盘必须钉在它上面：弹窗挂起
// 期间切了工作区，Rust 侧按当前活动工作区解析会把规则写进新工作区（bug）。
const {
  state: rememberState,
  persistRemember,
} = usePermissionRememberContext({
  requestId: () => props.permission?.id ?? null,
  workspacePath: () => props.workspacePath,
});

/** 落点作用域的中文措辞（toast 用）。 */
function scopeWordFor(scope: PermissionScope): string {
  return scope === "local" ? "本项目本地" : scope === "user" ? "用户全局" : scope;
}

/** 「允许并记住」落盘回执 → toast 文案。落盘失败仍放行本次（不阻塞用户），仅提示。 */
function toastRememberResult(result: RememberPersistResult): void {
  switch (result.outcome) {
    case "persisted":
      showToast(
        `已记住到${scopeWordFor(result.scope)}（${result.count} 条），下次自动放行`,
        "success",
      );
      return;
    case "all-covered":
      showToast("现有规则已放行同类调用，无需重复记住", "success");
      return;
    case "no-editable-scope":
      showToast("没有可写入的权限作用域，本次仍已放行", "danger");
      return;
    case "failed":
      showToast(`记住规则失败：${result.error}（本次仍已放行）`, "danger");
  }
}

// 滚动诊断环：弹窗显隐标记。滚轮定格的嫌疑方向之一是弹窗挤压/死区——留下
// show/hide 时间戳，定格时与 wheel/scroll 记录互证（弹窗出现前后滚轮是否还
// 落在对话区）。
watch(
  () => props.permission?.id ?? null,
  (id) => trail("perm", id ? `show:${props.permission?.name}` : "hide"),
);

/** PermissionDialog 的 respond 统一入口：处理「记住」持久化 + 会话规则推导 +
 *  权限模式同步 + 放行。发送前确认（变体 C，name="__sendConfirm__"）在此本地
 *  路由——不走 sidecar 权限协议。 */
async function onPermissionRespond(
  id: string,
  approved: boolean,
  answers?: Record<string, string>,
  nextMode?: string,
  persistRule?: { scope: PermissionScope; rules: PermissionRuleDraft[] },
  reason?: string,
) {
  // 发送前确认：approved→发送 + 推进 lastUsed 基线 + 递增坐实信号（输入框据此清空
  // 输入）；取消→保留输入（回退对话框）。匹配 id 用 sc.request.id（即 PermissionDialog
  // respond 回传的 permission.id）。
  const sc = sendConfirm.value;
  if (sc && sc.request.id === id) {
    if (approved) {
      identity.settleOnSend(props.sessionId ?? "", sc.effectiveProvider);
      emit("send", sc.pendingSend.prompt, sc.pendingSend.opts);
      sendConfirmedNonce.value++;
    }
    sendConfirm.value = null;
    return;
  }
  // nextMode 由 PermissionDialog 的「进入编辑模式/自动」按钮传（acceptEdits/auto），
  // 防御性更新对话框展示用 ref；输入框选择器是用户侧事实源，不经此同步。
  if (nextMode) permissionMode.value = nextMode;
  if (approved && persistRule) {
    // 落盘（现拉最新规则库 + 语义过滤，收口在 composable）→ 回执分派 toast；
    // 失败仍放行本次（toastRememberResult 内提示），不阻塞用户。
    toastRememberResult(await persistRemember(persistRule));
  }
  // 会话级规则：手动模式下点普通「允许」放行文件工具（Edit/Write/MultiEdit/
  // NotebookEdit）时，推导精确文件 allow 规则随放行透传 sidecar 入库——本会话内
  // 同文件不再询问。仅普通允许走这条：「允许并记住」已持久化目录级规则（folder
  // ⊇ file，会话规则冗余）；「进入编辑模式」切 acceptEdits 已覆盖。发送前确认
  // 已提前 return，走到这里 props.permission 必为真实权限请求。
  let sessionRules: PermissionRuleDraft[] | undefined;
  if (approved && !persistRule && !nextMode && props.permission && props.permission.id === id) {
    sessionRules = deriveSessionFileRules(props.permission.name, props.permission.input);
    if (sessionRules.length === 0) sessionRules = undefined;
  }
  emit("respond-permission", { id, approved, answers, nextMode, reason }, sessionRules);
}

/** 发送坐实信号：门控通过/确认后递增，ChatInputBox 据此清空输入（取消确认不递增，
 *  输入保留——与旧实现「取消时内容回退对话框」语义一致）。 */
const sendConfirmedNonce = ref(0);

/** 输入框的发送请求统一入口：跑发送前确认门控（provider respawn 维度——模型
 *  维度的切换确认已移交 SDK PreModelSwitch hook 的切换前弹窗，本门控不再比对
 *  模型；见 2026-09-01-model-switch-truth-design.md §2）。需确认 → 弹确认形态
 *  （不清输入，取消时内容回退对话框）；否则直接发送 + 推进 provider 基线 +
 *  递增 sendConfirmedNonce（输入框据此清空输入）。 */
function onSendRequest(prompt: string, opts: SendOptions & { effectiveProvider: string; effectiveModel: string }) {
  // 拆出确认门控用的 provider/模型，真实发送只带纯 SendOptions（不给 useChatSession 传额外字段）
  const { effectiveProvider, effectiveModel, ...sendOpts } = opts;
  const sidForGate = props.sessionId;
  if (sidForGate && !isPendingSession(sidForGate) && !props.isBusy) {
    const decision = buildConfirmDecision(effectiveProvider, identity.lastProvider.value);
    if (decision) {
      sendConfirm.value = {
        request: buildSendConfirmRequest(decision, effectiveModel),
        pendingSend: { prompt, opts: sendOpts },
        effectiveProvider,
        effectiveModel,
      };
      return;
    }
  }
  identity.settleOnSend(sidForGate ?? "", effectiveProvider);
  emit("send", prompt, sendOpts);
  sendConfirmedNonce.value++;
}

/** 权限模式（PermissionDialog current-mode 展示用）：ChatInputBox 的
 *  selectedPermissionMode 变化时经 permission-mode-changed 事件同步。 */
const permissionMode = ref("");

// ── 权限模式（plan / acceptEdits / default）——和模型下拉同一套模式：
// 会话没起进程时用静态兜底清单，用户的选择随每条消息的 permission_mode 带走；
// 进程活着时切换走运行时命令，显示状态靠 sidecar 回发的事件坐实。
const displayPermissionModes = computed<PermissionModeOption[]>(() =>
  props.permissionModes?.length ? props.permissionModes : defaultPermissionModes.value,
);

const contextCompactionVal = computed(() => props.contextCompaction ?? null);

// ── hero（零会话欢迎态）────────────────────────────────────────────────────
// 判定 = 未绑定会话且无消息：零 tab 布局与「新会话」空白预览 tab 共用这一套
// 居中样式。hero 是独立欢迎组件（HeroWelcome：时间问候 + 轮换文案），
// 输入盒/工具栏/发送路径仍全部复用。
const isHero = computed(() => !props.sessionId && props.messages.length === 0);
// 归属显示交给欢迎组件内嵌的 WorkspacePicker（path → 末段目录名）。
// 模型名由 ChatInputBox 上报（hero-model-name 事件）——选中模型在输入框组件内，
// hero 欢迎区只读展示，不持有选择状态。
const heroModelName = ref("");

// 离开 hero 的 FLIP 过渡：状态翻转瞬间（DOM 还没变，flush:"pre"）记录输入盒
// 位置，布局切到正常对话后让输入盒从旧位置平滑「落」到底部（零 tab → 建 tab
// 时 tab 栏出现造成的位移也一并被这次 FLIP 覆盖）。只在翻转瞬间量两次 rect、
// 只动 transform，不碰滚动区——本项目有 O(n²) 渲染/强布局前科，此处保持零负担。
// 输入盒根元素（.chat-input-area）经 ChatInputBox 的 defineExpose({ rootEl }) 暴露。
const inputBoxRef = ref<{ rootEl: HTMLElement | null } | null>(null);
const heroLeaving = ref(false); // 首条消息淡入用的一次性 class

watch(isHero, (now, prev) => {
  if (!prev || now) return;
  const el = inputBoxRef.value?.rootEl ?? null;
  const oldTop = el?.getBoundingClientRect().top ?? null;
  heroLeaving.value = true;
  setTimeout(() => { heroLeaving.value = false; }, 350);
  if (oldTop === null) return;
  void nextTick(() => {
    const el2 = inputBoxRef.value?.rootEl ?? null;
    if (!el2) return;
    if (typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const dy = oldTop - el2.getBoundingClientRect().top;
    if (!dy) return;
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      el2.style.transition = "";
      el2.style.transform = "";
      el2.removeEventListener("transitionend", cleanup);
    };
    el2.style.transition = "none";
    el2.style.transform = `translateY(${dy}px)`;
    requestAnimationFrame(() => {
      el2.style.transition = "transform .28s var(--aide-ease)";
      el2.style.transform = "translateY(0)";
      el2.addEventListener("transitionend", cleanup);
      setTimeout(cleanup, 450); // transitionend 可能不触发（元素卸载等），兜底清场
    });
  });
}, { flush: "pre" });

// 通用思考行与压缩状态条共用一个秒级计时器：压缩时以 SDK 生命周期到达的
// startedAt 为准，普通生成时才从 busy 开始计时。不会额外引入高频更新。
const activityElapsed = ref(0);
const busyStartedAt = ref<number | null>(null);
let activityTimer: ReturnType<typeof setInterval> | null = null;

function activeActivityStartedAt(): number | null {
  const compaction = contextCompactionVal.value;
  // 失败条会留在界面中供用户阅读，但它已不是运行态，不能继续每秒刷新。
  if (compaction) return compaction.stage === "compacting" ? compaction.startedAt : null;
  return busyStartedAt.value;
}

function refreshActivityElapsed() {
  const startedAt = activeActivityStartedAt();
  activityElapsed.value = startedAt === null ? 0 : Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

function syncActivityTimer() {
  const startedAt = activeActivityStartedAt();
  if (startedAt === null) {
    activityElapsed.value = 0;
    if (activityTimer) {
      clearInterval(activityTimer);
      activityTimer = null;
    }
    return;
  }
  refreshActivityElapsed();
  if (!activityTimer) activityTimer = setInterval(refreshActivityElapsed, 1000);
}

watch(() => props.isBusy, (busy) => {
  busyStartedAt.value = busy ? Date.now() : null;
  syncActivityTimer();
}, { immediate: true });
watch(contextCompactionVal, syncActivityTimer);
onUnmounted(() => { if (activityTimer) clearInterval(activityTimer); });

// 滚动 / 加载历史 / 页级回收全部收拢到 useChatScroll（行模型）：上滚到顶部触发带
// 自动取更早页；已加载页超字节预算时热区外页折叠成骨架（实测高度撑住不跳滚），
// 滚动停驻时结算回收/取回；切会话首帧 ramp 分帧挂载防 jam。
// 见 composables/useChatScroll.ts 与 useChatSession/recycle.ts。
const {
  scrollEl,
  contentEl,
  visibleRows,
  ramping,
  onScroll,
  jumpToBottom,
  farFromBottom,
  newWhileAway,
  expandOlderAnchored,
  restoreAnchored,
} = useChatScroll(() => props.messages, () => props.sessionId, {
  // P1 双向分页：所有分页函数绑定当前会话（props.sessionId 变化时闭包读新值）。
  // sessionId 为空（新会话未创建）时全链路 no-op。
  pagination: {
    hasMore: () => (props.sessionId ? hasMoreOlder(props.sessionId) : false),
    loadOlder: (limit) => (props.sessionId ? loadOlderPage(props.sessionId, limit) : Promise.resolve(0)),
  },
});

// 顶部入口按钮的「磁盘还有更早页」开关（模板里直接读，sessionId 空时 no-op）。
const canLoadOlder = computed(() => (props.sessionId ? hasMoreOlder(props.sessionId) : false));

// btw 轻量开关：BtwDrawer 与 ChatInputBox 共用（输入框经 prop 读、emit 回写）。
const btwLightweight = ref(true);

const btw = useBtwSession();
// 抽屉可见性:status 非 idle 且本窗口的活动会话正是被 fork 的那个主会话。
// btw store 是全局单例,但抽屉 per-ChatPanel 挂载——只看 status 会让任意窗口触发
// 时所有窗口的抽屉一起弹出。ownerSessionId 把抽屉绑回触发它的那个会话窗口。
const btwDrawerVisible = computed(
  () => btw.store.value.status !== "idle"
    && !btw.store.value.minimized
    && btw.store.value.ownerSessionId !== null
    && btw.store.value.ownerSessionId === props.sessionId,
);
// 抽屉标题里"· btw"那块小字换成这条支线实际用的模型名(查下拉 displayName,查不到回落原值)
// + 实际 effort 档位——"/btw 问题"直发不进输入模式,选择器显示的仍是主会话档位,
// 支线真实跑什么只能看这里(2026-08-02 用户实锤分不清 HIGH 是显示还是实际)。
// 档位显示走 effortLabel（三档中文，medium/xhigh 历史值映射相邻档位）。
const btwModelLabel = computed(() => {
  const v = btw.store.value.model;
  const base = v
    ? (displayModels.value.find((m) => m.value === v)?.displayName ?? v)
    : "btw";
  const eff = btw.store.value.effort;
  return eff ? `${base} · ${effortLabel(eff)}` : base;
});
// 「关闭」按状态分两种语义:
//  - 还在跑(starting/running):最小化——抽屉收起,sidecar 继续后台跑,跑完结论
//    照样作为批注插进主对话(不杀进程,用户要的就是这个)。
//  - 已结束/出错(done/error):teardown——杀残留 sidecar(出错时可能挂着一个僵
//    尸进程)、reset 回 idle。否则 error 态会卡在抽屉里关不掉、进程也赖着不死。
function closeBtw() {
  if (btw.store.value.isBusy) btw.minimize();
  else btw.cleanup();
}




/** 工具卡片「后台运行中」徽章：打开 dock 并选中对应任务（toggleBgDock 已开时只切选中）。 */
function onOpenBgDock(taskId: string) {
  if (props.sessionId) toggleBgDock(props.sessionId, taskId);
}
</script>

<template>
  <div ref="rootEl" class="chat-panel" :class="{ 'chat-panel--hero': isHero, 'chat-panel--hero-leaving': heroLeaving }">
    <TaskListPanel v-if="props.tasks && props.tasks.length > 0" :tasks="props.tasks" />

    <!-- 滚动区 wrapper：接手 .chat-messages 的 flex 占位，并作为「回到底部」
         悬浮按钮的定位锚点——按钮若直接放进滚动容器会随内容一起滚走；
         相对 chat-panel 绝对定位又无法自适应输入框/权限区的高度变化 -->
    <div class="chat-scroll-wrap">
      <div ref="scrollEl" class="chat-messages" @scroll.passive="onScroll">
      <div v-if="props.messages.length === 0" class="chat-empty">
        开始新对话
      </div>
      <!-- 内容盒：ResizeObserver 的观察目标（见 useChatScroll 的 contentObserver），
           纯布局 wrapper，消息增高的任何来源都会反映为它的盒高变化 -->
      <div ref="contentEl" class="chat-messages-body">
        <button
          v-if="canLoadOlder && !ramping"
          class="chat-history-gate"
          @click="expandOlderAnchored"
        >
          上方还有更早消息 · 点击或继续上滚加载
        </button>
        <ChatRow
          v-for="row in visibleRows"
          :key="row.id"
          :row="row"
          :workspace-path="workspacePath"
          :models="displayModels"
          :bg-tasks="bgTasks"
          @open-bg-dock="onOpenBgDock"
          @restore="restoreAnchored"
        />
      </div>
      </div>

      <!-- 回到底部：常驻渲染、class 控制显隐，留出淡入/上浮过渡；
           上翻期间来新消息时尾部亮铜色小点 -->
      <button
        class="jump-bottom"
        :class="{ 'jump-bottom--hidden': !farFromBottom }"
        v-tooltip="'回到底部'"
        @click="jumpToBottom"
      >
        <Icon name="arrow-down" :size="12" :stroke-width="1.6" />
        <span>回到底部</span>
        <span v-if="newWhileAway" class="jump-bottom-dot" />
      </button>
    </div>

    <!-- 权限确认 / AskUserQuestion / 发送前确认（变体 C）：挤在消息区和输入框之间，
         占真实布局空间而不是悬浮遮挡——上面 .chat-messages 是 flex:1，这块一出现
         就自动让出高度，正文和输入框都不会被盖住。displayedPermission 优先显示
         发送前确认（本地合成请求），其次真实权限请求。 -->
    <PermissionDialog
      :permission="displayedPermission"
      :queue-count="permissionQueueCount"
      :remember-context="rememberState"
      :current-mode="permissionMode"
      @respond="onPermissionRespond"
    />

    <!-- 模型切换成本确认：sidecar PreModelSwitch hook 挂起时由 store.modelSwitchConfirm
         驱动（切换发生前弹窗，SDK 真相裁决），与发送前确认（respawn 维度）不同轴 -->
    <ModelSwitchConfirm
      v-if="props.sessionId && !isPendingSession(props.sessionId)"
      :session-id="props.sessionId"
    />

    <!-- 活动状态行（上下文压缩 / 正在思考）：inline dock，固定位于后台任务 dock 上方——
         生成状态是当前会话的第一信息，后台任务条只是次要入口；
         不随消息滚动——上滚读历史时状态可见、中断按钮仍触手可及；
         出现时挤压消息区高度，与 PermissionDialog 同一模式。 -->
    <ContextCompactionStatus
      v-if="contextCompactionVal"
      :status="contextCompactionVal"
      :elapsed-seconds="activityElapsed"
      @interrupt="emit('interrupt')"
    />
    <div v-else-if="props.isBusy" class="chat-thinking">
      <AppLogo :size="15" animated />
      <span class="chat-thinking-text">正在思考</span>
      <InterruptButton class="chat-interrupt-btn" @click="emit('interrupt')" />
    </div>

    <!-- 后台任务 dock：与 PermissionDialog 同款 inline dock——挤压消息区而非浮层。
         位于活动状态行之下（状态行固定在上，后台条出现/消失不顶走它）。
         开合/清理语义在 toggleBgDock（结束的任务下次点开才清）。 -->
    <BgTaskDock
      :session-id="props.sessionId"
      :tasks="bgTasks ?? []"
      :open="bgDockOpen"
      :selected-id="bgDockSelectedId ?? null"
      @update:selected-id="(id: string) => emit('update:bgDockSelectedId', id)"
    />

    <!-- hero 欢迎区（零会话欢迎态）：时间问候 + 轮换文案（HeroWelcome）。
         模型/权限模式的实际选择仍在输入盒工具栏。 -->
    <Transition name="hero-fade">
      <HeroWelcome
        v-if="isHero"
        :workspace-path="props.workspacePath ?? ''"
        :model-name="heroModelName"
        @select-workspace="(ws) => emit('select-workspace', ws)"
      />
    </Transition>

    <!-- 输入区（textarea + 工具栏 + 全部输入逻辑）已拆为独立组件 ChatInputBox：
         输入框相关的改动（如 effort 选择器）不再动 ChatPanel。发送走 send-request
         门控（onSendRequest），确认后经 sendConfirmedNonce 坐实清空输入。 -->
    <ChatInputBox
      ref="inputBoxRef"
      :session-id="props.sessionId"
      :workspace-path="props.workspacePath"
      :is-busy="props.isBusy"
      :is-hero="isHero"
      :models="displayModels"
      :current-model="props.currentModel"
      :model-switch-result="props.modelSwitchResult"
      :current-effort="props.currentEffort"
      :effort-switch-error="props.effortSwitchError"
      :permission-modes="displayPermissionModes"
      :current-permission-mode="props.currentPermissionMode"
      :context-usage="props.contextUsage"
      :rate-limit="props.rateLimit"
      :pending-jumps="props.pendingJumps"
      :rollback-text="props.rollbackText"
      :focused="props.focused"
      :session-provider="sessionProvider"
      :send-confirmed-nonce="sendConfirmedNonce"
      :btw-lightweight="btwLightweight"
      @send-request="onSendRequest"
      @send-btw="(prompt, opts) => emit('send-btw', prompt, opts)"
      @send-btw-task="(opts) => emit('send-btw-task', opts)"
      @set-model="(m) => emit('set-model', m)"
      @set-effort="(e) => emit('set-effort', e)"
      @set-permission-mode="(m) => emit('set-permission-mode', m)"
      @rollback-text-consumed="emit('rollback-text-consumed')"
      @update:btw-lightweight="btwLightweight = $event"
      @hero-model-name="heroModelName = $event"
      @permission-mode-changed="permissionMode = $event"
    />
    <BtwDrawer
      :visible="btwDrawerVisible"
      :lightweight="btwLightweight"
      :model-label="btwModelLabel"
      @update:lightweight="btwLightweight = $event"
      @close="closeBtw"
    />
  </div>
</template>

<style scoped>
.chat-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--aide-bg-deep);
  color: var(--aide-text-primary);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  /* 会话区字体的唯一来源：整个聊天面板（消息流正文/输入框/工具栏/slash 下拉/btw 抽屉/
     权限确认区/toast）统一继承用户配置的等宽字体，不再逐叶子补丁。--aide-font-mono 由
     useSettings watch 同步成 settings.fontFamily（界面字体，同时驱动 --aide-font-ui
     控制 UI 正文）；编辑器走 editorFontFamily、终端走 terminalFontFamily，各自独立。
     代码块与 inline code 在 ChatMessage.vue 自带显式 var(--aide-font-mono)，不受影响；
     CJK 等无 JBM 字形的字符由浏览器按等宽回退（与编辑器一致）。 */
  font-family: var(--aide-font-mono);
}

.chat-messages {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* overflow-anchor:none 排除浏览器滚动锚定这个黑盒变量（我们的锚定/钉底全是
     手写逻辑，零依赖）。经验证**未**防住滚轮焊死 bug（现场 2 在本规则生效下仍
     复发），真正的根治在 useChatScroll 的 onWheel——接管滚轮走 JS 赋值路径，
     旁路掉合成器滚轮缓存。本规则保留仅为排除变量、无功能损失。 */
  overflow-anchor: none;
  padding: 8px 0;
}

/* 滚动区 wrapper：占位 + 悬浮按钮定位锚点（见模板注释） */
.chat-scroll-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 回到底部：居中胶囊，悬浮于滚动区底部上方；显隐走 opacity/transform
   过渡，hidden 态保留布局不占位（absolute）仅关指针事件 */
.jump-bottom {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  z-index: 5;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 999px;
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border-strong);
  box-shadow: var(--aide-shadow-md);
  color: var(--aide-text-secondary);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition:
    opacity var(--aide-ease-t),
    transform var(--aide-ease-t),
    background var(--aide-ease-t),
    color var(--aide-ease-t);
}
.jump-bottom:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-accent-hover);
}
.jump-bottom--hidden {
  opacity: 0;
  pointer-events: none;
  transform: translateX(-50%) translateY(8px);
}
.jump-bottom-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--aide-accent);
}
@media (prefers-reduced-motion: reduce) {
  .jump-bottom { transition: none; }
}

/* 对话区顶部环境光晕：pointer-events none，层级不压内容 */
.chat-messages::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--aide-ambient-glow);
  pointer-events: none;
  z-index: 0;
}

.chat-messages > * {
  position: relative;
  z-index: 1;
}

/* wrapper 接手原直接子元素的定位/层叠职责：消息从 .chat-messages 的
   直接子元素降为孙元素后，由本规则补回 position/z-index（内部若有
   absolute 后代仍以各自消息行为锚点，不受 wrapper 影响） */
.chat-messages-body > * {
  position: relative;
  z-index: 1;
}

.chat-empty {
  display: flex;
  height: 100%;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--aide-text-muted);
}

/* 窗口化渲染的顶部入口:窗口上方还有未挂载的历史时显示 */
.chat-history-gate {
  display: block;
  width: calc(100% - 24px);
  margin: 0 12px 4px;
  padding: 5px 0;
  border: 1px dashed var(--aide-border);
  border-radius: var(--aide-radius-sm);
  background: transparent;
  color: var(--aide-text-muted);
  font-size: 11px;
  cursor: pointer;
  transition: all var(--aide-ease-t);
}

.chat-history-gate:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-secondary);
}

.chat-thinking {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 12px;
  color: var(--aide-text-muted);
  /* 输入框正上方的固定状态行（inline dock）：flex 列里不许被压扁 */
  flex-shrink: 0;
}

.chat-thinking-text {
  position: relative;
  font-weight: 500;
  background: linear-gradient(
    90deg,
    var(--aide-text-muted) 0%,
    var(--aide-text-muted) 33%,
    var(--aide-agent-accent) 50%,
    var(--aide-text-muted) 67%,
    var(--aide-text-muted) 100%
  );
  background-size: 300% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: thinking-text-shimmer 2.5s linear infinite;
}

@keyframes thinking-text-shimmer {
  0% {
    background-position: 100% center;
  }
  100% {
    background-position: 0% center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .chat-thinking-text {
    animation: none;
    background: var(--aide-text-muted);
    -webkit-background-clip: initial;
    background-clip: initial;
    -webkit-text-fill-color: initial;
  }
}

/* 中断按钮：视觉在 InterruptButton.vue（声波停止钮），这里只给布局——靠右 */
.chat-interrupt-btn {
  margin-left: auto;
}

/* ── hero（零会话欢迎态）────────────────────────────────────────────
   同一棵 DOM 换布局：消息区隐藏、输入盒居中放大；进出 hero 的动画只动
   transform/opacity（FLIP 的 JS 部分见 script 里 isHero 的 watch）。 */
.chat-panel--hero {
  justify-content: center;
}

/* hero 下整条滚动区（含 wrapper）隐藏——wrapper 带 flex:1，只藏
   .chat-messages 会让它吃掉剩余空间、破坏输入盒居中 */
.chat-panel--hero .chat-scroll-wrap {
  display: none;
}

/* 离开 hero：消息区淡入（配合 FLIP 的输入盒落底） */
.chat-panel--hero-leaving .chat-messages {
  animation: hero-msgs-in .3s var(--aide-ease);
}

@keyframes hero-msgs-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

/* hero 标题行进出 */
.hero-fade-enter-active {
  transition: opacity .18s var(--aide-ease), transform .18s var(--aide-ease);
}
.hero-fade-leave-active {
  transition: opacity .15s ease;
}
.hero-fade-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.hero-fade-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .chat-panel--hero-leaving .chat-messages {
    animation: none;
  }
  .hero-fade-enter-active,
  .hero-fade-leave-active {
    transition: none;
  }
}

</style>
