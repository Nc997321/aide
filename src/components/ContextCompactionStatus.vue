<script setup lang="ts">
import { computed } from "vue";
import type { ContextCompactionState } from "@/types/chat";
import InterruptButton from "./InterruptButton.vue";

const props = defineProps<{
  status: ContextCompactionState;
  elapsedSeconds: number;
}>();

const emit = defineEmits<{ interrupt: [] }>();

const failed = computed(() => props.status.stage === "failed");
const headline = computed(() => (failed.value ? "上下文压缩未完成" : "正在压缩上下文"));
const supportingText = computed(() => {
  if (failed.value) return props.status.error || props.status.detail || "当前上下文会保持不变";
  return props.status.detail || "整理已读信息，为接下来的对话腾出空间";
});
// 已用时每秒变化；不能放进 live-region 的可访问名称，否则读屏器会反复播报。
const statusLabel = computed(() => `${headline.value}，${supportingText.value}`);
</script>

<template>
  <div
    class="context-compaction-status"
    :class="{ 'context-compaction-status--failed': failed }"
    role="status"
    aria-live="polite"
    aria-atomic="true"
    :aria-label="statusLabel"
  >
    <span class="context-fold-rail" aria-hidden="true">
      <span class="context-fold-segment context-fold-segment--left"></span>
      <span class="context-fold-segment context-fold-segment--center"></span>
      <span class="context-fold-segment context-fold-segment--right"></span>
    </span>

    <span class="context-compaction-copy">
      <span class="context-compaction-headline">{{ headline }}</span>
      <span class="context-compaction-detail">{{ supportingText }}</span>
    </span>

    <span v-if="!failed" class="context-compaction-elapsed" aria-hidden="true">{{ elapsedSeconds }}s</span>
    <InterruptButton v-if="!failed" class="context-compaction-interrupt" @click="emit('interrupt')" />
  </div>
</template>

<style scoped>
.context-compaction-status {
  --compaction-tone: var(--aide-accent);

  display: flex;
  align-items: center;
  gap: calc(var(--aide-space-unit) * 1.5);
  min-height: calc(var(--aide-space-unit) * 6);
  padding: calc(var(--aide-space-unit) * 1.5) calc(var(--aide-space-unit) * 4);
  border-top: 1px solid color-mix(in srgb, var(--compaction-tone) 26%, var(--aide-border));
  background: color-mix(in srgb, var(--compaction-tone) 7%, var(--aide-bg-base));
  color: var(--aide-text-secondary);
}

.context-compaction-status--failed {
  --compaction-tone: var(--aide-danger);
}

.context-fold-rail {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: calc(var(--aide-space-unit) * 6);
  gap: calc(var(--aide-space-unit) * 0.5);
  flex-shrink: 0;
}

.context-fold-segment {
  width: calc(var(--aide-space-unit) * 1.5);
  height: calc(var(--aide-space-unit) * 0.5);
  border-radius: var(--aide-radius-sm);
  background: var(--compaction-tone);
  opacity: 0.42;
  animation: context-fold 1100ms var(--aide-ease) infinite;
}

.context-fold-segment--left {
  --fold-shift: calc(var(--aide-space-unit) * 0.75);
  animation-delay: 0ms;
}

.context-fold-segment--center {
  --fold-shift: calc(var(--aide-space-unit) * 0);
  animation-delay: 120ms;
}

.context-fold-segment--right {
  --fold-shift: calc(var(--aide-space-unit) * -0.75);
  animation-delay: 240ms;
}

.context-compaction-status--failed .context-fold-segment {
  animation: none;
  opacity: 0.9;
}

@keyframes context-fold {
  0%,
  100% {
    opacity: 0.35;
    transform: translateX(0) scaleX(1);
  }

  50% {
    opacity: 1;
    transform: translateX(var(--fold-shift)) scaleX(0.52);
  }
}

.context-compaction-copy {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: calc(var(--aide-space-unit) * 0.25);
}

.context-compaction-headline {
  color: var(--compaction-tone);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.25;
}

.context-compaction-detail {
  overflow: hidden;
  color: var(--aide-text-muted);
  font-size: 11px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.context-compaction-elapsed {
  flex-shrink: 0;
  color: var(--aide-text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

@media (prefers-reduced-motion: reduce) {
  .context-fold-segment {
    animation: none;
    opacity: 0.85;
    transform: scaleX(0.72);
  }
}
</style>
