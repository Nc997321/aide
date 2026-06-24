<script setup lang="ts">
import { ref, watch, onMounted, computed } from "vue";
import { useSettings } from "../composables/useSettings";
import { useCustomizations } from "../composables/useCustomizations";
import CustomizationList from "./customizations/CustomizationList.vue";
import CustomizationDetail from "./customizations/CustomizationDetail.vue";
import MarketplaceTab from "./marketplace/MarketplaceTab.vue";
import ProviderSettings from "./ProviderSettings.vue";
import { formatShortcut, detectConflicts } from "../utils/shortcut";
import { applyTheme, themes } from "../themes";

const props = defineProps<{
  initialTab?: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

type Tab = "general" | "providers" | "extensions" | "marketplace";

const activeTab = ref<Tab>((props.initialTab as Tab) || "general");

// ── Settings (通用) ──

const { settings, update } = useSettings();
const fontSizeLocal = ref(settings.fontSize);
const fontFamilyLocal = ref(settings.fontFamily);
const notificationsEnabledLocal = ref(settings.notificationsEnabled);
const proxyLocal = ref(settings.proxy);
const shellPathLocal = ref(settings.shellPath);
const searchOpenLocal = ref(settings.keybindings.searchOpen);

watch(fontSizeLocal, (v) => { settings.fontSize = v; update({ fontSize: v }); });
watch(fontFamilyLocal, (v) => { settings.fontFamily = v; update({ fontFamily: v }); });
watch(notificationsEnabledLocal, (v) => { settings.notificationsEnabled = v; update({ notificationsEnabled: v }); });
watch(proxyLocal, (v) => { settings.proxy = v; update({ proxy: v }); });
watch(shellPathLocal, (v) => { settings.shellPath = v; update({ shellPath: v }); });

// ── Keybindings ──

const recordingKey = ref<string | null>(null);

const keybindingDefs: Array<{ key: string; label: string }> = [
  { key: "searchOpen", label: "打开搜索" },
];

const keybindingConflicts = computed(() => {
  const bindings: Record<string, string> = {};
  for (const def of keybindingDefs) {
    bindings[def.key] = settings.keybindings[def.key as keyof typeof settings.keybindings] || "";
  }
  return detectConflicts(bindings);
});

function startRecording(key: string) {
  recordingKey.value = key;
}

function onRecordKeydown(e: KeyboardEvent) {
  if (!recordingKey.value) return;
  e.preventDefault();
  e.stopPropagation();
  // Only record when a modifier key is held (to avoid recording plain letters)
  if (e.ctrlKey || e.metaKey || (e.altKey && e.key !== "Alt")) {
    const shortcut = formatShortcut(e);
    const kb = { ...settings.keybindings };
    (kb as any)[recordingKey.value] = shortcut;
    settings.keybindings = kb;
    update({ keybindings: kb });
    switch (recordingKey.value) {
      case "searchOpen": searchOpenLocal.value = shortcut; break;
    }
  }
  recordingKey.value = null;
}

function onRecordBlur() {
  recordingKey.value = null;
}

function resetKeybinding(key: string) {
  const defaults = { searchOpen: "Ctrl+P" };
  const kb = { ...settings.keybindings };
  (kb as any)[key] = (defaults as any)[key];
  settings.keybindings = kb;
  update({ keybindings: kb });
  switch (key) {
    case "searchOpen": searchOpenLocal.value = "Ctrl+P"; break;
  }
}

// ── Theme ──

function onThemeChange(themeId: string) {
  const tokens = themes[themeId];
  if (tokens) {
    applyTheme(tokens);
    update({ theme: themeId });
  }
}

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
  if (recordingKey.value) {
    onRecordKeydown(e);
    return;
  }
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
              :class="{ active: activeTab === 'providers' }"
              @click="activeTab = 'providers'"
            >
              <span class="nav-icon">🧠</span>
              <span class="nav-label">模型</span>
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

              <div class="settings-field">
                <label class="field-label">工作台终端 Shell</label>
                <input
                  v-model="shellPathLocal"
                  class="text-input"
                  placeholder="留空自动探测（Windows: PowerShell / Linux: bash）"
                />
                <span class="field-hint">填绝对路径覆盖默认，如 C:\Program Files\Git\bin\bash.exe</span>
              </div>

              <div class="settings-field">
                <label class="field-label">主题</label>
                <select
                  class="settings-select"
                  :value="settings.theme"
                  @change="onThemeChange(($event.target as HTMLSelectElement).value)"
                >
                  <option value="warm-dark">Warm Dark</option>
                  <option value="catppuccin">Catppuccin Mocha</option>
                </select>
              </div>

              <!-- ── Keybindings ── -->
              <div class="settings-section">
                <div class="section-title">快捷键</div>

                <div
                  v-for="def in keybindingDefs"
                  :key="def.key"
                  class="kb-row"
                >
                  <span class="kb-label">{{ def.label }}</span>
                  <div class="kb-control">
                    <input
                      class="kb-input"
                      :class="{ recording: recordingKey === def.key }"
                      :value="def.key === 'searchOpen' ? searchOpenLocal : ''"
                      readonly
                      :placeholder="recordingKey === def.key ? '按下快捷键...' : ''"
                      @click="startRecording(def.key)"
                      @blur="onRecordBlur"
                    />
                    <button
                      v-if="recordingKey === def.key"
                      class="kb-recording-hint"
                    >
                      录制中...
                    </button>
                    <button
                      v-else
                      class="kb-record-btn"
                      title="录制新快捷键"
                      @click="startRecording(def.key)"
                    >
                      🖱
                    </button>
                    <button
                      class="kb-reset-btn"
                      title="恢复默认"
                      @click="resetKeybinding(def.key)"
                    >
                      ↺
                    </button>
                  </div>
                </div>

                <div v-if="keybindingConflicts.length > 0" class="kb-conflict-warn">
                  ⚠ 快捷键冲突：
                  <span v-for="(pair, i) in keybindingConflicts" :key="i">
                    {{ keybindingDefs.find(d => d.key === pair[0])?.label }} 与
                    {{ keybindingDefs.find(d => d.key === pair[1])?.label }}
                    {{ i < keybindingConflicts.length - 1 ? '、' : '' }}
                  </span>
                </div>
              </div>
            </div>

            <!-- ── 模型 Tab ── -->
            <div v-else-if="activeTab === 'providers'" class="tab-providers">
              <ProviderSettings />
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
  background: var(--aide-bg-overlay);
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
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-surface-hover);
  border-radius: 12px;
  width: 680px;
  height: 520px;
  display: flex;
  flex-direction: column;
  box-shadow: var(--aide-shadow-lg);
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
  border-bottom: 1px solid var(--aide-surface-default);
  flex-shrink: 0;
}

.dialog-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--aide-text-primary);
}

.dialog-close {
  background: none;
  border: none;
  color: var(--aide-text-muted);
  cursor: pointer;
  font-size: 14px;
  padding: 4px 8px;
  border-radius: 4px;
  transition: all 0.12s;
  font-family: inherit;
}

.dialog-close:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
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
  background: var(--aide-bg-deep);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-right: 1px solid var(--aide-surface-default);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--aide-text-secondary);
  cursor: pointer;
  font-size: 12.5px;
  font-family: inherit;
  transition: all 0.12s;
  text-align: left;
  width: 100%;
}

.nav-item:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

.nav-item.active {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
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
  color: var(--aide-text-primary);
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
  accent-color: var(--aide-accent);
  height: 4px;
  cursor: pointer;
}

.field-value {
  font-size: 12px;
  color: var(--aide-text-secondary);
  min-width: 36px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.text-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-surface-hover);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--aide-text-primary);
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s;
}

.text-input::placeholder {
  color: var(--aide-text-muted);
}

.text-input:focus {
  border-color: var(--aide-accent);
}

.settings-select {
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  padding: 6px 10px;
  color: var(--aide-text-primary);
  font-size: 12px;
  font-family: inherit;
  outline: none;
  cursor: pointer;
}
.settings-select:focus {
  border-color: var(--aide-accent);
}

/* ── Toggle ── */

.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.field-hint {
  font-size: 12px;
  color: var(--aide-text-muted);
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
  background: var(--aide-surface-hover);
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
  background: var(--aide-text-primary);
  border-radius: 50%;
  transition: transform 0.15s;
}

.toggle input:checked + .toggle-track {
  background: var(--aide-success);
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
  color: var(--aide-text-secondary);
  cursor: pointer;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
  font-family: inherit;
  transition: all 0.12s;
}

.back-btn:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
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
  background: var(--aide-surface-default);
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
  color: var(--aide-text-primary);
}

.cat-desc {
  font-size: 11px;
  color: var(--aide-text-muted);
  margin-top: 2px;
}

.cat-badge {
  font-size: 11px;
  color: var(--aide-text-muted);
  background: var(--aide-bg-deep);
  padding: 2px 8px;
  border-radius: 10px;
  flex-shrink: 0;
}

/* ── Providers tab ── */

.tab-providers {
  display: flex;
  height: 100%;
  margin: -20px;
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
  background: var(--aide-surface-hover);
  border-radius: 2px;
}

/* ── Keybindings ── */

.settings-section {
  margin-top: 8px;
  border-top: 1px solid var(--aide-surface-default);
  padding-top: 16px;
}

.section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--aide-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 12px;
}

.kb-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.kb-label {
  font-size: 12.5px;
  color: var(--aide-text-secondary);
  flex-shrink: 0;
}

.kb-control {
  display: flex;
  align-items: center;
  gap: 4px;
}

.kb-input {
  width: 100px;
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-surface-hover);
  border-radius: 5px;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--aide-text-primary);
  text-align: center;
  font-family: "'Cascadia Code', 'Fira Code', monospace";
  cursor: pointer;
  transition: border-color 0.15s;
  outline: none;
}

.kb-input:hover {
  border-color: var(--aide-accent);
}

.kb-input.recording {
  border-color: var(--aide-success);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--aide-success) 30%, transparent);
  animation: kb-pulse 1s ease-in-out infinite;
}

@keyframes kb-pulse {
  0%, 100% { box-shadow: 0 0 0 1px color-mix(in srgb, var(--aide-success) 30%, transparent); }
  50% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--aide-success) 15%, transparent); }
}

.kb-recording-hint {
  background: none;
  border: none;
  color: var(--aide-success);
  font-size: 10px;
  cursor: default;
  animation: kb-pulse 1s ease-in-out infinite;
  font-family: inherit;
}

.kb-record-btn,
.kb-reset-btn {
  background: none;
  border: none;
  color: var(--aide-text-muted);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 4px;
  border-radius: 3px;
  transition: all 0.12s;
  font-family: inherit;
}

.kb-record-btn:hover,
.kb-reset-btn:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

.kb-conflict-warn {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--aide-warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-warning) 25%, transparent);
  font-size: 11px;
  color: var(--aide-warning);
}
</style>
