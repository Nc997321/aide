<script setup lang="ts">
import { ref, watch } from "vue";
import type { CustomizationType, CustomizationItem } from "../../types/customization";
import { CUSTOMIZATION_CATEGORIES } from "../../composables/useCustomizations";

const props = defineProps<{
  type: CustomizationType;
  item: CustomizationItem | null;
}>();

const emit = defineEmits<{
  update: [data: Partial<CustomizationItem>];
  delete: [];
  back: [];
}>();

const category = CUSTOMIZATION_CATEGORIES.find((c) => c.type === props.type);

const formData = ref<Partial<CustomizationItem>>({});
const isEditing = ref(false);

watch(
  () => props.item,
  (newItem) => {
    if (newItem) {
      formData.value = { ...newItem };
      isEditing.value = false;
    }
  },
  { immediate: true }
);

function handleSave() {
  emit("update", { ...formData.value });
  isEditing.value = false;
}

function handleDelete() {
  if (confirm(`确定要删除 "${props.item?.name}" 吗？`)) {
    emit("delete");
  }
}

function handleCancel() {
  if (props.item) {
    formData.value = { ...props.item };
  }
  isEditing.value = false;
}
</script>

<template>
  <div class="customization-detail">
    <!-- Header -->
    <div class="detail-header">
      <span class="detail-icon">{{ category?.icon }}</span>
      <span class="detail-name">{{ item?.name }}</span>
      <div class="detail-actions">
        <button
          v-if="!isEditing"
          class="edit-btn"
          @click="isEditing = true"
        >
          编辑
        </button>
        <button
          v-if="isEditing"
          class="save-btn"
          @click="handleSave"
        >
          保存
        </button>
        <button
          v-if="isEditing"
          class="cancel-btn"
          @click="handleCancel"
        >
          取消
        </button>
        <button class="delete-btn" @click="handleDelete">删除</button>
      </div>
    </div>

    <!-- Content -->
    <div class="detail-content">
      <!-- Name -->
      <div class="form-group">
        <label>名称</label>
        <input
          v-model="formData.name"
          :disabled="!isEditing"
          class="form-input"
        />
      </div>

      <!-- Description -->
      <div class="form-group">
        <label>描述</label>
        <input
          v-model="formData.description"
          :disabled="!isEditing"
          class="form-input"
        />
      </div>

      <!-- Type-specific fields -->
      <slot :formData="formData" :isEditing="isEditing" />
    </div>
  </div>
</template>

<style scoped>
.customization-detail {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.detail-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--aide-surface-default);
}

.detail-icon {
  font-size: 18px;
}

.detail-name {
  flex: 1;
  font-weight: 600;
  font-size: 14px;
}

.detail-actions {
  display: flex;
  gap: 8px;
}

.edit-btn,
.save-btn,
.cancel-btn,
.delete-btn {
  background: none;
  border: 1px solid var(--aide-surface-default);
  color: var(--aide-text-secondary);
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s;
}

.edit-btn:hover {
  border-color: var(--aide-accent);
  color: var(--aide-accent);
}

.save-btn {
  background: var(--aide-accent);
  border-color: var(--aide-accent);
  color: white;
}

.save-btn:hover {
  opacity: 0.9;
}

.cancel-btn:hover {
  background: var(--aide-surface-default);
}

.delete-btn {
  border-color: var(--aide-danger);
  color: var(--aide-danger);
}

.delete-btn:hover {
  background: var(--aide-danger);
  color: white;
}

.detail-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  font-size: 12px;
  color: var(--aide-text-secondary);
  margin-bottom: 6px;
}

.form-input {
  width: 100%;
  background: var(--aide-surface-default);
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--aide-text-primary);
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s;
}

.form-input:focus {
  border-color: var(--aide-accent);
}

.form-input:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

textarea.form-input {
  min-height: 100px;
  resize: vertical;
}
</style>
