<script setup lang="ts">
/**
 * ChatSendButton —— 分裂式发送按钮。
 *
 * 主体「发送 ↑」点击 = 正常发消息（emit send）；右侧小箭头 ▾ 点击 = 向上弹出
 * 菜单，列出工具栏快捷操作（压缩/清空上下文等，数据来自 useQuickActions）。
 * 两个区域互不干扰：发送不会被菜单抢走，菜单也不需要输入框有内容（压缩/清空
 * 可在空输入时触发）。
 *
 * 弹层定位复用 ThemedSelect.vue 已验证的方案：Teleport to body + position fixed，
 * 工具栏贴窗口底部时自动向上展开。全配色走 var(--aide-*)，不硬编码 hex。
 */
import { ref, nextTick, onUnmounted, watch } from "vue";
import type { QuickAction } from "@/composables/useQuickActions";

const props = withDefaults(
  defineProps<{
    /** 主体「发送」是否禁用（输入空且无图片时）。▾ 菜单不受此约束。 */
    disabled?: boolean;
    /** busy=true 时主体标签显示「排队」而非「发送」。 */
    busy?: boolean;
    /** 菜单项数据源；为空时不渲染 ▾。 */
    actions?: QuickAction[];
  }>(),
  { disabled: false, busy: false, actions: () => [] },
);

const emit = defineEmits<{
  (e: "send"): void;
  (e: "select", action: QuickAction): void;
}>();

const open = ref(false);
const positioned = ref(false); // 定位算完前先隐藏，避免在 (0,0) 闪一帧
const triggerRef = ref<HTMLElement>();
const menuRef = ref<HTMLElement>();
const menuStyle = ref<Record<string, string>>({});

async function positionMenu() {
  const trigger = triggerRef.value;
  if (!trigger) return;
  await nextTick();
  const menu = menuRef.value;
  const rect = trigger.getBoundingClientRect();
  const margin = 8;
  const menuHeight = menu?.offsetHeight ?? 0;
  const spaceBelow = window.innerHeight - rect.bottom;
  // 下方空间不足则向上弹（工具栏贴底时常态）
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

function toggleMenu() {
  open.value = !open.value;
}

function choose(action: QuickAction) {
  emit("select", action);
  open.value = false;
}

function onDocPointer(e: PointerEvent) {
  if (!open.value) return;
  const target = e.target as Node;
  if (triggerRef.value?.contains(target) || menuRef.value?.contains(target)) return;
  open.value = false;
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && open.value) open.value = false;
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
  <div ref="triggerRef" class="chat-send-split" :class="{ active: open }">
    <button
      type="button"
      class="chat-send-main"
      :disabled="disabled"
      @click="emit('send')"
    >
      {{ busy ? "排队" : "发送" }}
      <svg class="chat-send-arrow" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M6 9.5V2.5M6 2.5L2.5 6M6 2.5L9.5 6" fill="none" stroke="currentColor"
          stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <button
      v-if="actions.length"
      type="button"
      class="chat-send-caret"
      :class="{ active: open }"
      v-tooltip="'上下文操作'"
      @click="toggleMenu"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M2 3.5L5 6.5L8 3.5" fill="none" stroke="currentColor" stroke-width="1.4"
          stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <Teleport to="body">
      <Transition name="chat-send-pop">
        <div
          v-if="open"
          ref="menuRef"
          class="chat-send-menu"
          :style="[menuStyle, positioned ? {} : { visibility: 'hidden' }]"
          role="menu"
        >
          <button
            v-for="a in actions"
            :key="a.id"
            type="button"
            class="chat-send-menu-item"
            role="menuitem"
            @click="choose(a)"
          >
            <span v-if="a.icon" class="chat-send-menu-icon">{{ a.icon }}</span>
            <span class="chat-send-menu-label">{{ a.label }}</span>
          </button>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.chat-send-split {
  display: inline-flex;
  align-items: stretch;
}

.chat-send-main {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
  border: 1px solid var(--aide-accent);
  border-radius: var(--aide-radius-sm) 0 0 var(--aide-radius-sm);
  font-size: 13px;
  padding: 0 12px;
  height: 24px;
  cursor: pointer;
  transition: filter 0.12s ease, opacity 0.12s ease;
}

.chat-send-main:hover:not(:disabled) {
  filter: brightness(1.1);
}

.chat-send-main:disabled {
  opacity: 0.5;
  cursor: default;
}

.chat-send-arrow {
  flex-shrink: 0;
}

/* ▾ 触发器：与主体共边，左侧用 border-left 分隔 */
.chat-send-caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
  border: 1px solid var(--aide-accent);
  border-left: 1px solid color-mix(in srgb, var(--aide-text-on-accent) 30%, transparent);
  border-radius: 0 var(--aide-radius-sm) var(--aide-radius-sm) 0;
  padding: 0 8px;
  height: 24px;
  cursor: pointer;
  transition: filter 0.12s ease;
}

.chat-send-caret:hover,
.chat-send-caret.active {
  filter: brightness(1.15);
}

.chat-send-caret.active svg {
  transform: rotate(180deg);
}

.chat-send-caret svg {
  transition: transform 0.15s ease;
}

/* ── 弹层（Teleport 到 body）── */
.chat-send-menu {
  position: fixed;
  z-index: 9999;
  min-width: 160px;
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-surface-default);
  border-radius: 8px;
  padding: 4px;
  box-shadow: var(--aide-shadow-lg);
}

.chat-send-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border-radius: var(--aide-radius-sm);
  background: transparent;
  border: none;
  color: var(--aide-text-secondary);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease-out, color 0.12s ease-out;
}

.chat-send-menu-item:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

.chat-send-menu-icon {
  font-size: 12px;
  opacity: 0.9;
  width: 14px;
  text-align: center;
  flex-shrink: 0;
}

.chat-send-menu-label {
  white-space: nowrap;
}

/* Transition */
.chat-send-pop-enter-active {
  transition: opacity 0.12s, transform 0.12s;
}
.chat-send-pop-leave-active {
  transition: opacity 0.08s, transform 0.08s;
}
.chat-send-pop-enter-from,
.chat-send-pop-leave-to {
  opacity: 0;
  transform: scale(0.97);
}
</style>