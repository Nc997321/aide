<script setup lang="ts">
/**
 * ChatSendButton —— 发送按钮（2026-10-17 改：方形回车图标 + 悬停弹出功能列表）。
 *
 * 点击按钮 = 正常发消息（emit send）。鼠标停上去 → 向上弹出列表：第一项是「发送 / 排队 ↵」
 * （说明按钮本身做什么、快捷键是什么），其下是命令注册表（useQuickActions）的全部条目——
 * 列表只是注册表的 UI 投影：kind=btw 的条目带勾选态/置灰语义，kind=prompt 的是普通菜单项。
 * 输入为空时按钮置灰，但悬停列表照常可用（压缩/清空可在空输入时触发），所以禁用不用原生
 * disabled（禁用元素上的鼠标事件不可靠），用 aria-disabled + 点击守卫。
 *
 * 悬停开合：进按钮短延迟后打开，离开按钮/列表留一点宽限期再关，鼠标能从按钮挪进列表。
 * 弹层定位复用 ThemedSelect.vue 已验证的方案：Teleport to body + position fixed，
 * 贴窗口底部时向上展开、右缘对齐按钮。全配色走 var(--aide-*)，不硬编码 hex。
 */
import { ref, computed, nextTick, onUnmounted, watch } from "vue";
import type { QuickAction } from "@/composables/useQuickActions";
import Icon from "./Icon.vue";

const props = withDefaults(
  defineProps<{
    /** 「发送」是否禁用（输入空且无图片时）。悬停列表里的命令不受此约束。 */
    disabled?: boolean;
    /** busy=true 时「发送」显示为「排队」——忙碌时发送一律走排队
     *  （sidecar 在安全边界 interrupt 当前轮后续发）。 */
    busy?: boolean;
    /** 列表的命令条目数据源（命令注册表）。 */
    actions?: QuickAction[];
    /** btw 模式是否激活（kind=btw 条目的勾选态）。 */
    btwActive?: boolean;
    /** btw 不可用（无存活主会话可 fork）：kind=btw 条目置灰 + tooltip 说明原因。 */
    btwDisabled?: boolean;
    /** btw 置灰时 hover 显示的原因。 */
    btwDisabledReason?: string;
  }>(),
  { disabled: false, busy: false, actions: () => [], btwActive: false, btwDisabled: false, btwDisabledReason: "" },
);

const emit = defineEmits<{
  (e: "send"): void;
  (e: "select", action: QuickAction): void;
}>();

/** 进按钮多久后打开（避免鼠标路过就弹） */
const OPEN_DELAY_MS = 120;
/** 离开后多久关（留给鼠标从按钮挪进列表） */
const CLOSE_DELAY_MS = 180;

const open = ref(false);
const positioned = ref(false); // 定位算完前先隐藏，避免在 (0,0) 闪一帧
const triggerRef = ref<HTMLElement>();
const menuRef = ref<HTMLElement>();
const menuStyle = ref<Record<string, string>>({});
const sendLabel = computed(() => (props.busy ? "排队" : "发送"));

let openTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimers() {
  if (openTimer) clearTimeout(openTimer);
  if (closeTimer) clearTimeout(closeTimer);
  openTimer = closeTimer = null;
}

function onEnter() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  if (open.value || openTimer) return;
  openTimer = setTimeout(() => {
    openTimer = null;
    open.value = true;
  }, OPEN_DELAY_MS);
}

function onLeave() {
  if (openTimer) {
    clearTimeout(openTimer);
    openTimer = null;
  }
  if (!open.value || closeTimer) return;
  closeTimer = setTimeout(() => {
    closeTimer = null;
    open.value = false;
  }, CLOSE_DELAY_MS);
}

async function positionMenu() {
  const trigger = triggerRef.value;
  if (!trigger) return;
  await nextTick();
  const menu = menuRef.value;
  const rect = trigger.getBoundingClientRect();
  const margin = 8;
  const menuHeight = menu?.offsetHeight ?? 0;
  const menuWidth = menu?.offsetWidth ?? rect.width;
  const spaceBelow = window.innerHeight - rect.bottom;
  // 默认向上弹（按钮贴着窗口底部是常态）；上方放不下且下方更宽裕才向下
  const openDown = rect.top < menuHeight + margin && spaceBelow > rect.top;
  const top = openDown ? rect.bottom + 6 : Math.max(margin, rect.top - menuHeight - 6);
  // 右缘对齐按钮右缘，左侧不出窗
  const left = Math.min(window.innerWidth - menuWidth - margin, rect.right - menuWidth);

  menuStyle.value = { top: `${top}px`, left: `${Math.max(margin, left)}px` };
  positioned.value = true;
}

function send() {
  if (props.disabled) return;
  clearTimers();
  open.value = false;
  emit("send");
}

function choose(action: QuickAction) {
  // btw 置灰时静默：原因由 tooltip 给出，不切换、不关列表（让用户继续看提示）。
  if (action.kind === "btw" && props.btwDisabled) return;
  emit("select", action);
  clearTimers();
  open.value = false;
}

function onKeydown(e: KeyboardEvent) {
  // 消费标记（preventDefault）：PermissionDialog 的 window 级 Esc 见 defaultPrevented
  // 让路——列表开着时按 Esc 只关列表，不同时触发权限弹窗的负面动作。
  if (e.key === "Escape" && open.value) {
    e.preventDefault();
    clearTimers();
    open.value = false;
  }
}

watch(open, async (v) => {
  if (v) {
    positioned.value = false;
    await positionMenu();
    document.addEventListener("keydown", onKeydown);
    window.addEventListener("resize", positionMenu);
  } else {
    document.removeEventListener("keydown", onKeydown);
    window.removeEventListener("resize", positionMenu);
  }
});

onUnmounted(() => {
  clearTimers();
  document.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", positionMenu);
});
</script>

<template>
  <div ref="triggerRef" class="chat-send" @mouseenter="onEnter" @mouseleave="onLeave">
    <button
      type="button"
      class="chat-send-btn"
      :class="{ 'is-disabled': disabled, 'is-busy': busy, active: open }"
      :aria-disabled="disabled"
      :aria-label="sendLabel"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="send"
    >
      <Icon name="enter" :size="15" :stroke-width="1.5" />
    </button>

    <Teleport to="body">
      <Transition name="chat-send-pop">
        <div
          v-if="open"
          ref="menuRef"
          class="chat-send-menu"
          :style="[menuStyle, positioned ? {} : { visibility: 'hidden' }]"
          role="menu"
          @mouseenter="onEnter"
          @mouseleave="onLeave"
        >
          <button
            type="button"
            class="chat-send-menu-item is-primary"
            :class="{ 'is-disabled': disabled }"
            role="menuitem"
            :aria-disabled="disabled"
            @click="send"
          >
            <span class="chat-send-menu-label">{{ sendLabel }}</span>
            <span class="chat-send-kbd"><Icon name="enter" :size="11" :stroke-width="1.5" /></span>
          </button>
          <div v-if="actions.length" class="chat-send-menu-sep"></div>
          <button
            v-for="a in actions"
            :key="a.id"
            type="button"
            class="chat-send-menu-item"
            :class="a.kind === 'btw' ? { 'is-on': props.btwActive, 'is-disabled': props.btwDisabled } : {}"
            :role="a.kind === 'btw' ? 'menuitemcheckbox' : 'menuitem'"
            :aria-checked="a.kind === 'btw' ? props.btwActive : undefined"
            :aria-disabled="a.kind === 'btw' ? props.btwDisabled : undefined"
            v-tooltip="a.kind === 'btw' && props.btwDisabled ? props.btwDisabledReason : undefined"
            @click="choose(a)"
          >
            <span v-if="a.icon" class="chat-send-menu-icon">{{ a.icon }}</span>
            <span class="chat-send-menu-label">{{ a.label }}</span>
            <span v-if="a.kind === 'btw' && props.btwActive" class="chat-send-menu-check">✓</span>
            <span v-else class="chat-send-kbd is-text">/{{ a.command }}</span>
          </button>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.chat-send {
  display: inline-flex;
}

/* 方形回车键：可发送时铜色实底，空输入时退成浅底灰字 */
.chat-send-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: none;
  border-radius: var(--aide-radius-md);
  background: var(--aide-accent-gradient);
  color: var(--aide-text-on-accent);
  box-shadow: var(--aide-accent-glow), var(--aide-highlight-inset);
  cursor: pointer;
  transition: filter var(--aide-ease-t), background var(--aide-ease-t), color var(--aide-ease-t);
}

.chat-send-btn:hover:not(.is-disabled) {
  filter: brightness(1.07);
}

.chat-send-btn.is-disabled {
  background: var(--aide-surface-hover);
  color: var(--aide-text-muted);
  box-shadow: none;
  cursor: default;
}

.chat-send-btn.is-disabled.active,
.chat-send-btn.is-disabled:hover {
  color: var(--aide-text-secondary);
}

.chat-send-btn:focus-visible {
  outline: 2px solid var(--aide-accent);
  outline-offset: 2px;
}

/* ── 弹层（Teleport 到 body）：GALLERY .menu ── */
.chat-send-menu {
  position: fixed;
  z-index: 9999;
  min-width: 180px;
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
  padding: 6px 8px 6px 10px;
  border-radius: var(--aide-radius-sm);
  background: transparent;
  border: none;
  color: var(--aide-text-secondary);
  font-family: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  transition: all var(--aide-ease-t);
}

.chat-send-menu-item:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}

.chat-send-menu-item.is-primary {
  color: var(--aide-text-primary);
  font-weight: 600;
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

/* 右侧快捷键 / 命令名小键帽 */
.chat-send-kbd {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 5px;
  min-height: 18px;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  color: var(--aide-text-muted);
  font-size: 11px;
  font-weight: 400;
}

.chat-send-kbd.is-text {
  border-color: transparent;
  padding-right: 0;
  font-family: var(--aide-font-mono);
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
  transform: translateY(3px);
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
