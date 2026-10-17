<script setup lang="ts">
/**
 * 输入框里的锚定弹层（`＋` 菜单 / 模型·档位）：Teleport 到 body、fixed 定位，
 * 默认向上弹（输入框在窗口底部），上方放不下再向下。点外部 / Esc 关闭。
 *
 * 定位与收起规则与 ThemedSelect 同一套（Esc 打 preventDefault：PermissionDialog 的
 * window 级 Esc 见 defaultPrevented 让路，弹层开着时按 Esc 只关弹层）。
 */
import { nextTick, onUnmounted, ref, watch } from "vue";

const props = defineProps<{
  open: boolean;
  anchor: HTMLElement | null;
  /** 弹层最小宽度（px）；缺省跟锚点同宽 */
  minWidth?: number;
}>();

const emit = defineEmits<{ close: [] }>();

const menuRef = ref<HTMLElement | null>(null);
const style = ref<Record<string, string>>({});
const positioned = ref(false);

async function position() {
  const anchor = props.anchor;
  if (!anchor) return;
  await nextTick();
  const rect = anchor.getBoundingClientRect();
  const menu = menuRef.value;
  const margin = 8;
  const h = menu?.offsetHeight ?? 0;
  const w = menu?.offsetWidth ?? Math.max(rect.width, props.minWidth ?? 0);
  const spaceAbove = rect.top;
  const up = spaceAbove >= h + margin || spaceAbove > window.innerHeight - rect.bottom;
  const top = up ? Math.max(margin, rect.top - h - 6) : rect.bottom + 6;
  let left = rect.left;
  if (left + w > window.innerWidth - margin) left = window.innerWidth - w - margin;
  style.value = {
    top: `${top}px`,
    left: `${Math.max(margin, left)}px`,
    minWidth: `${Math.max(rect.width, props.minWidth ?? 0)}px`,
  };
  positioned.value = true;
}

function onDocPointer(e: PointerEvent) {
  const t = e.target as Node;
  if (props.anchor?.contains(t) || menuRef.value?.contains(t)) return;
  emit("close");
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    emit("close");
  }
}

function detach() {
  document.removeEventListener("pointerdown", onDocPointer, true);
  document.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", position);
}

watch(
  () => props.open,
  async (v) => {
    if (v) {
      positioned.value = false;
      await position();
      document.addEventListener("pointerdown", onDocPointer, true);
      document.addEventListener("keydown", onKeydown);
      window.addEventListener("resize", position);
    } else {
      detach();
    }
  },
);

onUnmounted(detach);
</script>

<template>
  <Teleport to="body">
    <Transition name="cpop">
      <div
        v-if="open"
        ref="menuRef"
        class="cpop"
        :style="[style, positioned ? {} : { visibility: 'hidden' }]"
      >
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.cpop {
  position: fixed;
  z-index: 9999;
  max-width: 320px;
  max-height: 420px;
  overflow-y: auto;
  padding: 5px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg);
  box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  font-family: var(--aide-font-mono);
}

.cpop-enter-active,
.cpop-leave-active {
  transition: opacity var(--aide-ease-t), transform var(--aide-ease-t);
}
.cpop-enter-from,
.cpop-leave-to {
  opacity: 0;
  transform: scale(0.97);
}
</style>
