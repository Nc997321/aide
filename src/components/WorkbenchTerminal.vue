<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch, computed } from "vue";
import { useWorkbenchTerminal } from "../composables/useWorkbenchTerminal";
import { useChatPaneWidth } from "../composables/useChatPaneWidth";
import "xterm/css/xterm.css";

const props = defineProps<{ workspaceKey: string; cwd: string; height: number }>();
const emit = defineEmits<{ "update:height": [v: number] }>();

const wb = useWorkbenchTerminal();
const { chatPaneWidth } = useChatPaneWidth();
const pillWidth = computed(() => chatPaneWidth.value > 0 ? `${chatPaneWidth.value}px` : "calc(100% - 20px)");
const containerRef = ref<HTMLDivElement>();

onMounted(() => {
  if (containerRef.value) wb.init(containerRef.value);
});

onUnmounted(() => {
  // wb.dispose() is called by App.vue — don't call here.
});

watch(() => wb.visible.value, async (v) => {
  if (v) {
    await nextTick();
    if (wb.tabs.value.length > 0 && wb.activeId.value) {
      wb.switchTo(wb.activeId.value);
    }
  }
});

const activeTabKind = computed<"shell" | "run" | undefined>(() => {
  const t = wb.tabs.value.find(t => t.id === wb.activeId.value);
  return t?.kind;
});

function addTerminal() {
  wb.createSession(props.workspaceKey, props.cwd);
}

function onHeaderDragStart(e: MouseEvent) {
  if ((e.target as HTMLElement).closest(".wb-tabs, .wb-header-right")) return;
  e.preventDefault();
  const startY = e.clientY;
  const startH = props.height;
  const onMove = (ev: MouseEvent) => {
    const h = Math.max(120, Math.min(window.innerHeight - 80, startH + ev.clientY - startY));
    emit("update:height", h);
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}
</script>

<template>
  <div class="workbench-overlay" :class="{ 'workbench-overlay--hidden': !wb.visible.value }">
    <div class="workbench-pill" :class="{ 'is-shown': wb.visible.value }" :style="{ height: props.height + 'px', width: pillWidth }">
      <div class="workbench-header" @mousedown="onHeaderDragStart">
        <div class="wb-tabs">
          <div
            v-for="tab in wb.tabs.value"
            :key="tab.id"
            class="wb-tab"
            :class="{ active: tab.id === wb.activeId.value }"
            @click.stop="wb.switchTo(tab.id)"
          >
            <span class="wb-tab-label">{{ tab.shellName || 'Shell' }} {{ tab.label }}</span>
            <button class="wb-tab-close" @click.stop="wb.closeSession(tab.id)" v-tooltip="'关闭终端'">✕</button>
          </div>
          <button class="wb-tab-add" @click.stop="addTerminal" v-tooltip="'新建终端'">+</button>
        </div>
        <div class="wb-header-right">
          <button class="wb-btn" v-tooltip="'清屏'" @click.stop="wb.clear()">⌫</button>
          <button class="wb-btn wb-btn--minimize" v-tooltip="'最小化 (Ctrl+`)'" @click.stop="wb.hide()">─</button>
        </div>
      </div>
      <div ref="containerRef" class="wb-container">
        <div
          v-if="wb.visible.value && wb.tabs.value.length === 0"
          class="wb-empty"
        >
          <div class="wb-empty__title">该工作空间还没有终端</div>
          <button class="wb-empty__btn" @click.stop="addTerminal">新建终端</button>
        </div>
        <div
          v-if="wb.activeExited.value && activeTabKind === 'shell'"
          class="workbench-exited"
          tabindex="0"
          @keydown.enter.prevent="wb.restart(wb.activeId.value, props.cwd)"
          @click="wb.restart(wb.activeId.value, props.cwd)"
        >
          <div class="workbench-exited__title">Shell 已退出</div>
          <div class="workbench-exited__hint">按 Enter 或点击重启</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
.workbench-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  z-index: 80;
  pointer-events: none;
  display: flex;
  justify-content: center;
}
.workbench-overlay--hidden {
  visibility: hidden;
}

.workbench-pill {
  pointer-events: auto;
  position: absolute;
  top: 10px;
  width: calc(100% - 20px);
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-surface-default);
  border-radius: var(--aide-radius-lg);
  box-shadow: var(--aide-shadow-lg);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  transform: translateY(-100%);
  opacity: 0;
  transition: transform 0.18s ease-out, opacity 0.18s ease-out;
}

.workbench-pill.is-shown {
  transform: translateY(0);
  opacity: 1;
}

.workbench-header {
  height: 32px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 4px;
  background: var(--aide-bg-deep);
  border-bottom: 1px solid var(--aide-surface-default);
  cursor: row-resize;
  user-select: none;
  gap: 8px;
}

/* ── Tab bar ── */

.wb-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  cursor: default;
}
.wb-tabs::-webkit-scrollbar { display: none; }

.wb-tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px 3px 10px;
  border-radius: var(--aide-radius-sm);
  font-size: 11px;
  color: var(--aide-text-muted);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s, color 0.12s;
}
.wb-tab:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-secondary);
}
.wb-tab.active {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}

.wb-tab-label { pointer-events: none; }

.wb-tab-close {
  background: none; border: none;
  color: var(--aide-text-muted);
  font-size: 10px;
  width: 16px; height: 16px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 3px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.1s, color 0.1s, background 0.1s;
}
.wb-tab:hover .wb-tab-close,
.wb-tab.active .wb-tab-close {
  opacity: 1;
}
.wb-tab-close:hover {
  background: var(--aide-surface-default);
  color: var(--aide-danger);
}

.wb-tab-add {
  background: none; border: none;
  color: var(--aide-text-muted);
  font-size: 14px; font-weight: 300;
  width: 22px; height: 22px;
  display: flex; align-items: center; justify-content: center;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.12s, color 0.12s;
}
.wb-tab-add:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

/* ── Header right actions ── */

.wb-header-right {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: default;
  flex-shrink: 0;
}
.wb-btn {
  background: none; border: none; color: var(--aide-text-muted);
  font-size: 11px; padding: 2px 7px; border-radius: 4px; cursor: pointer;
  line-height: 1;
  transition: color 0.12s, background 0.12s;
}
.wb-btn:hover { background: var(--aide-surface-default); color: var(--aide-text-secondary); }
.wb-btn--minimize { font-size: 13px; font-weight: 700; }

/* ── Terminal container ── */

.wb-container {
  flex: 1;
  position: relative;
  overflow: hidden;
}

.wb-term-pane {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.wb-term-pane .xterm { padding: 8px 10px; height: 100%; }
.wb-term-pane .xterm-viewport { scrollbar-width: thin; scrollbar-color: var(--aide-surface-default) transparent; }
.wb-term-pane .xterm-viewport::-webkit-scrollbar { width: 6px; }
.wb-term-pane .xterm-viewport::-webkit-scrollbar-thumb { background: var(--aide-surface-default); border-radius: 3px; }

/* ── Empty state ── */

.wb-empty {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; color: var(--aide-text-muted);
}
.wb-empty__title { font-size: 13px; }
.wb-empty__btn {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  padding: 6px 16px; font-size: 13px; cursor: pointer;
  transition: background 0.12s;
}
.wb-empty__btn:hover { background: var(--aide-surface-default); }

/* ── Shell exited overlay ── */

.workbench-exited {
  position: absolute; inset: 0;
  z-index: 5;
  background: var(--aide-bg-overlay);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; cursor: pointer; outline: none;
}
.workbench-exited__title { font-size: 14px; color: var(--aide-text-secondary); }
.workbench-exited__hint { font-size: 12px; color: var(--aide-text-muted); }
</style>
