<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";
import { useFileViewer, type FileWindowState } from "../composables/useFileViewer";
import FileWindow from "./fileviewer/FileWindow.vue";

/**
 * 文件窗口管理层。单窗口渲染在 fileviewer/FileWindow.vue。
 *
 * 层挂在 App.vue 的 .app-layout 内（绝对定位）：左边到 aide 最左缘
 * （允许盖住会话侧栏），右边止于文件树侧栏边界——文件树始终可点，
 * 可以连续从里面开文件。侧栏宽度可拖动调节、可折叠，边界不能信 CSS
 * 变量（折叠只改元素宽度不改 grid 轨道），用 ResizeObserver 量
 * .panel-center 的真实右缘。
 *
 * 布局是平铺式（tiling）而非「聚焦+最小化」：
 * - 无主窗时所有窗口按区域宽高比均分网格，随数量增多变小；
 * - 点某个窗口 → 它恢复默认弹窗大小靠左，其余窗口在右侧剩余空间里
 *   实际缩小平铺（仍是完整窗口，不是缩略条）；
 * - 拖标题栏可随意挪动；开/关/切主窗/边界变化会重新自动平铺。
 */

const { windows, focusedId, focusWindow } = useFileViewer();

const MARGIN = 12;
const DEFAULT_W = 900; // 单窗/主窗的默认弹窗宽度上限

const layerRef = ref<HTMLElement | null>(null);
/** 窗口活动区实时尺寸（app-layout 左缘 → panel-center 右缘），驱动平铺和拖拽钳制 */
const layerSize = ref({ w: 0, h: 0 });

function measureBounds() {
  const layout = layerRef.value?.parentElement;
  const center = layout?.querySelector(":scope > .panel-center");
  if (!layout || !center) return;
  const lr = layout.getBoundingClientRect();
  const cr = center.getBoundingClientRect();
  layerSize.value = { w: Math.max(0, Math.round(cr.right - lr.left)), h: Math.round(lr.height) };
}

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
  if (!n || !layerSize.value.w) return;
  const ax = MARGIN;
  const ay = MARGIN;
  const aw = layerSize.value.w - MARGIN * 2;
  const ah = layerSize.value.h - MARGIN * 2;

  if (n === 1) {
    const w0 = wins[0];
    w0.w = Math.min(DEFAULT_W, Math.round(aw * 0.9));
    w0.h = Math.round(ah * 0.96);
    w0.x = ax + Math.round((aw - w0.w) / 2);
    w0.y = ay + Math.round((ah - w0.h) / 2);
    return;
  }

  const focused = wins.find((w) => w.id === focusedId.value);
  if (focused) {
    // 主窗恢复默认弹窗大小靠左，其余在右侧剩余空间里平铺缩小
    focused.w = Math.min(DEFAULT_W, Math.round(aw * 0.62));
    focused.h = ah;
    focused.x = ax;
    focused.y = ay;
    const rest = wins.filter((w) => w !== focused);
    const rx = ax + focused.w + MARGIN;
    const rw = Math.max(ax + aw - rx, 200);
    tileGrid(rest, rx, ay, rw, ah);
  } else {
    tileGrid(wins, ax, ay, aw, ah);
  }
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  const layout = layerRef.value?.parentElement;
  const center = layout?.querySelector(":scope > .panel-center");
  if (!layout || !center) return;
  // panel-center 尺寸变（两侧侧栏拖动/折叠、窗口缩放）→ 右边界变；
  // app-layout 变 → 整体高宽变。两个都观察，回调里统一重量。
  resizeObserver = new ResizeObserver(() => measureBounds());
  resizeObserver.observe(layout);
  resizeObserver.observe(center);
  measureBounds();
});

onUnmounted(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});

watch(
  () => [windows.value.length, focusedId.value, layerSize.value] as const,
  () => retile(),
  { immediate: true },
);

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
  <!-- 容器常驻（ResizeObserver 挂靠），无窗口时 pointer-events:none 不挡任何交互 -->
  <div ref="layerRef" class="fv-layer" :style="{ width: layerSize.w + 'px' }">
    <div
      v-for="w in windows"
      :key="w.id"
      class="fv-win"
      :class="{ 'fv-win--focused': w.id === focusedId }"
      :style="{ left: w.x + 'px', top: w.y + 'px', width: w.w + 'px', height: w.h + 'px' }"
      @mousedown.capture="onWindowMousedown($event, w)"
    >
      <FileWindow :win="w" :bounds="layerSize" />
    </div>
  </div>
</template>

<style scoped>
.fv-layer {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  /* 右边界不用 inset：宽度由 measureBounds 实测（止于文件树侧栏） */
  z-index: 40;
  pointer-events: none;
  overflow: hidden;
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
