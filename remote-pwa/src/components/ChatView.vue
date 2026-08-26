<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { ConnState, RemoteClientLike } from "../protocol";
import type { ChatEvent } from "../types";
import { applyEvent, historyToMessages, type Message } from "../session";
import MessageList from "./MessageList.vue";

const props = defineProps<{
  client: RemoteClientLike;
  session: { id: string; name: string };
  /** 会话归属工作区（编码 key）；null = 跟随桌面当前工作区 */
  workspaceKey?: string | null;
  connState: ConnState;
}>();

const emit = defineEmits<{ back: [] }>();

const messages = ref<Message[]>([]);
const input = ref("");
const ta = ref<HTMLTextAreaElement | null>(null);
const toastShow = ref(false);
const sysNote = ref<string | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

// 流式进行中：末条 assistant 未 done（UI 据此禁用发送 + 显示光标）
const streaming = computed(() => {
  const last = messages.value[messages.value.length - 1];
  return !!last && last.role === "assistant" && !last.done;
});

const offline = computed(() => props.connState === "offline");

const stateDot = computed(() => {
  switch (props.connState) {
    case "authed":
      return "ok";
    case "connecting":
      return "warn";
    default:
      return "off";
  }
});

const stateText = computed(() => {
  switch (props.connState) {
    case "authed":
      return "已连接";
    case "connecting":
      return "重连中…";
    case "offline":
      return "设备离线";
    default:
      return "未连接";
  }
});

// ── 事件：当前会话的流式增量 ──

function onEvent(e: ChatEvent): void {
  if (e.session_id && e.session_id !== props.session.id) return;
  messages.value = applyEvent(messages.value, e);
}

function onReconnected(): void {
  // 重连成功：load_messages 补齐事件缺口 + toast + 分隔线（原型演示对应）
  reload();
  toastShow.value = true;
  sysNote.value = "已重连 · 会话历史已刷新";
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastShow.value = false), 2400);
}

async function reload(): Promise<void> {
  try {
    const { messages: items } = await props.client.loadMessages(props.session.id);
    messages.value = historyToMessages(items);
  } catch {
    // 新会话尚未创建 / 断线等：保持现状
  }
}

// ── 发送 ──

function send(): void {
  const text = input.value.trim();
  if (!text || offline.value || streaming.value) return;
  input.value = "";
  autoGrow();
  // 本地立即上屏（桌面侧不回推用户消息事件）
  messages.value = [
    ...messages.value,
    {
      id: crypto.randomUUID(),
      role: "user",
      blocks: [{ type: "text", text }],
      timestamp: Date.now(),
      done: true,
    },
  ];
  sysNote.value = null;
  props.client.sendMessage(props.session.id, text, props.workspaceKey ?? undefined);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

function autoGrow(): void {
  const el = ta.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 108) + "px";
}

// ── 生命周期 ──

onMounted(() => {
  props.client.onEvent(onEvent);
  props.client.onReconnected(onReconnected);
  reload();
});

onUnmounted(() => {
  props.client.offEvent(onEvent);
  props.client.offReconnected(onReconnected);
  if (toastTimer) clearTimeout(toastTimer);
});
</script>

<template>
  <div class="ch">
    <div class="ch-top">
      <button class="ch-back" title="返回" @click="emit('back')">
        <svg width="19" height="19" viewBox="0 0 20 20" fill="none"><path d="M12.5 4L6.5 10l6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="ch-title">
        <div class="ch-name">{{ session.name }}</div>
        <div class="ch-state"><span class="dot" :class="stateDot"></span><span>{{ stateText }}</span></div>
      </div>
      <span class="spacer"></span>
    </div>

    <div class="ch-offbar" :class="{ show: offline }">
      <span class="spinner" style="width: 11px; height: 11px; border-width: 1.5px"></span>设备离线，自动重连中…
    </div>
    <div class="ch-toast" :class="{ show: toastShow }">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.6"/><path d="M5 8.2l2 2 4-4.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>已重连，会话历史已刷新
    </div>

    <MessageList :messages="messages" :streaming="streaming" :sys-note="sysNote" />

    <div class="ch-input">
      <div class="ch-ta-wrap">
        <textarea
          ref="ta"
          v-model="input"
          rows="1"
          :placeholder="offline ? '设备离线，等待重连…' : '发消息给桌面 aide…'"
          :disabled="offline"
          @input="autoGrow"
          @keydown="onKeydown"
        ></textarea>
      </div>
      <button class="ch-send" title="发送" :disabled="offline || streaming" @click="send">
        <svg width="17" height="17" viewBox="0 0 18 18" fill="none"><path d="M9 14.5v-11M4 8l5-5 5 5" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
  </div>
</template>
