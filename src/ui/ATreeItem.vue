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
    <span
      v-if="isDir"
      class="a-tree-item__arrow"
      :class="{ 'a-tree-item__arrow--open': expanded }"
      @click.stop="$emit('toggle')"
    >&#x25B8;</span>
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
  font-size: 10px;
  width: 14px;
  text-align: center;
  color: var(--aide-text-muted);
  transition: transform 0.12s;
  flex-shrink: 0;
  cursor: pointer;
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
