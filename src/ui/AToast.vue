<script setup lang="ts">
import type { ToastState } from "@/composables/useToast";

/**
 * 通用瞬时提示卡片：锚定在最近的相对定位祖先的顶部外侧居中
 * （与 ChatPanel 的 btw-revert-toast 同一锚定模式），全 --aide-* token 随主题切换。
 * 状态由 useToast 管理，本组件纯展示。
 */
defineProps<{ state: ToastState }>();
</script>

<template>
  <Transition name="a-toast">
    <div v-if="state.visible" class="a-toast" :class="`a-toast--${state.kind}`" role="status">
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
  gap: 7px;
  max-width: min(480px, 90%);
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border);
  color: var(--aide-text-primary);
  font-size: 11.5px;
  padding: 5px 12px;
  border-radius: 999px;
  box-shadow: var(--aide-shadow-md);
  z-index: 40;
  pointer-events: none;
}
.a-toast-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.a-toast--success .a-toast-dot { background: var(--aide-success); }
.a-toast--danger .a-toast-dot { background: var(--aide-danger); }
.a-toast--info .a-toast-dot { background: var(--aide-info); }
.a-toast--danger { border-color: color-mix(in srgb, var(--aide-danger) 55%, transparent); }
.a-toast-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.a-toast-enter-active,
.a-toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.a-toast-enter-from,
.a-toast-leave-to { opacity: 0; transform: translate(-50%, 4px); }
</style>
