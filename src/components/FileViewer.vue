<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";
import { useFileViewer, type FileWindowState } from "../composables/useFileViewer";
import FileWindow from "./fileviewer/FileWindow.vue";

/**
 * 文件窗口管理层。单窗口渲染在 fileviewer/FileWindow.vue。
 *
 * 层挂在 App.vue 的 .app-layout 内（绝对定位），横跨整个 app-layout 宽度
 * （左缘 → 右缘，含两侧侧栏）。层容器本身 pointer-events:none 不挡下方点击，
 * 只有 .fv-win（pointer-events:auto）会拦截——所以侧栏未被窗口盖住的部分
 * 仍可点。单窗默认铺满主内容区（panel-center）：左右贴两侧侧栏内缘、顶部留
 * MARGIN、直达底部，侧栏拖动/折叠时窗口跟着收放（用户显式要的布局）；
 * 多窗也只在主内容区内平铺，侧栏保持可点。侧栏宽可拖动/可折叠，边界不能信
 * CSS 变量（折叠只改元素宽度不改 grid 轨道），用 ResizeObserver 量
 * .panel-center 的真实左/右缘与 .app-layout 的真实右缘。
 *
 * 布局是平铺式（tiling）而非「聚焦+最小化」：
 * - 无主窗时所有窗口按区域宽高比均分网格，随数量增多变小；
 * - 点某个窗口 → 它恢复默认弹窗大小，锚在自己当前所在的一侧（左/右）放大，
 *   不搬到固定一侧——窗口左右顺序永不因聚焦而交换；
 *   其余窗口在另一侧剩余空间里实际缩小平铺（仍是完整窗口，不是缩略条）；
 * - 拖标题栏可随意挪动；开/关/切主窗/边界变化会重新自动平铺。
 */

const { windows, focusedId, focusWindow } = useFileViewer();

const MARGIN = 12;
const TOP_MARGIN = 28; // 单窗/聚焦主窗：顶部留出更多空间，让圆角顶边 + box-shadow 完整露出，不被 layer 顶沿裁切
const DEFAULT_W = 900; // 单窗/主窗的默认弹窗宽度上限

const layerRef = ref<HTMLElement | null>(null);
/**
 * 窗口活动区实时尺寸，驱动平铺和拖拽钳制。
 * - w  = 整个 app-layout 宽（左缘 → 右缘）：层宽与拖拽/resize 钳制边界，
 *         用户手动拖出的窗口仍可在整个 app 内活动（含侧栏上方）。
 * - chatW = 主内容区右缘相对 app-layout 左缘的距离。
 * - chatX = 主内容区左缘相对 app-layout 左缘的距离（左侧栏宽度）。
 *           chatW - chatX 即主内容区（panel-center）实际宽度：
 *           单窗铺满它，多窗平铺其内，侧栏保持可点。
 */
const layerSize = ref<{ w: number; h: number; chatW: number; chatX: number }>({
  w: 0,
  h: 0,
  chatW: 0,
  chatX: 0,
});

function measureBounds() {
  const layout = layerRef.value?.parentElement;
  const center = layout?.querySelector(":scope > .panel-center");
  if (!layout || !center) return;
  const lr = layout.getBoundingClientRect();
  const cr = center.getBoundingClientRect();
  layerSize.value = {
    w: Math.max(0, Math.round(lr.right - lr.left)),
    chatW: Math.max(0, Math.round(cr.right - lr.left)),
    chatX: Math.max(0, Math.round(cr.left - lr.left)),
    h: Math.round(lr.height),
  };
}

function tileGrid(wins: FileWindowState[], area: { x: number; y: number; w: number; h: number }) {
  const n = wins.length;
  if (!n) return;
  // 按区域宽高比选列数，尽量让每格接近常规窗口比例
  const cols = Math.min(n, Math.max(1, Math.round(Math.sqrt((n * area.w) / area.h))));
  const rows = Math.ceil(n / cols);
  const cellW = (area.w - (cols - 1) * MARGIN) / cols;
  const cellH = (area.h - (rows - 1) * MARGIN) / rows;
  wins.forEach((win, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    win.x = Math.round(area.x + c * (cellW + MARGIN));
    win.y = Math.round(area.y + r * (cellH + MARGIN));
    win.w = Math.round(cellW);
    win.h = Math.round(cellH);
  });
}

function retile() {
  const wins = windows.value;
  const n = wins.length;
  if (!n || !layerSize.value.w) return;
  const fullW = layerSize.value.w; // 整个 app 宽
  const ah = layerSize.value.h - MARGIN * 2;

  // 用户手动调整过尺寸的窗口视为「浮动」：retile 不动它们的几何，
  // 只在边界收缩时钳制位置/尺寸让窗口始终拖得回来（至少 80px 宽可见）。
  for (const w of wins) {
    if (!w.userResized) continue;
    w.w = Math.min(Math.max(w.w, 240), Math.max(240, fullW));
    w.h = Math.min(Math.max(w.h, 160), Math.max(160, ah));
    w.x = Math.min(Math.max(w.x, 80 - w.w), fullW - 80);
    w.y = Math.min(Math.max(w.y, 0), layerSize.value.h - 40);
  }

  const tileable = wins.filter((w) => !w.userResized);
  const nT = tileable.length;
  if (!nT) return; // 全部由用户手动放置，无需平铺

  // 主内容区（panel-center）在 app-layout 内的左偏移与实际宽度。
  // 左右侧栏拖动/折叠时 ResizeObserver 会重量，窗口跟着收放。
  const chatX = layerSize.value.chatX || 0;
  const chatW2 = (layerSize.value.chatW || fullW) - chatX;

  // 单窗：左右贴主内容区两侧、顶部留 TOP_MARGIN（圆角完整可见）、直达底部（类似 IDE 的编辑区）。
  if (nT === 1 && n === 1) {
    const w0 = tileable[0];
    w0.x = chatX;
    w0.y = TOP_MARGIN;
    w0.w = Math.max(240, chatW2);
    w0.h = layerSize.value.h - TOP_MARGIN;
    return;
  }

  // 多窗：只在主内容区内平铺，左右侧栏保持可点。
  const ax = chatX + MARGIN;
  const ay = MARGIN;
  const caw = chatW2 - MARGIN * 2;
  const focused = tileable.find((w) => w.id === focusedId.value);
  if (focused) {
    // 主窗恢复默认弹窗大小，锚在自己当前所在的一侧放大（原地变大，不左右换位）：
    // 以窗口当前中心点相对平铺区中点判左右；62% 宽时放大后中心仍落在同侧，
    // 后续 retile（侧栏拖动等）不会翻侧抖动。
    const fw = Math.min(DEFAULT_W, Math.round(caw * 0.62));
    const dockRight = focused.x + focused.w / 2 > ax + caw / 2;
    focused.w = fw;
    focused.h = ah;
    focused.x = dockRight ? ax + caw - fw : ax;
    focused.y = ay;
    const rest = tileable.filter((w) => w !== focused);
    const rw = Math.max(caw - fw - MARGIN, 200);
    const rx = dockRight ? ax : ax + fw + MARGIN;
    tileGrid(rest, { x: rx, y: ay, w: rw, h: ah });
  } else {
    tileGrid(tileable, { x: ax, y: ay, w: caw, h: ah });
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
  if (el.closest(".fw-close, .fw-btn, .fw-md-mode-btn, .fw-resize")) return;
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
  /* 宽度由 measureBounds 实测 = 整个 app-layout 宽（含文件树侧栏）。
     容器 pointer-events:none 不挡下方侧栏点击，只有 .fv-win 拦截。 */
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
