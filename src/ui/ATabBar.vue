<script setup lang="ts">
import ABadge from "./ABadge.vue";

export interface Tab {
  id: string;
  /** 可见文字；省略时为纯图标 tab（仍可作为按钮的无障碍名称）。 */
  label?: string;
  icon?: string;
  badge?: number;
  /** 沉底标记：仅 ARailBar 消费——带此标记的 tab 用弹性分隔推到底部（如权限）。 */
  bottom?: boolean;
}

const props = defineProps<{
  tabs: Tab[];
  modelValue: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [id: string];
}>();

function onKeydown(e: KeyboardEvent) {
  const idx = props.tabs.findIndex((t) => t.id === props.modelValue);
  if (e.key === "ArrowRight" && idx < props.tabs.length - 1) {
    e.preventDefault();
    emit("update:modelValue", props.tabs[idx + 1].id);
  } else if (e.key === "ArrowLeft" && idx > 0) {
    e.preventDefault();
    emit("update:modelValue", props.tabs[idx - 1].id);
  }
}
</script>

<template>
  <div class="a-tab-bar" role="tablist" @keydown="onKeydown">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      class="a-tab"
      :class="{ 'a-tab--active': modelValue === tab.id }"
      role="tab"
      :aria-selected="modelValue === tab.id"
      :aria-label="tab.label"
      :tabindex="modelValue === tab.id ? 0 : -1"
      @click="emit('update:modelValue', tab.id)"
    >
      <span v-if="tab.icon" class="a-tab__icon" v-html="tab.icon"></span>
      <span v-if="tab.label" class="a-tab__label">{{ tab.label }}</span>
      <ABadge v-if="tab.badge && tab.badge > 0" :value="tab.badge" />
    </button>
  </div>
</template>

<style scoped>
.a-tab-bar {
  display: flex;
  padding: 0 8px;
  gap: 2px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--aide-border-subtle);
}

.a-tab {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 9px 14px;
  border: none;
  background: transparent;
  color: var(--aide-text-muted);
  font-size: 12.5px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  border-radius: var(--aide-radius-sm) var(--aide-radius-sm) 0 0;
  transition: color var(--aide-ease-t);
}

.a-tab:hover {
  color: var(--aide-text-secondary);
}

.a-tab--active {
  color: var(--aide-text-primary);
  font-weight: 500;
}

.a-tab--active::after {
  content: '';
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: var(--aide-accent-gradient);
  box-shadow: 0 0 8px color-mix(in srgb, var(--aide-accent) 55%, transparent);
}

.a-tab__icon {
  font-size: 13px;
  display: inline-flex;
  align-items: center;
}

.a-tab__icon :deep(svg) {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}

.a-tab__label {
  font-weight: 500;
}
</style>
