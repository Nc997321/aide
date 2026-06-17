<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { useSettings } from "../composables/useSettings";
import { useCustomizations } from "../composables/useCustomizations";
import CustomizationList from "./customizations/CustomizationList.vue";
import CustomizationDetail from "./customizations/CustomizationDetail.vue";
import MarketplaceTab from "./marketplace/MarketplaceTab.vue";

const emit = defineEmits<{
  close: [];
}>();

type Tab = "general" | "extensions" | "marketplace";

const activeTab = ref<Tab>("general");

// ── Settings (通用) ──

const { settings, update } = useSettings();
const fontSizeLocal = ref(settings.fontSize);
const fontFamilyLocal = ref(settings.fontFamily);
const notificationsEnabledLocal = ref(settings.notificationsEnabled);
const proxyLocal = ref(settings.proxy);

watch(fontSizeLocal, (v) => { settings.fontSize = v; update({ fontSize: v }); });
watch(fontFamilyLocal, (v) => { settings.fontFamily = v; update({ fontFamily: v }); });
watch(notificationsEnabledLocal, (v) => { settings.notificationsEnabled = v; update({ notificationsEnabled: v }); });
watch(proxyLocal, (v) => { settings.proxy = v; update({ proxy: v }); });

// ── Customizations (扩展) ──

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

onMounted(() => { loadAll(); });

function handleCreate(data: any) {
  if (activeType.value) createItem(activeType.value, data);
}

function handleUpdate(data: any) {
  if (activeType.value && activeItemId.value) updateItem(activeType.value, activeItemId.value, data);
}

function handleDelete() {
  if (activeType.value && activeItemId.value) deleteItem(activeType.value, activeItemId.value);
}

function handleToggle(id: string, enabled: boolean) {
  if (activeType.value) toggleItem(activeType.value, id, enabled);
}

function handleBack() {
  if (editingItem.value) {
    clearSelection();
  } else if (activeType.value) {
    activeType.value = null;
  }
}

// ── Overlay ──

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}

function onOverlayClick(e: MouseEvent) {
  if ((e.target as HTMLElement).classList.contains("settings-overlay")) {
    emit("close");
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="settings-overlay" @click="onOverlayClick" @keydown="onKeydown">
      <div class="settings-dialog" @click.stop>
        <!-- Header -->
        <div class="dialog-header">
          <span class="dialog-title">设置</span>
          <button class="dialog-close" @click="emit('close')">✕</button>
        </div>

        <div class="dialog-body">
          <!-- Left nav -->
          <nav class="side-nav">
            <button
              class="nav-item"
              :class="{ active: activeTab === 'general' }"
              @click="activeTab = 'general'"
            >
              <span class="nav-icon">⚙</span>
              <span class="nav-label">通用</span>
            </button>
            <button
              class="nav-item"
              :class="{ active: activeTab === 'extensions' }"
              @click="activeTab = 'extensions'"
            >
              <span class="nav-icon">🧩</span>
              <span class="nav-label">扩展</span>
            </button>
            <button
              class="nav-item"
              :class="{ active: activeTab === 'marketplace' }"
              @click="activeTab = 'marketplace'"
            >
              <span class="nav-icon">🏪</span>
              <span class="nav-label">市场</span>
            </button>
          </nav>

          <!-- Right content -->
          <div class="main-content">
            <!-- ── 通用 Tab ── -->
            <div v-if="activeTab === 'general'" class="tab-general">
              <div class="settings-field">
                <label class="field-label">终端字号</label>
                <div class="field-control">
                  <input
                    v-model.number="fontSizeLocal"
                    type="range"
                    min="11"
                    max="24"
                    class="slider"
                  />
                  <span class="field-value">{{ fontSizeLocal }}px</span>
                </div>
              </div>

              <div class="settings-field">
                <label class="field-label">终端字体</label>
                <input
                  v-model="fontFamilyLocal"
                  class="text-input"
                  placeholder="输入字体名称..."
                />
              </div>

              <div class="settings-field">
                <label class="field-label">桌面通知</label>
                <div class="toggle-row">
                  <span class="field-hint">Claude 回复完成后发送通知</span>
                  <label class="toggle">
                    <input v-model="notificationsEnabledLocal" type="checkbox" />
                    <span class="toggle-track"></span>
                  </label>
                </div>
              </div>

              <div class="settings-field">
                <label class="field-label">网络代理</label>
                <input
                  v-model="proxyLocal"
                  class="text-input"
                  placeholder="例如 http://127.0.0.1:7890（Clash）"
                />
              </div>
            </div>

            <!-- ── 扩展 Tab ── -->
            <div v-else-if="activeTab === 'extensions'" class="tab-extensions">
              <!-- Back button (when not at category root) -->
              <div v-if="activeType" class="ext-back">
                <button class="back-btn" @click="handleBack">← {{ categories.find(c => c.type === activeType)?.label || '返回' }}</button>
              </div>

              <!-- Category grid -->
              <div v-if="!activeType" class="category-grid">
                <button
                  v-for="cat in categories"
                  :key="cat.type"
                  class="category-card"
                  @click="selectCategory(cat.type)"
                >
                  <span class="cat-icon">{{ cat.icon }}</span>
                  <div class="cat-info">
                    <div class="cat-label">{{ cat.label }}</div>
                    <div class="cat-desc">{{ cat.description }}</div>
                  </div>
                  <span class="cat-badge">{{ items[cat.type].length }}</span>
                </button>
              </div>

              <!-- Item list -->
              <CustomizationList
                v-else-if="!editingItem"
                :type="activeType"
                :items="items[activeType]"
                :loading="loading[activeType]"
                @select="selectItem"
                @create="handleCreate"
                @toggle="handleToggle"
              />

              <!-- Item detail -->
              <CustomizationDetail
                v-else
                :type="activeType"
                :item="editingItem"
                @update="handleUpdate"
                @delete="handleDelete"
                @back="clearSelection"
              />
            </div>

            <!-- ── 市场 Tab ── -->
            <div v-else class="tab-marketplace">
              <MarketplaceTab @go-settings="activeTab = 'general'" />
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* ── Overlay ── */

.settings-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: fadeIn 0.12s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* ── Dialog ── */

.settings-dialog {
  background: var(--bg-secondary);
  border: 1px solid var(--surface-hover);
  border-radius: 12px;
  width: 680px;
  height: 520px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
  animation: scaleIn 0.15s ease;
  overflow: hidden;
}

@keyframes scaleIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

/* ── Header ── */

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--surface);
  flex-shrink: 0;
}

.dialog-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.dialog-close {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  padding: 4px 8px;
  border-radius: 4px;
  transition: all 0.12s;
  font-family: inherit;
}

.dialog-close:hover {
  background: var(--surface);
  color: var(--text-primary);
}

/* ── Body ── */

.dialog-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* ── Left nav ── */

.side-nav {
  width: 120px;
  flex-shrink: 0;
  background: var(--bg-tertiary);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-right: 1px solid var(--surface);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12.5px;
  font-family: inherit;
  transition: all 0.12s;
  text-align: left;
  width: 100%;
}

.nav-item:hover {
  background: var(--surface);
  color: var(--text-primary);
}

.nav-item.active {
  background: var(--surface);
  color: var(--text-primary);
}

.nav-icon {
  font-size: 14px;
  width: 18px;
  text-align: center;
  flex-shrink: 0;
}

.nav-label {
  white-space: nowrap;
}

/* ── Main content ── */

.main-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  min-width: 0;
}

/* ── General tab ── */

.tab-general {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.settings-field {
  margin-bottom: 20px;
}

.settings-field:last-child {
  margin-bottom: 0;
}

.field-label {
  display: block;
  font-size: 13px;
  color: var(--text-primary);
  margin-bottom: 8px;
  font-weight: 500;
}

.field-control {
  display: flex;
  align-items: center;
  gap: 10px;
}

.slider {
  flex: 1;
  accent-color: var(--accent);
  height: 4px;
  cursor: pointer;
}

.field-value {
  font-size: 12px;
  color: var(--text-secondary);
  min-width: 36px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.text-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--bg-primary);
  border: 1px solid var(--surface-hover);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--text-primary);
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s;
}

.text-input::placeholder {
  color: var(--text-muted);
}

.text-input:focus {
  border-color: var(--accent);
}

/* ── Toggle ── */

.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.field-hint {
  font-size: 12px;
  color: var(--text-muted);
}

.toggle {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  cursor: pointer;
  flex-shrink: 0;
}

.toggle input {
  opacity: 0;
  width: 0;
  height: 0;
  position: absolute;
}

.toggle-track {
  position: absolute;
  inset: 0;
  background: var(--surface-hover);
  border-radius: 10px;
  transition: background 0.15s;
}

.toggle-track::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: var(--text-primary);
  border-radius: 50%;
  transition: transform 0.15s;
}

.toggle input:checked + .toggle-track {
  background: var(--accent-green);
}

.toggle input:checked + .toggle-track::after {
  transform: translateX(16px);
}

/* ── Extensions tab ── */

.tab-extensions {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.ext-back {
  margin-bottom: 8px;
}

.back-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
  font-family: inherit;
  transition: all 0.12s;
}

.back-btn:hover {
  background: var(--surface);
  color: var(--text-primary);
}

/* Category grid */

.category-grid {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.category-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 8px;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  transition: background 0.12s;
  width: 100%;
}

.category-card:hover {
  background: var(--surface);
}

.cat-icon {
  font-size: 20px;
  width: 28px;
  text-align: center;
  flex-shrink: 0;
}

.cat-info {
  flex: 1;
  min-width: 0;
}

.cat-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.cat-desc {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
}

.cat-badge {
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  padding: 2px 8px;
  border-radius: 10px;
  flex-shrink: 0;
}

/* ── Marketplace tab ── */

.tab-marketplace {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* ── Scrollbar ── */

.main-content::-webkit-scrollbar {
  width: 4px;
}

.main-content::-webkit-scrollbar-track {
  background: transparent;
}

.main-content::-webkit-scrollbar-thumb {
  background: var(--surface-hover);
  border-radius: 2px;
}
</style>
