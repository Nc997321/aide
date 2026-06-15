<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from "vue";
import { useContextMenu, type MenuItem } from "../composables/useContextMenu";

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
  if (e.key === "Escape" && visible.value) {
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
        :style="{ left: screenX + 'px', top: screenY + 'px' }"
      >
        <template v-for="(item, i) in items" :key="i">
          <div v-if="item.separator" class="ctx-separator" />
          <div
            v-else
            class="ctx-item"
            :class="{ disabled: item.disabled, danger: item.danger }"
            @click="onItemClick(item)"
          >
            <span class="ctx-label">{{ item.label }}</span>
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
  max-width: 220px;
  background: var(--bg-secondary);
  border: 1px solid var(--surface);
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  overflow: hidden;
}

.ctx-item {
  display: flex;
  align-items: center;
  padding: 6px 10px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 12.5px;
  color: var(--text-secondary);
  transition: background 0.08s, color 0.08s;
}

.ctx-item:hover:not(.disabled) {
  background: var(--surface);
  color: var(--text-primary);
}

.ctx-item.danger {
  color: var(--accent-red);
}

.ctx-item.danger:hover:not(.disabled) {
  background: rgba(243, 139, 168, 0.12);
}

.ctx-item.disabled {
  color: var(--text-muted);
  cursor: default;
  opacity: 0.5;
}

.ctx-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ctx-separator {
  height: 1px;
  margin: 4px 8px;
  background: var(--surface);
}

/* Transition */
.ctx-menu-enter-active {
  transition: opacity 0.12s, transform 0.12s;
}
.ctx-menu-leave-active {
  transition: opacity 0.08s, transform 0.08s;
}
.ctx-menu-enter-from,
.ctx-menu-leave-to {
  opacity: 0;
  transform: scale(0.95);
}
</style>
