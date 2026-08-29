<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import { useModal } from "../composables/useModal";

const {
  visible,
  mode,
  title,
  message,
  inputValue,
  placeholder,
  confirmLabel,
  altLabel,
  danger,
  component,
  componentProps,
  width,
  resolveCustom,
  submit,
  submitAlt,
  cancel,
} = useModal();

const inputRef = ref<HTMLInputElement | null>(null);

watch(visible, async (v) => {
  if (v && mode.value === "prompt") {
    await nextTick();
    inputRef.value?.focus();
  }
});

function onKeydown(e: KeyboardEvent) {
  // Enter/Escape 被本弹窗消费时 preventDefault——下游 window 级键盘 handler
  // （PermissionDialog 的 Enter/Esc 确认）见 defaultPrevented 让路，防一次按键双效果。
  if (e.key === "Enter" && mode.value !== "custom") {
    e.preventDefault();
    submit();
  }
  if (e.key === "Escape") {
    e.preventDefault();
    cancel();
  }
}

function onOverlayClick(e: MouseEvent) {
  if ((e.target as HTMLElement).classList.contains("modal-overlay")) {
    cancel();
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-overlay" @click="onOverlayClick" @keydown="onKeydown">
      <div class="modal-dialog" :class="[mode === 'custom' ? width : '']" @click.stop>
        <div class="modal-header">{{ title }}</div>

        <div v-if="message" class="modal-body">{{ message }}</div>

        <div v-if="mode === 'prompt'" class="modal-input-wrap">
          <input
            ref="inputRef"
            v-model="inputValue"
            class="modal-input"
            :placeholder="placeholder"
            @keydown.enter="submit"
            @keydown.escape="cancel"
          />
        </div>

        <div v-if="mode === 'custom'" class="modal-custom-body">
          <component
            :is="component"
            v-bind="componentProps"
            @submit="resolveCustom"
            @cancel="cancel"
          />
        </div>

        <div v-if="mode !== 'custom'" class="modal-actions">
          <button v-if="mode !== 'notice'" class="modal-btn btn-cancel" @click="cancel">取消</button>
          <button v-if="mode === 'choice'" class="modal-btn btn-alt" @click="submitAlt">
            {{ altLabel }}
          </button>
          <button
            class="modal-btn btn-confirm"
            :class="{ danger }"
            @click="submit"
          >
            {{ confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--aide-bg-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1200; /* 高于 SettingsPanel 等面板层（1100）：confirm/notice/prompt 从面板内触发时必须盖在面板之上，否则被后渲染的面板遮住。低于 popover/menu/tooltip 层（9000+）。 */
  animation: fadeIn 0.12s ease;
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.modal-dialog {
  width: 380px;
  background: linear-gradient(180deg, var(--aide-bg-raised), var(--aide-bg-base));
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg);
  padding: 20px;
  min-width: 360px;
  max-width: 440px;
  box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  animation: scaleIn 0.15s ease;
}

/* Custom mode width variants */
.modal-dialog.sm { width: 360px; max-width: 400px; }
.modal-dialog.md { width: 480px; max-width: 560px; }
.modal-dialog.lg { width: 640px; max-width: 720px; }

@keyframes scaleIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

.modal-header {
  font-size: 14px;
  font-weight: 600;
  color: var(--aide-text-primary);
  margin-bottom: 12px;
}

.modal-body {
  font-size: 12.5px;
  color: var(--aide-text-secondary);
  line-height: 1.65;
  margin-bottom: 12px;
}

.modal-input-wrap {
  margin-bottom: 16px;
}

.modal-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  padding: 8px 12px;
  font-size: 12.5px;
  color: var(--aide-text-primary);
  outline: none;
  font-family: inherit;
  box-shadow: var(--aide-shadow-inset);
  transition: all var(--aide-ease-t);
}

.modal-input::placeholder {
  color: var(--aide-text-muted);
}

.modal-input:focus {
  border-color: var(--aide-accent);
  box-shadow: var(--aide-accent-ring), var(--aide-shadow-inset);
}

.modal-custom-body {
  margin-bottom: 0;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 9px;
}

.modal-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 7px 15px;
  border-radius: var(--aide-radius-md);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  transition: all var(--aide-ease-t);
  white-space: nowrap;
}

.btn-cancel {
  background: transparent;
  border: 1px solid transparent;
  color: var(--aide-text-secondary);
  box-shadow: none;
}

.btn-cancel:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

.btn-alt {
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--aide-danger) 35%, transparent);
  color: var(--aide-danger);
  box-shadow: none;
}

.btn-alt:hover {
  background: color-mix(in srgb, var(--aide-danger) 12%, transparent);
}

.btn-confirm {
  background: var(--aide-accent-gradient);
  border: 1px solid var(--aide-border-strong);
  color: var(--aide-text-on-accent);
  font-weight: 600;
  box-shadow: var(--aide-accent-glow), var(--aide-highlight-inset);
}

.btn-confirm:hover {
  filter: brightness(1.07);
}

.btn-confirm.danger {
  background: transparent;
  border-color: color-mix(in srgb, var(--aide-danger) 35%, transparent);
  color: var(--aide-danger);
  box-shadow: none;
}

.btn-confirm.danger:hover {
  background: color-mix(in srgb, var(--aide-danger) 12%, transparent);
}
</style>
