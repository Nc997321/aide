<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, onUnmounted } from "vue";
import ChatMessage from "../ChatMessage.vue";
import AppLogo from "../AppLogo.vue";
import Icon from "../Icon.vue";
import ContextCompactionStatus from "../ContextCompactionStatus.vue";
import TaskListPanel from "../TaskListPanel.vue";
import InterruptButton from "../InterruptButton.vue";
import PermissionDialog from "../PermissionDialog.vue";
import BgTaskDock from "../BgTaskDock.vue";
import WorkspacePicker from "../../ui/WorkspacePicker.vue";
import ChatInputBox from "./ChatInputBox.vue";
import BtwDrawer from "../BtwDrawer.vue";
import type { BgTask, ChatMessage as ChatMessageType, ContextCompactionState, ContextUsage, ModelOption, ModelSwitchResult, PermissionModeOption, PermissionRequest, RateLimitInfo, TaskItem } from "@/types/chat";
import type { WorkspaceInfo } from "@/types";
import { api } from "@/api";
import { permissionsApi } from "@/api/permissions";
import { deriveSessionFileRules } from "@/utils/permissionRuleDerivation";
import { trail } from "../../utils/diagnostics/scrollTrail";
import type { PermissionRuleDraft, PermissionScope, PermissionSettingsView } from "@/types/permissions";
import type { PendingJump, SendOptions } from "@/composables/useChatSession";
import { useChatScroll } from "@/composables/useChatScroll";
import { useProviders } from "@/composables/useProviders";
import { useSessionProviders } from "@/composables/useSessionProviders";
import type { ProviderConfig } from "@/types";
import { setChatPaneRect } from "@/composables/useChatPaneWidth";
import { useBtwSession } from "@/composables/useBtwSession";
import { useSessionContinuity } from "@/composables/useSessionContinuity";
import { isPendingSession, toggleBgDock } from "@/composables/useChatSession";
import { useToast } from "@/composables/useToast";
import { effortLabel } from "@/utils/effort";
import { providerModelList } from "@/utils/provider";

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

const { activeProviderId, allProviders, systemDefault, SYSTEM_DEFAULT_ID } = useProviders();
const { providerOf } = useSessionProviders();

// 会话所属 provider：存活会话锁定它 spawn 那一刻的 provider（存在 useSessionProviders
// 注册表里），全局切换供应商不影响已启动会话的模型下拉；没有绑定（新会话/已 stop/
// 重开历史）时回落到全局 active provider——这正是"stop_session 后供应商才改变"的
// 体现。下拉的选项列表与默认选中都跟 sessionProvider 走，不再跟 activeProvider。
const sessionProvider = computed<ProviderConfig>(() => {
  const id = (props.sessionId && providerOf(props.sessionId)) ?? activeProviderId.value;
  if (id === SYSTEM_DEFAULT_ID) return systemDefault.value;
  return allProviders.value.find((p) => p.id === id) ?? systemDefault.value;
});

// 会话供应商/模型延续性 + 发送前确认门控（见 useSessionContinuity）。allProviders 用来
// 判断「持久化的供应商是否还存在」——被删的供应商不恢复绑定，发送时与会话上次不同
// 则弹确认。lastUsed 在切会话时由 restoreBinding/refreshLastUsed 读回。
const continuity = useSessionContinuity(allProviders);

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

/** 构造发送前确认的合成请求（变体 C）：按「供应商变了/模型变了/都变」组合文案，
 *  复用 PermissionDialog 的 AskUserQuestion 视觉语言渲染。input 全前端字段，不进 sidecar。 */
function buildSendConfirmRequest(effectiveProviderId: string, effectiveModel: string): PermissionRequest {
  const oldProviderId = continuity.lastUsedProvider.value;
  const oldModel = continuity.lastUsedModel.value ?? "";
  const providerChanged = effectiveProviderId !== (oldProviderId ?? "");
  const modelChanged = effectiveModel !== oldModel;
  const newProviderName = sessionProvider.value.name || effectiveProviderId;
  const oldProviderName = oldProviderId
    ? (allProviders.value.find((p) => p.id === oldProviderId)?.name ?? oldProviderId)
    : "";
  const title = providerChanged && modelChanged
    ? "本次发送将切换供应商/模型"
    : providerChanged
      ? "本次发送将切换供应商"
      : "本次发送将切换模型";
  const question = providerChanged && modelChanged
    ? `将以 ${newProviderName}/${effectiveModel} 发送（原 ${oldProviderName}/${oldModel}）`
    : providerChanged
      ? `将以 ${newProviderName} 发送（原 ${oldProviderName}）`
      : `将以 ${effectiveModel} 发送（原 ${oldModel}）`;
  const info = providerChanged
    ? `切换供应商会重新拉起会话进程，提示缓存失效（冷缓存）；与该会话上次使用的 ${oldProviderName} 不同，对话历史将迁移到新会话继续。`
    : `切换模型会导致提示缓存失效（冷缓存），下一轮起新模型生效；与该会话上次使用的 ${oldModel} 不同`;
  return {
    id: `send-confirm-${crypto.randomUUID()}`,
    name: "__sendConfirm__",
    input: { title, chip: "切换确认", question, info, confirmLabel: `继续发送 · ${effectiveModel}` },
  };
}

// 会话还没开始时没有活的 sidecar 进程，SDK 的 models_available 事件还没发生，
// props.models 是空的——依次退化：provider 设置里配置的 knownModels（用户自己
// 填的） > 静态默认列表（读本地文件，不起进程，见 get_default_models），
// 让用户进会话就能选模型，不用等发完第一条消息。
const defaultModels = ref<ModelOption[]>([]);
const defaultPermissionModes = ref<PermissionModeOption[]>([]);
onMounted(async () => {
  try {
    defaultModels.value = await api.getDefaultModels();
  } catch {
    // 读不到就不兜底，下拉直接不显示——不影响其他功能
  }
  try {
    defaultPermissionModes.value = await api.getDefaultPermissionModes();
  } catch {
    // 同上
  }
});

/** 第三方供应商自己的真实模型列表：顶层默认模型 + 模型变量映射里的具体模型 id +
 * 模型列表（去重，去空）。跟 sessionProvider 走——存活会话用 spawn 时的 provider，
 * 不受全局切换影响。
 *
 * 模型变量映射（modelMappings）里的 anthropicModel/defaultOpusModel/.../subagent
 * 本就是该供应商真实可跑的模型 id，用户在设置里填了就期望下拉能看到——只取顶层
 * model + knownModels 会让用户配了一堆映射却只看到主模型。这里把它们一并并入。 */
const providerModels = computed<ModelOption[]>(() =>
  providerModelList(sessionProvider.value).map((v) => ({ value: v, displayName: v })),
);

const displayModels = computed<ModelOption[]>(() => {
  // 第三方供应商：下拉展示真实模型 id，始终以供应商配置为准——SDK 回发的
  // 是 Claude 的 opus/sonnet 别名列表，对第三方是假象（TUI 时代的别名
  // 欺骗机制已移除），选了还可能打到不存在的模型。
  if (sessionProvider.value.id !== SYSTEM_DEFAULT_ID) {
    return providerModels.value;
  }
  // 系统默认（真 Claude）：SDK 学到的列表 > 静态兜底
  return props.models?.length ? props.models : defaultModels.value;
});

const { toastState, showToast } = useToast();


// ── 「允许并记住」作用域解析 ──
// 权限请求出现时拉一次权限设置视图，决定「记住」默认落到哪个作用域（项目本地
// 优先，不可编辑则回退用户全局），并缓存规则列表供点击时去重。权限请求不频繁，
// 一次 prompt 一次 get() 可接受。请求消失时清空，避免跨请求串用旧视图。
// workspacePath prop 是弹窗所属会话自己的工作区（PaneGroup 按会话注册解析，
// 不随活动工作区变化）——「记住」的可用性判定与落盘必须钉在它上面：弹窗挂起
// 期间切了工作区，Rust 侧按当前活动工作区解析会把规则写进新工作区（bug）。
const rememberScope = ref<PermissionScope | null>(null);
const rememberView = ref<PermissionSettingsView | null>(null);
const rememberWsRoot = ref<string | null>(null);
watch(
  () => props.permission?.id,
  async (id) => {
    if (!id || !props.permission) {
      rememberScope.value = null;
      rememberView.value = null;
      rememberWsRoot.value = null;
      return;
    }
    rememberWsRoot.value = props.workspacePath ?? null;
    try {
      const view = await permissionsApi.get(rememberWsRoot.value ?? undefined);
      rememberView.value = view;
      const local = view.scopes.find((s) => s.scope === "local");
      const user = view.scopes.find((s) => s.scope === "user");
      rememberScope.value = local?.editable ? "local" : user?.editable ? "user" : null;
    } catch {
      rememberScope.value = null;
      rememberView.value = null;
    }
  },
  { immediate: true },
);

// 滚动诊断环：弹窗显隐标记。滚轮定格的嫌疑方向之一是弹窗挤压/死区——留下
// show/hide 时间戳，定格时与 wheel/scroll 记录互证（弹窗出现前后滚轮是否还
// 落在对话区）。
watch(
  () => props.permission?.id ?? null,
  (id) => trail("perm", id ? `show:${props.permission?.name}` : "hide"),
);

/** 点击「允许并记住」：先落盘 allow 规则（Rust 广播新快照给 sidecar，后续同类调用
 *  自动放行），再走正常 approve 放行本次。目标作用域已有等价 allow 规则时跳过创建，
 *  避免重复点击堆积重复规则。落盘失败仍放行本次（不阻塞用户），仅提示。
 *  落盘用 rememberWsRoot 显式钉住弹窗所属会话的工作区（弹窗挂起期间切工作区时，
 *  缺省按当前活动工作区解析会把规则写进新工作区）。 */
async function persistRememberRule(
  scope: PermissionScope,
  rules: PermissionRuleDraft[],
): Promise<void> {
  const scopeWord = scope === "local" ? "本项目本地" : scope === "user" ? "用户全局" : scope;
  try {
    const view = rememberView.value ?? (await permissionsApi.get(rememberWsRoot.value ?? undefined));
    const key = (r: { effect: string; tool: string; matcher: unknown }) =>
      `${r.effect}|${r.tool}|${JSON.stringify(r.matcher)}`;
    const fresh = rules.filter((rule) => {
      const draftKey = key({ effect: "allow", tool: rule.tool, matcher: rule.matcher });
      return !view.rules.some(
        (r) => r.scope === scope && r.effect === "allow" && key(r) === draftKey,
      );
    });
    if (fresh.length > 0) {
      await permissionsApi.createMany(scope, fresh, rememberWsRoot.value ?? undefined);
    }
    showToast(`已记住到${scopeWord}，下次自动放行`, "success");
  } catch (e) {
    showToast(`记住规则失败：${String((e as Error)?.message ?? e)}（本次仍已放行）`, "danger");
  }
}

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
      continuity.noteSent(sc.effectiveProvider, sc.effectiveModel);
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
    await persistRememberRule(persistRule.scope, persistRule.rules);
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

/** 输入框的发送请求统一入口：跑发送前确认门控（变体 C）。需确认 → 弹确认形态
 *  （不清输入，取消时内容回退对话框）；否则直接发送 + 推进 lastUsed 基线 +
 *  递增 sendConfirmedNonce（输入框据此清空输入）。 */
function onSendRequest(prompt: string, opts: SendOptions & { effectiveProvider: string; effectiveModel: string }) {
  // 拆出确认门控用的 provider/模型，真实发送只带纯 SendOptions（不给 useChatSession 传额外字段）
  const { effectiveProvider, effectiveModel, ...sendOpts } = opts;
  const sidForGate = props.sessionId;
  if (
    sidForGate &&
    !isPendingSession(sidForGate) &&
    !props.isBusy &&
    continuity.needsConfirm(effectiveProvider, effectiveModel)
  ) {
    sendConfirm.value = {
      request: buildSendConfirmRequest(effectiveProvider, effectiveModel),
      pendingSend: { prompt, opts: sendOpts },
      effectiveProvider,
      effectiveModel,
    };
    return;
  }
  continuity.noteSent(effectiveProvider, effectiveModel);
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
// 居中样式。hero 不是独立组件——输入盒/工具栏/发送路径全部复用，只是换布局文案。
const isHero = computed(() => !props.sessionId && props.messages.length === 0);
// 归属显示交给 WorkspacePicker（path → 末段目录名），hero 只需传 props.workspacePath。
// 模型名由 ChatInputBox 上报（hero-model-name 事件）——选中模型在输入框组件内，
// hero 头只读展示，不持有选择状态。
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

// 滚动 / 窗口化 / 分帧挂载全部收拢到 useChatScroll：数据窗口（useMessageWindow
// 尾部 30 条）之上叠一层渲染预算 mountedCount，切会话先挂尾部 6 条、每帧 rAF 加
// 几条到 30，帧间让出主线程给输入框流光绘制——长会话切回不再整窗未响应。
// 见 composables/useChatScroll.ts。
const {
  scrollEl,
  contentEl,
  visibleMessages,
  hiddenCount,
  ramping,
  onScroll,
  jumpToBottom,
  farFromBottom,
  newWhileAway,
  expandOlderAnchored,
} = useChatScroll(() => props.messages, () => props.sessionId);

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
          v-if="hiddenCount > 0 && !ramping"
          class="chat-history-gate"
          @click="expandOlderAnchored"
        >
          上方还有 {{ hiddenCount }} 条历史消息 · 点击或继续上滚加载
        </button>
        <ChatMessage
          v-for="msg in visibleMessages"
          :key="msg.id"
          :message="msg"
          :workspace-path="workspacePath"
          :models="displayModels"
          :bg-tasks="bgTasks"
          @open-bg-dock="onOpenBgDock"
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
      :remember-scope="rememberScope"
      :remember-rules="rememberView?.rules ?? []"
      :current-mode="permissionMode"
      @respond="onPermissionRespond"
    />

    <!-- 后台任务 dock：与 PermissionDialog 同款 inline dock——挤压消息区而非浮层。
         开合/清理语义在 toggleBgDock（结束的任务下次点开才清）。 -->
    <BgTaskDock
      :session-id="props.sessionId"
      :tasks="bgTasks ?? []"
      :open="bgDockOpen"
      :selected-id="bgDockSelectedId ?? null"
      @update:selected-id="(id: string) => emit('update:bgDockSelectedId', id)"
    />

    <!-- 活动状态行（上下文压缩 / 正在思考）：inline dock 固定在输入框上方，
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

    <!-- hero 标题区（零会话欢迎态）：logo + 一行纯展示信息，
         模型/权限模式的实际选择在输入盒工具栏 -->
    <Transition name="hero-fade">
      <div v-if="isHero" class="chat-hero-head">
        <AppLogo :size="56" class="chat-hero-logo" />
        <div class="chat-hero-title">
          新会话位于
          <WorkspacePicker
            :path="props.workspacePath ?? ''"
            @select="(ws) => emit('select-workspace', ws)"
          />
          <span class="chat-hero-sep">·</span>
          使用 <span class="chat-hero-model">{{ heroModelName || "默认模型" }}</span>
        </div>
      </div>
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
      :continuity="continuity"
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

.chat-hero-head {
  align-self: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
  user-select: none;
}

.chat-hero-logo {
  border-radius: 12px;
  box-shadow: var(--aide-shadow-md);
}

.chat-hero-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--aide-text-secondary);
}

.chat-hero-sep {
  color: var(--aide-text-muted);
}

.chat-hero-model {
  color: var(--aide-accent);
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
