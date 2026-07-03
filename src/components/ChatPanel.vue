<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted } from "vue";
import type { ComputedRef } from "vue";
import ChatMessage from "./ChatMessage.vue";
import TaskListPanel from "./TaskListPanel.vue";
import type { ChatMessage as ChatMessageType, ContextUsage, ModelOption, PermissionModeOption, TaskItem, TextBlock } from "@/types/chat";
import type { SkillMeta } from "@/types";
import { api } from "@/api";
import { resolvePastePayload } from "@/utils/paste";
import { resolveFileMentions } from "@/utils/fileMentions";
import type { FileMentionResolution } from "@/utils/fileMentions";
import { peekFileClipboard } from "@/composables/useFileClipboard";
import type { ImageAttachment, SendOptions } from "@/composables/useChatSession";
import { useSessionState } from "@/composables/useSessionState";
import { useProviders } from "@/composables/useProviders";
import AStatusDot from "@/ui/AStatusDot.vue";

const props = defineProps<{
  sessionId: string | null;
  sessionName?: string;
  workspacePath?: string;
  messages: ComputedRef<ChatMessageType[]> | ChatMessageType[];
  isBusy: { value: boolean } | boolean;
  models?: ModelOption[];
  currentModel?: string;
  totalCostUsd?: number;
  contextUsage?: ContextUsage | null;
  tasks?: TaskItem[];
  permissionModes?: PermissionModeOption[];
  currentPermissionMode?: string;
  /** 忙碌时排队的待发消息文本（顺序即发送顺序） */
  queuedPrompts?: string[];
}>();

const emit = defineEmits<{
  send: [prompt: string, opts: SendOptions];
  interrupt: [];
  stop: [];
  "set-model": [model: string];
  "set-permission-mode": [mode: string];
  "remove-queued": [index: number];
}>();

const { state: sessionState } = useSessionState();
const { activeProvider } = useProviders();

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

const preSessionModels = computed<ModelOption[]>(() => {
  const known = activeProvider.value.knownModels;
  return known.length ? known.map((v) => ({ value: v, displayName: v })) : defaultModels.value;
});
const displayModels = computed(() => (props.models?.length ? props.models : preSessionModels.value));

/** 本地选中值：随 props.currentModel（SDK 坐实/切换确认）同步；
 *  会话开始前没有 props.currentModel，用户选的先存在这，随第一条消息带走。 */
const selectedModel = ref("");

/** 下拉框必须始终有一个真实生效的选中值——不能只是视觉上落在第一个
 *  <option> 上而 selectedModel 仍是空串，否则 handleSend 里 `selectedModel.value
 *  || undefined` 不会把它带进 initialModel，导致下拉框显示的模型和实际启动
 *  sidecar 用的模型对不上。优先用 provider 配置里显式指定的默认模型（若在
 *  当前可选列表里），否则退化到列表第一项。 */
function applyDefaultModel(models: ModelOption[]) {
  if (selectedModel.value || !models.length) return;
  const providerDefault = activeProvider.value.model;
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
const currentStatus = computed(() => {
  const sid = props.sessionId;
  if (!sid) return "stopped" as const;
  return (sessionState[sid] || "stopped") as "stopped" | "running" | "waiting" | "attention";
});
const isLive = computed(() => currentStatus.value !== "stopped");

const isBusyVal = computed(() =>
  typeof props.isBusy === "boolean" ? props.isBusy : props.isBusy.value
);
const messagesVal = computed(() =>
  Array.isArray(props.messages) ? props.messages : props.messages.value
);

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
}

function scrollToBottom() {
  if (!autoScroll.value) return;
  nextTick(() => {
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

// 切换会话时清空待发图片、恢复自动置底
watch(() => props.sessionId, () => {
  pendingImages.value = [];
  autoScroll.value = true;
  scrollToBottom();
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

async function handleSend() {
  const text = inputText.value.trim();
  const hasImages = pendingImages.value.length > 0;
  // 忙碌时不再拦截：useChatSession 会把消息排队，message_stop 后按序续发
  if (!text && !hasImages) return;

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
  });
}
</script>

<template>
  <div class="chat-panel">
    <div class="chat-header">
      <AStatusDot :status="currentStatus" />
      <span class="chat-header-name">{{ sessionName || sessionId || '新对话' }}</span>
      <button
        v-if="isLive"
        class="chat-stop-btn"
        title="停止会话进程"
        @click="emit('stop')"
      >⏹ 停止</button>
    </div>

    <TaskListPanel v-if="props.tasks && props.tasks.length > 0" :tasks="props.tasks" />

    <div ref="scrollEl" class="chat-messages" @scroll.passive="onScroll">
      <div v-if="messagesVal.length === 0" class="chat-empty">
        开始新对话
      </div>
      <ChatMessage
        v-for="msg in messagesVal"
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
          <button class="queued-item-remove" title="撤回这条排队消息" @click="emit('remove-queued', i)">×</button>
        </div>
      </div>
      <div class="chat-input-box">
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
          :placeholder="isBusyVal ? '生成中，发送的消息将排队…' : '输入消息…'"
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
          <select
            v-if="displayModels.length"
            class="chat-model-select"
            :value="selectedModel"
            @change="handleModelChange(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="m in displayModels" :key="m.value" :value="m.value">{{ m.displayName }}</option>
          </select>
          <select
            v-if="displayPermissionModes.length"
            class="chat-model-select"
            :value="selectedPermissionMode"
            title="权限模式"
            @change="handlePermissionModeChange(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="m in displayPermissionModes" :key="m.value" :value="m.value">{{ m.displayName }}</option>
          </select>
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
          <span class="chat-cost-total">会话费用 ${{ (props.totalCostUsd ?? 0).toFixed(4) }}</span>
          <button
            class="chat-send-btn"
            :disabled="!inputText.trim() && !pendingImages.length"
            @click="handleSend"
          >
            {{ isBusyVal ? "排队" : "发送" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--aide-bg-base);
  color: var(--aide-text-primary);
}

.chat-header {
  padding: 8px 16px;
  border-bottom: 1px solid var(--aide-border);
  font-size: 12px;
  color: var(--aide-text-muted);
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  flex-shrink: 0;
}

.chat-stop-btn {
  margin-left: auto;
  background: none;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  color: var(--aide-danger);
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s;
}

.chat-stop-btn:hover {
  background: var(--aide-surface-hover);
}

.chat-header-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  color: #ff9090;
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
  background: var(--aide-surface-default);
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

.chat-model-select {
  background: transparent;
  color: var(--aide-text-secondary);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  font-size: 12px;
  padding: 2px 6px;
  cursor: pointer;
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

.chat-cost-total {
  white-space: nowrap;
  margin-right: auto;
}

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

.chat-send-btn {
  border-radius: var(--aide-radius-sm);
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
  border: none;
  padding: 0 16px;
  height: 24px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, opacity 0.15s;
  white-space: nowrap;
}

.chat-send-btn:hover:not(:disabled) {
  background: var(--aide-accent-hover);
}

.chat-send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
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
</style>
