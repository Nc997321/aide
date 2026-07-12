<script setup lang="ts">
import { onMounted, onUnmounted, watch } from "vue";
import IconOrChar from "../components/IconOrChar.vue";

export interface DropdownItem {
  id: string;
  label: string;
  icon?: string;
  divider?: boolean;
}

const props = defineProps<{
  open: boolean;
  items: DropdownItem[];
}>();

const emit = defineEmits<{
  select: [id: string];
  close: [];
}>();

function onClickOutside(e: MouseEvent) {
  if (props.open) {
    emit("close");
  }
}

watch(
  () => props.open,
  (v) => {
    if (v) {
      setTimeout(() => document.addEventListener("click", onClickOutside), 0);
    } else {
      document.removeEventListener("click", onClickOutside);
    }
  },
);

onUnmounted(() => {
  document.removeEventListener("click", onClickOutside);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="a-dropdown">
      <div v-if="open" class="a-dropdown" @click.stop>
        <template v-for="item in items" :key="item.id">
          <div v-if="item.divider" class="a-dropdown__divider" />
          <div
            v-else
            class="a-dropdown__item"
            @click="emit('select', item.id)"
          >
            <span v-if="item.icon" class="a-dropdown__icon"><IconOrChar :text="item.icon" :size="13" /></span>
            <span class="a-dropdown__label">{{ item.label }}</span>
          </div>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>

<style>
.a-dropdown {
  position: absolute;
  z-index: 9000;
  min-width: 160px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  box-shadow: var(--aide-shadow-md);
  padding: 4px;
  overflow: hidden;
}

.a-dropdown__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  font-size: 12px;
  color: var(--aide-text-secondary);
  transition: all 0.1s;
}

.a-dropdown__item:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

.a-dropdown__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  width: 18px;
  flex-shrink: 0;
}

.a-dropdown__divider {
  height: 1px;
  background: var(--aide-border);
  margin: 4px 0;
}

.a-dropdown-enter-active {
  transition: opacity 0.12s ease-out, transform 0.12s ease-out;
}
.a-dropdown-leave-active {
  transition: opacity 0.08s ease, transform 0.08s ease;
}
.a-dropdown-enter-from {
  opacity: 0;
  transform: scale(0.96);
}
.a-dropdown-leave-to {
  opacity: 0;
  transform: scale(0.96);
}
</style>
