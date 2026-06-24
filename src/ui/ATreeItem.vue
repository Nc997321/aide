<script setup lang="ts">
const props = defineProps<{
  label: string;
  icon: string;
  depth: number;
  isDir: boolean;
  expanded: boolean;
  active: boolean;
}>();

defineEmits<{
  toggle: [];
  select: [];
}>();
</script>

<template>
  <div
    class="a-tree-item"
    :class="{ 'a-tree-item--active': active }"
    :style="{ paddingLeft: `${depth * 16 + 8}px` }"
    @click="$emit('select')"
  >
    <svg
      v-if="isDir"
      class="a-tree-item__arrow"
      :class="{ 'a-tree-item__arrow--open': expanded }"
      width="12" height="12" viewBox="0 0 12 12" fill="none"
      @click.stop="$emit('toggle')"
    >
      <path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span v-else class="a-tree-item__arrow-placeholder" />
    <span class="a-tree-item__icon">{{ icon }}</span>
    <span class="a-tree-item__label">{{ label }}</span>
  </div>
</template>

<style scoped>
.a-tree-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 4px;
  padding-bottom: 4px;
  padding-right: 8px;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  font-size: 12px;
  color: var(--aide-text-secondary);
  transition: all 0.1s;
}

.a-tree-item:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

.a-tree-item--active {
  background: var(--aide-accent-subtle);
  color: var(--aide-accent);
}

.a-tree-item__arrow {
  width: 14px;
  height: 12px;
  color: var(--aide-text-muted);
  transition: transform 0.15s ease, color 0.15s ease;
  flex-shrink: 0;
  cursor: pointer;
  border-radius: 3px;
  padding: 1px;
}

.a-tree-item__arrow--open {
  transform: rotate(90deg);
}

.a-tree-item__arrow-placeholder {
  width: 14px;
  flex-shrink: 0;
}

.a-tree-item__icon {
  font-size: 14px;
  width: 18px;
  text-align: center;
  flex-shrink: 0;
}

.a-tree-item__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
