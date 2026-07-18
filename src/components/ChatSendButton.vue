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
    /** btw 模式是否激活。 */
    btwActive?: boolean;
    /** btw 不可用（无存活主会话可 fork）：菜单项置灰 + tooltip 说明原因，点击无反应。 */
    btwDisabled?: boolean;
    /** btw 置灰时 hover 显示的原因。 */
    btwDisabledReason?: string;
  }>(),
  { disabled: false, busy: false, actions: () => [], btwActive: false, btwDisabled: false, btwDisabledReason: "" },
);

const emit = defineEmits<{
  (e: "send"): void;
  (e: "select", action: QuickAction): void;
  (e: "toggle-btw"): void;
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

function onToggleBtw() {
  // 置灰时静默:原因由 tooltip 给出,不切换、不关菜单(让用户继续看提示)。
  if (props.btwDisabled) return;
  emit("toggle-btw");
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
            type="button"
            class="chat-send-menu-item"
            :class="{ 'is-on': props.btwActive, 'is-disabled': props.btwDisabled }"
            role="menuitemcheckbox"
            :aria-checked="props.btwActive"
            :aria-disabled="props.btwDisabled"
            v-tooltip="props.btwDisabled ? props.btwDisabledReason : undefined"
            @click="onToggleBtw"
          >
            <span class="chat-send-menu-icon">↳</span>
            <span class="chat-send-menu-label">顺便问一下</span>
            <span v-if="props.btwActive" class="chat-send-menu-check">✓</span>
          </button>
          <div v-if="actions.length" class="chat-send-menu-sep"></div>
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
/* 发送按钮 · 分裂按钮：GALLERY .send-split */
.chat-send-split {
  display: inline-flex;
  align-items: stretch;
  border-radius: var(--aide-radius-md);
  box-shadow: var(--aide-accent-glow), inset 0 1px 0 rgba(255, 255, 255, .28);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
}

.chat-send-split button {
  border: none;
  background: var(--aide-accent-gradient);
  color: var(--aide-text-on-accent);
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: filter var(--aide-ease-t);
}

.chat-send-split button:hover:not(:disabled) {
  filter: brightness(1.07);
}

.chat-send-main {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 7px 16px;
  border-radius: var(--aide-radius-md) 0 0 var(--aide-radius-md);
}

.chat-send-arrow {
  flex-shrink: 0;
}

.chat-send-caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 7px 10px;
  border-radius: 0 var(--aide-radius-md) var(--aide-radius-md) 0;
  border-left: 1px solid rgba(0, 0, 0, .18);
  font-size: 10px;
}

.chat-send-caret.active svg {
  transform: rotate(180deg);
}

.chat-send-caret svg {
  transition: transform var(--aide-ease-t);
}

.chat-send-main:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ── 弹层（Teleport 到 body）：GALLERY .menu ── */
.chat-send-menu {
  position: fixed;
  z-index: 9999;
  min-width: 160px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg);
  padding: 5px;
  box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
}

.chat-send-menu-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 10px;
  border-radius: var(--aide-radius-sm);
  background: transparent;
  border: none;
  color: var(--aide-text-secondary);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  transition: all var(--aide-ease-t);
}

.chat-send-menu-item:hover {
  background: var(--aide-surface-hover);
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

.chat-send-menu-item.is-on {
  background: var(--aide-accent-subtle);
  color: var(--aide-accent);
}
.chat-send-menu-item.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.chat-send-menu-item.is-disabled:hover {
  background: transparent;
  color: var(--aide-text-secondary);
}
.chat-send-menu-check {
  margin-left: auto;
  font-size: 12px;
}
.chat-send-menu-sep {
  height: 1px;
  background: var(--aide-border-subtle);
  margin: 5px 8px;
}
</style>