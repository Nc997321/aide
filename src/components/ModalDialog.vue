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
  danger,
  submit,
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

.modal-dialog {
  background: var(--surface);
  border: 1px solid var(--surface-hover);
  border-radius: 10px;
  padding: 20px 24px;
  min-width: 360px;
  max-width: 440px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  animation: scaleIn 0.15s ease;
}

@keyframes scaleIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

.modal-header {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 12px;
}

.modal-body {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
  margin-bottom: 12px;
}

.modal-input-wrap {
  margin-bottom: 16px;
}

.modal-input {
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
.modal-input::placeholder {
  color: var(--text-muted);
}
.modal-input:focus {
  border-color: var(--accent);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.modal-btn {
  padding: 7px 18px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
  border: 1px solid var(--surface-hover);
  transition: all 0.12s;
}

.btn-cancel {
  background: transparent;
  color: var(--text-secondary);
}
.btn-cancel:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.btn-confirm {
  background: var(--accent);
  border-color: var(--accent);
  color: #1e1e2e;
}
.btn-confirm:hover {
  filter: brightness(1.1);
}
.btn-confirm.danger {
  background: #f38ba8;
  border-color: #f38ba8;
  color: #1e1e2e;
}
.btn-confirm.danger:hover {
  filter: brightness(1.1);
}
</style>
