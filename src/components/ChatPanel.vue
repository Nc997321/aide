<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, onUnmounted } from "vue";
import type { ComputedRef } from "vue";
import ChatMessage from "./ChatMessage.vue";
import AppLogo from "./AppLogo.vue";
import TaskListPanel from "./TaskListPanel.vue";
import ThemedSelect from "./ThemedSelect.vue";
import ChatSendButton from "./ChatSendButton.vue";
import PermissionDialog from "./PermissionDialog.vue";
import BgTaskDock from "./BgTaskDock.vue";
import type { ChatMessage as ChatMessageType, ContextUsage, ModelOption, PermissionModeOption, PermissionRequest, RateLimitInfo, TaskItem, TextBlock, BgTask } from "@/types/chat";
import type { SkillMeta } from "@/types";
import { api } from "@/api";
import { resolvePastePayload } from "@/utils/paste";
import { resolveFileMentions } from "@/utils/fileMentions";
import type { FileMentionResolution } from "@/utils/fileMentions";
import { checkImageInputSupport } from "@/utils/imageInputPreflight";
import { peekFileClipboard } from "@/composables/useFileClipboard";
import { useMentionInserter } from "@/composables/useMentionInserter";
import { getFileIcon, pathBasename, FOLDER_ICON_PATH } from "@/utils/fileIcons";
import type { ImageAttachment, SendOptions } from "@/composables/useChatSession";
import { useMessageWindow } from "@/composables/useMessageWindow";
import { useProviders } from "@/composables/useProviders";
import { useSessionProviders } from "@/composables/useSessionProviders";
import type { ProviderConfig } from "@/types";
import { useQuickActions } from "@/composables/useQuickActions";
import type { QuickAction } from "@/composables/useQuickActions";
import { useModal } from "@/composables/useModal";
import { setChatPaneRect } from "@/composables/useChatPaneWidth";
import BtwDrawer from "./BtwDrawer.vue";
import { useBtwSession } from "@/composables/useBtwSession";
import { pickModelValue, isModelInList } from "@/utils/modelSelect";
import { isPendingSession, toggleBgDock } from "@/composables/useChatSession";
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
  contextUsage?: ContextUsage | null;
  /** 账号级订阅额度/速率；null 时不显示 */
  rateLimit?: RateLimitInfo | null;
  tasks?: TaskItem[];
  permissionModes?: PermissionModeOption[];
  currentPermissionMode?: string;
  /** 忙碌时插队、正在 sidecar 里等安全边界的消息原文（顺序即发出顺序） */
  pendingJumps?: string[];
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
  "send-btw": [prompt: string, opts: { lightweight: boolean; model?: string }];
  interrupt: [];
  "set-model": [model: string];
  "set-permission-mode": [mode: string];
  "respond-permission": [id: string, approved: boolean, always?: boolean, answers?: Record<string, string>, nextMode?: string];
  "update:bgDockSelectedId": [id: string];
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

/** 打开会话时从元数据读回的模型记忆（null = 没记过/还没读回）——
 *  作为「provider 默认」之前的一档候选参与默认值解析：这个会话上次
 *  用什么模型，重开（含重启 app）后选择器还是它。 */
const rememberedModel = ref<string | null>(null);
/** 用户在当前会话视图里手动改过选择 = true——异步恢复读回时不得覆盖用户操作。 */
let modelTouchedByUser = false;

/** remembered 优先于 provider 默认；但它不在当前列表里（停会话期间换了
 *  provider）时不采信，退回 provider 默认。 */
function modelFallback(models: ModelOption[]): string {
  return isModelInList(models, rememberedModel.value)
    ? (rememberedModel.value as string)
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
  // 坐实模型持久化（重开会话恢复的数据来源）：只记选择器能显示的值（在列表
  //  里）。第三方 provider 下 sidecar 会把 wire id 解析成 Claude 别名（实测
  //  kimi：kimi-for-coding → "haiku"），别名不在真实 id 列表里——记了恢复
  //  不出来，还会盖掉用户真实选择。
  const sid = props.sessionId;
  if (sid && !isPendingSession(sid) && isModelInList(displayModels.value, props.currentModel)) {
    void api.setSessionModel(sid, props.currentModel as string).catch(() => {});
  }
});
watch(displayModels, applyDefaultModel, { immediate: true });
watch(
  () => props.sessionId,
  async (sid) => {
    modelTouchedByUser = false;
    rememberedModel.value = null;
    if (!sid) {
      selectedModel.value = "";
      applyDefaultModel(displayModels.value);
      return;
    }
    // 新建（pending）会话：选择是用户刚做的/随 initialModel 走的，不恢复不重置；
    // 存活会话：SDK 坐实值（currentModel watcher）优先。此处显式同步 selectedModel
    // 而不是简单 return——因为 currentModel watcher 只在值变化时触发，若两个会话
    // 的 currentModel 碰巧相同（如都用了 deepseek-v4-flash），或组件初始化时
    // props 初始值不算"变化"，watcher 都不会触发，selectedModel 会停留在旧值。
    if (isPendingSession(sid) || props.currentModel) {
      if (props.currentModel) {
        const next = pickModelValue(
          displayModels.value,
          selectedModel.value,
          props.currentModel,
          modelFallback(displayModels.value),
        );
        if (next !== selectedModel.value) selectedModel.value = next;
      }
      return;
    }
    // 打开的是停止/历史会话：先清掉上个会话的残留选择、落默认（记忆还没读回），
    // 再异步恢复这个会话记住的模型。
    selectedModel.value = "";
    applyDefaultModel(displayModels.value);
    const remembered = await api.sessionModel(sid).catch(() => null);
    // 读回期间切走了别的会话，或用户已经手动改过选择 → 放弃恢复
    if (props.sessionId !== sid || modelTouchedByUser) return;
    rememberedModel.value = remembered;
    // 记忆的模型在列表里才直接选中——不能再走 applyDefaultModel：此刻
    // selectedModel 占着上面落的占位默认，它会以 existing 身份在 pickModelValue
    // 里压过 remembered（回归：停止会话切回来选择器永远停在默认模型）。
    // 不在列表（停会话期间换过 provider）则维持刚落的默认。
    if (isModelInList(displayModels.value, remembered)) {
      selectedModel.value = remembered as string;
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
watch(() => props.sessionId, (sid) => {
  if (!sid) {
    selectedPermissionMode.value = "";
    applyDefaultPermissionMode(displayPermissionModes.value);
  }
});

function handlePermissionModeChange(value: string) {
  selectedPermissionMode.value = value;
  emit("set-permission-mode", value);
}
const isBusyVal = computed(() =>
  typeof props.isBusy === "boolean" ? props.isBusy : props.isBusy.value
);
const messagesVal = computed(() =>
  Array.isArray(props.messages) ? props.messages : props.messages.value
);

// 思考状态行计时器：isBusyVal 为 true 时每秒递增，离开/卸载时清理。
const thinkingElapsed = ref(0);
let thinkingTimer: ReturnType<typeof setInterval> | null = null;
watch(isBusyVal, (busy) => {
  if (busy) {
    thinkingElapsed.value = 0;
    thinkingTimer = setInterval(() => thinkingElapsed.value++, 1000);
  } else if (thinkingTimer) {
    clearInterval(thinkingTimer);
    thinkingTimer = null;
  }
}, { immediate: true });
onUnmounted(() => { if (thinkingTimer) clearInterval(thinkingTimer); });

// 窗口化渲染:store 里的消息全量在场,但进 v-for 建 DOM 的只有尾部一个有界
// 窗口——长会话一次性挂载全史(几万 DOM 节点 + 全量 Markdown/高亮)曾把切
// 会话的首帧卡成整窗未响应。向上滚动/点击顶部入口逐步扩窗,见 useMessageWindow。
const { visible: visibleMessages, hiddenCount, expandOlder } = useMessageWindow(
  () => messagesVal.value,
  () => props.sessionId,
);

/** 扩窗 + 滚动锚定:上方插入内容会把当前可视内容往下顶,读扩窗前后的
 *  scrollHeight 差把 scrollTop 补回去,保持视觉位置不跳。强制布局(读
 *  scrollHeight)只发生在用户主动翻旧消息时,不在流式热路径上。 */
let expandingOlder = false;
async function expandOlderAnchored() {
  const el = scrollEl.value;
  if (!el || expandingOlder || hiddenCount.value === 0) return;
  expandingOlder = true;
  try {
    const prevHeight = el.scrollHeight;
    const prevTop = el.scrollTop;
    expandOlder();
    await nextTick();
    el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
  } finally {
    expandingOlder = false;
  }
}

const btwMode = ref(false);
const btwLightweight = ref(true);
// btw 默认走便宜快的模型。但「便宜快」在不同 provider 下名字不同,必须按 provider 解析:
//  - 第三方供应商:选项列表装的是真实模型 id(deepseek-v4-flash),不是 Claude 别名。
//    "haiku" 字面量永远不在列表里(见 providerModels 的收口规则)。所以走供应商配的
//    defaultHaikuModel 映射——用户把 haiku 映到的那个真实 id,它一定在选项列表里
//    (providerModels 就是这么收来的)。这也是用户在设置里表达「我的便宜快模型是哪个」
//    的唯一入口。
//  - 系统默认(真 Claude):defaultHaikuModel 为空,选项列表本身就是别名列表,
//    "haiku" 直接命中。
//  - 兜底:两者都没有就退到主会话当前模型(绝不让下拉显示一个不存在的值)。
// btw 期间模型选择器显示它,用户可临时改这条支线的模型(不回写主会话);
// 发送后 btwMode 关闭,选择器自动回到主会话模型。
const btwModel = ref("haiku");
const btwDefaultModel = computed(() => {
  const opts = modelSelectOptions.value;
  const haikuMapping = sessionProvider.value.modelMappings?.defaultHaikuModel;
  if (haikuMapping && opts.some((m) => m.value === haikuMapping)) return haikuMapping;
  if (opts.some((m) => m.value === "haiku")) return "haiku";
  return selectedModel.value || opts[0]?.value || "haiku";
});
function toggleBtw() {
  btwMode.value = !btwMode.value;
  if (btwMode.value) btwModel.value = btwDefaultModel.value;
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
const btwModelLabel = computed(() => {
  const v = btw.store.value.model;
  if (!v) return "btw";
  return modelSelectOptions.value.find((m) => m.value === v)?.label ?? v;
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
const scrollEl = ref<HTMLDivElement>();
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

// 用户向上滚动时暂停自动置底，回到底部附近恢复
const autoScroll = ref(true);

function onScroll() {
  const el = scrollEl.value;
  if (!el) return;
  autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  // 滚到接近顶部 = 想看更早的消息:扩窗(带锚定)。只在用户真实滚动时触发,
  // 挂载/置底不产生 scrollTop≈0 的 scroll 事件,不会误触发。
  if (el.scrollTop < 80 && hiddenCount.value > 0) void expandOlderAnchored();
}

// 按帧节流：读 scrollHeight 会强制整个消息容器同步布局（成本 ∝ 会话历史 DOM
// 体积），流式期间每个增量都触发一次的话，光这一项就能压垮 UI 线程。合并到
// 每帧至多一次；rAF 回调晚于 Vue 的微任务渲染批次，天然拿到更新后的 DOM。
let scrollQueued = false;
function scrollToBottom() {
  if (!autoScroll.value || scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
  });
}

watch(() => messagesVal.value.length, scrollToBottom);
watch(
  () => {
    const last = messagesVal.value[messagesVal.value.length - 1];
    const block = last?.blocks[last.blocks.length - 1];
    return block?.type === "text" ? (block as TextBlock).text.length : 0;
  },
  scrollToBottom
);

// 置底的统一触发器：数据层 watcher 只能枚举「新消息 / 文本增量」，但让滚动条
// 搁浅的来源远不止这些——
//   ① 内容增高：变更卡（Edit/Write/NotebookEdit）结果到达时「等待结果…」就地
//      换成几百 px 的 DiffViewer、图片异步加载、历史扩窗……（观察 contentEl）
//   ② 视口变化：权限对话框出现/消失、Pane 拖拽、窗口缩放改变 clientHeight——
//      scrollTop 未被钳位时不产生 scroll 事件，onScroll 不重算、内容盒也没变，
//      滚动条搁浅在半中腰且 autoScroll 仍是 true（观察 scrollEl）
// 枚举数据必然挂一漏万，改为在 DOM 层观察这两个症状本身。RO 通知按帧合并、
// 频率与现有 watcher 同级；autoScroll=false 时 scrollToBottom 自身 no-op，不打扰
// 翻历史的用户；置底只写 scrollTop 不改两者尺寸，无反馈循环。
const contentEl = ref<HTMLDivElement>();
let contentObserver: ResizeObserver | null = null;
onMounted(() => {
  if (typeof ResizeObserver === "undefined") return;
  contentObserver = new ResizeObserver(() => scrollToBottom());
  if (contentEl.value) contentObserver.observe(contentEl.value);
  if (scrollEl.value) contentObserver.observe(scrollEl.value);
});
onUnmounted(() => {
  contentObserver?.disconnect();
  contentObserver = null;
});

watch(inputText, (val) => {
  const match = val.match(/^\/(\S*)$/); // / 开头且无空格
  if (match) {
    slashFilter.value = match[1];
    slashDropdownVisible.value = true;
    slashSelectedIndex.value = 0;
  } else {
    slashDropdownVisible.value = false;
  }
});

// 切换会话时清空待发图片/引用芯片、恢复自动置底、清理 btw 支线
watch(() => props.sessionId, () => {
  pendingImages.value = [];
  pendingMentions.value = [];
  autoScroll.value = true;
  scrollToBottom();
  // 切主会话 → btw 抽屉关、进程清理
  if (btw.store.value.question || btw.store.value.isBusy || btw.store.value.done) {
    btw.cleanup();
  }
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
const mentionName = pathBasename;
const mentionIcon = getFileIcon;
const folderIconPath = FOLDER_ICON_PATH;

function handleTabKey(e: KeyboardEvent) {
  if (slashDropdownVisible.value && filteredSkills.value.length) {
    e.preventDefault();
    selectSkill(filteredSkills.value[slashSelectedIndex.value]);
  }
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
    const [files, img] = await Promise.all([
      api.clipboardReadFiles(),
      api.clipboardReadImage(),
    ]);
    const { text, imagePaths } = resolvePastePayload(files, img, peekFileClipboard(), plainText);
    if (text) insertAtCursor(text);
    for (const imgPath of imagePaths) {
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
  } catch {
    if (plainText) insertAtCursor(plainText);
  }
}

/** 忙碌时发送 = 插队：不排队，交给 sidecar 在安全边界（当前工具调用跑完）
 *  打断当前这轮再发出——见 useChatSession.sendMessage 的注释。 */
async function handleSend() {
  const text = inputText.value.trim();
  const hasImages = pendingImages.value.length > 0;
  // 引用芯片 → @path 前缀：发送时才展开成文本，走与手打/粘贴 @path 完全相同的
  // resolveFileMentions 管道（历史 transcript 也因此天然兼容，无需迁移）。
  const mentionPrefix = pendingMentions.value.length
    ? pendingMentions.value.map((m) => "@" + m.path).join(" ") + " "
    : "";
  // 忙碌时不再拦截：useChatSession 会带插队标记透传，sidecar 在安全边界续发
  if (!text && !hasImages && !mentionPrefix) return;

  // 只在有图片时预检；明确不支持则保留输入和附件，未知/临时失败交给 sidecar 二次防线。
  if (!(await checkImageInputSupport(hasImages, selectedModel.value || undefined, api.probeImageInput))) {
    showToast("当前模型不支持图片输入。已保留输入内容和图片附件。", "danger");
    return;
  }

  if (btwMode.value) {
    // btw 一次性:发完自动切回主对话输入。回弹确认(回弹动画 + "已切回"toast)
    // 不在这里乐观触发——等支线真正进入 running 才确认(见上面 status 的 watch),
    // 否则 fork 失败时也会弹"已切回主对话输入"造成误导。
    // 引用芯片在 btw 里只带 @path 字面量（支线没有 mention 展开通道），模型可自行 Read。
    emit("send-btw", mentionPrefix + text, { lightweight: btwLightweight.value, model: btwModel.value });
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
  inputText.value = "";
  pendingImages.value = [];
  pendingMentions.value = [];
  emit("send", mentionPrefix + finalPrompt, {
    images: images.length ? images : undefined,
    // Rust 只在 sidecar 进程还没起来时才会用这个值（见 chat.rs），已有会话时
    // 无害地被忽略，不需要在这里判断"是否已有会话"。
    initialModel: selectedModel.value || undefined,
    mentions: mentionResolution,
    permissionMode: selectedPermissionMode.value || undefined,
  });
}

// 快捷操作（压缩/清空上下文）：跟手打消息走同一条路径（忙碌排队/权限模式透传都
// 免费拿到），但用户气泡渲染成动作胶囊（emit 时带 action 描述符，见
// useChatSession.dispatchSend）。/clear 不可逆，执行前弹 useModal.confirm 二次确认；
// /compact 可逆，直接发。取消确认则什么都不发、不入队、不推气泡。
async function handleQuickAction(action: QuickAction) {
  if (action.confirm) {
    const ok = await useModal().confirm(
      action.label,
      "将清空当前会话上下文，不可撤销。是否继续？",
      "清空",
      true,
    );
    if (!ok) return;
  }
  emit("send", action.prompt, {
    initialModel: selectedModel.value || undefined,
    permissionMode: selectedPermissionMode.value || undefined,
    action: { id: action.id, label: action.label, icon: action.icon },
  });
}

/** 工具卡片「后台运行中」徽章：打开 dock 并选中对应任务（toggleBgDock 已开时只切选中）。 */
function onOpenBgDock(taskId: string) {
  if (props.sessionId) toggleBgDock(props.sessionId, taskId);
}
</script>

<template>
  <div ref="rootEl" class="chat-panel">
    <TaskListPanel v-if="props.tasks && props.tasks.length > 0" :tasks="props.tasks" />

    <div ref="scrollEl" class="chat-messages" @scroll.passive="onScroll">
      <div v-if="messagesVal.length === 0" class="chat-empty">
        开始新对话
      </div>
      <!-- 内容盒：ResizeObserver 的观察目标（见 script contentObserver），
           纯布局 wrapper，消息增高的任何来源都会反映为它的盒高变化 -->
      <div ref="contentEl" class="chat-messages-body">
        <button
          v-if="hiddenCount > 0"
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
        <div v-if="isBusyVal" class="chat-thinking">
          <AppLogo :size="15" animated />
          <span>Claude 正在思考…</span>
          <span class="chat-thinking-time">{{ thinkingElapsed }}s</span>
          <button class="chat-interrupt-btn" @click="emit('interrupt')">中断</button>
        </div>
      </div>
    </div>

    <!-- 权限确认 / AskUserQuestion：挤在消息区和输入框之间，占真实布局空间而
         不是悬浮遮挡——上面 .chat-messages 是 flex:1，这块一出现就自动让出
         高度，正文和输入框都不会被盖住。 -->
    <PermissionDialog
      :permission="permission ?? null"
      :queue-count="permissionQueueCount"
      @respond="(id: string, approved: boolean, always?: boolean, answers?: Record<string, string>, nextMode?: string) => { if (nextMode) selectedPermissionMode = nextMode; emit('respond-permission', id, approved, always, answers, nextMode); }"
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

    <div class="chat-input-area">
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
      <!-- 忙碌时插队、正在等安全边界（当前工具跑完）的消息：sidecar 已登记，不可撤回 -->
      <div v-if="pendingJumps?.length" class="jump-strip">
        <div v-for="(p, i) in pendingJumps" :key="i" class="jump-item">
          <span class="jump-item-tag">插队</span>
          <span class="jump-item-text">{{ p }}</span>
          <span class="jump-item-hint">等当前工具跑完发出</span>
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
      <div class="chat-input-box" :class="{ 'btw-mode': btwMode }">
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
          :placeholder="btwMode ? '顺便问一下,不进入主对话…' : (isBusyVal ? '生成中，发送的消息将排队…' : '输入消息…')"
          rows="3"
          @keydown.enter.exact.prevent="(slashDropdownVisible && filteredSkills.length) ? selectSkill(filteredSkills[slashSelectedIndex]) : handleSend()"
          @keydown.enter.shift.exact.prevent="insertAtCursor('\n')"
          @keydown.tab="handleTabKey"
          @keydown.escape="slashDropdownVisible = false"
          @keydown.up="handleArrowUp"
          @keydown.down="handleArrowDown"
          @paste="handlePaste"
        />
        <div class="chat-toolbar">
          <ThemedSelect
            v-if="displayModels.length"
            :model-value="displayedModel"
            :options="modelSelectOptions"
            title="模型"
            @update:model-value="handleModelChange"
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
            :title="`上下文用量：${props.contextUsage.totalTokens.toLocaleString()} / ${props.contextUsage.maxTokens.toLocaleString()} tokens`"
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
            :title="w.title"
          >
            <span class="chat-quota-dot" />
            <span class="chat-quota-label">{{ w.label }}</span>
            <div class="chat-ctx-bar">
              <div class="chat-ctx-bar-fill" :style="{ width: w.pct + '%' }" />
            </div>
            <span class="chat-ctx-percent">{{ w.pct }}%</span>
          </div>
          <ChatSendButton
            :disabled="!inputText.trim() && !pendingImages.length && !pendingMentions.length"
            :busy="isBusyVal && !btwMode"
            :actions="quickActions"
            :btw-active="btwMode"
            :btw-disabled="!props.sessionId"
            :btw-disabled-reason="'先发送一条消息开始主对话，才能顺便问一下'"
            @send="handleSend()"
            @toggle-btw="toggleBtw"
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
     useSettings watch 同步成 settings.fontFamily，与编辑器/终端同一来源。代码块与
     inline code 在 ChatMessage.vue 自带显式 var(--aide-font-mono)，不受影响；CJK 等无
     JBM 字形的字符由浏览器按等宽回退（与编辑器一致）。 */
  font-family: var(--aide-font-mono);
}

.chat-messages {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 0;
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
}

.chat-thinking-time {
  color: var(--aide-text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.chat-interrupt-btn {
  margin-left: auto;
  padding: 3.5px 12px;
  font-size: 11px;
  font-weight: 500;
  font-family: inherit;
  border-radius: var(--aide-radius-sm);
  border: 1px solid color-mix(in srgb, var(--aide-danger) 32%, transparent);
  background: transparent;
  color: var(--aide-danger);
  cursor: pointer;
  transition: all var(--aide-ease-t);
}

.chat-interrupt-btn:hover {
  background: color-mix(in srgb, var(--aide-danger) 12%, transparent);
  border-color: color-mix(in srgb, var(--aide-danger) 55%, transparent);
  box-shadow: 0 0 12px color-mix(in srgb, var(--aide-danger) 22%, transparent);
}

.chat-input-area {
  border-top: 1px solid var(--aide-border);
  padding: 8px 12px;
  flex-shrink: 0;
  position: relative;
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
