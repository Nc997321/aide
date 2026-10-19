<script setup lang="ts">
/**
 * 「关闭 Aide 窗口？」卡片的正文：`useModal().custom()` 的内容（遮罩 / Esc / 点外面 = 取消，
 * 由 ModalDialog 负责）。按契约 emit submit({ action, remember }) / cancel。
 *
 * 只在关**最后一扇**窗口、且用户没选过「不再询问」时出现（Rust 的 CloseRequested 判定，
 * 见 commands/app.rs 的 decide_close）。主按钮是「最小化到托盘」：不打断正在跑的活。
 */
import { ref } from "vue";

const props = defineProps<{
  /** 本窗口正在跑（生成中 / 等权限）的会话数；0 = 不提 */
  running: number;
}>();

const emit = defineEmits<{
  submit: [payload: { action: "tray" | "quit"; remember: boolean }];
  cancel: [];
}>();

const remember = ref(false);

const vFocus = { mounted: (el: HTMLElement) => el.focus() };
</script>

<template>
  <div class="cc">
    <p class="cc-msg">
      最小化到托盘后，Agent 和后台任务会继续运行；退出应用会停止正在进行的工作。
    </p>
    <p v-if="props.running > 0" class="cc-running">
      <span class="cc-dot" aria-hidden="true"></span>{{ props.running }} 个会话正在运行
    </p>
    <label class="cc-remember">
      <input v-model="remember" type="checkbox" />
      <span>不再询问<span class="cc-hint">（可在 设置 → 通用 里改回）</span></span>
    </label>
    <div class="cc-actions">
      <button class="cc-btn cc-btn--cancel" type="button" @click="emit('cancel')">取消</button>
      <button class="cc-btn cc-btn--quit" type="button" @click="emit('submit', { action: 'quit', remember })">
        退出应用
      </button>
      <button
        v-focus
        class="cc-btn cc-btn--primary"
        type="button"
        @click="emit('submit', { action: 'tray', remember })"
      >
        最小化到托盘
      </button>
    </div>
  </div>
</template>

<style scoped>
.cc {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.cc-msg {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--aide-text-secondary);
}
.cc-running {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-size: 12.5px;
  color: var(--aide-text-primary);
}
.cc-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--aide-success);
}
.cc-remember {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--aide-text-secondary);
  cursor: pointer;
  user-select: none;
}
.cc-remember input {
  accent-color: var(--aide-accent);
  margin: 0;
}
.cc-hint {
  margin-left: 4px;
  color: var(--aide-text-muted);
}
.cc-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 9px;
  margin-top: 4px;
}
.cc-btn {
  padding: 7px 15px;
  border-radius: var(--aide-radius-md);
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: all var(--aide-ease-t);
}
.cc-btn:focus-visible {
  outline: none;
  box-shadow: var(--aide-accent-ring);
}
.cc-btn--cancel {
  background: transparent;
  border: 1px solid transparent;
  color: var(--aide-text-secondary);
}
.cc-btn--cancel:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}
.cc-btn--quit {
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--aide-danger) 35%, transparent);
  color: var(--aide-danger);
}
.cc-btn--quit:hover {
  background: color-mix(in srgb, var(--aide-danger) 12%, transparent);
}
.cc-btn--primary {
  background: var(--aide-accent-gradient);
  border: 1px solid var(--aide-border-strong);
  color: var(--aide-text-on-accent);
  font-weight: 600;
  box-shadow: var(--aide-accent-glow), var(--aide-highlight-inset);
}
.cc-btn--primary:hover {
  filter: brightness(1.07);
}
</style>
