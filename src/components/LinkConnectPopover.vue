<script setup lang="ts">
// 侧栏状态栏的「连接移动端」按钮（设置齿轮左边）：点开一张浮卡，卡里就是配对二维码。
// 卡片经 Teleport 挂 body、按按钮位置向上弹出（按钮在侧栏最底部）；点卡外面 / Esc 收起。
// 内容组件只在打开时才挂载——网关状态轮询与一次性密钥都跟着卡片的生命周期走，关着就零开销。
import { nextTick, onBeforeUnmount, ref } from "vue";
import LinkConnectCard from "./LinkConnectCard.vue";

const emit = defineEmits<{ "open-settings": [] }>();

const open = ref(false);
const btn = ref<HTMLElement | null>(null);
const card = ref<HTMLElement | null>(null);
const pos = ref({ left: 0, bottom: 0 });

const GAP = 8;
const MARGIN = 8;

function place() {
  const r = btn.value?.getBoundingClientRect();
  if (!r) return;
  const w = card.value?.offsetWidth ?? 320;
  // 卡片左缘对齐按钮、贴着按钮上沿；右侧放不下就整体左移，别被窗口裁掉
  const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - w - MARGIN));
  pos.value = { left, bottom: window.innerHeight - r.top + GAP };
}

function onDocPointerDown(e: PointerEvent) {
  const t = e.target as Node;
  if (card.value?.contains(t) || btn.value?.contains(t)) return;
  close();
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") close();
}

async function toggle() {
  if (open.value) return close();
  place();
  open.value = true;
  document.addEventListener("pointerdown", onDocPointerDown, true);
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", place);
  await nextTick();
  place(); // 卡片挂上后才知道真实宽度
}

function close() {
  open.value = false;
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  document.removeEventListener("keydown", onKey);
  window.removeEventListener("resize", place);
}

function openSettings() {
  close();
  emit("open-settings");
}

onBeforeUnmount(close);
</script>

<template>
  <button
    ref="btn"
    class="status-bar-btn link-connect-btn"
    :class="{ active: open }"
    v-tooltip="'连接移动端'"
    data-testid="link-connect-btn"
    @click="toggle"
  >
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="6" y="2" width="12" height="20" rx="2.5"/>
      <path d="M11 18h2"/>
    </svg>
    <!-- 卡片放在按钮里面只为保持**单根节点**：父级（SidebarLeft）scoped 的 .status-bar-btn 样式要落到根元素上，
         多根（fragment）会丢；Teleport 把它实际挂到 body，DOM 上并不在按钮内 -->
    <Teleport to="body">
      <div v-if="open" ref="card" class="link-connect-pop" :style="{ left: `${pos.left}px`, bottom: `${pos.bottom}px` }" @click.stop>
        <LinkConnectCard @open-settings="openSettings" />
      </div>
    </Teleport>
  </button>
</template>

<style scoped>
/* 按钮外观沿用 SidebarLeft 的 .status-bar-btn（父级 scoped 样式会作用到子组件根元素）；
   这里只补「卡片开着」的按下态 */
.link-connect-btn.active {
  color: var(--aide-text-primary);
  background: var(--aide-surface-default);
}
.link-connect-pop {
  position: fixed;
  z-index: 9000;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg);
  box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
}
</style>
