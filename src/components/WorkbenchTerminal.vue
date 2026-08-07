<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch, computed } from "vue";
import { useWorkbenchTerminal } from "../composables/useWorkbenchTerminal";
import { useTerminalSearch } from "../composables/useTerminalSearch";
import { useChatPaneWidth } from "../composables/useChatPaneWidth";
import TerminalSearchBar from "./workbenchterminal/SearchBar.vue";
import "xterm/css/xterm.css";

const props = defineProps<{ workspaceKey: string; cwd: string; height: number }>();
const emit = defineEmits<{ "update:height": [v: number] }>();

const wb = useWorkbenchTerminal();
const search = useTerminalSearch();
const searchBarRef = ref<InstanceType<typeof TerminalSearchBar>>();

// 快捷键路由（capture 挂在 pill 上，先于 xterm textarea 处理）：
// Ctrl+F 打开/重聚焦搜索条；搜索条开着时 Esc 关闭并回焦终端（不开则 Esc 透传给 shell/vim）。
// 只绑在 pill DOM 内生效——焦点在编辑器/文件窗时 Ctrl+F 仍归 CodeMirror。
function onPillKeydown(e: KeyboardEvent) {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyF") {
    e.preventDefault();
    e.stopPropagation();
    search.open();
    nextTick(() => searchBarRef.value?.focusInput());
    return;
  }
  if (e.key === "Escape" && search.visible.value) {
    e.preventDefault();
    e.stopPropagation();
    search.close();
  }
}
const { chatPaneWidth, chatPaneLeft } = useChatPaneWidth();
// pill 左缘/宽度对齐聚焦对话框：测得值后严格贴齐（左缘=对话框左缘，宽=对话框宽），
// 而不是在整窗居中——侧栏把对话框右推，居中的 pill 会比对话框偏右。未测得时兜底整窗 10px 边距。
// 终端面板顶部固定在标题栏下方，不遮挡标题栏（标题栏 42px + 8px 间距 = 50px）。
// 水平方向对齐聚焦聊天窗（chatPaneLeft/Width）；未测得时兜底整窗 10px 边距。
const WORKBENCH_TOP = "50px";
const pillStyle = computed(() => {
  const base = { height: props.height + "px", top: WORKBENCH_TOP };
  if (chatPaneWidth.value > 0) {
    return { ...base, left: `${chatPaneLeft.value}px`, width: `${chatPaneWidth.value}px` };
  }
  return { ...base, left: "10px", width: "calc(100% - 20px)" };
});
const containerRef = ref<HTMLDivElement>();

onMounted(() => {
  if (containerRef.value) wb.init(containerRef.value);
});

onUnmounted(() => {
  // wb.dispose() is called by App.vue — don't call here.
});

// 首次打开某工作空间的终端面板时自动建一个 shell——用户点终端就是要用，不必再点"新建终端"。
function ensureActiveTerminal() {
  if (wb.tabs.value.length === 0 && props.workspaceKey) {
    wb.createSession(props.workspaceKey, props.cwd);
  }
}

watch(() => wb.visible.value, async (v) => {
  if (!v) return;
  await nextTick();
  if (wb.tabs.value.length === 0) {
    ensureActiveTerminal();   // createSession 内部已 switchTo 显示新 pane
  } else {
    wb.switchTo(wb.activeId.value);
  }
});

watch(() => wb.activeId.value, (id) => {
  if (!wb.visible.value) return;
  if (!id && wb.tabs.value.length === 0) {
    // 面板开着时切到无终端工作空间：同样自动建；不可再 switchTo("")，否则会把刚建的 pane 藏掉
    ensureActiveTerminal();
    return;
  }
  nextTick(() => wb.switchTo(id));
});

const activeTabKind = computed<"shell" | "run" | undefined>(() => {
  const t = wb.tabs.value.find(t => t.id === wb.activeId.value);
  return t?.kind;
});

function addTerminal() {
  wb.createSession(props.workspaceKey, props.cwd);
}

// 底部边缘拖拽调高度：pill 顶部固定在标题栏下方，向下拖=变高（底部下展），
// 向上拖=变矮。下界 120px 保 header+终端可见；上界留出 top(50)+底部间距(8) 不溢出窗口。
function onResizeStart(e: MouseEvent) {
  e.preventDefault();
  const startY = e.clientY;
  const startH = props.height;
  const onMove = (ev: MouseEvent) => {
    const h = Math.max(120, Math.min(window.innerHeight - 58, startH + ev.clientY - startY));
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
    <div class="workbench-pill" :class="{ 'is-shown': wb.visible.value }" :style="pillStyle" @keydown.capture="onPillKeydown">
      <div class="workbench-header">
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
        <TerminalSearchBar v-if="search.visible.value" ref="searchBarRef" />
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
      <div class="workbench-resize-handle" @mousedown="onResizeStart" v-tooltip="'拖动调整高度'"></div>
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
  cursor: default;
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

/* ── 底部 resize 手柄：pill 顶部固定在标题栏下方，拖此条上下调高度 ── */
.workbench-resize-handle {
  height: 6px;
  flex-shrink: 0;
  cursor: row-resize;
  background: var(--aide-bg-deep);
  border-top: 1px solid var(--aide-surface-default);
  user-select: none;
  position: relative;
}
.workbench-resize-handle::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 50%;
  transform: translateX(-50%);
  width: 36px;
  height: 2px;
  border-radius: 2px;
  background: var(--aide-text-muted);
  opacity: 0.35;
  transition: opacity 0.15s;
}
.workbench-resize-handle:hover::after {
  opacity: 0.7;
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
