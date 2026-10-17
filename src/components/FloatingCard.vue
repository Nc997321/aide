<script setup lang="ts">
/**
 * 浮窗外壳：贴着一个锚点矩形弹出的卡片（Teleport 到 body、fixed 定位）。
 * 消息里选中文字「派给子会话」、＋ 菜单「新建子会话」共用；知识库圈选浮窗日后换到这里。
 *
 * 只管位置、外观与收起（点外部 / Esc），内容走默认插槽。锚点用函数给：内容滚动、选区还在时
 * 每次重算都取最新位置；取不到（选区没了）就停在上一次的位置。
 * 收起规则同 ComposerPopover：Esc 打 preventDefault，PermissionDialog 的 window 级 Esc 见了让路。
 * 登记成浮层（v-overlay-layer）：卡里有输入框、回车即提交，开着时权限弹窗的 window 级
 * Enter/Esc 不许穿透过来；内嵌浏览器的原生视图也据此让位，不把卡片吃掉。
 */
import { nextTick, onUnmounted, ref, watch } from "vue";
import type { AnchorRect } from "./floatingCard";
import { vOverlayLayer } from "@/directives/overlayLayer";

const props = withDefaults(
  defineProps<{
    open: boolean;
    anchor: () => AnchorRect | null;
    /** 优先往哪边弹；放不下自动翻到另一边 */
    prefer?: "below" | "above";
    width?: number;
    label: string;
    /** 点外部是否收起（写了一半的内容不想被误点丢掉时关掉） */
    closeOnOutside?: boolean;
  }>(),
  { prefer: "below", width: 460, closeOnOutside: true },
);

const emit = defineEmits<{ close: [] }>();

const cardEl = ref<HTMLElement | null>(null);
const style = ref<Record<string, string>>({});
const last = ref<AnchorRect | null>(null);

const MARGIN = 8;
const GAP = 8;

async function position() {
  const a = props.anchor() ?? last.value;
  if (!a) return;
  last.value = a;
  await nextTick();
  const h = cardEl.value?.offsetHeight ?? 0;
  const w = Math.min(props.width, window.innerWidth - MARGIN * 2);
  const roomBelow = window.innerHeight - a.bottom - GAP - MARGIN;
  const roomAbove = a.top - GAP - MARGIN;
  const below = props.prefer === "below" ? roomBelow >= h || roomBelow >= roomAbove : !(roomAbove >= h || roomAbove >= roomBelow);
  const top = below ? a.bottom + GAP : a.top - GAP - h;
  const left = Math.min(Math.max(MARGIN, a.left), window.innerWidth - w - MARGIN);
  style.value = {
    top: `${Math.max(MARGIN, Math.min(top, window.innerHeight - h - MARGIN))}px`,
    left: `${left}px`,
    width: `${w}px`,
  };
}

function onDocPointer(e: PointerEvent) {
  if (!props.closeOnOutside) return;
  if (cardEl.value?.contains(e.target as Node)) return;
  emit("close");
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    emit("close");
  }
}

let ro: ResizeObserver | null = null;
function detach() {
  document.removeEventListener("pointerdown", onDocPointer, true);
  document.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", reposition);
  document.removeEventListener("scroll", reposition, true);
  ro?.disconnect();
  ro = null;
}
function reposition() {
  void position();
}

watch(
  () => props.open,
  async (v) => {
    if (!v) {
      detach();
      last.value = null;
      return;
    }
    await position();
    document.addEventListener("pointerdown", onDocPointer, true);
    document.addEventListener("keydown", onKeydown);
    window.addEventListener("resize", reposition);
    document.addEventListener("scroll", reposition, true);
    // 内容长高（输入框撑高 / 出错提示）时重新贴边
    if (typeof ResizeObserver !== "undefined" && cardEl.value) {
      ro = new ResizeObserver(reposition);
      ro.observe(cardEl.value);
    }
  },
  { immediate: true },
);

onUnmounted(detach);
defineExpose({ reposition });
</script>

<template>
  <Teleport to="body">
    <div v-if="open" ref="cardEl" v-overlay-layer class="fcard" role="dialog" :aria-label="label" :style="style">
      <slot />
    </div>
  </Teleport>
</template>

<style scoped>
.fcard {
  position: fixed;
  z-index: 9000; /* 与弹层 / 菜单同层（ComposerPopover、ContextMenu），高于 ModalDialog（1200） */
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border-radius: var(--aide-radius-lg);
  border: 1px solid var(--aide-border-strong);
  background: var(--aide-bg-raised);
  box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  animation: fcard-in 150ms var(--aide-ease, ease-out);
}
@keyframes fcard-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
