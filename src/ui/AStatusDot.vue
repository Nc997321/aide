<script setup lang="ts">
import type { DotTone } from "../composables/useSessionState";

// tone 是活跃度轴 × 健康度轴的投影结果（见 useSessionState.dotTone），不是原始状态。
defineProps<{
  tone: DotTone;
}>();
</script>

<template>
  <span class="a-status-dot" :class="`a-status-dot--${tone}`" />
</template>

<style scoped>
.a-status-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.a-status-dot--stopped {
  background: transparent;
  border: 1.5px solid var(--aide-text-muted);
}

.a-status-dot--running {
  background: var(--aide-success);
  box-shadow: 0 0 7px color-mix(in srgb, var(--aide-success) 80%, transparent);
  animation: a-dot-pulse 2s ease-in-out infinite;
}

/* 空闲（waiting）：用 info 蓝灰——与 useSessionState 文档「waiting 蓝」及
 * TitleBar 活动面板的 status-waiting 对齐；灰填充实心与 stopped 空心灰圈
 * 距离太近，浅底下几乎分不清。 */
.a-status-dot--waiting {
  background: var(--aide-info);
}

.a-status-dot--attention {
  background: var(--aide-warning);
  box-shadow: 0 0 6px color-mix(in srgb, var(--aide-warning) 60%, transparent);
  animation: a-dot-pulse 2s ease-in-out infinite;
}

/* 健康度轴：可恢复错误 → 红 */
.a-status-dot--warning {
  background: var(--aide-danger);
  box-shadow: 0 0 6px color-mix(in srgb, var(--aide-danger) 50%, transparent);
  animation: a-dot-pulse 2s ease-in-out infinite;
}

/* 健康度轴：疑似卡住 → 橙 */
.a-status-dot--stalled {
  background: var(--aide-stalled);
  box-shadow: 0 0 6px color-mix(in srgb, var(--aide-stalled) 50%, transparent);
  animation: a-dot-pulse 2s ease-in-out infinite;
}

@keyframes a-dot-pulse {
  0%, 100% { opacity: 0.7; }
  50% { opacity: 1; }
}
</style>
