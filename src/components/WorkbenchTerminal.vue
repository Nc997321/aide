<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch } from "vue";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { useSettings } from "../composables/useSettings";
import { useWorkbenchTerminal } from "../composables/useWorkbenchTerminal";
import { api } from "../api";
import "xterm/css/xterm.css";

const props = defineProps<{ cwd: string; height: number }>();
const emit = defineEmits<{ "update:height": [v: number] }>();

const { settings } = useSettings();
const wb = useWorkbenchTerminal();

const termHostRef = ref<HTMLDivElement>();
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let observer: ResizeObserver | null = null;

onMounted(async () => {
  if (!termHostRef.value) return;
  terminal = new Terminal({
    cursorBlink: true,
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily,
    theme: {
      background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc",
      selectionBackground: "#585b70",
      black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
      blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
      brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af", brightBlue: "#89b4fa", brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5", brightWhite: "#a6adc8",
    },
    allowProposedApi: true,
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(termHostRef.value);
  fitAddon.fit();

  wb.attachTerminal(terminal, fitAddon, termHostRef.value);

  observer = new ResizeObserver(() => {
    fitAddon?.fit();
    if (terminal) api.ptyResize(wb.getSessionId(), terminal.rows, terminal.cols).catch(() => {});
  });
  observer.observe(termHostRef.value);
});

onUnmounted(() => {
  observer?.disconnect();
  terminal?.dispose();
  wb.dispose();
});

// Refit when the panel becomes visible (container was visibility:hidden).
watch(() => wb.visible.value, async (v) => {
  if (v) {
    await nextTick();
    fitAddon?.fit();
    terminal?.focus();
  }
});

// Drag the header to resize height.
function onHeaderDragStart(e: MouseEvent) {
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

function onExitedKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    wb.restart(props.cwd);
  }
}
</script>

<template>
  <div
    class="workbench-overlay"
    :class="{ 'workbench-overlay--hidden': !wb.visible.value }"
  >
    <div class="workbench-pill" :class="{ 'is-shown': wb.visible.value }" :style="{ height: props.height + 'px' }">
      <div class="workbench-header" @mousedown="onHeaderDragStart">
        <div class="wb-dots">
          <span class="wb-dot wb-dot--red"></span>
          <span class="wb-dot wb-dot--yellow"></span>
          <span class="wb-dot wb-dot--green"></span>
        </div>
        <div class="wb-header-right">
          <span class="wb-shell-name">{{ wb.shellName.value }}</span>
          <button class="wb-btn" title="清屏" @click="wb.clear()">⌫</button>
          <button class="wb-btn" title="关闭" @click="wb.close()">✕</button>
        </div>
      </div>
      <div ref="termHostRef" class="workbench-term-host"></div>
      <div
        v-if="wb.shellExited.value"
        class="workbench-exited"
        tabindex="0"
        @keydown="onExitedKeydown"
        @click="wb.restart(props.cwd)"
      >
        <div class="workbench-exited__title">Shell 已退出</div>
        <div class="workbench-exited__hint">按 Enter 或点击重启</div>
      </div>
    </div>
  </div>
</template>

<style>
.workbench-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  z-index: 80;
  pointer-events: none; /* let the underlying UI stay interactive */
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
  background: var(--bg-primary);
  border: 1px solid var(--surface);
  border-radius: 10px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
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
  height: 26px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--surface);
  cursor: row-resize;
  user-select: none;
}

.wb-dots { display: flex; gap: 6px; }
.wb-dot { width: 8px; height: 8px; border-radius: 50%; }
.wb-dot--red { background: #f38ba8; }
.wb-dot--yellow { background: #f9e2af; }
.wb-dot--green { background: #a6e3a1; }

.wb-header-right { display: flex; align-items: center; gap: 8px; cursor: default; }
.wb-shell-name { font-size: 11px; color: var(--text-muted); }
.wb-btn {
  background: var(--surface); border: none; color: var(--text-secondary);
  font-size: 11px; padding: 2px 7px; border-radius: 4px; cursor: pointer;
  line-height: 1;
}
.wb-btn:hover { color: var(--accent-red); }

.workbench-term-host {
  flex: 1;
  position: relative;
  overflow: hidden;
}
.workbench-term-host .xterm { padding: 8px 10px; height: 100%; }
.workbench-term-host .xterm-viewport { scrollbar-width: thin; scrollbar-color: var(--surface) transparent; }
.workbench-term-host .xterm-viewport::-webkit-scrollbar { width: 6px; }
.workbench-term-host .xterm-viewport::-webkit-scrollbar-thumb { background: var(--surface); border-radius: 3px; }

.workbench-exited {
  position: absolute; inset: 26px 0 0 0;
  background: rgba(17, 17, 27, 0.85);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; cursor: pointer; outline: none;
}
.workbench-exited__title { font-size: 14px; color: var(--text-secondary); }
.workbench-exited__hint { font-size: 12px; color: var(--text-muted); }
</style>
