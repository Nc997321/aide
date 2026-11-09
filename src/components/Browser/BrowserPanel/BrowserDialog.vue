<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId } from "vue";
import { vOverlayLayer } from "../../../directives/overlayLayer";
import Icon from "../../Icon.vue";

const props = defineProps<{ title: string }>();
const emit = defineEmits<{ close: [] }>();
const titleId = useId();
const content = ref<HTMLElement | null>(null);
const previousFocus = document.activeElement;

function onKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented) return;
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
  } else if (event.key === "Tab") trapFocus(event);
}

function trapFocus(event: KeyboardEvent): void {
  const controls = [...(content.value?.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
  ) ?? [])];
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (!first || !last) return;
  if (event.shiftKey && (document.activeElement === first || !content.value?.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !content.value?.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown, true);
  void nextTick(() => content.value?.querySelector<HTMLElement>("input, textarea, button")?.focus());
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown, true);
  if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
});
</script>

<template>
  <Teleport to="body">
    <div class="browser-dialog-overlay" v-overlay-layer @click.self="emit('close')">
      <section ref="content" class="browser-dialog" role="dialog" aria-modal="true" :aria-labelledby="titleId">
        <header class="browser-dialog__header">
          <h2 :id="titleId">{{ props.title }}</h2>
          <button class="browser-dialog__close" type="button" aria-label="关闭弹窗" @click="emit('close')"><Icon name="close" :size="16" /></button>
        </header>
        <div class="browser-dialog__body"><slot /></div>
      </section>
    </div>
  </Teleport>
</template>

<style>
.browser-dialog-overlay {
  position: fixed; inset: 0; z-index: 9100; display: grid; place-items: center;
  padding: calc(var(--aide-space-unit) * 5); background: var(--aide-bg-overlay);
}
.browser-dialog {
  display: flex; flex-direction: column; width: min(540px, 100%); max-height: 85vh; min-height: 0;
  padding: calc(var(--aide-space-unit) * 5); border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg); background: var(--aide-bg-raised); color: var(--aide-text-primary);
  box-shadow: var(--aide-shadow-lg); backdrop-filter: var(--aide-surface-blur);
}
.browser-dialog__header { display: flex; align-items: center; justify-content: space-between; gap: calc(var(--aide-space-unit) * 3); }
.browser-dialog__header h2 { margin: 0; font-size: 15px; font-weight: 600; }
.browser-dialog__close { display: grid; place-items: center; padding: var(--aide-space-unit); border: 0; border-radius: var(--aide-radius-sm); background: transparent; color: var(--aide-text-secondary); cursor: pointer; }
.browser-dialog__close:hover { background: var(--aide-surface-hover); }
.browser-dialog__body { min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: calc(var(--aide-space-unit) * 4); padding-top: calc(var(--aide-space-unit) * 4); font-size: 13px; }
.browser-dialog__body p { margin: 0; color: var(--aide-text-secondary); line-height: 1.7; }
.browser-dialog button:focus-visible, .browser-dialog textarea:focus-visible { outline: 2px solid var(--aide-text-secondary); outline-offset: 2px; }
.browser-dialog__error { color: var(--aide-danger); overflow-wrap: anywhere; font-size: 12px; }
</style>
