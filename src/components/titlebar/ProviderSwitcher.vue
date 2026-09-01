<script setup lang="ts">
/**
 * 标题栏供应商切换器：「打开目录」右侧，显示当前供应商，点击下拉切换。
 *
 * 自包含——切换直接走 useProviders 模块级单例（setActiveProvider 持久化 +
 * 全 app 响应式同步），不向上抛事件；只有「管理供应商…」需要开设置面板，
 * 经 emit('open-settings-providers') 由 TitleBar 转给 App.vue。
 * （原侧栏 status-bar 版本搬家而来：下拉由向上弹出改为向下，外观对齐标题栏
 * 按钮语言。）
 */
import { ref, onMounted, onUnmounted } from "vue";
import { useProviders } from "../../composables/useProviders";
import ProviderLogo from "../ProviderLogo.vue";
import Icon from "../Icon.vue";

const emit = defineEmits<{
  "open-settings-providers": [];
}>();

const { displayList, activeProviderId, activeProvider, setActiveProvider } = useProviders();

const open = ref(false);
const rootRef = ref<HTMLDivElement | null>(null);

function toggle() {
  open.value = !open.value;
}

async function onSelect(id: string) {
  open.value = false;
  if (id === activeProviderId.value) return;
  await setActiveProvider(id);
}

function openProviderSettings() {
  open.value = false;
  emit("open-settings-providers");
}

function onClickOutside(e: MouseEvent) {
  if (rootRef.value && !rootRef.value.contains(e.target as Node)) {
    open.value = false;
  }
}

/** 只在下拉真开着时才消费 Esc（preventDefault 标记：PermissionDialog 的 window 级
 *  Esc 见 defaultPrevented 让路）；没开着就不是本组件的按键，不拦截。 */
function onEsc(e: KeyboardEvent) {
  if (!open.value) return;
  e.preventDefault();
  open.value = false;
}

onMounted(() => document.addEventListener("click", onClickOutside));
onUnmounted(() => document.removeEventListener("click", onClickOutside));
</script>

<template>
  <div ref="rootRef" class="provider-switcher" @keydown.esc="onEsc">
    <button
      class="provider-trigger"
      :class="{ open }"
      v-tooltip="'切换供应商'"
      @click.stop="toggle"
    >
      <span class="provider-trigger-icon"><ProviderLogo :kind="activeProvider.kind" :text="activeProvider.icon" :size="13" /></span>
      <span class="provider-trigger-name">{{ activeProvider.name }}</span>
      <svg class="provider-trigger-chevron" :class="{ open }" width="8" height="5" viewBox="0 0 8 5" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M0.5 0.5L4 4L7.5 0.5"/>
      </svg>
    </button>

    <Transition name="provider-menu">
      <div v-if="open" class="provider-menu" @click.stop>
        <div
          v-for="p in displayList"
          :key="p.id"
          class="provider-option"
          :class="{ active: p.id === activeProviderId }"
          @click="onSelect(p.id)"
        >
          <span class="provider-opt-icon"><ProviderLogo :kind="p.kind" :text="p.icon" :size="14" /></span>
          <span class="provider-opt-name">{{ p.name }}</span>
          <span v-if="p.id === activeProviderId" class="provider-opt-check">✓</span>
        </div>
        <div class="provider-divider"></div>
        <div class="provider-option" @click="openProviderSettings">
          <span class="provider-opt-icon"><Icon name="general" :size="14" /></span>
          <span class="provider-opt-name">管理供应商…</span>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.provider-switcher {
  position: relative;
  flex-shrink: 0;
  min-width: 0;
}

/* 触发按钮与「打开目录」同语言：边框 + radius-sm + 26px 高 */
.provider-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 8px;
  background: none;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  color: var(--aide-text-secondary);
  font-family: inherit;
  cursor: pointer;
  max-width: 160px;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.provider-trigger:hover,
.provider-trigger.open {
  background: var(--aide-surface-hover);
  border-color: color-mix(in srgb, var(--aide-text-secondary) 30%, transparent);
  color: var(--aide-text-primary);
}

.provider-trigger-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  flex-shrink: 0;
  color: var(--aide-accent);
}

.provider-trigger-name {
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-trigger-chevron {
  flex-shrink: 0;
  opacity: 0.5;
  transition: transform 0.14s ease;
}
.provider-trigger-chevron.open {
  transform: rotate(180deg);
}

/* 下拉菜单：与标题栏 config-drop-panel 同语言（向下弹出） */
.provider-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  width: 220px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-md);
  box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  z-index: 950;
  padding: 4px;
  backdrop-filter: var(--aide-surface-blur);
}

.provider-menu-enter-active,
.provider-menu-leave-active {
  transition: opacity var(--aide-ease-t), transform var(--aide-ease-t);
}
.provider-menu-enter-from,
.provider-menu-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.provider-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  font-size: 12px;
  color: var(--aide-text-secondary);
  transition: all 0.1s;
}
.provider-option:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}
.provider-option.active {
  color: var(--aide-text-primary);
}

.provider-opt-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  width: 18px;
  flex-shrink: 0;
  color: var(--aide-accent);
}

.provider-opt-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-opt-check {
  color: var(--aide-success);
  font-size: 12px;
  flex-shrink: 0;
}

.provider-divider {
  height: 1px;
  background: var(--aide-border);
  margin: 4px 6px;
}
</style>
