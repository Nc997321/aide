<script setup lang="ts">
/**
 * ThemedSelect —— 主题化下拉框（替代原生 <select>）
 *
 * 原生 <select> 的弹出选项列表与箭头由操作系统渲染，CSS 无法主题化。
 * 本组件用自绘触发器 + Teleport 弹层实现完全可控的外观，弹层位置
 * 根据可视区自动向上/向下展开（工具栏在窗口底部时向上弹）。
 *
 * 复用于：ChatPanel 底部 model / 权限模式、SettingsPanel 主题、
 *         ProviderSettings effort 等所有下拉场景。
 */
import { ref, computed, nextTick, onUnmounted, watch } from "vue";

interface Option {
  value: string;
  label: string;
}

const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: Option[];
    title?: string;
    disabled?: boolean;
    placeholder?: string;
    /** 整宽表单模式：撑满容器、对齐表单输入框（用于设置面板） */
    block?: boolean;
  }>(),
  { title: "", disabled: false, placeholder: "", block: false },
);

const emit = defineEmits<{ (e: "update:modelValue", value: string): void }>();

const open = ref(false);
const positioned = ref(false); // 定位算完前先隐藏，避免在 (0,0) 闪一帧
const triggerRef = ref<HTMLElement>();
const menuRef = ref<HTMLElement>();

// 弹层定位（fixed 坐标 + 触发器宽度）
const menuStyle = ref<Record<string, string>>({});

const selectedLabel = computed(
  () => props.options.find((o) => o.value === props.modelValue)?.label ?? props.placeholder,
);

async function positionMenu() {
  const trigger = triggerRef.value;
  if (!trigger) return;
  await nextTick();
  const menu = menuRef.value;
  const rect = trigger.getBoundingClientRect();
  const margin = 8;
  const menuHeight = menu?.offsetHeight ?? 0;
  const spaceBelow = window.innerHeight - rect.bottom;

  // 下方空间不足则向上弹
  const openUp = spaceBelow < menuHeight + margin && rect.top > spaceBelow;
  const top = openUp
    ? Math.max(margin, rect.top - menuHeight - 4)
    : rect.bottom + 4;

  let left = rect.left;
  const menuWidth = menu?.offsetWidth ?? rect.width;
  if (left + menuWidth > window.innerWidth - margin) {
    left = window.innerWidth - menuWidth - margin;
  }

  menuStyle.value = {
    top: `${top}px`,
    left: `${Math.max(margin, left)}px`,
    minWidth: `${rect.width}px`,
  };
  positioned.value = true;
}

function toggle() {
  if (props.disabled) return;
  open.value = !open.value;
}

function choose(value: string) {
  emit("update:modelValue", value);
  open.value = false;
}

function onDocPointer(e: PointerEvent) {
  if (!open.value) return;
  const target = e.target as Node;
  if (triggerRef.value?.contains(target) || menuRef.value?.contains(target)) return;
  open.value = false;
}

function onKeydown(e: KeyboardEvent) {
  // 消费标记（preventDefault）：PermissionDialog 的 window 级 Esc 见 defaultPrevented
  // 让路——下拉开着时按 Esc 只关下拉，不同时触发权限弹窗的负面动作。
  if (e.key === "Escape" && open.value) {
    e.preventDefault();
    open.value = false;
  }
}

watch(open, async (v) => {
  if (v) {
    positioned.value = false;
    await positionMenu();
    document.addEventListener("pointerdown", onDocPointer, true);
    document.addEventListener("keydown", onKeydown);
    window.addEventListener("resize", positionMenu);
  } else {
    document.removeEventListener("pointerdown", onDocPointer, true);
    document.removeEventListener("keydown", onKeydown);
    window.removeEventListener("resize", positionMenu);
  }
});

onUnmounted(() => {
  document.removeEventListener("pointerdown", onDocPointer, true);
  document.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", positionMenu);
});
</script>

<template>
  <button
    ref="triggerRef"
    type="button"
    class="themed-select"
    :class="{ disabled, active: open, block }"
    v-tooltip="title"
    :disabled="disabled"
    @click="toggle"
  >
    <span class="themed-select-label">{{ selectedLabel }}</span>
    <svg class="themed-select-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 3.5L5 6.5L8 3.5" fill="none" stroke="currentColor" stroke-width="1.4"
        stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>

  <Teleport to="body">
    <Transition name="themed-select-pop">
      <div
        v-if="open"
        ref="menuRef"
        class="themed-select-menu"
        :style="[menuStyle, positioned ? {} : { visibility: 'hidden' }]"
        role="listbox"
      >
        <div
          v-for="opt in options"
          :key="opt.value"
          class="themed-select-option"
          :class="{ selected: opt.value === modelValue }"
          role="option"
          :aria-selected="opt.value === modelValue"
          @click="choose(opt.value)"
        >
          <span class="themed-select-option-label">{{ opt.label }}</span>
          <svg v-if="opt.value === modelValue" class="themed-select-check" width="12" height="12"
            viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2.5 6.5L4.8 8.8L9.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.themed-select {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  font-size: 12.5px;
  cursor: pointer;
  box-shadow: var(--aide-highlight-inset), var(--aide-shadow-sm);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  transition: all var(--aide-ease-t);
}

.themed-select:hover:not(.disabled),
.themed-select.active {
  background: var(--aide-surface-hover);
  border-color: var(--aide-border-strong);
}

.themed-select.disabled {
  opacity: 0.45;
  cursor: default;
}

/* 整宽表单模式：撑满并对齐设置面板里的文本输入框 */
.themed-select.block {
  display: flex;
  width: 100%;
  justify-content: space-between;
  padding: 8px 12px;
  font-size: 13px;
  background: var(--aide-bg-deep);
  border-color: var(--aide-border);
  color: var(--aide-text-primary);
  box-shadow: var(--aide-shadow-inset);
}

.themed-select.block:hover:not(.disabled),
.themed-select.block.active {
  border-color: var(--aide-border-strong);
}

.themed-select-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.themed-select-chevron {
  flex-shrink: 0;
  color: var(--aide-text-muted);
  font-size: 10px;
  transition: transform var(--aide-ease-t);
}

.themed-select.active .themed-select-chevron {
  transform: rotate(180deg);
}

/* ── 弹层（Teleport 到 body）── */
.themed-select-menu {
  position: fixed;
  z-index: 9999;
  max-width: 280px;
  max-height: 320px;
  overflow-y: auto;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg);
  padding: 5px;
  box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
}

.themed-select-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 0 1px;
  padding: 7px 10px;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  font-size: 12.5px;
  color: var(--aide-text-secondary);
  transition: all var(--aide-ease-t);
}

.themed-select-option:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}

.themed-select-option.selected {
  background: var(--aide-accent-subtle);
  color: var(--aide-text-primary);
}

.themed-select-option-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.themed-select-check {
  flex-shrink: 0;
  color: var(--aide-accent);
}

/* Transition */
.themed-select-pop-enter-active {
  transition: opacity var(--aide-ease-t), transform var(--aide-ease-t);
}
.themed-select-pop-leave-active {
  transition: opacity var(--aide-ease-t), transform var(--aide-ease-t);
}
.themed-select-pop-enter-from,
.themed-select-pop-leave-to {
  opacity: 0;
  transform: scale(0.97);
}
</style>
