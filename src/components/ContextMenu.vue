<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from "vue";
import { useContextMenu, type MenuItem } from "../composables/useContextMenu";
import { vOverlayLayer } from "../directives/overlayLayer";

const { visible, x, y, items, hide } = useContextMenu();

const menuRef = ref<HTMLElement>();
const screenX = ref(0);
const screenY = ref(0);

function onItemClick(item: MenuItem) {
  if (item.separator || item.disabled) return;
  hide();
  item.action?.();
}

function updatePosition() {
  if (!menuRef.value) return;

  const menu = menuRef.value;
  const rect = menu.getBoundingClientRect();
  const margin = 8;

  let posX = x.value;
  let posY = y.value;

  if (posX + rect.width > window.innerWidth - margin) {
    posX = window.innerWidth - rect.width - margin;
  }
  if (posY + rect.height > window.innerHeight - margin) {
    posY = window.innerHeight - rect.height - margin;
  }

  screenX.value = Math.max(margin, posX);
  screenY.value = Math.max(margin, posY);
}

// Recalculate position when menu becomes visible
import { watch } from "vue";
watch(visible, async (v) => {
  if (v) {
    await nextTick();
    updatePosition();
  }
});

// Close on outside click
function onDocClick(e: MouseEvent) {
  if (!visible.value) return;
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    hide();
  }
}

function onKeydown(e: KeyboardEvent) {
  // 消费标记（preventDefault）：PermissionDialog 的 window 级 Esc 见 defaultPrevented
  // 让路——菜单开着时按 Esc 只关菜单，不同时触发权限弹窗的负面动作。
  if (e.key === "Escape" && visible.value) {
    e.preventDefault();
    hide();
  }
}

onMounted(() => {
  document.addEventListener("click", onDocClick, true);
  document.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
  document.removeEventListener("click", onDocClick, true);
  document.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="ctx-menu">
      <div
        v-if="visible"
        ref="menuRef"
        class="context-menu"
        v-overlay-layer
        :style="{ left: screenX + 'px', top: screenY + 'px' }"
      >
        <template v-for="(item, i) in items" :key="i">
          <div v-if="item.separator" class="ctx-separator" />
          <div
            v-else
            class="ctx-item"
            :class="{ disabled: item.disabled, danger: item.danger, warning: item.warning }"
            @click="onItemClick(item)"
          >
            <span v-if="item.icon" class="ctx-icon">{{ item.icon }}</span>
            <span class="ctx-label">{{ item.label }}</span>
            <span v-if="item.kbd" class="ctx-kbd">{{ item.kbd }}</span>
          </div>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.context-menu {
  position: fixed;
  z-index: 9999;
  min-width: 168px;
  max-width: 260px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg);
  padding: 5px;
  box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  overflow: hidden;
  backdrop-filter: var(--aide-surface-blur);
}

.ctx-item {
  display: flex;
  align-items: center;
  padding: 6px 10px;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  font-size: 13px;
  color: var(--aide-text-secondary);
  transition: background 0.12s ease-out, color 0.12s ease-out;
}

.ctx-item:hover:not(.disabled) {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

.ctx-item.danger {
  color: var(--aide-danger);
}

.ctx-item.danger:hover:not(.disabled) {
  background: color-mix(in srgb, var(--aide-danger) 12%, transparent);
}

/* 警示项（黄）：与行内碎盾/警告三角图标同一个 --aide-warning，用于状态纠正入口 */
.ctx-item.warning {
  color: var(--aide-warning);
}

.ctx-item.warning:hover:not(.disabled) {
  background: color-mix(in srgb, var(--aide-warning) 12%, transparent);
}

.ctx-item.disabled {
  color: var(--aide-text-muted);
  cursor: default;
  opacity: 0.5;
}

.ctx-icon {
  width: 15px;
  text-align: center;
  opacity: 0.75;
  font-size: 12px;
  flex-shrink: 0;
}

.ctx-kbd {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--aide-text-muted);
  font-family: var(--aide-font-mono);
  flex-shrink: 0;
}

.ctx-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.ctx-separator {
  height: 1px;
  margin: 5px 8px;
  background: var(--aide-border-subtle);
}

/* Transition */
.ctx-menu-enter-active {
  transition: opacity var(--aide-ease-t), transform var(--aide-ease-t);
}
.ctx-menu-leave-active {
  transition: opacity var(--aide-ease-t), transform var(--aide-ease-t);
}
.ctx-menu-enter-from,
.ctx-menu-leave-to {
  opacity: 0;
  transform: scale(0.95);
}
</style>
