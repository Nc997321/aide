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
  if (e.key === "Enter") submit();
  if (e.key === "Escape") cancel();
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
      <div class="modal-dialog" @click.stop>
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

        <div class="modal-actions">
          <button class="modal-btn btn-cancel" @click="cancel">取消</button>
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
  z-index: 1100;
  animation: fadeIn 0.12s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.modal-dialog {
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-surface-hover);
  border-radius: var(--aide-radius-lg);
  padding: 20px 24px;
  min-width: 360px;
  max-width: 440px;
  box-shadow: var(--aide-shadow-lg);
  animation: scaleIn 0.15s ease;
}

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
  font-size: 13px;
  color: var(--aide-text-secondary);
  line-height: 1.5;
  margin-bottom: 12px;
}

.modal-input-wrap {
  margin-bottom: 16px;
}

.modal-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-surface-hover);
  border-radius: var(--aide-radius-md);
  padding: 8px 12px;
  font-size: 13px;
  color: var(--aide-text-primary);
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s;
}
.modal-input::placeholder {
  color: var(--aide-text-muted);
}
.modal-input:focus {
  border-color: var(--aide-accent);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.modal-btn {
  padding: 8px 16px;
  border-radius: var(--aide-radius-md);
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
  border: 1px solid var(--aide-surface-hover);
  transition: all 0.12s;
}

.btn-cancel {
  background: transparent;
  color: var(--aide-text-secondary);
}
.btn-cancel:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}

.btn-alt {
  background: transparent;
  color: var(--aide-danger);
  border-color: color-mix(in srgb, var(--aide-danger) 35%, transparent);
}
.btn-alt:hover {
  background: color-mix(in srgb, var(--aide-danger) 12%, transparent);
}

.btn-confirm {
  background: var(--aide-accent);
  border-color: var(--aide-accent);
  color: var(--aide-text-on-accent);
}
.btn-confirm:hover {
  filter: brightness(1.1);
}
.btn-confirm.danger {
  background: var(--aide-danger);
  border-color: var(--aide-danger);
  color: var(--aide-text-on-accent);
}
.btn-confirm.danger:hover {
  filter: brightness(1.1);
}
</style>
