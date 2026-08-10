<script setup lang="ts">
import type { CustomizationType, CustomizationItem } from "../../types/customization";
import { CUSTOMIZATION_CATEGORIES } from "../../composables/useCustomizations";
import { useModal } from "../../composables/useModal";
import Icon from "../Icon.vue";

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

const { prompt: modalPrompt } = useModal();

async function handleCreate() {
  const name = await modalPrompt(`请输入${category?.label || '项目'}名称:`);
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

function sourceLabel(s: NonNullable<CustomizationItem["source"]>): string {
  return s === "builtin" ? "内置" : s === "project" ? "项目" : s === "plugin" ? "插件" : "用户";
}
</script>

<template>
  <div class="customization-list">
    <!-- Loading -->
    <div v-if="loading" class="loading">加载中...</div>

    <!-- Empty -->
    <div v-else-if="items.length === 0" class="empty">
      <div class="empty-icon"><Icon :name="category?.icon ?? ''" :size="32" /></div>
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
        <span
          class="src-badge"
          :class="`src-${item.source ?? 'user'}`"
          v-if="item.source"
        >{{ sourceLabel(item.source) }}</span>
        <button
          class="toggle-btn"
          :class="{ active: item.enabled }"
          @click="handleToggle(item.id, $event)"
          v-tooltip="item.enabled ? '禁用' : '启用'"
        >
          {{ item.enabled ? '启用' : '停用' }}
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
  color: var(--aide-accent);
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
  border-radius: var(--aide-radius-md);
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
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  color: var(--aide-text-secondary);
  padding: 2px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 10px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all var(--aide-ease-t);
  font-family: inherit;
  min-width: 42px;
  height: auto;
}

.toggle-btn:hover {
  border-color: var(--aide-accent);
  color: var(--aide-accent);
}

.toggle-btn.active {
  background: color-mix(in srgb, var(--aide-success) 13%, transparent);
  border-color: color-mix(in srgb, var(--aide-success) 28%, transparent);
  color: var(--aide-success);
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
  border-radius: var(--aide-radius-md);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s;
}

.add-btn:hover {
  border-color: var(--aide-accent);
  color: var(--aide-accent);
}

.src-badge {
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.3px;
  padding: 2px 7px;
  border-radius: 10px;
  white-space: nowrap;
  flex-shrink: 0;
}
.src-user {
  background: color-mix(in srgb, var(--aide-info) 14%, transparent);
  color: var(--aide-info);
}
.src-project {
  background: color-mix(in srgb, var(--aide-success) 14%, transparent);
  color: var(--aide-success);
}
.src-plugin {
  background: color-mix(in srgb, var(--aide-warning) 14%, transparent);
  color: var(--aide-warning);
}
.src-builtin {
  background: var(--aide-surface-active);
  color: var(--aide-text-muted);
}
</style>
