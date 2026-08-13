<script setup lang="ts">
import type { ToastState } from "@/composables/useToast";

/**
 * 通用瞬时提示卡片：锚定在最近的相对定位祖先的顶部外侧居中
 * （与 ChatPanel 的 btw-revert-toast 同一锚定模式），全 --aide-* token 随主题切换。
 * 状态由 useToast 管理，本组件纯展示。
 */
defineProps<{ state: ToastState; placement?: "outside-top" | "inside-bottom" }>();
</script>

<template>
  <Transition name="a-toast">
    <div v-if="state.visible" class="a-toast" :class="[`a-toast--${state.kind}`, { 'a-toast--inside-bottom': placement === 'inside-bottom' }]" role="status">
      <span class="a-toast-dot" aria-hidden="true" />
      <span class="a-toast-text">{{ state.text }}</span>
    </div>
  </Transition>
</template>

<style scoped>
.a-toast {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: 100%;
  margin-bottom: 6px;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  max-width: min(480px, 90%);
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  color: var(--aide-text-primary);
  font-size: 12.5px;
  padding: 10px 14px;
  box-shadow: var(--aide-shadow-md), var(--aide-highlight-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  z-index: 40;
  pointer-events: none;
  overflow: hidden;
}

.a-toast-dot {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  flex: none;
}

.a-toast--success .a-toast-dot {
  background: var(--aide-success);
  box-shadow: 0 0 10px color-mix(in srgb, var(--aide-success) 60%, transparent);
}

.a-toast--danger .a-toast-dot {
  background: var(--aide-danger);
  box-shadow: 0 0 10px color-mix(in srgb, var(--aide-danger) 60%, transparent);
}

.a-toast--info .a-toast-dot {
  background: var(--aide-info);
  box-shadow: 0 0 10px color-mix(in srgb, var(--aide-info) 60%, transparent);
}

.a-toast-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* inside-bottom：弹在锚容器内侧底部——用于锚容器 overflow:hidden 会裁掉外侧 toast
   的场景（如 GitPanel 的 .git-panel overflow:hidden），且不挡顶部工具栏。
   outside-top 默认弹外侧顶部（ChatPanel 用）。 */
.a-toast--inside-bottom {
  top: auto;
  bottom: 8px;
  margin-bottom: 0;
}

.a-toast-enter-active,
.a-toast-leave-active { transition: opacity var(--aide-ease-t), transform var(--aide-ease-t); }

.a-toast-enter-from,
.a-toast-leave-to { opacity: 0; transform: translate(-50%, 4px); }
</style>
