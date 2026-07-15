<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, onUnmounted } from "vue";
import type { ComputedRef } from "vue";
import ChatMessage from "./ChatMessage.vue";
import TaskListPanel from "./TaskListPanel.vue";
import ThemedSelect from "./ThemedSelect.vue";
import ChatSendButton from "./ChatSendButton.vue";
import PermissionDialog from "./PermissionDialog.vue";
import type { ChatMessage as ChatMessageType, ContextUsage, ModelOption, PermissionModeOption, PermissionRequest, RateLimitInfo, TaskItem, TextBlock } from "@/types/chat";
import type { SkillMeta } from "@/types";
import { api } from "@/api";
import { resolvePastePayload } from "@/utils/paste";
import { resolveFileMentions } from "@/utils/fileMentions";
import type { FileMentionResolution } from "@/utils/fileMentions";
import { peekFileClipboard } from "@/composables/useFileClipboard";
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

const props = defineProps<{
  sessionId: string | null;
  workspacePath?: string;
  messages: ComputedRef<ChatMessageType[]> | ChatMessageType[];
  isBusy: { value: boolean } | boolean;
  models?: ModelOption[];
  currentModel?: string;
  contextUsage?: ContextUsage | null;
  /** 账号级订阅额度/速率；null 时不显示 */
  rateLimit?: RateLimitInfo | null;
  tasks?: TaskItem[];
  permissionModes?: PermissionModeOption[];
  currentPermissionMode?: string;
  /** 忙碌时排队的待发消息文本（顺序即发送顺序） */
  queuedPrompts?: string[];
  /** 本会话待确认的权限/提问请求——渲染在消息区和输入框之间（见模板），
   *  不是浮层，见 PermissionDialog.vue 顶部注释。 */
  permission?: PermissionRequest | null;
  permissionQueueCount?: number;
  focused?: boolean;
}>();

const emit = defineEmits<{
  send: [prompt: string, opts: SendOptions];
  "send-btw": [prompt: string, opts: { lightweight: boolean }];
  interrupt: [];
  "set-model": [model: string];
  "set-permission-mode": [mode: string];
  "remove-queued": [index: number];
  "respond-permission": [id: string, approved: boolean, always?: boolean, answers?: Record<string, string>];
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
  if (id === SYSTEM_DEFAULT_ID) return systemDefault;
  return allProviders.value.find((p) => p.id === id) ?? systemDefault;
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

/** 下拉框必须始终有一个真实生效的选中值——不能只是视觉上落在第一个
 *  <option> 上而 selectedModel 仍是空串，否则 handleSend 里 `selectedModel.value
 *  || undefined` 不会把它带进 initialModel，导致下拉框显示的模型和实际启动
 *  sidecar 用的模型对不上。优先用 provider 配置里显式指定的默认模型（若在
 *  当前可选列表里），否则退化到列表第一项。 */
function applyDefaultModel(models: ModelOption[]) {
  if (selectedModel.value || !models.length) return;
  const providerDefault = sessionProvider.value.model;
  selectedModel.value = providerDefault && models.some((m) => m.value === providerDefault)
    ? providerDefault
    : models[0].value;
}

watch(() => props.currentModel, (v) => { if (v) selectedModel.value = v; });
watch(displayModels, applyDefaultModel, { immediate: true });
watch(() => props.sessionId, (sid) => {
  if (!sid) {
    selectedModel.value = "";
    applyDefaultModel(displayModels.value);
  }
});
// 会话所属 provider 变了（全局切换影响到非存活会话，或 stop_session 释放了绑定），
// 旧选择大概率不在新列表里，重置回新 provider 的默认模型。存活会话的 sessionProvider
// 锁在 spawn 时的 provider，全局切换不会触发这个 watcher——模型下拉不受影响。
watch(() => sessionProvider.value.id, () => {
  selectedModel.value = "";
  applyDefaultModel(displayModels.value);
});

function handleModelChange(value: string) {
  selectedModel.value = value;
  // 会话还没开始时 useChatSession.setModel 是无会话可发的空操作，安全；
  // 真正生效靠 handleSend 把 selectedModel 带进第一条消息。
  emit("set-model", value);
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
const btwRevertToast = ref(false);
let btwToastTimer: number | undefined;
function showBtwRevertToast() {
  btwRevertToast.value = true;
  clearTimeout(btwToastTimer);
  btwToastTimer = window.setTimeout(() => (btwRevertToast.value = false), 1600);
}

const btw = useBtwSession();
const btwDrawerVisible = computed(() => !!btw.store.value.question || btw.store.value.isBusy || btw.store.value.done);
function closeBtw() { btw.cleanup(); }
function stopBtw() { btw.cleanup(); }

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

// 切换会话时清空待发图片、恢复自动置底、清理 btw 支线
watch(() => props.sessionId, () => {
  pendingImages.value = [];
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

/** jumpQueue=true 时对应"插队发送"按钮：不排队，交给 sidecar 在安全边界
 *  （当前工具调用跑完）打断当前这轮再发出——见 useChatSession.ts 的 SendOptions
 *  注释。其余逻辑跟普通发送完全一致，避免两套构造消息的代码。 */
async function handleSend(jumpQueue = false) {
  const text = inputText.value.trim();
  const hasImages = pendingImages.value.length > 0;
  // 忙碌时不再拦截：useChatSession 会把消息排队，message_stop 后按序续发
  if (!text && !hasImages) return;

  if (btwMode.value) {
    // btw 一次性:发完自动切回主对话输入,视觉突出(回弹)
    emit("send-btw", text, { lightweight: btwLightweight.value });
    inputText.value = "";
    pendingImages.value = [];
    const box = rootEl.value?.querySelector(".chat-input-box") as HTMLElement | null;
    btwMode.value = false; // 横幅收起、按钮复原
    if (box) {
      box.classList.remove("btw-revert-flash");
      void box.offsetWidth; // 重启动画
      box.classList.add("btw-revert-flash");
      setTimeout(() => box.classList.remove("btw-revert-flash"), 800);
    }
    showBtwRevertToast();
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
  const mentionResolution = await resolveFileMentions(finalPrompt, api.readFileContent);

  const images = pendingImages.value.map(({ data, mediaType }) => ({ data, mediaType }));
  inputText.value = "";
  pendingImages.value = [];
  emit("send", finalPrompt, {
    images: images.length ? images : undefined,
    // Rust 只在 sidecar 进程还没起来时才会用这个值（见 chat.rs），已有会话时
    // 无害地被忽略，不需要在这里判断"是否已有会话"。
    initialModel: selectedModel.value || undefined,
    mentions: mentionResolution,
    permissionMode: selectedPermissionMode.value || undefined,
    jumpQueue: jumpQueue || undefined,
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
</script>

<template>
  <div ref="rootEl" class="chat-panel">
    <TaskListPanel v-if="props.tasks && props.tasks.length > 0" :tasks="props.tasks" />

    <div ref="scrollEl" class="chat-messages" @scroll.passive="onScroll">
      <div v-if="messagesVal.length === 0" class="chat-empty">
        开始新对话
      </div>
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
      />
      <div v-if="isBusyVal" class="chat-thinking">
        <span class="chat-thinking-dot">●</span>
        Claude 正在思考…
        <button class="chat-interrupt-btn" @click="emit('interrupt')">中断</button>
      </div>
    </div>

    <!-- 权限确认 / AskUserQuestion：挤在消息区和输入框之间，占真实布局空间而
         不是悬浮遮挡——上面 .chat-messages 是 flex:1，这块一出现就自动让出
         高度，正文和输入框都不会被盖住。 -->
    <PermissionDialog
      :permission="permission ?? null"
      :queue-count="permissionQueueCount"
      @respond="(id: string, approved: boolean, always?: boolean, answers?: Record<string, string>) => emit('respond-permission', id, approved, always, answers)"
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
      <!-- 忙碌时排队的消息：还没发出去，可随时撤掉 -->
      <div v-if="queuedPrompts?.length" class="queued-strip">
        <div v-for="(p, i) in queuedPrompts" :key="i" class="queued-item">
          <span class="queued-item-tag">排队</span>
          <span class="queued-item-text">{{ p }}</span>
          <button class="queued-item-remove" v-tooltip="'撤回这条排队消息'" @click="emit('remove-queued', i)">×</button>
        </div>
      </div>
      <div class="chat-input-box" :class="{ 'btw-mode': btwMode }">
        <Transition name="btw-banner">
          <div v-if="btwMode" class="btw-mode-banner">
            <span class="btw-banner-glyph">↳</span>
            <span class="btw-banner-text"><b>顺便问一下</b> · 不进入主对话 · 阅后即弃</span>
            <button type="button" class="btw-banner-x" @click="btwMode = false" v-tooltip="'退出 btw 模式'">×</button>
          </div>
        </Transition>
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
            :model-value="selectedModel"
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
          <button
            v-if="isBusyVal"
            class="chat-jump-btn"
            v-tooltip="'插队发送：不用等这轮生成结束，sidecar 会在当前工具调用跑完后立刻打断、优先发出这条'"
            :disabled="!inputText.trim() && !pendingImages.length"
            @click="handleSend(true)"
          >插队</button>
          <ChatSendButton
            :disabled="!inputText.trim() && !pendingImages.length"
            :busy="isBusyVal"
            :actions="quickActions"
            :btw-active="btwMode"
            @send="handleSend()"
            @toggle-btw="btwMode = !btwMode"
            @select="handleQuickAction"
          />
        </div>
      </div>
      <Transition name="btw-toast">
        <div v-if="btwRevertToast" class="btw-revert-toast">已切回主对话输入</div>
      </Transition>
    </div>
    <BtwDrawer
      :visible="btwDrawerVisible"
      :lightweight="btwLightweight"
      @update:lightweight="btwLightweight = $event"
      @close="closeBtw"
      @stop="stopBtw"
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
}

.chat-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 0;
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
  transition: background 0.1s, color 0.1s;
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

.chat-thinking-dot {
  animation: pulse 1s infinite;
  color: var(--aide-accent);
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.chat-interrupt-btn {
  margin-left: 4px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  color: var(--aide-danger);
  padding: 0 4px;
}

.chat-interrupt-btn:hover {
  color: color-mix(in srgb, var(--aide-danger) 85%, white);
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
  transition: border-color 0.15s;
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
  transition: width 0.2s;
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

.chat-jump-btn {
  /* 原来靠 .chat-cost-total 的 margin-right: auto 把发送按钮推到工具栏最右侧；
   * 去掉费用展示后这条移到这里，保持发送/插队按钮组始终靠右的布局不变。只有
   * 忙碌时才渲染这个按钮，所以 margin-left:auto 落在它上面；空闲时它不存在，
   * .chat-send-split 自己的 margin-left:auto 兜底（见下面）。 */
  margin-left: auto;
  border-radius: var(--aide-radius-sm);
  background: transparent;
  color: var(--aide-accent);
  border: 1px solid var(--aide-accent);
  padding: 0 12px;
  height: 24px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, opacity 0.15s;
  white-space: nowrap;
}

.chat-jump-btn:hover:not(:disabled) {
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
}

.chat-jump-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 分裂式发送按钮（ChatSendButton 根元素）：插队按钮只在忙碌时渲染并吃掉
 * margin-left:auto；空闲时它不存在，这里的 auto 顶上，保持发送按钮始终靠右。
 * 两者同时存在时这条不生效（flex 的 auto margin 只有第一个吃到的元素生效），
 * 靠 .chat-toolbar 的 gap 分隔即可。按钮自身的外观在 ChatSendButton.vue 内。 */
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
  font-family: 'Cascadia Code', 'Consolas', monospace;
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

.queued-strip {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 6px;
}

.queued-item {
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

.queued-item-tag {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--aide-text-muted);
  background: var(--aide-bg-deep);
  padding: 1px 4px;
  border-radius: 3px;
}

.queued-item-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queued-item-remove {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--aide-text-muted);
  cursor: pointer;
  font-size: 13px;
  padding: 0 2px;
  line-height: 1;
}

.queued-item-remove:hover {
  color: var(--aide-danger);
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
  background: rgba(0, 0, 0, 0.6);
  color: white;
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
</style>
