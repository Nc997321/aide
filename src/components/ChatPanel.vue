<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted } from "vue";
import type { ComputedRef } from "vue";
import ChatMessage from "./ChatMessage.vue";
import type { ChatMessage as ChatMessageType, TextBlock } from "@/types/chat";
import type { SkillMeta } from "@/types";
import { api } from "@/api";
import { resolvePastePayload } from "@/utils/paste";
import { peekFileClipboard } from "@/composables/useFileClipboard";

const props = defineProps<{
  sessionId: string | null;
  sessionName?: string;
  workspacePath?: string;
  messages: ComputedRef<ChatMessageType[]> | ChatMessageType[];
  isBusy: { value: boolean } | boolean;
}>();

const emit = defineEmits<{
  send: [prompt: string];
  interrupt: [];
}>();

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
const scrollEl = ref<HTMLDivElement>();
const textareaEl = ref<HTMLTextAreaElement>();

onMounted(async () => {
  try {
    skillList.value = await api.scanPluginSkills(props.workspacePath ?? "");
  } catch {
    // 静默失败，autocomplete 不显示
  }
});

function scrollToBottom() {
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
    const payload = resolvePastePayload(files, img, peekFileClipboard(), plainText);
    if (payload) insertAtCursor(payload);
  } catch {
    if (plainText) insertAtCursor(plainText);
  }
}

function handleSend() {
  const text = inputText.value.trim();
  if (!text || isBusyVal.value || !props.sessionId) return;
  inputText.value = "";
  emit("send", text);
}
</script>

<template>
  <div class="chat-panel">
    <div class="chat-header">
      <span class="chat-header-name">{{ sessionName || sessionId || '未选择会话' }}</span>
    </div>

    <div ref="scrollEl" class="chat-messages">
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
      <div class="chat-input-row">
        <textarea
          ref="textareaEl"
          v-model="inputText"
          class="chat-input"
          placeholder="输入消息…"
          rows="3"
          :disabled="isBusyVal || !sessionId"
          @keydown.enter.exact.prevent="(slashDropdownVisible && filteredSkills.length) ? selectSkill(filteredSkills[slashSelectedIndex]) : handleSend()"
          @keydown.enter.shift.exact.prevent="inputText += '\n'"
          @keydown.tab="handleTabKey"
          @keydown.escape="slashDropdownVisible = false"
          @keydown.up.prevent="slashDropdownVisible && (slashSelectedIndex = Math.max(0, slashSelectedIndex - 1))"
          @keydown.down.prevent="slashDropdownVisible && (slashSelectedIndex = Math.min(filteredSkills.length - 1, slashSelectedIndex + 1))"
          @paste="handlePaste"
        />
        <button
          class="chat-send-btn"
          :disabled="isBusyVal || !sessionId || !inputText.trim()"
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
  min-height: 36px;
  flex-shrink: 0;
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
</style>
