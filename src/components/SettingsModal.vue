<script setup lang="ts">
import { ref, watch } from "vue";
import { useSettings } from "../composables/useSettings";

const emit = defineEmits<{
  close: [];
}>();

const visible = ref(false);
const { settings, update } = useSettings();

// Local copies bound to form controls (immediate apply pattern)
const fontSizeLocal = ref(settings.fontSize);
const fontFamilyLocal = ref(settings.fontFamily);
const notificationsEnabledLocal = ref(settings.notificationsEnabled);

// Sync local refs → reactive settings → persist
watch(fontSizeLocal, (v) => { settings.fontSize = v; update({ fontSize: v }); });
watch(fontFamilyLocal, (v) => { settings.fontFamily = v; update({ fontFamily: v }); });
watch(notificationsEnabledLocal, (v) => { settings.notificationsEnabled = v; update({ notificationsEnabled: v }); });

// Animation trigger on mount
visible.value = true;

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
        <div class="settings-header">设置</div>

        <!-- Font size -->
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

        <!-- Font family -->
        <div class="settings-field">
          <label class="field-label">终端字体</label>
          <input
            v-model="fontFamilyLocal"
            class="text-input"
            placeholder="输入字体名称..."
          />
        </div>

        <!-- Notifications toggle -->
        <div class="settings-field">
          <label class="field-label">桌面通知</label>
          <div class="toggle-row">
            <span class="field-hint">Claude 回复完成后发送通知</span>
            <label class="toggle">
              <input
                v-model="notificationsEnabledLocal"
                type="checkbox"
              />
              <span class="toggle-track"></span>
            </label>
          </div>
        </div>

        <div class="settings-actions">
          <button class="settings-btn btn-primary" @click="emit('close')">关闭</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
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

.settings-dialog {
  background: var(--surface);
  border: 1px solid var(--surface-hover);
  border-radius: 10px;
  padding: 20px 24px;
  width: 400px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  animation: scaleIn 0.15s ease;
}

@keyframes scaleIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

.settings-header {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 20px;
}

.settings-field {
  margin-bottom: 18px;
}

.field-label {
  display: block;
  font-size: 13px;
  color: var(--text-primary);
  margin-bottom: 6px;
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

.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.field-hint {
  font-size: 12px;
  color: var(--text-muted);
}

/* ── Toggle switch ── */

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

/* ── Actions ── */

.settings-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 24px;
}

.settings-btn {
  padding: 7px 22px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.12s;
}

.btn-primary {
  background: var(--accent);
  border: 1px solid var(--accent);
  color: #1e1e2e;
}
.btn-primary:hover {
  filter: brightness(1.1);
}
</style>
