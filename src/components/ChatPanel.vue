<script setup lang="ts">
import { ref, watch, nextTick, computed } from "vue";
import type { ComputedRef } from "vue";
import ChatMessage from "./ChatMessage.vue";
import type { ChatMessage as ChatMessageType, TextBlock } from "@/types/chat";
import type { SkillMeta } from "@/types";
import { api } from "@/api";
import { resolvePastePayload } from "@/utils/paste";
import { peekFileClipboard } from "@/composables/useFileClipboard";
import type { ImageAttachment } from "@/composables/useChatSession";
import { useSessionState } from "@/composables/useSessionState";
import AStatusDot from "@/ui/AStatusDot.vue";

const props = defineProps<{
  sessionId: string | null;
  sessionName?: string;
  workspacePath?: string;
  messages: ComputedRef<ChatMessageType[]> | ChatMessageType[];
  isBusy: { value: boolean } | boolean;
}>();

const emit = defineEmits<{
  send: [prompt: string, images?: ImageAttachment[]];
  interrupt: [];
  stop: [];
}>();

const { state: sessionState } = useSessionState();
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
  if ((!text && !hasImages) || isBusyVal.value || !props.sessionId) return;

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

  const images = pendingImages.value.map(({ data, mediaType }) => ({ data, mediaType }));
  inputText.value = "";
  pendingImages.value = [];
  emit("send", finalPrompt, images.length ? images : undefined);
}
</script>

<template>
  <div class="chat-panel">
    <div class="chat-header">
      <AStatusDot :status="currentStatus" />
      <span class="chat-header-name">{{ sessionName || sessionId || '未选择会话' }}</span>
      <button
        v-if="isLive"
        class="chat-stop-btn"
        title="停止会话进程"
        @click="emit('stop')"
      >⏹ 停止</button>
    </div>

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
      <!-- Image attachment strip -->
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
      <div class="chat-input-row">
        <textarea
          ref="textareaEl"
          v-model="inputText"
          class="chat-input"
          placeholder="输入消息…"
          rows="3"
          :disabled="isBusyVal || !sessionId"
          @keydown.enter.exact.prevent="(slashDropdownVisible && filteredSkills.length) ? selectSkill(filteredSkills[slashSelectedIndex]) : handleSend()"
          @keydown.enter.shift.exact.prevent="insertAtCursor('\n')"
          @keydown.tab="handleTabKey"
          @keydown.escape="slashDropdownVisible = false"
          @keydown.up="handleArrowUp"
          @keydown.down="handleArrowDown"
          @paste="handlePaste"
        />
        <button
          class="chat-send-btn"
          :disabled="isBusyVal || !sessionId || (!inputText.trim() && !pendingImages.length)"
          @click="handleSend"
        >
          发送
        </button>
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

.chat-input-row {
  display: flex;
  gap: 8px;
}

.chat-input {
  flex: 1;
  resize: none;
  border-radius: var(--aide-radius-sm);
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  padding: 8px 12px;
  font-size: 13px;
  color: var(--aide-text-primary);
  outline: none;
  font-family: inherit;
  line-height: 1.5;
  transition: border-color 0.15s;
}

.chat-input::placeholder {
  color: var(--aide-text-muted);
}

.chat-input:focus {
  border-color: var(--aide-accent);
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

.image-attachment-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 0 6px;
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
