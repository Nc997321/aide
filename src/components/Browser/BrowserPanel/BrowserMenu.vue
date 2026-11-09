<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { vOverlayLayer } from "../../../directives/overlayLayer";
import Icon from "../../Icon.vue";

export type BrowserMenuAction = "new-tab" | "bookmarks" | "history" | "import";
const props = defineProps<{ anchor: { right: number; top: number } }>();
const emit = defineEmits<{ select: [action: BrowserMenuAction]; close: [] }>();
const menu = ref<HTMLElement | null>(null);
const items: { action: BrowserMenuAction; label: string; icon: string }[] = [
  { action: "new-tab", label: "新标签页", icon: "plus" },
  { action: "bookmarks", label: "收藏夹", icon: "star" },
  { action: "history", label: "历史记录", icon: "history" },
  { action: "import", label: "导入收藏…", icon: "arrow-down" },
];
const position = {
  right: `${Math.max(8, window.innerWidth - props.anchor.right)}px`,
  top: `${Math.max(8, Math.min(props.anchor.top, window.innerHeight - 220))}px`,
};

function onKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented) return;
  if (event.key === "Escape" || event.key === "Tab") {
    if (event.key === "Escape") event.preventDefault();
    emit("close");
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const controls = [...(menu.value?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
  const index = controls.findIndex((button) => button === document.activeElement);
  const direction = event.key === "ArrowUp" ? -1 : 1;
  const next = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1 : (index + direction + controls.length) % controls.length;
  controls[next]?.focus();
}
function close(): void { emit("close"); }
onMounted(() => {
  window.addEventListener("keydown", onKeydown, true);
  window.addEventListener("resize", close);
  void nextTick(() => menu.value?.querySelector("button")?.focus());
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown, true);
  window.removeEventListener("resize", close);
});
</script>

<template>
  <Teleport to="body">
    <div class="browser-menu-overlay" v-overlay-layer @click.self="emit('close')">
      <div ref="menu" class="browser-menu" role="menu" aria-label="浏览器操作" :style="position">
        <button v-for="item in items" :key="item.action" type="button" role="menuitem" :data-action="item.action" @click="emit('select', item.action)">
          <Icon :name="item.icon" :size="15" /><span>{{ item.label }}</span>
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.browser-menu-overlay { position: fixed; inset: 0; z-index: 9000; }
.browser-menu { position: fixed; width: min(240px, calc(100vw - 16px)); padding: var(--aide-space-unit); background: var(--aide-bg-raised); border: 1px solid var(--aide-border-strong); border-radius: var(--aide-radius-lg); box-shadow: var(--aide-shadow-lg); backdrop-filter: var(--aide-surface-blur); }
.browser-menu button { display: flex; align-items: center; gap: calc(var(--aide-space-unit) * 3); width: 100%; padding: calc(var(--aide-space-unit) * 2) calc(var(--aide-space-unit) * 3); border: 0; border-radius: var(--aide-radius-sm); background: transparent; color: var(--aide-text-secondary); font-size: 13px; text-align: left; cursor: pointer; }
.browser-menu button:hover, .browser-menu button:focus-visible { background: var(--aide-surface-hover); color: var(--aide-text-primary); }
.browser-menu button:focus-visible { outline: 2px solid var(--aide-text-secondary); outline-offset: -2px; }
.browser-menu button:first-child { margin-bottom: var(--aide-space-unit); border-bottom: 1px solid var(--aide-border); }
</style>
