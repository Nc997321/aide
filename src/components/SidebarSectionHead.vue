<script setup lang="ts">
/** 侧栏分区树的共享分区头（VS Code 资源管理器范式）：
 *  chevron 旋转 + 图标 + 大写标签 + 计数徽标 + 可选呼吸点 + hover 操作槽。
 *  会话/自动化/未来分区共用，保证视觉与交互完全一致。 */
defineProps<{
  icon: string;
  label: string;
  count?: number;
  /** 有活跃活动（运行中任务等）时亮呼吸点 */
  live?: boolean;
  liveTitle?: string;
  expanded: boolean;
}>();

const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
  <div class="sec-head" @click="emit('toggle')">
    <svg class="chevron" :class="{ expanded }" width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <span class="sec-ico">{{ icon }}</span>
    <span class="sec-label">{{ label }}</span>
    <span v-if="count !== undefined" class="sec-count">{{ count }}</span>
    <span v-if="live" class="live-dot" v-tooltip="liveTitle ?? ''" />
    <span class="sec-actions" @click.stop>
      <slot name="actions" />
    </span>
  </div>
</template>

<style scoped>
.sec-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  margin: 0 10px 4px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  color: var(--aide-text-muted);
  border-radius: var(--aide-radius-md);
  transition: all var(--aide-ease-t);
  letter-spacing: 0.2px;
  user-select: none;
}
.sec-head:hover {
  color: var(--aide-text-secondary);
  background: var(--aide-surface-default);
}

.chevron {
  flex-shrink: 0;
  color: var(--aide-text-muted);
  transition: transform 0.2s ease;
}
.chevron.expanded {
  transform: rotate(90deg);
  color: var(--aide-accent);
}

.sec-ico {
  font-size: 11px;
}

.sec-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.6px;
  text-transform: uppercase;
}

.sec-count {
  font-size: 10px;
  font-weight: 600;
  color: var(--aide-text-muted);
  background: var(--aide-surface-default);
  padding: 0 6px;
  border-radius: 8px;
  min-width: 18px;
  text-align: center;
  line-height: 1.6;
  flex-shrink: 0;
}

.live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--aide-info);
  animation: sec-pulse 1.2s infinite;
  margin-left: auto;
  flex-shrink: 0;
}
.live-dot + .sec-actions {
  margin-left: 4px;
}
@keyframes sec-pulse {
  50% {
    opacity: 0.35;
  }
}

.sec-actions {
  margin-left: auto;
  display: none;
  align-items: center;
}
.sec-head:hover .sec-actions {
  display: flex;
}
/* 操作按钮的统一形态由使用方填 slot，这里只管容器；
   按钮样式用 :deep 透给 slot 内容 */
.sec-actions :deep(.sec-act-btn) {
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--aide-text-muted);
  font-size: 13px;
  cursor: pointer;
  display: grid;
  place-items: center;
}
.sec-actions :deep(.sec-act-btn:hover) {
  background: var(--aide-surface-active);
  color: var(--aide-accent);
}
</style>
