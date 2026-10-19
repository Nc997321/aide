<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, onUnmounted, inject } from "vue";
import ChatRow from "./ChatRow.vue";
import TurnChangeCard from "./TurnChangeCard.vue";
import { TURN_CHANGES_KEY } from "./turnChanges";
import Icon from "../Icon.vue";
import TaskListPanel from "../TaskListPanel.vue";
import PermissionDialog from "../PermissionDialog.vue";
import ActivityStrip from "../activity/ActivityStrip.vue";
import ActivityDrawer from "../activity/ActivityDrawer.vue";
import { bgTaskChip, btwChip, subagentChip, subsessionChip, type ActivityChip, type ActivityChipTarget, type ChildActivity } from "../activity/activityChips";
import { openActivityTab } from "../activity/ActivityDrawer.vue";
import SubsessionWaitCard from "../subsession/SubsessionWaitCard.vue";
import SubsessionDrillBar from "../subsession/SubsessionDrillBar.vue";
import SubsessionComposer from "../subsession/SubsessionComposer.vue";
import { quoteMarkdown } from "../subsession/composeTask";
import FloatingCard from "../FloatingCard.vue";
import { anchorOf, type AnchorRect } from "../floatingCard";
import MessageSelectionBar from "./MessageSelectionBar.vue";
import { readMessageSelection, rectVisibleIn, selectionEndRect, selectionRect, type MessageSelection } from "./messageSelection";
import { SUBSESSION_MAX_RUNNING, useSubsessions } from "@/composables/useSubsessions";
import { useSessionState } from "@/composables/useSessionState";
import { pickAnswer } from "./answerSlot";
import HeroWelcome from "./hero/HeroWelcome.vue";
import { DEFAULT_CHAT_MODE, type ChatMode } from "./modes";
import ChatInputBox from "./ChatInputBox.vue";
import ThinkingLine from "./ThinkingLine.vue";
import { applyLspChoice, lspLangsToAsk, pendingLspAsk } from "./lspSendGate";
import LspSendPrompt from "./LspSendPrompt.vue";
import { sameRoot, useLsp } from "@/composables/useLsp";
import type { PreflightLang } from "@aide/sdk/types/lspPacks";
import ModelSwitchConfirm from "./ModelSwitchConfirm.vue";
import type { UsageTip } from "./usageTips";
import { useUsageTips } from "@/composables/useUsageTips";
import type { BgTask, ChatMessage as ChatMessageType, ContextCompactionState, ContextUsage, ModelOption, ModelSwitchResult, PermissionModeOption, PermissionRequest, RateLimitInfo, SubagentBlock, TaskItem } from "@/types/chat";
import type { WorkspaceInfo } from "@/types";
import { api } from "@/api";
import { deriveSessionFileRules } from "@/utils/permissionRuleDerivation";
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
import { provideSessionIdentityView, sessionIdentityStore, buildConfirmDecision, type ConfirmDecision } from "@/composables/sessionIdentity";
import {
  isPendingSession,
  toggleBgDock,
  loadOlderPage,
  hasMoreOlder,
  messagesOf,
  pendingPermissionsOf,
  respondPermissionFor,
} from "@/composables/useChatSession";
import { QUESTION_TOOL_NAME } from "@aide/sdk/utils/permissionShape";
import { useToast } from "@/composables/useToast";

const props = defineProps<{
  sessionId: string | null;
  workspacePath?: string;
  /** 这个 tab 的模式（日常 / 工程）：归属行、文案、档位默认、右栏都由它分叉。
   *  由 PaneGroup 的 currentMode 给出（活着的会话问注册表，空白 tab 看 pendingWs）。 */
  mode?: ChatMode;
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
  /** 本会话收到的 SDK 斜杠命令清单；null = 会话还没开始 */
  slashCommands?: string[] | null;
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
  /** 本会话派发过的子代理（运行中 + 已结束）+ dock 开合状态（useChatSession 透传） */
  subagents?: SubagentBlock[];
  subagentDockOpen: boolean;
  subagentDockSelectedId?: string | null;
  /** 本会话待确认的权限/提问请求——渲染在消息区和输入框之间（见模板），
   *  不是浮层，见 PermissionDialog.vue 顶部注释。 */
  permission?: PermissionRequest | null;
  permissionQueueCount?: number;
  /** 图片 400 回滚后待放回输入框的文本（useChatSession 透传；空串 = 无待回填）。
   *  回填后 emit rollback-text-consumed 清空，避免重复回填。 */
  rollbackText?: string;
  /** 父层恒传（PaneGroup 的聚焦判定 computed），非可选 */
  focused: boolean;
  /** 还没有会话时输入框草稿记在哪（PaneGroup：标签 id，无标签用分屏组 id），见 useComposerDrafts */
  draftBlankKey?: string;
}>();

const emit = defineEmits<{
  send: [prompt: string, opts: SendOptions];
  "send-btw": [prompt: string];
  interrupt: [];
  /** 子会话返回条的 ←（参数：父会话 id）：PaneGroup 决定是退出钻入还是去父会话的 tab */
  "back-to-parent": [parentId: string];
  "set-model": [model: string];
  "set-effort": [effort: string];
  "set-permission-mode": [mode: string];
  /** 权限/提问请求的放行结果：req 具名对象（nextMode/reason 相邻 string 不再错位），
   *  sessionRules 为会话级规则草稿（「允许」文件工具时前端推导，随放行透传） */
  "respond-permission": [req: { id: string; approved: boolean; answers?: Record<string, string>; nextMode?: string; reason?: string }, sessionRules?: PermissionRuleDraft[]];
  "update:bgDockSelectedId": [id: string];
  "update:subagentDockSelectedId": [id: string];
  /** hero 归属选择：选中的是会话归属，不是活动工作区（PaneGroup 据此改 pendingWs/defaultWs） */
  "select-workspace": [ws: WorkspaceInfo];
  /** hero 模式切换（日常 / 工程）：同样只改归属与意图，不切活动工作区 */
  "select-mode": [mode: ChatMode];
  /** hero「接着上次」：打开一场已有会话 */
  "open-session": [sessionId: string];
  /** 图片 400 回滚文本已回填进输入框（父组件据此清空 store.rollbackText） */
  "rollback-text-consumed": [];
}>();

/** 回合变更结算卡的数据（App 唯一实例的投影，见 turnChanges.ts）。没有它的宿主
 *  （单测 / 非桌面宿主）整块不渲染——不是渲染一张空卡。 */
const turnChanges = inject(TURN_CHANGES_KEY, null);

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
const identity = provideSessionIdentityView();

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

/** 构造发送前确认的合成请求：供应商漂移与「仅模型漂移」两种文案。
 *
 * 供应商漂移 = 要 respawn（进程原地 resume 重拉、提示缓存失效），必须说清是**永久**改动；
 * 仅模型漂移 = 供应商没换，只换模型，文案侧重模型本身。两者都复用
 * PermissionDialog 的 AskUserQuestion 视觉语言渲染，input 全前端字段，不进 sidecar。 */
function buildSendConfirmRequest(decision: ConfirmDecision): PermissionRequest {
  const newProviderName = sessionProvider.value.name || decision.effective;
  // 「原」一侧只在确有漂移的维度上展示记录值；某维度 drift=false 时按当前值填，
  // 否则一旦盘上某字段缺失（如「仅模型变」+ 旧供应商未记录）就会出现
  // "原 未记录/sonnet" 之类自相矛盾的文字。Rust 侧 drift=true ⟹ 对应 last 非空，
  // 此处保留兜底是防御，不应该触发。
  const oldProviderName = decision.providerDrift
    ? (decision.last
      ? (allProviders.value.find((p) => p.id === decision.last)?.name ?? decision.last)
      : newProviderName)
    : newProviderName;
  const oldModel = decision.modelDrift
    ? (decision.lastModel ?? decision.effectiveModel)
    : decision.effectiveModel;
  return {
    id: `send-confirm-${crypto.randomUUID()}`,
    name: "__sendConfirm__",
    input: {
      // 不说"本次"：确认后会话身份会落盘改写（settleOnSend），下次打开仍是新供应商/模型，
      // 且没有反向入口改回去。文案必须让用户在点确认前就知道这是**永久**改动。
      title: decision.providerDrift
        ? `此会话将改用 ${newProviderName}`
        : `此会话将改用 ${decision.effectiveModel}`,
      chip: decision.providerDrift ? "切换确认" : "模型变更",
      question: `将以 ${newProviderName}/${decision.effectiveModel} 发送（原 ${oldProviderName}/${oldModel}）`,
      info: decision.providerDrift
        ? `确认后这条会话的供应商会改为 ${newProviderName} 并写入会话记录，以后打开都是它。运行中的会话会重新拉起进程、提示缓存失效，对话在本会话原地继续。`
        : `供应商仍是 ${newProviderName}，仅模型由 ${oldModel} 改为 ${decision.effectiveModel}。确认后模型选择会写入会话记录。`,
      confirmLabel: `继续发送 · ${decision.effectiveModel}`,
    },
  };
}

// 会话还没开始时没有活的 sidecar 进程，SDK 的 models_available 事件还没发生，
// props.models 是空的——依次退化：provider 设置里配置的 knownModels（用户自己
// 填的） > 静态默认列表（读本地文件，不起进程，见 get_default_models），
// 让用户进会话就能选模型，不用等发完第一条消息。
const defaultPermissionModes = ref<PermissionModeOption[]>([]);
onMounted(async () => {
  // 系统默认 / 第三方供应商的 known_models 都在 get_providers 一次性返回，
  // 跟着 allProviders 一起走——不需要单独刷。权限模式仍在此读。
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
      // 空白面板（sid 为空）的 spawn 落盘已由 useChatSession.sendMessage 在生成 tempId 后处理；
      // 这里只坐实已有会话——传空 sid 无法落盘，且会污染全局基线。
      if (props.sessionId) sessionIdentityStore.settleOnSend(props.sessionId, sc.effectiveProvider);
      emit("send", sc.pendingSend.prompt, sc.pendingSend.opts);
      sendConfirmedNonce.value++;
    }
    sendConfirm.value = null;
    return;
  }
  // nextMode 由 PermissionDialog 的「批准，手动确认编辑 / 批准，使用 Auto 模式」
  // 按钮传（manual/auto），以及编辑工具的「进入自动模式」按钮传（auto）；
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
  // ⊇ file，会话规则冗余）；「进入自动模式」切 auto 已覆盖。发送前确认
  // 已提前 return，走到这里 props.permission 必为真实权限请求。
  let sessionRules: PermissionRuleDraft[] | undefined;
  if (approved && !persistRule && !nextMode && props.permission && props.permission.id === id) {
    sessionRules = deriveSessionFileRules(props.permission.name, props.permission.input);
    if (sessionRules.length === 0) sessionRules = undefined;
  }
  emit("respond-permission", { id, approved, answers, nextMode, reason }, sessionRules);
}

/** 新会话发出首条消息时的语言服务器询问（输入框上方那条，LspSendPrompt）。**不阻塞发送**：
 *  消息照发，这条留着等用户选。询问记在工作区上（`pendingLspAsk`，见 lspSendGate.ts）：本面板是工程
 *  模式且同一工作区就显示；不理它 / 点 × = 不记录，下次新会话还会问。 */
const lspAsk = pendingLspAsk;
const lspAskBusy = ref(false);
const lspState = useLsp();
const showLspAsk = computed(() => {
  const ask = lspAsk.value;
  return (
    !!ask &&
    props.mode === "project" &&
    !!props.workspacePath &&
    sameRoot(props.workspacePath, ask.workspaceRoot) &&
    // 别的会话 / 客户端已经替这个工作区选了（lsp-switch-changed）：不再显示
    !lspState.isLspDecided(ask.workspaceRoot)
  );
});

async function resolveLspAsk(choice: "enable" | "skip" | "dismiss") {
  const ask = lspAsk.value;
  if (!ask || lspAskBusy.value) return;
  if (choice !== "dismiss") {
    lspAskBusy.value = true;
    try {
      await applyLspChoice(ask.workspaceRoot, ask.langs, choice === "enable");
    } finally {
      lspAskBusy.value = false;
    }
  }
  lspAsk.value = null;
}

/** 发送坐实信号：门控通过/确认后递增，ChatInputBox 据此清空输入（取消确认不递增，
 *  输入保留——与旧实现「取消时内容回退对话框」语义一致）。 */
const sendConfirmedNonce = ref(0);

/** 输入框的发送请求统一入口：跑发送前确认门控（**供应商 + 模型两维**——判定规则
 *  下沉 Rust，桌面端与手机端共用同一份 `session_identity_drift`；两维都相同才不弹）。
 *  需确认 → 弹确认形态（不清输入，取消时内容回退对话框）；否则直接发送 + 推进
 *  provider 基线 + 递增 sendConfirmedNonce（输入框据此清空输入）。 */
/** 门控判定在途：这期间输入框还没清空，再按一次回车会把同一条再发一遍——直接吞掉。 */
let sendGating = false;
async function onSendRequest(prompt: string, opts: SendOptions & { effectiveProvider: string; effectiveModel: string }) {
  if (sendGating) return;
  sendGating = true;
  try {
    await gateAndSend(prompt, opts);
  } finally {
    sendGating = false;
  }
}

async function gateAndSend(prompt: string, opts: SendOptions & { effectiveProvider: string; effectiveModel: string }) {
  // 拆出确认门控用的 provider/模型，真实发送只带纯 SendOptions（不给 useChatSession 传额外字段）
  const { effectiveProvider, effectiveModel, ...sendOpts } = opts;
  const sidForGate = props.sessionId;
  if (sidForGate && !isPendingSession(sidForGate) && !props.isBusy) {
    const decision = await buildConfirmDecision(sidForGate, effectiveProvider, effectiveModel);
    // 判定是异步的：等回执期间用户可能已切走会话——此时结果属于旧会话，丢弃。
    if (props.sessionId !== sidForGate) return;
    if (decision) {
      sendConfirm.value = {
        request: buildSendConfirmRequest(decision),
        pendingSend: { prompt, opts: sendOpts },
        effectiveProvider,
        effectiveModel,
      };
      return;
    }
  }
  // 新会话（工程模式）即将启动：这个工作区还没决定开不开语言服务器 → 问一句。
  // 只在这一刻问——打开 / 浏览已有会话不问；日常模式不问（日常目录不是工程）。
  // **后台判定、不等**：未决定的工作区 Host 要遍历目录探测语言，大项目要好几秒；以前 await 在这里，
  // 输入框不清空、看着像没发出去，用户补张截图再按回车就发成了两条（2026-10-19 工作机）。
  // 询问记在工作区上（pendingLspAsk），面板换会话号也不丢，所以回执晚到照样挂上。
  if ((!sidForGate || isPendingSession(sidForGate)) && props.mode === "project" && props.workspacePath) {
    const ws = props.workspacePath;
    void lspLangsToAsk(ws).then((langs) => {
      if (langs) pendingLspAsk.value = { workspaceRoot: ws, langs };
    });
  }
  // 空白面板（sid 为空）：没有会话可落盘，spawn 时由 useChatSession.sendMessage
  // 拿到 tempId 后坐实（见 store.spawnProviderOf / finalizeSpawn）。
  if (sidForGate) sessionIdentityStore.settleOnSend(sidForGate, effectiveProvider);
  emit("send", prompt, sendOpts);
  sendConfirmedNonce.value++;
}

/** 权限模式（PermissionDialog current-mode 展示用）：ChatInputBox 的
 *  selectedPermissionMode 变化时经 permission-mode-changed 事件同步。 */
const permissionMode = ref("");

// ── 权限模式（plan / auto / manual）——和模型下拉同一套模式：
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
const inputBoxRef = ref<{
  rootEl: HTMLElement | null;
  insertQuote: (quote: string) => void;
  spawnDefaults: () => { model?: string; effort?: string; permissionMode?: string };
} | null>(null);

// 待确认时收起输入框：此刻唯一要做的事是回应弹窗，输入框只是噪音，腾出的高度归弹窗。
// 真实权限请求：有草稿就不收（人家正写着）；发送前确认：输入框里的就是待确认的那条，照收。
const inputStow = computed<"off" | "unless-draft" | "always">(() =>
  sendConfirm.value ? "always" : props.permission ? "unless-draft" : "off",
);

// ── 子会话（本会话派出去的；子会话设计 §8.5）──
const subs = useSubsessions();
const { state: sessionActivity } = useSessionState();
const children = computed(() => subs.childrenOfSession(props.sessionId));
const childActivity = (id: string): ChildActivity => (sessionActivity[id] as ChildActivity | undefined) ?? "waiting";
/** 子会话队头那条是不是提问（AskUserQuestion）：提问在父会话作答槽就地回答，答案回到子会话、由它接着做。 */
function childQuestionOf(id: string): PermissionRequest | null {
  const head = pendingPermissionsOf(id)[0];
  return head && head.name === QUESTION_TOOL_NAME ? head : null;
}
/** 在等你的子会话：提问排在前面（就地能答）；权限批准出引导卡、去子会话里批（不代批，§8.5-6）。 */
const waitingChildren = computed(() => {
  const waiting = children.value.filter((c) => childActivity(c.id) === "attention");
  return [...waiting.filter((c) => childQuestionOf(c.id)), ...waiting.filter((c) => !childQuestionOf(c.id))];
});
/** 作答槽里要就地回答的子会话提问（队首子会话在问问题时才有）。 */
const childQuestion = computed(() => {
  const child = waitingChildren.value[0];
  const req = child ? childQuestionOf(child.id) : null;
  return child && req ? { child, req } : null;
});
/** 子会话提问不涉及「记住规则」，弹窗的记住上下文恒为不可用。 */
const NO_REMEMBER = { status: "failed" } as const;
function onChildQuestionRespond(id: string, approved: boolean, answers?: Record<string, string>) {
  const q = childQuestion.value;
  if (!q || q.req.id !== id) return;
  void respondPermissionFor(q.child.id, id, approved, { answers }).catch((e) =>
    showToast(`回答没送到子会话：${e instanceof Error ? e.message : String(e)}`, "danger"),
  );
}
const subsessionOpen = computed(() => (props.sessionId ? !!subs.drawerOpen[props.sessionId] : false));
/** 本会话是子会话：父会话 id 与名字（头条面包屑）。 */
const parentId = computed(() => subs.parentIdOf(props.sessionId));
/** 自动回报被暂停（防乒乓）：null = 没暂停；数字 = 攒着的回报条数。 */
const pausedCount = computed(() => {
  const n = props.sessionId ? subs.paused[props.sessionId] : undefined;
  return n === undefined ? null : n;
});

/** 作答槽仲裁：本会话权限队列（含发送前确认）> 子会话等批准 > 语言服务器询问；一次只出一张。 */
const answer = computed(() =>
  pickAnswer({
    permission: !!displayedPermission.value,
    permissionCount: sendConfirm.value ? 1 : (props.permissionQueueCount ?? (props.permission ? 1 : 0)),
    lsp: showLspAsk.value,
    subsessionWaiting: waitingChildren.value.length,
  }),
);

/** 活动带的 chip：每类后台活一个，点开活动抽屉对应 tab。 */
const btw = useBtwSession();
/** 本会话的 btw 线程（侧栏本体挂在 PaneGroup，与会话并排；这里只管活动带 chip） */
const btwThread = computed(() => btw.threadFor(props.sessionId));

const activityChips = computed<ActivityChip[]>(() =>
  [
    btwChip(btwThread.value),
    subsessionChip(children.value, childActivity, subsessionOpen.value),
    subagentChip(props.subagents ?? [], props.subagentDockOpen),
    bgTaskChip(props.bgTasks ?? [], props.bgDockOpen),
  ].filter((c): c is ActivityChip => c !== null),
);

/** chip 点击：开对应 tab；已开着就收起（三个 tab 互斥，见 openActivityTab）。
 *  btw 不是活动抽屉的 tab：点它 = 打开会话右侧的 btw 侧栏。 */
function onToggleActivity(tab: ActivityChipTarget) {
  if (!props.sessionId) return;
  if (tab === "btw") {
    btw.openPanel(props.sessionId);
    return;
  }
  const open = { subagentOpen: props.subagentDockOpen, bgOpen: props.bgDockOpen, subsessionOpen: subsessionOpen.value };
  const isOpen = tab === "subagent" ? open.subagentOpen : tab === "bg" ? open.bgOpen : open.subsessionOpen;
  openActivityTab(props.sessionId, isOpen ? null : tab, open);
}
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
/** 此刻在想：忙、没有在等用户作答、不在压缩上下文（消息流末尾的思考行据此淡入淡出）。 */
const thinkingNow = computed(() => !!props.isBusy && !displayedPermission.value && !contextCompactionVal.value);
/** 消息流末尾的思考行在不在可视区：往上翻走了，活动带补一个精简的「思考中」（中断始终在活动带）。 */
const thinkingLineInView = ref(true);
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

// 「正在思考」旁的小提示轮播：思考满 TIP_DELAY_S 秒才出（短回复不闪一下），每
// TIP_ROTATE_S 秒换一条；骑在上面的秒级计时器上，不另起定时器。只有聚焦的面板轮——
// 多个分屏同时在跑时各自计一次出场，会把提示过早耗完。
const TIP_DELAY_S = 3;
const TIP_ROTATE_S = 9;
const usageTips = useUsageTips();
const thinkingTip = ref<UsageTip | null>(null);
let thinkingTipSlot = -1;
watch(activityElapsed, (s) => {
  if (!props.isBusy || contextCompactionVal.value || !props.focused || s < TIP_DELAY_S) {
    thinkingTip.value = null;
    thinkingTipSlot = -1;
    return;
  }
  const slot = Math.floor((s - TIP_DELAY_S) / TIP_ROTATE_S);
  if (slot === thinkingTipSlot) return;
  thinkingTipSlot = slot;
  const tip = usageTips.nextThinkingTip(thinkingTip.value?.id ?? null);
  if (tip) usageTips.markShown(tip.id);
  thinkingTip.value = tip;
});

// 滚动 / 加载历史 / 页级回收全部收拢到 useChatScroll（行模型）：上滚到顶部触发带
// 自动取更早页；已加载页超字节预算时热区外页折叠成骨架（实测高度撑住不跳滚），
// 滚动停驻时结算回收/取回；切入按热区页收紧驻留量（挂载量由窗口决定，无分帧 ramp）。
// 见 composables/useChatScroll.ts 与 useChatSession/recycle.ts。
const {
  scrollEl,
  contentEl,
  rows,
  onScroll,
  jumpToBottom,
  farFromBottom,
  newWhileAway,
  expandOlderAnchored,
  restoreAnchored,
  expandLiveAnchored,
} = useChatScroll(() => props.messages, () => props.sessionId, {
  // P1 双向分页：所有分页函数绑定当前会话（props.sessionId 变化时闭包读新值）。
  // sessionId 为空（新会话未创建）时全链路 no-op。
  pagination: {
    hasMore: () => (props.sessionId ? hasMoreOlder(props.sessionId) : false),
    loadOlder: (limit) => (props.sessionId ? loadOlderPage(props.sessionId, limit) : Promise.resolve(0)),
  },
  // 切走收拢/释放操作「离开会话」：watcher 时刻 props.messages 已是新会话的，
  // 旧会话数据经此按 sid 取（live 窗口化，见 useChatScroll.collapseAndTightenForSwitchAway）。
  messagesOf: (sid) => (sid ? messagesOf(sid) : []),
});

// 顶部入口按钮的「磁盘还有更早页」开关（模板里直接读，sessionId 空时 no-op）。
const canLoadOlder = computed(() => (props.sessionId ? hasMoreOlder(props.sessionId) : false));


// ── 手动派子会话 + 消息里选中文字的小浮条（子会话设计 §11）──
// 能派 = 已定名的顶层会话（子会话不能再派：深度 1；还没发过第一条的没有父会话可挂）。
// 限额以 Host 为准，这里的计数只为提前置灰、写明原因。
const runningChildren = computed(
  () => children.value.filter((c) => ["running", "attention"].includes(childActivity(c.id))).length,
);
const canSpawn = computed(
  () => !!props.sessionId && !isPendingSession(props.sessionId) && !parentId.value && !isHero.value,
);
const spawnFullReason = computed(() =>
  runningChildren.value >= SUBSESSION_MAX_RUNNING ? `已有 ${runningChildren.value} 个子会话在跑，等其中一个回报后再派` : null,
);
const plusSubsession = computed(() =>
  canSpawn.value ? { running: runningChildren.value, max: SUBSESSION_MAX_RUNNING } : null,
);

const msgSel = ref<MessageSelection | null>(null);
const msgSelRect = ref<AnchorRect | null>(null);
function placeSelectionBar() {
  const s = msgSel.value;
  const box = scrollEl.value?.getBoundingClientRect();
  const r = s ? selectionEndRect(s.range) : null;
  msgSelRect.value = r && box && rectVisibleIn(r, box) ? r : null;
}
function refreshSelection() {
  if (composer.value) return;
  msgSel.value = readMessageSelection(contentEl.value ?? null, window.getSelection());
  placeSelectionBar();
}
/** 鼠标抬起 / 键盘扩选之后再读（等浏览器把选区落定）。 */
function onMessagesPointerUp() {
  setTimeout(refreshSelection, 0);
}
function onSelectionChange() {
  // 只管「选区没了」：出现由抬起鼠标那一刻判定，免得拖选途中浮条跟着闪
  if (msgSel.value && window.getSelection()?.isCollapsed) {
    msgSel.value = null;
    msgSelRect.value = null;
  }
}
function onMessagesScroll() {
  onScroll();
  if (msgSel.value) placeSelectionBar();
}
onMounted(() => document.addEventListener("selectionchange", onSelectionChange));
onUnmounted(() => document.removeEventListener("selectionchange", onSelectionChange));
watch(() => props.sessionId, () => {
  msgSel.value = null;
  msgSelRect.value = null;
  composer.value = null;
});

function quoteSelection() {
  const s = msgSel.value;
  if (!s) return;
  inputBoxRef.value?.insertQuote(quoteMarkdown(s.text));
  msgSel.value = null;
  msgSelRect.value = null;
}

/** 派活浮窗：一个会话面板同时只开一张；两个入口只差有没有原文、贴在哪里。 */
const composer = ref<{ quote?: string; prefer: "below" | "above"; anchor: () => AnchorRect | null } | null>(null);
const composerDirty = ref(false);
function spawnFromSelection() {
  const s = msgSel.value;
  if (!s || !canSpawn.value) return;
  const range = s.range;
  composer.value = { quote: s.text, prefer: "below", anchor: () => selectionRect(range) };
  composerDirty.value = false;
  msgSelRect.value = null;
  msgSel.value = null;
}
function spawnFromPlus() {
  if (!canSpawn.value) return;
  composer.value = { prefer: "above", anchor: () => anchorOf(inputBoxRef.value?.rootEl?.getBoundingClientRect()) };
  composerDirty.value = false;
}
function closeComposer() {
  composer.value = null;
}


/** 工具卡片「后台运行中」徽章：打开 dock 并选中对应任务（toggleBgDock 已开时只切选中）。 */
function onOpenBgDock(taskId: string) {
  if (props.sessionId) toggleBgDock(props.sessionId, taskId);
}
</script>

<template>
  <div ref="rootEl" class="chat-panel" :class="{ 'chat-panel--hero': isHero, 'chat-panel--hero-leaving': heroLeaving }">
    <!-- 子会话返回条（整宽）：← 回父会话 · 状态 · 停止这一轮（spec §13） -->
    <SubsessionDrillBar
      v-if="parentId && props.sessionId"
      :child-id="props.sessionId"
      :parent-id="parentId"
      @back="emit('back-to-parent', parentId)"
      @stop="emit('interrupt')"
    />
    <!-- 会话头条：自动回报暂停提示 / 待办摘要（清单浮层下拉，不挤压消息区） -->
    <div v-if="pausedCount !== null || (props.tasks && props.tasks.length > 0)" class="chat-col chat-head">
      <div v-if="pausedCount !== null" class="chat-paused">
        已暂停子会话自动回报（连续多次没有你的输入）<template v-if="pausedCount"> · {{ pausedCount }} 条待投递</template>
        · 发任意一条消息即恢复
      </div>
      <TaskListPanel v-if="props.tasks && props.tasks.length > 0" :tasks="props.tasks" />
    </div>

    <!-- 滚动区 wrapper：接手 .chat-messages 的 flex 占位，并作为「回到底部」
         悬浮按钮的定位锚点——按钮若直接放进滚动容器会随内容一起滚走；
         相对 chat-panel 绝对定位又无法自适应输入框/权限区的高度变化 -->
    <div class="chat-scroll-wrap">
      <div
        ref="scrollEl"
        class="chat-messages"
        @scroll.passive="onMessagesScroll"
        @mouseup="onMessagesPointerUp"
        @keyup.shift="onMessagesPointerUp"
      >
      <div v-if="props.messages.length === 0" class="chat-empty">
        开始新对话
      </div>
      <!-- 内容盒：ResizeObserver 的观察目标（见 useChatScroll 的 contentObserver），
           纯布局 wrapper，消息增高的任何来源都会反映为它的盒高变化 -->
      <div ref="contentEl" class="chat-messages-body chat-col">
        <button
          v-if="canLoadOlder"
          class="chat-history-gate"
          @click="expandOlderAnchored"
        >
          上方还有更早消息 · 点击或继续上滚加载
        </button>
        <ChatRow
          v-for="row in rows"
          :key="row.id"
          :row="row"
          :workspace-path="workspacePath"
          :models="displayModels"
          :bg-tasks="bgTasks"
          @open-bg-dock="onOpenBgDock"
          @restore="restoreAnchored"
          @expand-live="expandLiveAnchored"
        />
        <!-- 回合变更结算卡：挂在消息流尾部、跟随当前轮（spec 2026-09-24）——
             读完回答、正想"接下来呢"的那一秒它就在视线里。0 个文件的轮整卡不渲染。 -->
        <TurnChangeCard
          v-if="turnChanges"
          :feed="turnChanges"
          :session-id="props.sessionId"
        />
        <!-- 「正在思考」跟着会话走：消息流最末一格，常驻固定高度、只淡入淡出（防闪，见 ThinkingLine 文件头） -->
        <ThinkingLine
          v-if="props.messages.length > 0"
          :active="thinkingNow"
          :elapsed-seconds="activityElapsed"
          :tip="thinkingTip"
          @in-view="thinkingLineInView = $event"
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

    <!-- 底部组成（2026-10-16 重排）：作答槽 → 活动抽屉 → 活动带 → 输入框，整列与消息内容同宽居中。 -->
    <div class="chat-col chat-bottom">
      <!-- 作答槽：「需要你回应」的只有这一个位置，一次一张卡（answerSlot.ts 仲裁），其余计入「还有 N 条」。
           权限 / 提问 / 发送前确认占真实布局空间而不是悬浮遮挡，出现时输入框收起（inputStow；有草稿则不收）。
           语言服务器询问不阻塞（消息已发出），保持轻量一行，权限卡在时让位。 -->
      <PermissionDialog
        :permission="answer.kind === 'permission' ? displayedPermission : null"
        :queue-count="answer.total"
        :remember-context="rememberState"
        :current-mode="permissionMode"
        @respond="onPermissionRespond"
      />
      <PermissionDialog
        v-if="answer.kind === 'subsession' && childQuestion"
        :permission="childQuestion.req"
        :queue-count="answer.total"
        :remember-context="NO_REMEMBER"
        :from-subsession="childQuestion.child.title"
        @respond="onChildQuestionRespond"
      />
      <SubsessionWaitCard
        v-else-if="answer.kind === 'subsession' && waitingChildren.length"
        :child="waitingChildren[0]"
        :others="answer.total - 1"
      />
      <LspSendPrompt
        v-else-if="answer.kind === 'lsp' && lspAsk"
        :langs="lspAsk.langs"
        :busy="lspAskBusy"
        @enable="resolveLspAsk('enable')"
        @skip="resolveLspAsk('skip')"
        @dismiss="resolveLspAsk('dismiss')"
      />

      <!-- 模型切换成本确认：Teleport 到 body 的模态框，由用户刚点的切换直接触发，不进作答槽 -->
      <ModelSwitchConfirm
        v-if="props.sessionId && !isPendingSession(props.sessionId)"
        :session-id="props.sessionId"
      />

      <!-- 活动抽屉：子代理 / 后台任务面板合一，按 tab 切换（开合语义在 store 的 toggle*Dock） -->
      <ActivityDrawer
        :session-id="props.sessionId"
        :subagents="subagents ?? []"
        :subagent-open="subagentDockOpen"
        :subagent-selected-id="subagentDockSelectedId ?? null"
        :bg-tasks="bgTasks ?? []"
        :bg-open="bgDockOpen"
        :bg-selected-id="bgDockSelectedId ?? null"
        :subsession-open="subsessionOpen"
        @update:subagent-selected-id="(id: string) => emit('update:subagentDockSelectedId', id)"
        @update:bg-selected-id="(id: string) => emit('update:bgDockSelectedId', id)"
      />

      <!-- 活动带：压缩 / 思考 + 计时 + 轮换提示、子代理与后台任务 chip、中断，一行。
           不随消息滚动——上滚读历史时状态可见、中断按钮仍触手可及。 -->
      <ActivityStrip
        :compaction="contextCompactionVal"
        :thinking="props.isBusy && !displayedPermission"
        :thinking-label="!thinkingLineInView"
        :elapsed-seconds="activityElapsed"
        :tip="null"
        :chips="activityChips"
        @interrupt="emit('interrupt')"
        @toggle="onToggleActivity"
      />

      <!-- hero 欢迎区（零会话欢迎态）：时间问候 + 轮换文案（HeroWelcome）。
           模型/权限模式的实际选择仍在输入盒工具栏。 -->
      <Transition name="hero-fade">
        <HeroWelcome
          v-if="isHero"
          :mode="props.mode ?? DEFAULT_CHAT_MODE"
          :workspace-path="props.workspacePath ?? ''"
          :model-name="heroModelName"
          @select-workspace="(ws) => emit('select-workspace', ws)"
          @select-mode="(m) => emit('select-mode', m)"
          @open-session="(sid) => emit('open-session', sid)"
        />
      </Transition>

      <ChatInputBox
        :stow="inputStow"
        ref="inputBoxRef"
        :session-id="props.sessionId"
        :blank-key="props.draftBlankKey"
        :workspace-path="props.workspacePath"
        :is-busy="props.isBusy"
        :is-hero="isHero"
        :mode="props.mode"
        :models="displayModels"
        :current-model="props.currentModel"
        :model-switch-result="props.modelSwitchResult"
        :current-effort="props.currentEffort"
        :effort-switch-error="props.effortSwitchError"
        :permission-modes="displayPermissionModes"
        :current-permission-mode="props.currentPermissionMode"
        :context-usage="props.contextUsage"
        :slash-commands="props.slashCommands"
        :rate-limit="props.rateLimit"
        :pending-jumps="props.pendingJumps"
        :rollback-text="props.rollbackText"
        :focused="props.focused"
        :session-provider="sessionProvider"
        :send-confirmed-nonce="sendConfirmedNonce"
        @send-request="onSendRequest"
        @send-btw="(prompt) => emit('send-btw', prompt)"
        @set-model="(m) => emit('set-model', m)"
        @set-effort="(e) => emit('set-effort', e)"
        @set-permission-mode="(m) => emit('set-permission-mode', m)"
        @rollback-text-consumed="emit('rollback-text-consumed')"
        @hero-model-name="heroModelName = $event"
        @permission-mode-changed="permissionMode = $event"
        :subsession="plusSubsession"
        @new-subsession="spawnFromPlus"
      />
    </div>
    <MessageSelectionBar
      v-if="msgSelRect && !composer"
      :rect="msgSelRect"
      :spawn="canSpawn ? { disabledReason: spawnFullReason } : null"
      @quote="quoteSelection"
      @spawn="spawnFromSelection"
    />
    <FloatingCard
      :open="!!composer && canSpawn"
      :anchor="composer?.anchor ?? (() => null)"
      :prefer="composer?.prefer"
      :label="composer?.quote ? '派给子会话' : '新建子会话'"
      :close-on-outside="!composerDirty"
      @close="closeComposer"
    >
      <SubsessionComposer
        v-if="composer && props.sessionId"
        :parent-id="props.sessionId"
        :quote="composer.quote"
        :running="runningChildren"
        :defaults="() => inputBoxRef?.spawnDefaults() ?? {}"
        @dirty="composerDirty = $event"
        @close="closeComposer"
      />
    </FloatingCard>
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
  /* 浮在正文上：与其它浮层同一配方（raised 底 + 毛玻璃），玻璃主题下 surface-default 近乎全透明会和正文糊在一起 */
  background: var(--aide-bg-raised);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
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

/* ── 会话列（2026-10-16）：内容列默认居中限宽（阅读友好），窗格比上限窄时自然满宽。
   滚动容器 .chat-messages 仍满宽（滚动条贴窗格边），只有内容盒与头条 / 底部组成套这一列。
   --chat-col-max 是布局尺寸、不是配色，不进主题 token。 */
.chat-panel {
  --chat-col-max: 860px;
}

.chat-col {
  width: 100%;
  max-width: var(--chat-col-max);
  margin-left: auto;
  margin-right: auto;
  /* 行 / 卡片自带 12px 左右边距（.msg-row、.perm-dock、输入区），列只补一点 */
  padding-left: 4px;
  padding-right: 4px;
  box-sizing: border-box;
}

.chat-head {
  flex: none;
}

/* 自动回报被暂停（防乒乓）：一行提示，发消息即恢复 */
.chat-paused {
  margin: 6px 12px 0;
  padding: 6px 10px;
  border-radius: var(--aide-radius-sm);
  background: color-mix(in srgb, var(--aide-warning) 10%, transparent);
  color: var(--aide-warning);
  font-size: 12px;
}

.chat-bottom {
  flex: none;
  display: flex;
  flex-direction: column;
}

/* 活动带与输入框、子代理 / 后台抽屉对齐行的 12px 边距 */
.chat-bottom > :deep(.astrip),
.chat-bottom > :deep(.adrawer) {
  margin-left: 12px;
  margin-right: 12px;
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
