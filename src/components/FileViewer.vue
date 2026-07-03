<script setup lang="ts">
import { watch, onMounted, onUnmounted } from "vue";
import { useFileViewer, type FileWindowState } from "../composables/useFileViewer";
import FileWindow from "./fileviewer/FileWindow.vue";

/**
 * 文件窗口管理层。单窗口渲染在 fileviewer/FileWindow.vue。
 *
 * 层覆盖整个 aide 视口（Teleport 到 body），但自身 pointer-events:none——
 * 只有窗口本体可交互，文件树/会话栏/聊天区在窗口之间的空隙里照常可点，
 * 窗口可以铺满乃至挤占整个界面，不受聊天区边界约束。
 *
 * 布局是平铺式（tiling）而非「聚焦+最小化」：
 * - 无主窗时所有窗口按视口宽高比均分网格，随数量增多变小；
 * - 点某个窗口 → 它恢复默认弹窗大小靠左，其余窗口在右侧剩余空间里
 *   实际缩小平铺（仍是完整窗口，不是缩略条）；
 * - 拖标题栏可随意挪动；开/关/切主窗会重新自动平铺（覆盖手动位置）。
 */

const { windows, focusedId, focusWindow } = useFileViewer();

const MARGIN = 12;
const TOP = 44;   // 让出自定义标题栏
const BOTTOM = 10;
const DEFAULT_W = 900; // 单窗/主窗的默认弹窗宽度上限

function tileGrid(wins: FileWindowState[], x: number, y: number, w: number, h: number) {
  const n = wins.length;
  if (!n) return;
  // 按区域宽高比选列数，尽量让每格接近常规窗口比例
  const cols = Math.min(n, Math.max(1, Math.round(Math.sqrt((n * w) / h))));
  const rows = Math.ceil(n / cols);
  const cellW = (w - (cols - 1) * MARGIN) / cols;
  const cellH = (h - (rows - 1) * MARGIN) / rows;
  wins.forEach((win, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    win.x = Math.round(x + c * (cellW + MARGIN));
    win.y = Math.round(y + r * (cellH + MARGIN));
    win.w = Math.round(cellW);
    win.h = Math.round(cellH);
  });
}

function retile() {
  const wins = windows.value;
  const n = wins.length;
  if (!n) return;
  const ax = MARGIN;
  const ay = TOP;
  const aw = window.innerWidth - MARGIN * 2;
  const ah = window.innerHeight - TOP - BOTTOM;

  if (n === 1) {
    const w0 = wins[0];
    w0.w = Math.min(DEFAULT_W, Math.round(aw * 0.82));
    w0.h = Math.round(ah * 0.94);
    w0.x = ax + Math.round((aw - w0.w) / 2);
    w0.y = ay + Math.round((ah - w0.h) / 2);
    return;
  }

  const focused = wins.find((w) => w.id === focusedId.value);
  if (focused) {
    // 主窗恢复默认弹窗大小靠左，其余在右侧剩余空间里平铺缩小
    focused.w = Math.min(DEFAULT_W, Math.round(aw * 0.6));
    focused.h = ah;
    focused.x = ax;
    focused.y = ay;
    const rest = wins.filter((w) => w !== focused);
    const rx = ax + focused.w + MARGIN;
    const rw = Math.max(window.innerWidth - MARGIN - rx, 220);
    tileGrid(rest, rx, ay, rw, ah);
  } else {
    tileGrid(wins, ax, ay, aw, ah);
  }
}

watch(
  () => [windows.value.length, focusedId.value] as const,
  () => retile(),
  { immediate: true },
);

function onResize() {
  retile();
}

onMounted(() => window.addEventListener("resize", onResize));
onUnmounted(() => window.removeEventListener("resize", onResize));

/**
 * 点到非主窗 → 它成为主窗（恢复默认大小）。capture 阶段拦截，避免这一下
 * 顺带落进小窗的编辑器；但放行关闭/保存/模式切换按钮，平铺态下点 × 就是直接关。
 */
function onWindowMousedown(e: MouseEvent, win: FileWindowState) {
  if (windows.value.length <= 1 || focusedId.value === win.id) return;
  const el = e.target as HTMLElement;
  if (el.closest(".fw-close, .fw-btn, .fw-md-mode-btn")) return;
  e.preventDefault();
  e.stopPropagation();
  focusWindow(win.id);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="windows.length" class="fv-layer">
      <div
        v-for="w in windows"
        :key="w.id"
        class="fv-win"
        :class="{ 'fv-win--focused': w.id === focusedId }"
        :style="{ left: w.x + 'px', top: w.y + 'px', width: w.w + 'px', height: w.h + 'px' }"
        @mousedown.capture="onWindowMousedown($event, w)"
      >
        <FileWindow :win="w" />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.fv-layer {
  position: fixed;
  inset: 0;
  z-index: 60;
  pointer-events: none;
}

.fv-win {
  position: absolute;
  pointer-events: auto;
  min-width: 0;
  min-height: 0;
  animation: fv-scale-in 0.15s ease;
  transition: left 0.18s ease, top 0.18s ease, width 0.18s ease, height 0.18s ease;
}

/* 拖拽中由 FileWindow 加在自身上的类，暂停几何过渡避免拖起来发糊 */
.fv-win:has(.fw-window--dragging) {
  transition: none;
}

.fv-win--focused {
  z-index: 2;
}

@keyframes fv-scale-in {
  from { opacity: 0; transform: scale(0.96); }
  to { opacity: 1; transform: scale(1); }
}
</style>
