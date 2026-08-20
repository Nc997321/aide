<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, onUnmounted } from "vue";
import type { ComputedRef } from "vue";
import ChatMessage from "./ChatMessage.vue";
import AppLogo from "./AppLogo.vue";
import Icon from "./Icon.vue";
import ContextCompactionStatus from "./ContextCompactionStatus.vue";
import TaskListPanel from "./TaskListPanel.vue";
import ThemedSelect from "./ThemedSelect.vue";
import ChatSendButton from "./ChatSendButton.vue";
import InterruptButton from "./InterruptButton.vue";
import PermissionDialog from "./PermissionDialog.vue";
import BgTaskDock from "./BgTaskDock.vue";
import WorkspacePicker from "../ui/WorkspacePicker.vue";
import type { BgTask, ChatMessage as ChatMessageType, ContextCompactionState, ContextUsage, ModelOption, PermissionModeOption, PermissionRequest, RateLimitInfo, TaskItem } from "@/types/chat";
import type { SkillMeta, WorkspaceInfo } from "@/types";
import { api } from "@/api";
import { permissionsApi } from "@/api/permissions";
import { trail } from "../utils/diagnostics/scrollTrail";
import type { PermissionRuleDraft, PermissionScope, PermissionSettingsView } from "@/types/permissions";
import { resolvePastePayload } from "@/utils/paste";
import type { PasteResolution } from "@/utils/paste";
import { resolveFileMentions } from "@/utils/fileMentions";
import type { FileMentionResolution } from "@/utils/fileMentions";
import { nextPermissionMode } from "@/utils/permissionModeCycle";
import { checkImageInputSupport } from "@/utils/imageInputPreflight";
import { peekFileClipboard, clearFileClipboard } from "@/composables/useFileClipboard";
import { useInlineMention } from "@/composables/useInlineMention";
import { useMentionInserter } from "@/composables/useMentionInserter";
import { getFileIcon, pathBasename, FOLDER_ICON_PATH } from "@/utils/fileIcons";
import type { ImageAttachment, PendingJump, SendOptions } from "@/composables/useChatSession";
import { useChatScroll } from "@/composables/useChatScroll";
import { useProviders } from "@/composables/useProviders";
import { useSessionProviders } from "@/composables/useSessionProviders";
import type { ProviderConfig } from "@/types";
import { useQuickActions } from "@/composables/useQuickActions";
import type { QuickAction } from "@/composables/useQuickActions";
import { useModal } from "@/composables/useModal";
import { setChatPaneRect } from "@/composables/useChatPaneWidth";
import BtwDrawer from "./BtwDrawer.vue";
import { useBtwSession } from "@/composables/useBtwSession";
import { useSessionContinuity } from "@/composables/useSessionContinuity";
import { pickModelValue, isModelInList } from "@/utils/modelSelect";
import { isPendingSession, isFinalizedSessionPair, toggleBgDock } from "@/composables/useChatSession";
import AToast from "@/ui/AToast.vue";
import { useToast } from "@/composables/useToast";
import type { ModelSwitchResult } from "@/types/chat";

const props = defineProps<{
  sessionId: string | null;
  workspacePath?: string;
  messages: ComputedRef<ChatMessageType[]> | ChatMessageType[];
  isBusy: { value: boolean } | boolean;
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
  bgDockOpen?: boolean;
  bgDockSelectedId?: string | null;
  /** 本会话待确认的权限/提问请求——渲染在消息区和输入框之间（见模板），
   *  不是浮层，见 PermissionDialog.vue 顶部注释。 */
  permission?: PermissionRequest | null;
  permissionQueueCount?: number;
  focused?: boolean;
}>();

const emit = defineEmits<{
  send: [prompt: string, opts: SendOptions];
  "send-btw": [prompt: string, opts: { lightweight: boolean; model?: string; effort?: string }];
  "send-btw-task": [opts: { taskId: string }];
  interrupt: [];
  "set-model": [model: string];
  "set-effort": [effort: string];
  "set-permission-mode": [mode: string];
  "respond-permission": [id: string, approved: boolean, answers?: Record<string, string>, nextMode?: string, reason?: string];
  "update:bgDockSelectedId": [id: string];
  /** hero 归属选择：选中的是会话归属，不是活动工作区（PaneGroup 据此改 pendingWs/defaultWs） */
  "select-workspace": [ws: WorkspaceInfo];
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

// 工具栏快捷操作（/compact /clear）：composable 早就写好且有单测，但从没接到
// UI 上过——之前工具栏里完全看不到这两个按钮。见 handleQuickAction。
const { actions: quickActions } = useQuickActions();

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
const providerModels = computed<ModelOption[]>(() => {
  const p = sessionProvider.value;
  const m = p.modelMappings;
  const vals = [
    p.model,
    m?.anthropicModel,
    m?.defaultOpusModel,
    m?.defaultSonnetModel,
    m?.defaultHaikuModel,
    m?.subagent,
    ...p.knownModels,
  ].filter((v): v is string => !!v && typeof v === "string");
  return [...new Set(vals)].map((v) => ({ value: v, displayName: v }));
});

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

/** 本地选中值：随 props.currentModel（SDK 坐实/切换确认）同步；
 *  会话开始前没有 props.currentModel，用户选的先存在这，随第一条消息带走。 */
const selectedModel = ref("");

/** ThemedSelect 需要 {value,label}，把 {value,displayName} 映射过去 */
const modelSelectOptions = computed(() =>
  displayModels.value.map((m) => ({ value: m.value, label: m.displayName })),
);

/** 用户在当前会话视图里手动改过选择 = true——异步恢复读回时不得覆盖用户操作。 */
let modelTouchedByUser = false;

/** 会话上次用的模型（continuity.lastUsedModel）优先于 provider 默认参与默认值解析：
 *  这个会话上次用什么模型，重开（含重启 app）后选择器还是它；不在当前列表里（停会话
 *  期间换了 provider）则退回 provider 默认。lastUsedModel 由切会话时的
 *  restoreBinding/refreshLastUsed 读回（取代旧 rememberedModel 本地 ref）。 */
function modelFallback(models: ModelOption[]): string {
  return isModelInList(models, continuity.lastUsedModel.value)
    ? (continuity.lastUsedModel.value as string)
    : sessionProvider.value.model;
}

/** 下拉框必须始终有一个「在当前可选项里」的选中值——不能只是视觉上落在第一个
 *  <option> 上而 selectedModel 仍是空串，否则 handleSend 里 `selectedModel.value
 *  || undefined` 不会把它带进 initialModel，导致下拉框显示的模型和实际启动
 *  sidecar 用的模型对不上；更不能让 selectedModel 落到一个不在列表里的值
 *  （ThemedSelect 找不到匹配项会显示空）。
 *
 *  解析统一走 pickModelValue：保证返回值 ∈ 列表（列表空才返回 ""）。这里
 *  sdkCurrent 传 "" —— applyDefaultModel 只在「列表变更 / 会话/provider 重置」
 *  时负责选默认值，不采信 SDK 回报的当前模型（那是 currentModel watcher 的
 *  职责）；尤其 provider 切换时 props.currentModel 可能还是旧 provider 的值，
 *  在此采信会把旧模型带进新 provider 的下拉。 */
function applyDefaultModel(models: ModelOption[]) {
  selectedModel.value = pickModelValue(
    models,
    selectedModel.value,
    "",
    modelFallback(models),
  );
}

/** SDK 在每轮 assistant 消息后回报当前模型（models_available.current）。
 *  仅当它落在当前可选项里才采信——第三方 provider 下 sidecar 回报的常是
 *  Claude 别名（sonnet/opus）或对不上的 id，不在真实模型 id 列表里，采信它
 *  会让下拉显示空；此时保留用户已选的真实 id。existing 仍在列表里则保留之，
 *  否则退化到 记忆/provider 默认 / 首项，绝不空。 */
watch(() => props.currentModel, () => {
  const next = pickModelValue(
    displayModels.value,
    selectedModel.value,
    props.currentModel ?? "",
    modelFallback(displayModels.value),
  );
  if (next !== selectedModel.value) selectedModel.value = next;
  // 注意：模型持久化不在此处（也不在 setModel 下拉切换处）——下拉切换是草稿，
  // 只在 SDK 真正接收发送时落盘（useChatSession.commitPendingModel，挂在
  // session_init / jump_promoted / 存活非排队派发 / finalize 上）。本 watcher 只
  // 负责 selectedModel 与 sidecar 坐实值同步。
});
watch(displayModels, applyDefaultModel, { immediate: true });
watch(
  () => props.sessionId,
  async (sid, prevSid) => {
    // 定名搬迁（tempId→realId）：同一场会话换名，选择不洗。模型落盘交给
    // useChatSession.commitPendingModel（finalizeSession 在搬迁后落盘用户发送时选的模型）。
    if (isFinalizedSessionPair(prevSid, sid)) {
      return;
    }
    modelTouchedByUser = false;
    if (!sid) {
      selectedModel.value = "";
      applyDefaultModel(displayModels.value);
      continuity.clear();
      return;
    }
    // 新建（pending）会话：选择是用户刚做的/随 initialModel 走的，不恢复不重置。
    if (isPendingSession(sid)) return;
    // 停止/重开（无内存绑定）：先恢复供应商绑定 + 读 lastUsed（须在模型恢复前 await，
    // 让 displayModels 反映恢复后的供应商）；存活会话（有内存绑定）：只读 lastUsed。
    if (!providerOf(sid)) {
      await continuity.restoreBinding(sid);
    } else {
      await continuity.refreshLastUsed(sid);
    }
    // 读回期间切走了别的会话 → 放弃（切回来时会再走一遍）。
    if (props.sessionId !== sid) return;
    // 重置到中性：不带上个会话的 selectedModel 当 existing（那是跨会话串的根因——
    // 同供应商下旧值永远在新列表里，pickModelValue 会把它当 existing 留下）。
    selectedModel.value = "";
    applyDefaultModel(displayModels.value);
    // 存活会话 sidecar 坐实的当前模型在列表里 → 权威采信（反映真实在跑的模型）；
    // 第三方别名（不在真实列表）/停止会话（currentModel 空）则恢复 lastUsed。
    if (props.currentModel && isModelInList(displayModels.value, props.currentModel)) {
      if (selectedModel.value !== props.currentModel) selectedModel.value = props.currentModel;
    } else if (isModelInList(displayModels.value, continuity.lastUsedModel.value)) {
      // 用 isModelInList + 直接赋值，不再过 pickModelValue——existing 会压过 remembered
      // （见 modelSelect.test.ts 注释）。不在列表（停会话期间换过 provider）则维持默认。
      selectedModel.value = continuity.lastUsedModel.value as string;
    }
  },
  { immediate: true },
);
// 会话所属 provider 变了（全局切换影响到非存活会话，或 stop_session 释放了绑定），
// 旧选择大概率不在新列表里，重置回新 provider 的默认模型。存活会话的 sessionProvider
// 锁在 spawn 时的 provider，全局切换不会触发这个 watcher——模型下拉不受影响。
watch(() => sessionProvider.value.id, () => {
  // 当前选择在新 provider 的列表里仍然有效就保留——启动竞态：provider 配置异步
  // 加载完成时 id 从系统默认翻成真实 provider，若无脑清空，用户刚选好（还没
  // 发送）的模型会被擦回默认，下一条消息的 initialModel 就带错了模型。
  if (isModelInList(displayModels.value, selectedModel.value)) return;
  selectedModel.value = "";
  applyDefaultModel(displayModels.value);
});

function handleModelChange(value: string) {
  // btw 模式下模型选择器只决定这条支线用什么模型,不回写主会话(主会话模型不变,
  // 发送后 btwMode 关闭,选择器自动回到主会话模型)。
  if (btwMode.value) {
    btwModel.value = value;
    return;
  }
  modelTouchedByUser = true;
  selectedModel.value = value;
  // 会话还没开始时 useChatSession.setModel 是无会话可发的空操作，安全；
  // 真正生效靠 handleSend 把 selectedModel 带进第一条消息。
  emit("set-model", value);
}

// 模型切换回执 → 瞬时提示：sidecar 运行时坐实（成功 = CLI 已接受；失败 = 被
// 驳回，下拉已被回滚广播拉回旧值）；未启动会话走本地 deferred 回执（无活
// sidecar，选择随下一条消息 initialModel 生效）。此前切换成败在 UI 上完全
// 无法区分。watch seq 而不是整个对象引用：连续两次切同一个模型也要照样弹。
const { toastState, showToast } = useToast();
watch(
  () => props.modelSwitchResult?.seq,
  (seq) => {
    const r = props.modelSwitchResult;
    if (!seq || !r) return;
    // 过期回执不弹：切 tab 离开时 watcher 会随 prop 切换重新触发（seq 从
    // undefined 变回 N），没有这道新鲜度判断，几分钟前切别的会话时的旧提示
    // 会在回到这个 tab 时再弹一遍。
    if (Date.now() - r.at > 5000) return;
    if (r.deferred) {
      showToast(`已选定 ${r.display}，将在发送后生效`, "info");
    } else {
      showToast(
        r.ok ? `模型已切换为 ${r.display}` : `模型切换失败：${r.error ?? "未知原因"}`,
        r.ok ? "success" : "danger",
        r.ok ? undefined : 4200, // 失败原因要读完，留久一点
      );
    }
  },
);

// ── Effort 选择器 ──
// 会话级思考深度：选项固定五档（不像模型有 provider 相关列表/SDK 回报列表），
// 默认解析顺序：会话记忆（sessionEffort 元数据）→ provider 配置的 effortLevel →
// "high"。切换经 set-effort 走 sidecar applyFlagSettings 即时生效（SDK 官方中途
// 通道，不重启进程、实测不碰 prompt 缓存）；进程没起时选择随下一条消息的
// initialEffort（env 通道）带上。sidecar 坐实/回滚由 props.currentEffort 同步。
const EFFORT_OPTIONS = [
  { value: "low", label: "LOW" },
  { value: "medium", label: "MEDIUM" },
  { value: "high", label: "HIGH" },
  { value: "xhigh", label: "XHIGH" },
  { value: "max", label: "MAX" },
];
const selectedEffort = ref("high");
/** 用户在当前会话视图里手动改过 = true——异步恢复/provider 就绪回调不得覆盖。 */
let effortTouchedByUser = false;
/** 上次用户手动切 effort 的时刻——坐实 toast 的新鲜度守卫（仿模型回执的 5s 窗口）。 */
let lastEffortUserActionAt = 0;
/** 已弹过坐实 toast 的档位——同值重复坐实（重连回放开）不重复弹。会话切换时重置。 */
let lastEffortToastValue = "";

/** provider 配置的默认档位（设置面板的 effortLevel 是 LOW/MAX 风格大写）；
 *  没配或非法值 → "high"（用户决定：选择器没有"默认"档，默认就落 high）。 */
function providerDefaultEffort(): string {
  const v = (sessionProvider.value.effortLevel ?? "").trim().toLowerCase();
  return EFFORT_OPTIONS.some((o) => o.value === v) ? v : "high";
}

function handleEffortChange(value: string) {
  // btw 模式下 effort 选择器只决定这条支线的档位，不回写主会话（同模型选择器语义）。
  if (btwMode.value) {
    btwEffort.value = value;
    return;
  }
  effortTouchedByUser = true;
  lastEffortUserActionAt = Date.now();
  selectedEffort.value = value;
  // 会话还没开始时 setEffort 是无会话可发的空操作，安全；真正生效靠
  // handleSend 把 selectedEffort 带进第一条消息的 initialEffort。
  emit("set-effort", value);
  // 会话未起：不会有 effort_changed 坐实事件，立即给 deferred 提示（同模型 deferred 文案）。
  if (!props.sessionId) {
    const label = EFFORT_OPTIONS.find((o) => o.value === value)?.label ?? value;
    showToast(`已选定 ${label}，将在发送后生效`, "info");
  }
}

// sidecar 坐实/回滚同步：失败时选择器被拉回旧值（error toast 由下方 watcher 弹）。
// 成功坐实 → toast（镜像模型回执范式）：坐实值 == 用户选定值才弹——失败回滚带
// 的是旧值 ≠ 选定值，天然不弹（失败提示走 effortSwitchError）。比较必须在回滚
// 同步赋值之前。守卫：用户在本视图手动改过（挡初始同步/恢复）+ 5s 新鲜度窗口
// （挡切 tab 回来的旧回执重弹）+ 同值去重。
watch(() => props.currentEffort, (v) => {
  if (!v) return;
  if (
    v === selectedEffort.value &&
    effortTouchedByUser &&
    Date.now() - lastEffortUserActionAt <= 5000 &&
    v !== lastEffortToastValue
  ) {
    lastEffortToastValue = v;
    const label = EFFORT_OPTIONS.find((o) => o.value === v)?.label ?? v;
    showToast(`effort 已切换为 ${label}`, "success");
  }
  if (v !== selectedEffort.value) selectedEffort.value = v;
});

// effort 切换失败 → 瞬时提示（同 modelSwitchResult 的新鲜度守卫语义）。
watch(
  () => props.effortSwitchError?.seq,
  (seq) => {
    if (!seq || !props.effortSwitchError) return;
    showToast(`effort 切换失败：${props.effortSwitchError.message}`, "danger", 4200);
  },
);

// 会话切换：恢复这个会话记住的 effort（没有则落 provider 默认/high）。
// pending 会话不恢复不重置——选择是用户刚做的/随 initialEffort 走的。
// tempId→realId 定名搬迁同理：同一场会话换名，选择不洗（此前定名时落进下面
// 的 providerDefault 重置，首轮发送后 effort 被洗回默认——首轮 bug 的修复）。
watch(
  () => props.sessionId,
  async (sid, prevSid) => {
    // 定名搬迁（首轮发送后 SDK 确认真实 id）：不重置不恢复；用户开工前显式
    // 选过的档位随定名持久化进会话元数据（对齐 setEffort 契约，重开会话恢复）。
    if (isFinalizedSessionPair(prevSid, sid)) {
      if (effortTouchedByUser && sid) {
        void api.setSessionEffort(sid, selectedEffort.value).catch(() => {});
      }
      return;
    }
    if (!sid) {
      effortTouchedByUser = false;
      lastEffortToastValue = "";
      selectedEffort.value = providerDefaultEffort();
      return;
    }
    // pending 临时会话（首轮已发送、等 SDK 定名）：不恢复不重置；touched 保留
    // 到上面的定名分支，用它决定是否把选择持久化。
    if (isPendingSession(sid)) return;
    effortTouchedByUser = false;
    lastEffortToastValue = "";
    // 先按存活会话坐实的 currentEffort 落值，不带上个会话的 selectedEffort（跨会话串）；
    // currentEffort 无效（停止会话/还没学到）时退 provider 默认。再异步恢复 remembered
    // （用户持久化选择优先）——pre-send 选档（pending 时未持久化）靠 currentEffort 兜。
    const ce = props.currentEffort;
    selectedEffort.value =
      ce && EFFORT_OPTIONS.some((o) => o.value === ce) ? ce : providerDefaultEffort();
    const remembered = await api.sessionEffort(sid).catch(() => null);
    // 读回期间切走了别的会话，或用户已经手动改过 → 放弃恢复
    if (props.sessionId !== sid || effortTouchedByUser) return;
    if (remembered && EFFORT_OPTIONS.some((o) => o.value === remembered)) {
      selectedEffort.value = remembered;
    }
  },
  { immediate: true },
);

// provider 就绪/切换：只兜底没被用户动过、且不在存活会话里的选择
// （存活会话的 sessionProvider 锁在 spawn 时的 provider，id 不会变，天然跳过）。
watch(() => sessionProvider.value.id, () => {
  if (effortTouchedByUser) return;
  if (props.sessionId && !isPendingSession(props.sessionId)) return;
  selectedEffort.value = providerDefaultEffort();
});

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

/** PermissionDialog 的 respond 统一入口：处理「记住」持久化 + 权限模式同步 + 放行。
 *  发送前确认（变体 C，name="__sendConfirm__"）在此本地路由——不走 sidecar 权限协议。 */
async function onPermissionRespond(
  id: string,
  approved: boolean,
  answers?: Record<string, string>,
  nextMode?: string,
  persistRule?: { scope: PermissionScope; rules: PermissionRuleDraft[] },
  reason?: string,
) {
  // 发送前确认：approved→清输入并发送 + 推进 lastUsed 基线；取消→保留输入（回退对话框）。
  // 匹配 id 用 sc.request.id（即 PermissionDialog respond 回传的 permission.id）。
  const sc = sendConfirm.value;
  if (sc && sc.request.id === id) {
    if (approved) {
      inputText.value = "";
      pendingImages.value = [];
      pendingMentions.value = [];
      continuity.noteSent(sc.effectiveProvider, sc.effectiveModel);
      emit("send", sc.pendingSend.prompt, sc.pendingSend.opts);
    }
    sendConfirm.value = null;
    return;
  }
  if (nextMode) selectedPermissionMode.value = nextMode;
  if (approved && persistRule) {
    await persistRememberRule(persistRule.scope, persistRule.rules);
  }
  emit("respond-permission", id, approved, answers, nextMode, reason);
}

// ── 权限模式（plan / acceptEdits / default）——和模型下拉同一套模式：
// 会话没起进程时用静态兜底清单，用户的选择随每条消息的 permission_mode 带走；
// 进程活着时切换走运行时命令，显示状态靠 sidecar 回发的事件坐实。
const displayPermissionModes = computed<PermissionModeOption[]>(() =>
  props.permissionModes?.length ? props.permissionModes : defaultPermissionModes.value,
);

/** ThemedSelect 需要 {value,label} */
const permissionModeSelectOptions = computed(() =>
  displayPermissionModes.value.map((m) => ({ value: m.value, label: m.displayName })),
);

// 订阅额度展示：把每个并行窗口折成一个小徽标（已用% + 状态色 + 重置时间）。
// 按已用比例降序（最吃紧的排前面），空则不显示。
const rateLimitWindows = computed(() => {
  const wins = props.rateLimit?.windows ?? [];
  return [...wins]
    .sort((a, b) => b.utilization - a.utilization)
    .map((w) => {
      const pct = Math.round(w.utilization);
      const status = pct >= 100 ? "exceeded" : pct >= 80 ? "warning" : "ok";
      const resetText = formatResetTime(w.resetsAt);
      const parts = [`${w.label} 额度已用 ${pct}%`];
      if (resetText) parts.push(`${resetText}重置`);
      if (status === "exceeded") parts.push("已达上限");
      return { key: w.key, label: w.label, pct, status, title: parts.join(" · ") };
    });
});

/** resetsAt 可能是秒或毫秒的 unix 时间戳——启发式归一到毫秒后折成"还剩 Xh/Xm"。 */
function formatResetTime(resetsAt: number | null): string | null {
  if (typeof resetsAt !== "number" || resetsAt <= 0) return null;
  const ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt; // < 1e12 视作秒
  const diff = ms - Date.now();
  if (diff <= 0) return null;
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `约 ${mins} 分钟后`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `约 ${hours} 小时后`;
  return `约 ${Math.round(hours / 24)} 天后`;
}

const selectedPermissionMode = ref("");

function applyDefaultPermissionMode(modes: PermissionModeOption[]) {
  if (selectedPermissionMode.value || !modes.length) return;
  selectedPermissionMode.value = modes[0].value; // 清单首项即 provider 默认模式
}

watch(() => props.currentPermissionMode, (v) => { if (v) selectedPermissionMode.value = v; });
watch(displayPermissionModes, applyDefaultPermissionMode, { immediate: true });
watch(
  () => props.sessionId,
  (sid, prevSid) => {
    // 定名搬迁：不重置（保留用户 pre-send 选的模式，首条消息 permissionMode 带对）。
    if (isFinalizedSessionPair(prevSid, sid)) return;
    if (!sid) {
      selectedPermissionMode.value = "";
      applyDefaultPermissionMode(displayPermissionModes.value);
      return;
    }
    // pending 会话：保留用户刚选的（无 sidecar 权威源可同步）。
    if (isPendingSession(sid)) return;
    // 每次切换都重置（不带上个会话的模式——跨会话串），再从 sidecar 坐实值或默认落值。
    // currentPermissionMode 同值时 currentPermissionMode watcher 不触发，故此处必须主动落。
    selectedPermissionMode.value = "";
    if (props.currentPermissionMode) selectedPermissionMode.value = props.currentPermissionMode;
    else applyDefaultPermissionMode(displayPermissionModes.value);
  },
  { immediate: true },
);

function handlePermissionModeChange(value: string) {
  selectedPermissionMode.value = value;
  emit("set-permission-mode", value);
  // 用户主动切换（下拉/Shift+Tab）→ 瞬时提示；sidecar 广播同步走
  // currentPermissionMode watcher 不经过这里，不会误弹。
  const label = permissionModeSelectOptions.value.find((o) => o.value === value)?.label ?? value;
  showToast(`权限模式：${label}`, "info");
}
const isBusyVal = computed(() =>
  typeof props.isBusy === "boolean" ? props.isBusy : props.isBusy.value
);
const contextCompactionVal = computed(() => props.contextCompaction ?? null);
const messagesVal = computed(() =>
  Array.isArray(props.messages) ? props.messages : props.messages.value
);

// ── hero（零会话欢迎态）────────────────────────────────────────────────────
// 判定 = 未绑定会话且无消息：零 tab 布局与「新会话」空白预览 tab 共用这一套
// 居中样式。hero 不是独立组件——输入盒/工具栏/发送路径全部复用，只是换布局文案。
const isHero = computed(() => !props.sessionId && messagesVal.value.length === 0);
// 归属显示交给 WorkspacePicker（path → 末段目录名），hero 只需传 props.workspacePath
const heroModelName = computed(
  () => displayModels.value.find((m) => m.value === selectedModel.value)?.displayName ?? "",
);

// 离开 hero 的 FLIP 过渡：状态翻转瞬间（DOM 还没变，flush:"pre"）记录输入盒
// 位置，布局切到正常对话后让输入盒从旧位置平滑「落」到底部（零 tab → 建 tab
// 时 tab 栏出现造成的位移也一并被这次 FLIP 覆盖）。只在翻转瞬间量两次 rect、
// 只动 transform，不碰滚动区——本项目有 O(n²) 渲染/强布局前科，此处保持零负担。
const inputAreaEl = ref<HTMLElement | null>(null);
const heroLeaving = ref(false); // 首条消息淡入用的一次性 class

watch(isHero, (now, prev) => {
  if (!prev || now) return;
  const el = inputAreaEl.value;
  const oldTop = el?.getBoundingClientRect().top ?? null;
  heroLeaving.value = true;
  setTimeout(() => { heroLeaving.value = false; }, 350);
  if (oldTop === null) return;
  void nextTick(() => {
    const el2 = inputAreaEl.value;
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

watch(isBusyVal, (busy) => {
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
} = useChatScroll(() => messagesVal.value, () => props.sessionId);

const btwMode = ref(false);
const btwLightweight = ref(true);
// btw 默认继承主会话当前模型（2026-08-02 改：原默认最便宜的 haiku 系/defaultHaikuModel
// 映射，用户反馈支线回答质量跟不上主会话，索性同源）。btw 期间模型选择器显示它，
// 用户可临时改这条支线的模型（不回写主会话）；发送后 btwMode 关闭，选择器自动回到
// 主会话模型。
const btwModel = ref("");
const btwDefaultModel = computed(() =>
  selectedModel.value || modelSelectOptions.value[0]?.value || "",
);
// btw 期间 effort 选择器落到最低档 low（一次性支线省 token）——与模型选择器同形：
// 用户可临时改（只影响这条支线，不回写主会话），发送后 btwMode 关闭，选择器自动
// 回到主会话之前的档位。
const btwEffort = ref("low");
const displayedEffort = computed(() => (btwMode.value ? btwEffort.value : selectedEffort.value));
function toggleBtw() {
  btwMode.value = !btwMode.value;
  if (btwMode.value) {
    btwModel.value = btwDefaultModel.value;
    btwEffort.value = "low";
  }
}
// 输入框模型选择器显示值:btw 期间显示支线模型,否则显示主会话模型
const displayedModel = computed(() => (btwMode.value ? btwModel.value : selectedModel.value));
const btwRevertToast = ref(false);
let btwToastTimer: number | undefined;
function showBtwRevertToast() {
  btwRevertToast.value = true;
  clearTimeout(btwToastTimer);
  btwToastTimer = window.setTimeout(() => (btwRevertToast.value = false), 1600);
}
function playBtwRevertFlash() {
  const box = rootEl.value?.querySelector(".chat-input-box") as HTMLElement | null;
  if (!box) return;
  box.classList.remove("btw-revert-flash");
  void box.offsetWidth; // 重启动画
  box.classList.add("btw-revert-flash");
  setTimeout(() => box.classList.remove("btw-revert-flash"), 800);
}

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
// 最小化后,支线还在后台跑(starting/running)时浮一个可点开重展抽屉的小标。
// 出错会强制取消最小化(见 useBtwSession error 分支)把错误露出来,所以这里只
// 盖真正在跑的情况;跑完(done)结论已进主对话批注,不再浮。
const btwBgChipVisible = computed(
  () => btw.store.value.minimized
    && btw.store.value.isBusy
    && btw.store.value.ownerSessionId !== null
    && btw.store.value.ownerSessionId === props.sessionId,
);
// 抽屉标题里"· btw"那块小字换成这条支线实际用的模型名(查下拉 displayName,查不到回落原值)
// + 实际 effort 档位——"/btw 问题"直发不进输入模式,选择器显示的仍是主会话档位,
// 支线真实跑什么只能看这里(2026-08-02 用户实锤分不清 HIGH 是显示还是实际)。
const btwModelLabel = computed(() => {
  const v = btw.store.value.model;
  const base = v
    ? (modelSelectOptions.value.find((m) => m.value === v)?.label ?? v)
    : "btw";
  const eff = btw.store.value.effort;
  return eff ? `${base} · ${eff.toUpperCase()}` : base;
});
// 一次性回弹确认:只在支线真正进入 running 才弹"已切回主对话"+flash。
// 失败(error)不弹成功提示,原因在抽屉里展示——修掉"没抽屉却弹已切回"的误导。
const awaitingBtwLaunch = ref(false);
watch(
  () => btw.store.value.status,
  (st) => {
    if (!awaitingBtwLaunch.value) return;
    if (st === "running") {
      awaitingBtwLaunch.value = false;
      playBtwRevertFlash();
      showBtwRevertToast();
    } else if (st === "error") {
      awaitingBtwLaunch.value = false;
    }
  },
);
// 「关闭」按状态分两种语义:
//  - 还在跑(starting/running):最小化——抽屉收起,sidecar 继续后台跑,跑完结论
//    照样作为批注插进主对话(不杀进程,用户要的就是这个)。
//  - 已结束/出错(done/error):teardown——杀残留 sidecar(出错时可能挂着一个僵
//    尸进程)、reset 回 idle。否则 error 态会卡在抽屉里关不掉、进程也赖着不死。
function closeBtw() {
  if (btw.store.value.isBusy) btw.minimize();
  else btw.cleanup();
}
// 点浮标重展抽屉(最小化的逆操作)。仅清标志、不动进程。
function reopenBtw() { btw.reopen(); }

const inputText = ref("");
const skillList = ref<SkillMeta[]>([]);
const slashDropdownVisible = ref(false);
const slashFilter = ref("");
const slashSelectedIndex = ref(0);

const filteredSkills = computed(() => {
  if (!slashDropdownVisible.value) return [];
  const q = slashFilter.value.toLowerCase();
  return skillList.value
    .filter((s) => s.name.toLowerCase().includes(q))
    .slice(0, 8);
});
const pendingImages = ref<Array<ImageAttachment & { previewUrl: string }>>([]);
const textareaEl = ref<HTMLTextAreaElement>();

// skills 随工作区变化重扫（onMounted 时 workspacePath 往往还是空串）
watch(
  () => props.workspacePath,
  async (ws) => {
    try {
      skillList.value = await api.scanPluginSkills(ws ?? "");
    } catch {
      skillList.value = [];
    }
  },
  { immediate: true },
);

// 滚动 / 窗口 / 置底 / 分帧挂载逻辑已摘至 useChatScroll（见上方 useChatScroll 调用）。

watch(inputText, (val) => {
  const match = val.match(/^\/(\S*)$/); // / 开头且无空格
  if (match) {
    slashFilter.value = match[1];
    slashDropdownVisible.value = true;
    slashSelectedIndex.value = 0;
    return;
  }
  slashDropdownVisible.value = false;
  // 模式类斜杠命令的即时切换（同一监听点，与斜杠下拉共用）："/btw "（命令名 +
  // 空格）= 点分裂按钮菜单的「顺便问一下」，立即进输入模式并清空，不用等 Enter
  // （"/btw 问题" 的 Enter 直发分发仍在 handleSend）。prompt 类命令（/compact
  // /clear）无输入模式，仍由 Enter 执行。
  const cmd = val.match(/^\/(\S+)\s$/)?.[1];
  const action = cmd ? quickActions.find((a) => a.command === cmd) : undefined;
  if (!btwMode.value && action?.kind === "btw") {
    inputText.value = "";
    toggleBtw();
  }
});

// 切换会话时清空待发图片/引用芯片
// （滚动/窗口复位 + 分帧 ramp 由 useChatScroll 自己 watch sessionId 处理）
//
// 注意:切会话绝不清理 btw 支线——此前这里调 btw.cleanup(),跑中的支线(问答/
// git-commit)直接被 kill,像被"取消"了一样。现在:抽屉可见性由 ownerSessionId
// 绑定(切走自动隐藏、切回重现),sidecar 进程后台照跑,结论经 onDone 回插主会话
// store(模块级,切换不丢)。真正 teardown 只有两处:用户关抽屉(done/error 态)
// / 开新 btw(单实例替换,见 useBtwSession.startBtw)。
watch(() => props.sessionId, () => {
  pendingImages.value = [];
  pendingMentions.value = [];
});

function selectSkill(skill: SkillMeta | undefined) {
  if (!skill) return;
  inputText.value = "/" + skill.name + " ";
  slashDropdownVisible.value = false;
  nextTick(() => textareaEl.value?.focus());
}

// 文件树右键「添加到对话」：所有分屏组的 ChatPanel 都会看到同一个 pending，
// 但只有聚焦组激活 tab（= 选中的会话，props.focused）消费——多工作区会话
// 并存时引用芯片只进选中的那个输入框，与其它会话无关。
const mentionInserter = useMentionInserter();
/** 输入框上方的文件引用芯片（路径去重）；发送时展开成 @path 前缀拼进 prompt。 */
const pendingMentions = ref<Array<{ path: string; isDir: boolean }>>([]);
watch(
  () => mentionInserter.pending.value?.nonce,
  () => {
    if (!props.focused) return;
    const m = mentionInserter.consumeMention();
    if (!m) return;
    if (!pendingMentions.value.some((x) => x.path === m.path)) {
      pendingMentions.value.push({ path: m.path, isDir: m.isDir });
    }
    nextTick(() => textareaEl.value?.focus());
  },
);

// 输入框 `@path `→mention 芯片转换层（与来源无关：手打/粘贴/拖入都走这）。
// paste/drop 管道把文件引用以 `@path ` 文本插进 textarea，这里统一扫描转换。
const { onInput: handleMentionInput, scan: scanMentions } = useInlineMention({
  inputText,
  textareaEl,
  workspacePath: () => props.workspacePath ?? "",
  addMention: (path, isDir) => {
    if (!pendingMentions.value.some((m) => m.path === path)) {
      pendingMentions.value.push({ path, isDir });
    }
  },
});

const mentionName = pathBasename;
const mentionIcon = getFileIcon;
const folderIconPath = FOLDER_ICON_PATH;

function handleTabKey(e: KeyboardEvent) {
  // Shift+Tab = 循环权限模式（CLI 同款），与 slash 补全互斥
  if (e.shiftKey) {
    cyclePermissionMode(e);
    return;
  }
  if (slashDropdownVisible.value && filteredSkills.value.length) {
    e.preventDefault();
    selectSkill(filteredSkills.value[slashSelectedIndex.value]);
  }
}

/** Shift+Tab 循环权限模式：序列剔除 bypassPermissions（见 permissionModeCycle）。
 *  无可切（清单未就位/剔除后不足两项）时不拦截按键，焦点正常移动。 */
function cyclePermissionMode(e: KeyboardEvent) {
  const next = nextPermissionMode(selectedPermissionMode.value, displayPermissionModes.value);
  if (!next) return;
  e.preventDefault();
  handlePermissionModeChange(next);
}

function handleArrowUp(e: KeyboardEvent) {
  if (slashDropdownVisible.value) {
    e.preventDefault();
    slashSelectedIndex.value = Math.max(0, slashSelectedIndex.value - 1);
  }
}

function handleArrowDown(e: KeyboardEvent) {
  if (slashDropdownVisible.value) {
    e.preventDefault();
    slashSelectedIndex.value = Math.min(filteredSkills.value.length - 1, slashSelectedIndex.value + 1);
  }
}

function insertAtCursor(text: string) {
  const ta = textareaEl.value;
  if (!ta) { inputText.value += text; return; }
  const start = ta.selectionStart ?? inputText.value.length;
  const end = ta.selectionEnd ?? inputText.value.length;
  inputText.value = inputText.value.slice(0, start) + text + inputText.value.slice(end);
  nextTick(() => {
    const pos = start + text.length;
    ta.setSelectionRange(pos, pos);
  });
}

async function handlePaste(e: ClipboardEvent) {
  e.preventDefault();
  const plainText = e.clipboardData?.getData("text/plain") ?? "";
  try {
    // 串行读：clipboardReadFiles 与 clipboardReadImage 各自 OpenClipboard，
    // 同进程并发打开会互斥失败（粘贴偶发为空的真实根因），先 files 后 image。
    const files = await api.clipboardReadFiles();
    const img = await api.clipboardReadImage();
    const res = resolvePastePayload(files, img, peekFileClipboard(), plainText);
    await applyPasteResolution(res);
  } catch {
    if (plainText) insertAtCursor(plainText);
  }
}

/** 把 resolvePastePayload 的结果落进输入框：文本→光标插入；图片路径→base64 附件。
 *  paste 与 drop 共用这条管道，确保两种"把文件弄进输入"的来源行为一致。 */
async function applyPasteResolution(res: PasteResolution) {
  if (res.text) {
    insertAtCursor(res.text);
    // paste/drop 是程序化改 inputText（insertAtCursor 直接赋值），不触发 textarea
    // 的 @input 事件——检测器不会自醒。这里插入 @path 文本后主动扫一次，让芯片
    // 转换立即发生，不必等用户再按键。纯文本扫描无 token 即 no-op。
    void scanMentions();
  }
  for (const imgPath of res.imagePaths) {
    try {
      const data = await api.readFileBase64(imgPath);
      const mediaType = imgPath.toLowerCase().endsWith(".png") ? "image/png"
        : imgPath.toLowerCase().endsWith(".gif") ? "image/gif"
        : imgPath.toLowerCase().endsWith(".webp") ? "image/webp"
        : "image/jpeg";
      pendingImages.value.push({
        data,
        mediaType,
        previewUrl: `data:${mediaType};base64,${data}`,
      });
    } catch { /* 静默失败 */ }
  }
}

/** Uint8Array → base64（分块，避免超大文件一次展开爆栈）。 */
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 允许 OS 文件拖入输入框（OLE 已禁用，WebView2 原生 HTML5 DnD 才会触发）。
 *  preventDefault + dropEffect=copy 消除禁止光标、让 drop 事件落地。 */
function handleDragOver(e: DragEvent) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
}

/** 把拖入的文件接进现有粘贴管道。两路来源：
 *  - 外部 OS 文件：dataTransfer.files。WebView2 不一定暴露 File.path——有则
 *    用真实路径（零额外设施），无则读字节落临时盘兜底拿路径。统一走
 *    resolvePastePayload → @path 引用 / 图片附件。
 *  - 文件树内部拖入：TreeNodeItem.onDragStart 同时 cut(path) 设了 in-app 剪贴板，
 *    以其为准（WebView2 下 dataTransfer.getData 偶发返回空）。拖入输入框是
 *    "引用"不是"移动"，处理后清 cut 态，避免残留半透明与误移。
 *  文件树→文件树的移动走 TreeNodeItem.onDrop，与此处互不干扰（不同落点）。 */
async function handleDrop(e: DragEvent) {
  e.preventDefault();
  e.stopPropagation();
  const dt = e.dataTransfer;
  if (!dt) return;

  const dropped = Array.from(dt.files ?? []);
  let paths: string[] = [];
  let entry: ReturnType<typeof peekFileClipboard> = null;

  if (dropped.length > 0) {
    for (const file of dropped) {
      const fp = (file as File & { path?: string }).path;
      if (typeof fp === "string" && fp) {
        paths.push(fp);
      } else {
        try {
          const buf = new Uint8Array(await file.arrayBuffer());
          const staged = await api.stageDroppedFile(file.name, encodeBase64(buf));
          paths.push(staged);
        } catch { /* 单个文件失败不阻断其余 */ }
      }
    }
  } else {
    // 内部文件树拖入：onDragStart 调的是 cut(path)，而 resolvePastePayload 只认
    // copy 条目，所以不把 entry 喂给它——直接把路径推进 paths 走 files 分支
    // （拖入输入框一律当"引用"，且图片文件能正确转成附件而非 @path）。
    entry = peekFileClipboard();
    if (entry) paths.push(entry.path);
  }

  const res = resolvePastePayload(paths, null, null, "");
  await applyPasteResolution(res);
  if (entry) clearFileClipboard();
}

/** 忙碌时发送 = 排队：不排队，交给 sidecar 在安全边界（当前工具调用跑完）
 *  打断当前这轮再发出——见 useChatSession.sendMessage 的注释。
 *
 *  重入守卫 sending：发图时 checkImageInputSupport 会做一次真实 LLM 往返探测
 *  （首图约 1s，之后按 endpoint+credential+model 在 sidecar 缓存命中即瞬返），
 *  探测期间输入框文本/图片尚未清空——若无守卫，这 1s 内连按两次 Enter 会两次
 *  都读到尚在的输入并各 emit 一次，发出两条消息。finally 复位确保所有早退路径
 *  （探测不支持 / btw 无参 / skill 读取失败）都能正确解锁，下一次发送可正常进入。 */
const sending = ref(false);
async function handleSend() {
  if (sending.value) return;
  sending.value = true;
  try {
    await performSend();
  } finally {
    sending.value = false;
  }
}

async function performSend() {
  const text = inputText.value.trim();
  const hasImages = pendingImages.value.length > 0;
  // 引用芯片 → @path 前缀：发送时才展开成文本，走与手打/粘贴 @path 完全相同的
  // resolveFileMentions 管道（历史 transcript 也因此天然兼容，无需迁移）。
  const mentionPrefix = pendingMentions.value.length
    ? pendingMentions.value.map((m) => "@" + m.path).join(" ") + " "
    : "";
  // 忙碌时不再拦截：useChatSession 会带排队标记透传，sidecar 在安全边界续发
  if (!text && !hasImages && !mentionPrefix) return;

  // 只在有图片时预检；明确不支持则保留输入和附件，未知/临时失败交给 sidecar 二次防线。
  if (!(await checkImageInputSupport(hasImages, selectedModel.value || undefined, api.probeImageInput))) {
    showToast("当前模型不支持图片输入。已保留输入内容和图片附件。", "danger");
    return;
  }

  // 斜杠命令统一分发：/name 命中命令注册表（useQuickActions，/... 的唯一事实源）
  // 就按 kind 执行——prompt 类与点分裂按钮菜单完全同路径（原文发引擎 + 动作胶囊
  // + 二次确认）；btw 无参数进输入模式、有参数直接发支线。查不到才走 skill /
  // 普通文本。已在 btw 模式里时不拦（输入本来就是支线内容，/btw 字面量无意义）。
  if (!btwMode.value) {
    const cmdMatch = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    const action = cmdMatch ? quickActions.find((a) => a.command === cmdMatch[1]) : undefined;
    if (action) {
      const args = (cmdMatch![2] ?? "").trim();
      if (action.kind === "task") {
        // 任务支线(git-commit):无参数、不进输入模式,一键直跑;输入清空同 btw。
        inputText.value = "";
        pendingImages.value = [];
        pendingMentions.value = [];
        emit("send-btw-task", { taskId: action.taskId ?? action.id });
        return;
      }
      if (action.kind === "btw") {
        inputText.value = "";
        pendingImages.value = [];
        pendingMentions.value = [];
        if (!args) {
          toggleBtw(); // 只切输入模式，等问题
          return;
        }
        emit("send-btw", mentionPrefix + args, {
          lightweight: btwLightweight.value,
          model: btwModel.value || btwDefaultModel.value,
          effort: btwEffort.value,
        });
        awaitingBtwLaunch.value = true;
        return;
      }
      // prompt 类：菜单点击与手打同出口；取消确认则保留输入、什么都不发。
      const sent = await runPromptAction(action, mentionPrefix + text);
      if (sent) {
        inputText.value = "";
        pendingImages.value = [];
        pendingMentions.value = [];
      }
      return;
    }
  }

  if (btwMode.value) {
    // btw 一次性:发完自动切回主对话输入。回弹确认(回弹动画 + "已切回"toast)
    // 不在这里乐观触发——等支线真正进入 running 才确认(见上面 status 的 watch),
    // 否则 fork 失败时也会弹"已切回主对话输入"造成误导。
    // 引用芯片在 btw 里只带 @path 字面量（支线没有 mention 展开通道），模型可自行 Read。
    emit("send-btw", mentionPrefix + text, { lightweight: btwLightweight.value, model: btwModel.value, effort: btwEffort.value });
    inputText.value = "";
    pendingImages.value = [];
    pendingMentions.value = [];
    btwMode.value = false; // 横幅收起、按钮复原
    awaitingBtwLaunch.value = true;
    return;
  }

  let finalPrompt = text;
  const slashMatch = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (slashMatch) {
    const skillName = slashMatch[1];
    const userText = (slashMatch[2] ?? "").trim();
    const skill = skillList.value.find((s) => s.name === skillName);
    if (skill) {
      try {
        const content = await api.readFileContent(skill.filePath);
        finalPrompt = userText ? `${content}\n\n---\n\n${userText}` : content;
      } catch { /* 读取失败则原样发送 */ }
    }
  }

  // headless 的 query() 不会像交互式终端那样把 @path 自动展开成文件内容——
  // 那是 TUI 按键输入层的行为，这里必须自己在发送前把引用的文件读出来拼进
  // 发给模型的文本里，否则模型收到的只是字面量文本，读不读全凭它自己判断
  // （见踩坑记录）。展开后的内容不进 finalPrompt（用户气泡显示用的原文），
  // 只进 mentionResolution.sendText（发给模型用）——避免文件内容和用户
  // 自己打的字混在一个气泡里，读起来很差。
  const mentionResolution = await resolveFileMentions(mentionPrefix + finalPrompt, api.readFileContent);

  const images = pendingImages.value.map(({ data, mediaType }) => ({ data, mediaType }));
  const sendOpts: SendOptions = {
    images: images.length ? images : undefined,
    // Rust 只在 sidecar 进程还没起来时才会用这个值（见 chat.rs），已有会话时
    // 无害地被忽略，不需要在这里判断"是否已有会话"。
    initialModel: selectedModel.value || undefined,
    // effort 选择器当前值：每条消息都带（存活会话同值幂等），新会话 spawn 时
    // 是初始档位——没有选择器默认值以外的"隐式 effort"。
    initialEffort: selectedEffort.value || undefined,
    mentions: mentionResolution,
    permissionMode: selectedPermissionMode.value || undefined,
  };

  // 发送前确认门控（变体 C）：若本次发送的 provider/模型与会话上次不同（fork/冷缓存代价）
  // → 不立即发送，交给 PermissionDialog 确认形态：确认才发，取消则保留输入（内容回退对话框）。
  // 覆盖停止会话（发送 respawn）和 idle 存活会话（waiting，发送续跑但模型已切换 → 冷缓存）；
  // 仅「正在生成」(isBusy) 跳过避免打断；pending（首条）无 lastUsed 不弹；同值不弹。
  const effectiveProvider = sessionProvider.value.id;
  const effectiveModel = selectedModel.value || sessionProvider.value.model;
  const sidForGate = props.sessionId;
  if (
    sidForGate &&
    !isPendingSession(sidForGate) &&
    !isBusyVal.value &&
    continuity.needsConfirm(effectiveProvider, effectiveModel)
  ) {
    sendConfirm.value = {
      request: buildSendConfirmRequest(effectiveProvider, effectiveModel),
      pendingSend: { prompt: mentionPrefix + finalPrompt, opts: sendOpts },
      effectiveProvider,
      effectiveModel,
    };
    return; // 不清输入——取消时内容回退对话框
  }

  inputText.value = "";
  pendingImages.value = [];
  pendingMentions.value = [];
  continuity.noteSent(effectiveProvider, effectiveModel);
  emit("send", mentionPrefix + finalPrompt, sendOpts);
}

// 快捷操作（压缩/清空上下文）：跟手打消息走同一条路径（忙碌排队/权限模式透传都
// 免费拿到），但用户气泡渲染成动作胶囊（emit 时带 action 描述符，见
// useChatSession.dispatchSend）。/clear 不可逆，执行前弹 useModal.confirm 二次确认。
// 菜单点击与手打 /name 统一走 runPromptAction——取消确认则什么都不发、不入队、不推气泡。
async function runPromptAction(action: QuickAction, prompt: string): Promise<boolean> {
  if (action.confirm) {
    const ok = await useModal().confirm(
      action.label,
      "将清空当前会话上下文，不可撤销。是否继续？",
      "清空",
      true,
    );
    if (!ok) return false;
  }
  const sendOpts: SendOptions = {
    initialModel: selectedModel.value || undefined,
    initialEffort: selectedEffort.value || undefined,
    permissionMode: selectedPermissionMode.value || undefined,
    action: { id: action.id, label: action.label, icon: action.icon },
  };
  // 同 performSend 的发送前确认门控：provider/模型与会话上次不同（fork/冷缓存）→
  // 交确认形态（停止会话 respawn / idle 存活会话冷缓存都弹，正在生成跳过）。取消→返回
  // false，调用方据此保留输入。
  const effectiveProvider = sessionProvider.value.id;
  const effectiveModel = selectedModel.value || sessionProvider.value.model;
  const sidForGate = props.sessionId;
  if (
    sidForGate &&
    !isPendingSession(sidForGate) &&
    !isBusyVal.value &&
    continuity.needsConfirm(effectiveProvider, effectiveModel)
  ) {
    sendConfirm.value = {
      request: buildSendConfirmRequest(effectiveProvider, effectiveModel),
      pendingSend: { prompt, opts: sendOpts },
      effectiveProvider,
      effectiveModel,
    };
    return false;
  }
  continuity.noteSent(effectiveProvider, effectiveModel);
  emit("send", prompt, sendOpts);
  return true;
}

/** 分裂按钮菜单选择：btw 是输入模式切换（不发消息），task 一键直跑任务支线，
 *  prompt 类与手打 /name 同路径。 */
async function handleQuickAction(action: QuickAction) {
  if (action.kind === "btw") {
    toggleBtw();
    return;
  }
  if (action.kind === "task") {
    emit("send-btw-task", { taskId: action.taskId ?? action.id });
    return;
  }
  await runPromptAction(action, "/" + action.command);
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
      <div v-if="messagesVal.length === 0" class="chat-empty">
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
      :current-mode="selectedPermissionMode"
      @respond="onPermissionRespond"
    />

    <!-- 后台任务 dock：与 PermissionDialog 同款 inline dock——挤压消息区而非浮层。
         开合/清理语义在 toggleBgDock（结束的任务下次点开才清）。 -->
    <BgTaskDock
      :session-id="props.sessionId"
      :tasks="bgTasks ?? []"
      :open="bgDockOpen ?? false"
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
    <div v-else-if="isBusyVal" class="chat-thinking">
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

    <div ref="inputAreaEl" class="chat-input-area">
      <!-- Slash command dropdown -->
      <div v-if="filteredSkills.length" class="skill-dropdown">
        <div
          v-for="(skill, i) in filteredSkills"
          :key="skill.provider + ':' + skill.name"
          :class="['skill-item', i === slashSelectedIndex ? 'skill-item--active' : '']"
          @mousedown.prevent="selectSkill(skill)"
        >
          <span class="skill-item-name">/{{ skill.name }}</span>
          <span class="skill-item-source">{{ skill.source }}</span>
          <span class="skill-item-desc">{{ skill.description }}</span>
        </div>
      </div>
      <!-- 输入框、图片缩略图、模型工具栏放进同一个带边框的盒子里，工具栏焊在底部——
           不再是"模型栏单独一行浮在输入框上方"，避免贴图片时模型栏被顶得到处跑。 -->
      <!-- 忙碌时排队、正在等安全边界（当前回合结束）的消息：sidecar 已登记，不可撤回 -->
      <div v-if="pendingJumps?.length" class="jump-strip">
        <div v-for="(p, i) in pendingJumps" :key="i" class="jump-item">
          <span class="jump-item-tag">排队</span>
          <span class="jump-item-text">{{ p.text }}</span>
          <span class="jump-item-hint">等当前回合结束发出</span>
        </div>
      </div>
      <!-- 最小化后支线仍在后台跑:浮一个可点开重展抽屉的小标(done 后结论已进批注,不再浮) -->
      <Transition name="btw-chip">
        <button
          v-if="btwBgChipVisible"
          class="btw-bg-chip"
          v-tooltip="'支线还在后台跑,点开重展抽屉'"
          @click="reopenBtw"
        >
          <span class="btw-bg-chip-glyph">↳</span> btw 后台运行中
          <span class="btw-bg-chip-pulse"></span>
        </button>
      </Transition>
      <div
        class="chat-input-box"
        :class="{ 'btw-mode': btwMode, 'session-running': isBusyVal }"
        @dragover.prevent="handleDragOver"
        @drop.prevent="handleDrop"
      >
        <Transition name="btw-banner">
          <div v-if="btwMode" class="btw-mode-banner">
            <span class="btw-banner-glyph">↳</span>
            <span class="btw-banner-text"><b>顺便问一下</b> · 不进入主对话 · 阅后即弃</span>
            <button type="button" class="btw-banner-x" @click="btwMode = false" v-tooltip="'退出 btw 模式'">×</button>
          </div>
        </Transition>
        <!-- 文件引用芯片（文件树右键「添加到对话」）：发送时展开成 @path 前缀 -->
        <div v-if="pendingMentions.length" class="mention-strip">
          <div
            v-for="(m, i) in pendingMentions"
            :key="m.path"
            class="mention-chip"
            v-tooltip="m.path"
          >
            <svg
              v-if="m.isDir"
              class="mention-chip-icon mention-chip-icon--folder"
              width="13" height="13" viewBox="0 0 24 24" fill="none"
            >
              <path :d="folderIconPath" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <svg
              v-else
              class="mention-chip-icon"
              :style="{ color: mentionIcon(mentionName(m.path)).color }"
              width="13" height="13" viewBox="0 0 24 24" fill="none"
            >
              <path :d="mentionIcon(mentionName(m.path)).path" fill="currentColor" opacity="0.85"/>
            </svg>
            <span class="mention-chip-name">{{ mentionName(m.path) }}</span>
            <button class="mention-chip-remove" @click="pendingMentions.splice(i, 1)">×</button>
          </div>
        </div>
        <div v-if="pendingImages.length" class="image-attachment-strip">
          <div
            v-for="(img, i) in pendingImages"
            :key="i"
            class="image-thumb"
          >
            <img :src="img.previewUrl" class="image-thumb-img" alt="附图" />
            <button class="image-thumb-remove" @click="pendingImages.splice(i, 1)">×</button>
          </div>
        </div>
        <textarea
          ref="textareaEl"
          v-model="inputText"
          class="chat-input"
          :placeholder="btwMode ? '顺便问一下,不进入主对话…' : (isBusyVal ? '生成中，发送的消息将排队…' : (isHero ? '你正在解决什么问题？' : '输入消息…'))"
          rows="3"
          @keydown.enter.exact.prevent="(slashDropdownVisible && filteredSkills.length) ? selectSkill(filteredSkills[slashSelectedIndex]) : handleSend()"
          @keydown.enter.shift.exact.prevent="insertAtCursor('\n')"
          @keydown.tab="handleTabKey"
          @keydown.escape="slashDropdownVisible = false"
          @keydown.up="handleArrowUp"
          @keydown.down="handleArrowDown"
          @paste="handlePaste"
          @input="handleMentionInput"
        />
        <div class="chat-toolbar">
          <ThemedSelect
            v-if="displayModels.length"
            :model-value="displayedModel"
            :options="modelSelectOptions"
            title="模型"
            @update:model-value="handleModelChange"
          />
          <!-- effort 选择器：会话级思考深度，切换即时生效（sidecar applyFlagSettings，
               不重启进程、不碰 prompt 缓存）；默认 high -->
          <ThemedSelect
            :model-value="displayedEffort"
            :options="EFFORT_OPTIONS"
            title="effort（思考深度）：低档省 token、高档想得更深；切换从下一轮起生效，不影响缓存"
            @update:model-value="handleEffortChange"
          />
          <div
            v-if="displayPermissionModes.length"
            class="perm-mode-wrap"
            :class="{ 'perm-mode-wrap--bypass': selectedPermissionMode === 'bypassPermissions' }"
          >
            <ThemedSelect
              :model-value="selectedPermissionMode"
              :options="permissionModeSelectOptions"
              title="权限模式"
              @update:model-value="handlePermissionModeChange"
            />
            <span
              v-if="selectedPermissionMode === 'bypassPermissions'"
              class="perm-bypass-badge"
              v-tooltip="'已跳过所有工具权限确认（含本会话派生的所有子代理，子代理会继承此模式且不能单独覆盖），仅本会话生效；切换/新建会话会恢复默认权限模式'"
            >⚠️ 跳过确认</span>
          </div>
          <div
            v-if="props.contextUsage"
            class="chat-ctx-usage"
            v-tooltip="`上下文用量：${props.contextUsage.totalTokens.toLocaleString()} / ${props.contextUsage.maxTokens.toLocaleString()} tokens`"
          >
            <span class="chat-ctx-label">ctx</span>
            <div class="chat-ctx-bar">
              <div class="chat-ctx-bar-fill" :style="{ width: props.contextUsage.percentage + '%' }" />
            </div>
            <span class="chat-ctx-percent">{{ Math.round(props.contextUsage.percentage) }}%</span>
          </div>
          <div
            v-for="w in rateLimitWindows"
            :key="w.key"
            class="chat-quota"
            :class="`chat-quota--${w.status}`"
            v-tooltip="w.title"
          >
            <span class="chat-quota-dot" />
            <span class="chat-quota-label">{{ w.label }}</span>
            <div class="chat-ctx-bar">
              <div class="chat-ctx-bar-fill" :style="{ width: w.pct + '%' }" />
            </div>
            <span class="chat-ctx-percent">{{ w.pct }}%</span>
          </div>
          <ChatSendButton
            :disabled="(!inputText.trim() && !pendingImages.length && !pendingMentions.length) || sending"
            :busy="isBusyVal && !btwMode"
            :actions="quickActions"
            :btw-active="btwMode"
            :btw-disabled="!props.sessionId"
            :btw-disabled-reason="'先发送一条消息开始主对话，才能顺便问一下'"
            @send="handleSend()"
            @select="handleQuickAction"
          />
        </div>
      </div>
      <Transition name="btw-toast">
        <div v-if="btwRevertToast" class="btw-revert-toast">已切回主对话输入</div>
      </Transition>
      <AToast :state="toastState" />
    </div>
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

.chat-input-area {
  border-top: 1px solid var(--aide-border);
  padding: 8px 12px;
  flex-shrink: 0;
  position: relative;
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

.chat-panel--hero .chat-input-area {
  flex: none;
  width: min(680px, 92%);
  margin: 0 auto;
  padding: 0;
  border-top: none;
  animation: hero-rise .22s var(--aide-ease);
}

.chat-panel--hero .chat-input-box {
  box-shadow: var(--aide-shadow-lg);
}

/* 进入 hero：标题行/输入盒淡入上浮 */
@keyframes hero-rise {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
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
  .chat-panel--hero .chat-input-area,
  .chat-panel--hero-leaving .chat-messages {
    animation: none;
  }
  .hero-fade-enter-active,
  .hero-fade-leave-active {
    transition: none;
  }
}

/* 统一的带边框输入盒子——图片缩略图、文本框、模型工具栏都在里面，
   焦点样式挂在盒子本身（:focus-within），不是内层 textarea 单独一圈边框。 */
.chat-input-box {
  display: flex;
  flex-direction: column;
  border-radius: var(--aide-radius-sm);
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border);
  transition: all var(--aide-ease-t);
}

.chat-input-box:focus-within {
  border-color: var(--aide-accent);
}

/* 运行中聚焦不再整圈 accent 描边——边框保持素色，让彗星环成为唯一的彩色信号 */
.chat-input-box.session-running:focus-within {
  border-color: var(--aide-border);
}

/* 会话运行时输入盒流光（双向对追双彗星 + 柔光晕）：纯 CSS 单伪元素，零 JS。
   ::before 的 conic 渐变随 @property 角度旋转（两颗彗星相隔 180° 对跑），
   2 层 mask + exclude 只露出 1px 锐环、精确压盖住边框；光晕用 drop-shadow
   实现——关键教训：filter 作用于 mask 之后的结果，所以 drop-shadow 严格
   跟随环形（盒内一笔不画，glass 半透明背景主题也安全）；而 blur 在 mask 前
   生效、会被 mask 裁出硬边平顶光带（"粗边框"观感的来源），不能用。
   另注意此 WebView2 只支持单值 mask-composite，3 层以上多值组合整条失效
   （退化成全叠加、光楔糊满输入框），mask 层数必须 ≤2。
   渐变淡出端用 color-mix 0% 同色透明，不用 transparent 关键字（透明黑插值
   会经过发暗中间色、光带显脏）。颜色全走主题 token，空闲时无伪元素零开销。 */
@property --aide-input-comet {
  syntax: "<angle>";
  initial-value: 0deg;
  inherits: false;
}

.chat-input-box.session-running {
  position: relative;
  isolation: isolate;
}

.chat-input-box.session-running::before {
  content: "";
  position: absolute;
  inset: 0;
  padding: 1px;
  border-radius: var(--aide-radius-sm);
  pointer-events: none;
  background: conic-gradient(
    from var(--aide-input-comet),
    color-mix(in srgb, var(--aide-accent) 0%, transparent) 0deg,
    var(--aide-accent) 30deg,
    var(--aide-accent-hover) 42deg,
    color-mix(in srgb, var(--aide-accent-hover) 0%, transparent) 55deg,
    color-mix(in srgb, var(--aide-accent) 0%, transparent) 180deg,
    var(--aide-accent) 210deg,
    var(--aide-accent-hover) 222deg,
    color-mix(in srgb, var(--aide-accent-hover) 0%, transparent) 235deg,
    color-mix(in srgb, var(--aide-accent) 0%, transparent) 360deg
  );
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  filter: drop-shadow(0 0 10px color-mix(in srgb, var(--aide-accent) 85%, transparent));
  animation: chat-input-comet 3.2s linear infinite;
}

@keyframes chat-input-comet {
  to { --aide-input-comet: 360deg; }
}

.chat-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-top: 1px solid var(--aide-border);
  font-size: 12px;
  color: var(--aide-text-secondary);
}

/* bypassPermissions（跳过所有确认）常驻警示：不用一次性确认框，而是选中期间持续
 * 可见的红色信号，提醒当前会话正在跳过所有工具权限确认。注意类名用 --bypass 而非
 * --auto：auto 是另一个独立的权限模式（模型分类器判断），不要和这里的危险模式混淆。 */
.perm-mode-wrap {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.perm-mode-wrap--bypass :deep(.themed-select) {
  border-color: var(--aide-danger);
  color: var(--aide-danger);
}

.perm-bypass-badge {
  font-size: 11px;
  color: var(--aide-danger);
  white-space: nowrap;
}

.chat-ctx-usage {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--aide-text-muted);
}

.chat-ctx-label {
  white-space: nowrap;
}

.chat-ctx-bar {
  width: 48px;
  height: 5px;
  border-radius: 3px;
  background: var(--aide-surface-hover);
  overflow: hidden;
}

.chat-ctx-bar-fill {
  height: 100%;
  background: var(--aide-accent);
  transition: width var(--aide-ease-t);
}

.chat-ctx-percent {
  white-space: nowrap;
  min-width: 28px;
}

.chat-quota {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--aide-text-muted);
  cursor: default;
}

.chat-quota-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--aide-accent);
}

.chat-quota-label {
  white-space: nowrap;
}

/* 归一化状态色：ok 走强调色、warning 橙、exceeded 红（点 + 进度条同步变色）。 */
.chat-quota--warning .chat-quota-dot,
.chat-quota--warning .chat-ctx-bar-fill {
  background: var(--aide-warning);
}
.chat-quota--warning .chat-quota-label { color: var(--aide-warning); }

.chat-quota--exceeded .chat-quota-dot,
.chat-quota--exceeded .chat-ctx-bar-fill {
  background: var(--aide-danger);
}
.chat-quota--exceeded .chat-quota-label { color: var(--aide-danger); font-weight: 600; }

.chat-input {
  resize: none;
  border: none;
  background: transparent;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--aide-text-primary);
  outline: none;
  font-family: inherit;
  line-height: 1.5;
}

.chat-input::placeholder {
  color: var(--aide-text-muted);
}

.chat-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 分裂式发送按钮（ChatSendButton 根元素）：始终靠右。按钮自身的外观在
 * ChatSendButton.vue 内。 */
.chat-send-split {
  margin-left: auto;
}

.skill-dropdown {
  position: absolute;
  bottom: 100%;
  left: 12px;
  right: 12px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  box-shadow: var(--aide-shadow-lg);
  z-index: 100;
  max-height: 280px;
  overflow-y: auto;
  margin-bottom: 4px;
}

.skill-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 12px;
  overflow: hidden;
}

.skill-item:hover,
.skill-item--active {
  background: var(--aide-surface-hover);
}

.skill-item-name {
  font-weight: 600;
  color: var(--aide-accent);
  flex-shrink: 0;
  font-family: var(--aide-font-mono);
}

.skill-item-source {
  font-size: 10px;
  color: var(--aide-text-muted);
  flex-shrink: 0;
  background: var(--aide-bg-deep);
  padding: 1px 4px;
  border-radius: 3px;
}

.skill-item-desc {
  color: var(--aide-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.jump-strip {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 6px;
}

.jump-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--aide-text-secondary);
  background: var(--aide-surface-default);
  border: 1px dashed var(--aide-border);
  border-radius: var(--aide-radius-sm);
}

.jump-item-tag {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--aide-accent);
  background: var(--aide-accent-subtle);
  padding: 1px 4px;
  border-radius: 3px;
}

.jump-item-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.jump-item-hint {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--aide-text-muted);
}

/* ── 文件引用芯片 ── */
.mention-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 12px 0;
}

.mention-chip {
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 220px;
  padding: 3px 5px 3px 7px;
  border-radius: var(--aide-radius-sm);
  border: 1px solid var(--aide-border);
  background: var(--aide-surface-default);
  font-size: 11px;
  color: var(--aide-text-secondary);
  user-select: none;
}

.mention-chip-icon {
  flex-shrink: 0;
}

.mention-chip-icon--folder {
  color: var(--aide-text-muted);
}

.mention-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mention-chip-remove {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--aide-text-muted);
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.mention-chip-remove:hover {
  background: var(--aide-danger);
  color: var(--aide-text-primary);
}

.image-attachment-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 12px 0;
}

.image-thumb {
  position: relative;
  width: 56px;
  height: 56px;
  border-radius: var(--aide-radius-sm);
  overflow: hidden;
  border: 1px solid var(--aide-border);
  flex-shrink: 0;
}

.image-thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.image-thumb-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--aide-bg-overlay);
  color: var(--aide-text-primary);
  border: none;
  cursor: pointer;
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  line-height: 1;
}

.image-thumb-remove:hover {
  background: var(--aide-danger);
}

/* ── btw 模式 ── */
.btw-mode-banner {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 11px;
  font-size: 11px;
  color: var(--aide-accent);
  background: color-mix(in srgb, var(--aide-accent) 8%, transparent);
  border-bottom: 1px solid var(--aide-border-subtle);
}
.btw-banner-glyph { font-size: 14px; line-height: 1; }
.btw-banner-text { flex: 1; }
.btw-banner-text b { color: var(--aide-accent); }
.btw-banner-x {
  background: none; border: none; color: var(--aide-accent);
  font-size: 14px; cursor: pointer; opacity: 0.8; line-height: 1;
}
.btw-banner-x:hover { opacity: 1; }
.chat-input-box.btw-mode {
  border-color: var(--aide-accent);
  box-shadow: 0 0 0 2px var(--aide-accent-subtle);
}
.chat-input-box.btw-revert-flash { animation: btw-revert-flash 0.8s ease-out; }
@keyframes btw-revert-flash {
  0% { border-color: var(--aide-accent); box-shadow: 0 0 0 3px var(--aide-accent-subtle); }
  40% { border-color: var(--aide-accent); box-shadow: 0 0 0 3px var(--aide-accent-subtle); }
  100% { border-color: var(--aide-border); box-shadow: none; }
}
.btw-revert-toast {
  position: absolute; left: 50%; transform: translateX(-50%);
  bottom: 100%; margin-bottom: 6px;
  background: var(--aide-bg-raised); border: 1px solid var(--aide-accent);
  color: var(--aide-accent); font-size: 11px; padding: 4px 12px;
  border-radius: 999px; box-shadow: var(--aide-shadow-md);
  z-index: 40; pointer-events: none; white-space: nowrap;
}
.btw-banner-enter-active, .btw-banner-leave-active { transition: opacity 0.2s, max-height 0.25s; overflow: hidden; }
.btw-banner-enter-from, .btw-banner-leave-to { opacity: 0; max-height: 0; }
.btw-toast-enter-active, .btw-toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.btw-toast-enter-from, .btw-toast-leave-to { opacity: 0; transform: translate(-50%, 4px); }

/* 最小化后重展抽屉的入口浮标:支线仍在后台跑时显示,点开重展。 */
.btw-bg-chip {
  display: inline-flex; align-items: center; gap: 6px;
  margin: 0 0 8px auto; padding: 4px 11px;
  background: color-mix(in srgb, var(--aide-accent) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-accent) 40%, transparent);
  color: var(--aide-accent); font-size: 11.5px;
  border-radius: 999px; cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}
.btw-bg-chip:hover { background: color-mix(in srgb, var(--aide-accent) 20%, transparent); border-color: var(--aide-accent); }
.btw-bg-chip-glyph { font-size: 13px; line-height: 1; }
.btw-bg-chip-pulse {
  width: 6px; height: 6px; border-radius: 50%; background: var(--aide-accent);
  animation: btw-chip-pulse 1.4s ease-in-out infinite;
}
@keyframes btw-chip-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
.btw-chip-enter-active, .btw-chip-leave-active { transition: opacity 0.18s, transform 0.18s; }
.btw-chip-enter-from, .btw-chip-leave-to { opacity: 0; transform: translateY(4px); }
</style>
