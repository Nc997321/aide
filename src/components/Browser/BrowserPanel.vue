<script setup lang="ts">
// 内嵌浏览器面板（可视原型）。
//
// 核心物理约束（plan §2）：原生 WebView2 子视图浮在主 webview 的 HTML **之上**、不能与 Vue 元素
// z 序交错。所以 .bp-surface 是布局里的一个「占位洞」——原生视图被钉在它的屏幕坐标上；工具栏排在
// 洞**外**（不重叠），否则会被原生视图吃掉。切走面板（open=false）必须 setVisible(false)，否则
// 原生视图脱离 DOM 生命周期、继续浮在全部内容之上。
//
// 坐标：窗口 decorations(false) + 主 webview 铺满客户区 → getBoundingClientRect()(CSS px)
// 直接等于 Tauri logical px（devicePixelRatio == scale_factor），无需换算；且 rect 是视口相对，
// 天然吸收滚动偏移。
import { ref, watch, nextTick, onBeforeUnmount } from "vue";
import {
  useEmbeddedBrowser,
  type BrowserViewDto,
  type BoundsDto,
} from "../../composables/useEmbeddedBrowser";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "close"): void }>();

const browser = useEmbeddedBrowser();
const surfaceEl = ref<HTMLElement | null>(null);
const address = ref("https://www.bing.com");
const viewId = ref("");
const view = ref<BrowserViewDto | null>(null);
const error = ref("");

let ro: ResizeObserver | null = null;
let rafId = 0;

/** 量占位洞的视口矩形；display:none / 未布局（宽高 ≤0）时返回 null。 */
function rectOf(): BoundsDto | null {
  const el = surfaceEl.value;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function syncBounds() {
  if (!viewId.value) return;
  const b = rectOf();
  if (!b) return;
  void browser.setBounds(viewId.value, b).catch(() => {});
}

/** rAF 节流：resize 期间每帧至多一次 IPC，不淹没命令通道。 */
function scheduleSync() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    syncBounds();
  });
}

function normalizeUrl(u: string): string {
  const t = u.trim();
  // 裸域名补 https（UX 便利）；scheme 合法性由后端 url_guard 守门。
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t) ? t : `https://${t}`;
}

async function ensureCreated(): Promise<void> {
  if (viewId.value) return;
  await nextTick(); // 等 v-show 摘掉 display:none、完成布局
  const b = rectOf();
  if (!b) {
    error.value = "占位区未就绪（宽高为 0）";
    return;
  }
  const id = `browser-${Date.now()}`;
  try {
    view.value = await browser.create(id, normalizeUrl(address.value), b);
    viewId.value = id;
    error.value = "";
    ro = new ResizeObserver(scheduleSync);
    if (surfaceEl.value) ro.observe(surfaceEl.value);
    window.addEventListener("resize", scheduleSync);
  } catch (e) {
    error.value = typeof e === "string" ? e : String(e);
  }
}

async function show() {
  await ensureCreated();
  if (!viewId.value) return;
  await browser.setVisible(viewId.value, true).catch(() => {});
  await nextTick();
  syncBounds();
}

async function hide() {
  if (!viewId.value) return;
  await browser.setVisible(viewId.value, false).catch(() => {});
}

watch(
  () => props.open,
  (open) => {
    if (open) void show();
    else void hide();
  },
);

async function go() {
  if (!viewId.value) return;
  error.value = "";
  try {
    view.value = await browser.navigate(viewId.value, normalizeUrl(address.value));
  } catch (e) {
    error.value = typeof e === "string" ? e : String(e);
  }
}

async function back() {
  if (!viewId.value) return;
  try {
    view.value = await browser.goBack(viewId.value);
  } catch (e) {
    error.value = String(e);
  }
}

async function forward() {
  if (!viewId.value) return;
  try {
    view.value = await browser.goForward(viewId.value);
  } catch (e) {
    error.value = String(e);
  }
}

onBeforeUnmount(() => {
  if (ro) {
    ro.disconnect();
    ro = null;
  }
  window.removeEventListener("resize", scheduleSync);
  if (rafId) cancelAnimationFrame(rafId);
  // 组件销毁 = 销毁原生视图（否则它脱离 DOM 继续浮在最上层）。
  if (viewId.value) void browser.close(viewId.value).catch(() => {});
});
</script>

<template>
  <div v-show="open" class="browser-panel">
    <div class="bp-toolbar">
      <button class="bp-btn" :disabled="!view?.can_go_back" title="后退" @click="back">‹</button>
      <button class="bp-btn" :disabled="!view?.can_go_forward" title="前进" @click="forward">›</button>
      <button class="bp-btn" title="刷新（重新导航到地址栏）" @click="go">⟳</button>
      <input
        v-model="address"
        class="bp-address"
        placeholder="输入网址，回车打开（裸域名自动补 https://）"
        spellcheck="false"
        @keydown.enter="go"
      />
      <button class="bp-btn bp-go" @click="go">打开</button>
      <button class="bp-btn bp-close" title="关闭面板 (Ctrl+Shift+B)" @click="emit('close')">✕</button>
    </div>

    <div v-if="error" class="bp-error">{{ error }}</div>

    <!-- 占位洞：原生 WebView2 子视图浮在这块的屏幕坐标之上 -->
    <div ref="surfaceEl" class="bp-surface">
      <div class="bp-hint">
        <span class="bp-hint-title">原生 WebView2 子视图区域</span>
        <span class="bp-hint-sub">网页加载后将覆盖此提示（原生视图浮于 HTML 之上）</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.browser-panel {
  /* .app-layout 是 position:relative 锚点；inset:0 铺满内容区（标题栏在其外，不被覆盖） */
  position: absolute;
  inset: 0;
  z-index: 120; /* 高于 FileViewer(40)/Workbench(80)/左 overlay(90) */
  display: flex;
  flex-direction: column;
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-border);
}

.bp-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: var(--aide-bg-deep);
  border-bottom: 1px solid var(--aide-border);
}

.bp-btn {
  flex: 0 0 auto;
  min-width: 30px;
  height: 28px;
  padding: 0 8px;
  font-size: 15px;
  line-height: 1;
  color: var(--aide-text-secondary);
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  transition: background var(--aide-ease-t), color var(--aide-ease-t);
}
.bp-btn:hover:not(:disabled) {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
.bp-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.bp-go {
  color: var(--aide-text-on-accent);
  background: var(--aide-accent);
  border-color: var(--aide-accent);
  font-size: 13px;
}
.bp-go:hover:not(:disabled) {
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
}
.bp-close {
  font-size: 13px;
}

.bp-address {
  flex: 1 1 auto;
  min-width: 0;
  height: 28px;
  padding: 0 10px;
  font-size: 13px;
  font-family: var(--aide-font-mono);
  color: var(--aide-text-primary);
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  outline: none;
}
.bp-address:focus {
  border-color: var(--aide-accent);
}

.bp-error {
  flex: 0 0 auto;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--aide-danger);
  background: var(--aide-surface-default);
  border-bottom: 1px solid var(--aide-border);
}

.bp-surface {
  flex: 1 1 auto;
  position: relative;
  min-height: 0;
  background: var(--aide-surface-default);
}

.bp-hint {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  pointer-events: none;
}
.bp-hint-title {
  font-size: 14px;
  color: var(--aide-text-secondary);
}
.bp-hint-sub {
  font-size: 12px;
  color: var(--aide-text-muted);
}
</style>
