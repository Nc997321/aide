<script setup lang="ts">
import ABadge from "./ABadge.vue";

export interface Tab {
  id: string;
  label: string;
  icon?: string;
  badge?: number;
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
      :tabindex="modelValue === tab.id ? 0 : -1"
      @click="emit('update:modelValue', tab.id)"
    >
      <span v-if="tab.icon" class="a-tab__icon">{{ tab.icon }}</span>
      <span class="a-tab__label">{{ tab.label }}</span>
      <ABadge v-if="tab.badge && tab.badge > 0" :value="tab.badge" />
    </button>
  </div>
</template>

<style scoped>
.a-tab-bar {
  display: flex;
  padding: 6px 8px 0;
  gap: 2px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--aide-border);
}

.a-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 7px 0 8px;
  border: none;
  background: transparent;
  color: var(--aide-text-muted);
  font-size: 11.5px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  border-radius: var(--aide-radius-sm) var(--aide-radius-sm) 0 0;
  transition: all 0.15s ease;
}

.a-tab:hover {
  color: var(--aide-text-secondary);
  background: var(--aide-border-subtle);
}

.a-tab--active {
  color: var(--aide-text-primary);
  border-bottom-color: var(--aide-accent);
  background: var(--aide-border-subtle);
}

.a-tab__icon {
  font-size: 13px;
}

.a-tab__label {
  font-weight: 500;
}
</style>
