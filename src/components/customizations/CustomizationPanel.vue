<script setup lang="ts">
import { onMounted } from "vue";
import { useCustomizations } from "../../composables/useCustomizations";
import CustomizationList from "./CustomizationList.vue";
import CustomizationDetail from "./CustomizationDetail.vue";

const emit = defineEmits<{
  close: [];
}>();

const {
  categories,
  items,
  activeType,
  activeItemId,
  editingItem,
  loading,
  loadAll,
  selectCategory,
  selectItem,
  clearSelection,
  createItem,
  updateItem,
  deleteItem,
  toggleItem,
} = useCustomizations();

onMounted(() => {
  loadAll();
});

function handleBack() {
  if (editingItem.value) {
    clearSelection();
  } else if (activeType.value) {
    activeType.value = null;
  }
}

function handleCreate(data: any) {
  if (activeType.value) {
    createItem(activeType.value, data);
  }
}

function handleUpdate(data: any) {
  if (activeType.value && activeItemId.value) {
    updateItem(activeType.value, activeItemId.value, data);
  }
}

function handleDelete() {
  if (activeType.value && activeItemId.value) {
    deleteItem(activeType.value, activeItemId.value);
  }
}

function handleToggle(id: string, enabled: boolean) {
  if (activeType.value) {
    toggleItem(activeType.value, id, enabled);
  }
}
</script>

<template>
  <div class="customization-panel">
    <!-- Header -->
    <div class="panel-header">
      <button class="back-btn" @click="handleBack" v-if="activeType">
        ←
      </button>
      <span class="header-title">
        {{ activeType ? categories.find(c => c.type === activeType)?.label : '自定义' }}
      </span>
      <button class="close-btn" @click="emit('close')">✕</button>
    </div>

    <!-- Content -->
    <div class="panel-content">
      <!-- Category Selection -->
      <div v-if="!activeType" class="category-list">
        <div
          v-for="cat in categories"
          :key="cat.type"
          class="category-item"
          @click="selectCategory(cat.type)"
        >
          <span class="cat-icon">{{ cat.icon }}</span>
          <div class="cat-info">
            <div class="cat-label">{{ cat.label }}</div>
            <div class="cat-desc">{{ cat.description }}</div>
          </div>
          <span class="cat-count">{{ items[cat.type].length }}</span>
        </div>
      </div>

      <!-- Item List -->
      <CustomizationList
        v-else-if="!editingItem"
        :type="activeType"
        :items="items[activeType]"
        :loading="loading[activeType]"
        @select="selectItem"
        @create="handleCreate"
        @toggle="handleToggle"
      />

      <!-- Item Detail/Edit -->
      <CustomizationDetail
        v-else
        :type="activeType"
        :item="editingItem"
        @update="handleUpdate"
        @delete="handleDelete"
        @back="clearSelection"
      />
    </div>
  </div>
</template>

<style scoped>
.customization-panel {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 500px;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-surface-default);
  border-radius: 12px;
  box-shadow: var(--aide-shadow-lg);
  z-index: 1000;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--aide-surface-default);
  border-radius: 12px 12px 0 0;
}

.back-btn,
.close-btn {
  background: none;
  border: none;
  color: var(--aide-text-secondary);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 14px;
}

.back-btn:hover,
.close-btn:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

.header-title {
  flex: 1;
  font-weight: 600;
  font-size: 14px;
}

.panel-content {
  flex: 1;
  overflow-y: auto;
  border-radius: 0 0 12px 12px;
}

/* Category List */
.category-list {
  padding: 8px;
}

.category-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
}

.category-item:hover {
  background: var(--aide-surface-default);
}

.cat-icon {
  font-size: 20px;
}

.cat-info {
  flex: 1;
}

.cat-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--aide-text-primary);
}

.cat-desc {
  font-size: 11px;
  color: var(--aide-text-muted);
  margin-top: 2px;
}

.cat-count {
  font-size: 12px;
  color: var(--aide-text-muted);
  background: var(--aide-bg-deep);
  padding: 2px 8px;
  border-radius: 10px;
}
</style>
