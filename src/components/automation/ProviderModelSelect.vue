<script setup lang="ts">
/**
 * ProviderModelSelect —— 「供应商 → 模型」级联选择（一个触发器，一张菜单带二级）。
 *
 * 外观与 ThemedSelect 的整宽表单模式一致；区别只在弹层：一级列供应商，指到/点到
 * 某个供应商在它旁边展开二级模型列表，点模型才落值。供应商没有模型清单时没有二级，
 * 点供应商本身即选中（用它的默认模型）。
 */
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import type { ProviderModelGroup } from "./modelOptions";

const props = defineProps<{
  /** 当前生效的供应商 id（调用方已把「没钉过」折算成激活供应商） */
  providerId: string;
  model: string;
  groups: ProviderModelGroup[];
  /** 触发器文案 */
  label: string;
}>();

const emit = defineEmits<{
  (e: "select", value: { providerId: string; model: string }): void;
}>();

const open = ref(false);
const positioned = ref(false); // 定位算完前先隐藏，避免在 (0,0) 闪一帧
const triggerRef = ref<HTMLElement>();
const menuRef = ref<HTMLElement>();
const subRef = ref<HTMLElement>();
const menuStyle = ref<Record<string, string>>({});
const subStyle = ref<Record<string, string>>({});
const subPositioned = ref(false);

/** 二级展开在哪个供应商上 */
const expandedId = ref<string | null>(null);
const expanded = computed(() => props.groups.find((g) => g.id === expandedId.value) ?? null);

/** 只有「默认模型」一项 = 没有模型清单，不值得开二级 */
function hasSubmenu(g: ProviderModelGroup): boolean {
  return g.models.length > 1;
}

const MARGIN = 8;

async function positionMenu() {
  const trigger = triggerRef.value;
  if (!trigger) return;
  await nextTick();
  const menu = menuRef.value;
  const rect = trigger.getBoundingClientRect();
  const menuHeight = menu?.offsetHeight ?? 0;
  const spaceBelow = window.innerHeight - rect.bottom;

  // 下方空间不足则向上弹
  const openUp = spaceBelow < menuHeight + MARGIN && rect.top > spaceBelow;
  const top = openUp ? Math.max(MARGIN, rect.top - menuHeight - 4) : rect.bottom + 4;

  menuStyle.value = {
    top: `${top}px`,
    left: `${Math.max(MARGIN, rect.left)}px`,
    minWidth: `${Math.min(rect.width, 280)}px`,
  };
  positioned.value = true;
}

async function positionSub(row: HTMLElement) {
  subPositioned.value = false;
  await nextTick();
  const menu = menuRef.value;
  const sub = subRef.value;
  if (!menu || !sub) return;
  const menuRect = menu.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const width = sub.offsetWidth;
  const height = sub.offsetHeight;

  // 右侧放不下就翻到左侧
  let left = menuRect.right + 4;
  if (left + width > window.innerWidth - MARGIN) left = menuRect.left - width - 4;
  // 与所指的那一行对齐（减掉弹层内边距），底部溢出则上移
  let top = rowRect.top - 6;
  if (top + height > window.innerHeight - MARGIN) top = window.innerHeight - MARGIN - height;

  subStyle.value = {
    top: `${Math.max(MARGIN, top)}px`,
    left: `${Math.max(MARGIN, left)}px`,
  };
  subPositioned.value = true;
}

function expand(g: ProviderModelGroup, e: Event) {
  if (!hasSubmenu(g)) {
    expandedId.value = null;
    return;
  }
  const row = e.currentTarget as HTMLElement;
  if (expandedId.value === g.id && subPositioned.value) return;
  expandedId.value = g.id;
  void positionSub(row);
}

function onProviderClick(g: ProviderModelGroup, e: Event) {
  if (hasSubmenu(g)) {
    expand(g, e);
    return;
  }
  choose(g.id, "");
}

function choose(providerId: string, model: string) {
  emit("select", { providerId, model });
  open.value = false;
}

function toggle() {
  open.value = !open.value;
}

function reposition() {
  expandedId.value = null;
  void positionMenu();
}

function onDocPointer(e: PointerEvent) {
  if (!open.value) return;
  const target = e.target as Node;
  if (
    triggerRef.value?.contains(target) ||
    menuRef.value?.contains(target) ||
    subRef.value?.contains(target)
  )
    return;
  open.value = false;
}

function onKeydown(e: KeyboardEvent) {
  // 与 ThemedSelect 同款消费标记：Esc 只关这张菜单，不连带触发窗口级的 Esc 处理
  if (e.key === "Escape" && open.value) {
    e.preventDefault();
    open.value = false;
  }
}

function unbind() {
  document.removeEventListener("pointerdown", onDocPointer, true);
  document.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", reposition);
}

watch(open, async (v) => {
  if (v) {
    positioned.value = false;
    expandedId.value = null;
    await positionMenu();
    document.addEventListener("pointerdown", onDocPointer, true);
    document.addEventListener("keydown", onKeydown);
    window.addEventListener("resize", reposition);
  } else {
    expandedId.value = null;
    unbind();
  }
});

onUnmounted(unbind);
</script>

<template>
  <button
    ref="triggerRef"
    type="button"
    class="pm-select"
    :class="{ active: open }"
    @click="toggle"
  >
    <span class="pm-select-label">{{ label }}</span>
    <svg class="pm-select-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 3.5L5 6.5L8 3.5" fill="none" stroke="currentColor" stroke-width="1.4"
        stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>

  <Teleport to="body">
    <Transition name="pm-pop">
      <div
        v-if="open"
        ref="menuRef"
        class="pm-menu"
        :style="[menuStyle, positioned ? {} : { visibility: 'hidden' }]"
        role="menu"
      >
        <div
          v-for="g in groups"
          :key="g.id"
          class="pm-option"
          :class="{ selected: g.id === providerId, expanded: g.id === expandedId }"
          role="menuitem"
          :aria-haspopup="hasSubmenu(g) ? 'menu' : undefined"
          :aria-expanded="hasSubmenu(g) ? g.id === expandedId : undefined"
          @pointerenter="expand(g, $event)"
          @click="onProviderClick(g, $event)"
        >
          <span class="pm-option-label">{{ g.name }}</span>
          <span v-if="hasSubmenu(g)" class="pm-tri">▸</span>
          <svg v-else-if="g.id === providerId" class="pm-check" width="12" height="12"
            viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2.5 6.5L4.8 8.8L9.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
      </div>
    </Transition>

    <div
      v-if="open && expanded"
      ref="subRef"
      class="pm-menu pm-sub"
      :style="[subStyle, subPositioned ? {} : { visibility: 'hidden' }]"
      role="menu"
    >
      <div
        v-for="m in expanded.models"
        :key="m.value"
        class="pm-option"
        :class="{ selected: expanded.id === providerId && m.value === model }"
        role="menuitemradio"
        :aria-checked="expanded.id === providerId && m.value === model"
        @click="choose(expanded.id, m.value)"
      >
        <span class="pm-option-label">{{ m.label }}</span>
        <svg v-if="expanded.id === providerId && m.value === model" class="pm-check" width="12"
          height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 6.5L4.8 8.8L9.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5"
            stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 触发器：规格照抄 ThemedSelect 的 .block，表单里两者并排要一个样 */
.pm-select {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  background: var(--aide-bg-deep);
  color: var(--aide-text-primary);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  font-size: 13px;
  cursor: pointer;
  box-shadow: var(--aide-shadow-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  transition: all var(--aide-ease-t);
}
.pm-select:hover,
.pm-select.active {
  border-color: var(--aide-border-strong);
}
.pm-select-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pm-select-chevron {
  flex-shrink: 0;
  color: var(--aide-text-muted);
  transition: transform var(--aide-ease-t);
}
.pm-select.active .pm-select-chevron {
  transform: rotate(180deg);
}

/* ── 弹层（Teleport 到 body）── */
.pm-menu {
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
.pm-sub {
  min-width: 180px;
  max-width: 320px;
}
.pm-option {
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
.pm-option:hover,
.pm-option.expanded {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
.pm-option.selected {
  background: var(--aide-accent-subtle);
  color: var(--aide-text-primary);
}
.pm-option-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pm-tri {
  flex-shrink: 0;
  font-size: 14px;
  line-height: 1;
  color: var(--aide-text-muted);
}
.pm-check {
  flex-shrink: 0;
  color: var(--aide-accent);
}

.pm-pop-enter-active,
.pm-pop-leave-active {
  transition: opacity var(--aide-ease-t), transform var(--aide-ease-t);
}
.pm-pop-enter-from,
.pm-pop-leave-to {
  opacity: 0;
  transform: scale(0.97);
}
</style>
