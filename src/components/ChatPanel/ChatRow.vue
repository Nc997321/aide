<script setup lang="ts">
import ChatMessage from "../ChatMessage.vue";
import type { Row } from "@/composables/useChatSession/recycle";
import type { BgTask, ModelOption } from "@/types/chat";

/** 行渲染单元（页级回收的渲染层）：
 *  - page：已加载页——页内消息组（wrapper 带 data-row-id 供滚动层实测页高，
 *    释放时以实测高度建骨架 → 总高不变、滚动零跳变）；
 *  - skeleton：已释放页占位——内联 heightPx 撑住原高度，点击进入视口即取回
 *    （滚动层 prefetch 通常先到，点击是兜底）；
 *  - live：流式段单条（永不回收，不测高——页/骨架全在 live 段之前，定位/补偿
 *    公式只需要页区高度，live 行不带 data-row-id 避免每条消息一次布局读）。 */
defineProps<{
  row: Row;
  workspacePath?: string;
  models: ModelOption[];
  bgTasks?: BgTask[];
}>();

const emit = defineEmits<{
  "open-bg-dock": [taskId: string];
  /** 骨架行点击取回（滚动层 restoreAnchored 的兜底入口） */
  restore: [pageIndex: number];
}>();
</script>

<template>
  <div v-if="row.kind === 'page'" class="chat-row-page" :data-row-id="row.id">
    <ChatMessage
      v-for="msg in row.messages"
      :key="msg.id"
      :message="msg"
      :workspace-path="workspacePath"
      :models="models"
      :bg-tasks="bgTasks"
      @open-bg-dock="(id: string) => emit('open-bg-dock', id)"
    />
  </div>
  <button
    v-else-if="row.kind === 'skeleton'"
    class="chat-row-skeleton"
    :data-row-id="row.id"
    :style="{ height: row.heightPx + 'px' }"
    @click="emit('restore', row.pageIndex)"
  >
    <span class="chat-row-skeleton-label">{{ row.count }} 条历史消息已折叠 · 点此加载</span>
  </button>
  <div v-else class="chat-row-live">
    <ChatMessage
      :message="row.message"
      :workspace-path="workspacePath"
      :models="models"
      :bg-tasks="bgTasks"
      @open-bg-dock="(id: string) => emit('open-bg-dock', id)"
    />
  </div>
</template>

<style scoped>
/* 页/live 包装是纯布局容器：无内外边距，不影响消息间距 */
.chat-row-page,
.chat-row-live {
  display: block;
}

/* 骨架占位：与 chat-history-gate 同族虚线语义，但撑满原页高度（内联 style 给定），
   内容居中——视觉上是一整块「被折叠的历史」而不是一行按钮 */
.chat-row-skeleton {
  display: flex;
  align-items: center;
  justify-content: center;
  width: calc(100% - 24px);
  margin: 0 12px 4px;
  padding: 0;
  border: 1px dashed var(--aide-border);
  border-radius: var(--aide-radius-sm);
  background: transparent;
  cursor: pointer;
  transition: background var(--aide-ease-t);
}

.chat-row-skeleton:hover {
  background: var(--aide-surface-hover);
}

.chat-row-skeleton-label {
  font-size: 11px;
  color: var(--aide-text-muted);
  animation: skeleton-pulse 1.5s ease-in-out infinite;
}

.chat-row-skeleton:hover .chat-row-skeleton-label {
  color: var(--aide-text-secondary);
}

@keyframes skeleton-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .chat-row-skeleton-label { animation: none; }
}
</style>
