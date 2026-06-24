<script setup lang="ts">
import type { CustomizationType, CustomizationItem } from "../../types/customization";
import { CUSTOMIZATION_CATEGORIES } from "../../composables/useCustomizations";

const props = defineProps<{
  type: CustomizationType;
  items: CustomizationItem[];
  loading: boolean;
}>();

const emit = defineEmits<{
  select: [id: string];
  create: [data: Partial<CustomizationItem>];
  toggle: [id: string, enabled: boolean];
}>();

const category = CUSTOMIZATION_CATEGORIES.find((c) => c.type === props.type);

function handleCreate() {
  const name = prompt(`请输入${category?.label || '项目'}名称:`);
  if (name) {
    emit("create", { name, type: props.type, enabled: true });
  }
}

function handleToggle(id: string, event: Event) {
  event.stopPropagation();
  const item = props.items.find((i) => i.id === id);
  if (item) {
    emit("toggle", id, !item.enabled);
  }
}
</script>

<template>
  <div class="customization-list">
    <!-- Loading -->
    <div v-if="loading" class="loading">加载中...</div>

    <!-- Empty -->
    <div v-else-if="items.length === 0" class="empty">
      <div class="empty-icon">{{ category?.icon }}</div>
      <div class="empty-text">暂无{{ category?.label }}</div>
      <button class="create-btn" @click="handleCreate">创建第一个</button>
    </div>

    <!-- List -->
    <div v-else class="list">
      <div
        v-for="item in items"
        :key="item.id"
        class="list-item"
        :class="{ disabled: !item.enabled }"
        @click="emit('select', item.id)"
      >
        <div class="item-info">
          <div class="item-name">{{ item.name }}</div>
          <div class="item-meta" v-if="item.description">{{ item.description }}</div>
        </div>
        <button
          class="toggle-btn"
          :class="{ active: item.enabled }"
          @click="handleToggle(item.id, $event)"
          :title="item.enabled ? '禁用' : '启用'"
        >
          {{ item.enabled ? '✓' : '○' }}
        </button>
      </div>
    </div>

    <!-- Add Button -->
    <div class="add-bar" v-if="!loading && items.length > 0">
      <button class="add-btn" @click="handleCreate">+ 添加</button>
    </div>
  </div>
</template>

<style scoped>
.customization-list {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.loading,
.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--aide-text-muted);
  padding: 32px;
}

.empty-icon {
  font-size: 32px;
  margin-bottom: 12px;
}

.empty-text {
  font-size: 13px;
  margin-bottom: 16px;
}

.create-btn {
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
  border: none;
  padding: 8px 16px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}

.create-btn:hover {
  opacity: 0.9;
}

.list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.list-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
}

.list-item:hover {
  background: var(--aide-surface-default);
}

.list-item.disabled {
  opacity: 0.5;
}

.item-info {
  flex: 1;
  min-width: 0;
}

.item-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--aide-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-meta {
  font-size: 11px;
  color: var(--aide-text-muted);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toggle-btn {
  background: none;
  border: 1px solid var(--aide-surface-default);
  color: var(--aide-text-muted);
  width: 24px;
  height: 24px;
  border-radius: 50%;
  cursor: pointer;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.toggle-btn:hover {
  border-color: var(--aide-accent);
  color: var(--aide-accent);
}

.toggle-btn.active {
  background: var(--aide-accent);
  border-color: var(--aide-accent);
  color: var(--aide-text-on-accent);
}

.add-bar {
  padding: 12px;
  border-top: 1px solid var(--aide-surface-default);
}

.add-btn {
  width: 100%;
  background: none;
  border: 1px dashed var(--aide-surface-default);
  color: var(--aide-text-secondary);
  padding: 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s;
}

.add-btn:hover {
  border-color: var(--aide-accent);
  color: var(--aide-accent);
}
</style>
