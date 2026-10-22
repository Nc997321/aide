<script setup lang="ts">
/**
 * 消息流末尾的「正在思考」行（跟着会话走：就在当前这轮回答的下面）。
 *
 * 这一行以前在消息流里待过，后来搬去输入框上方。这回搬回来，**防闪三条**：
 * 1. **槽位常驻、高度固定**：不论在不在想，消息流末尾都有这一格同样高的位置，思考行只在里面
 *    淡入淡出（opacity）。内容高度永远不因它变化——消息区的「内容一变高就滚到底」
 *    （useChatScroll 的 ResizeObserver）不会被它来回拉扯，结束那一刻页面也不会往下一跳。
 * 2. **滞回**：出现稍等一下（SHOW_DELAY_MS，排除一闪而过的忙），消失再晚一点（HIDE_DELAY_MS，
 *    两轮之间、排队消息接上时那一瞬的「不忙」不让它灭了又亮）。
 * 3. **只挂一次**：放在消息行列表外面（ChatPanel 里 rows 之后），不随某条消息重渲染，
 *    光带动画与计时不会被打断重来。
 *
 * 往上翻历史、看不到这一行时，活动带补一个精简的「思考中」：本行报告自己在不在消息区可视范围
 * （`in-view`），ChatPanel 据此告诉活动带。中断按钮始终在活动带。
 *
 * 「在不在」是**直接量出来的**（本行与滚动容器的矩形求交，露出 ≥60% 算在），在三个时机重量：
 * 挂载、容器滚动（rAF 合并）、计时每跳一秒。以前只靠 IntersectionObserver 的事件，工作机上
 * 出现过漏报一次就一直卡在「看不见」——本行明明在眼前，活动带又亮一个「思考中」，两个计时并排。
 * 每秒重量一次让任何漏报最多活 1 秒。
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import ThinkingMark from "../activity/ThinkingMark.vue";
import UsageTipText from "./UsageTipText.vue";
import type { UsageTip } from "./usageTips";

const SHOW_DELAY_MS = 150;
const HIDE_DELAY_MS = 450;

const props = defineProps<{
  /** 此刻在想（忙且没有在等用户作答、不在压缩） */
  active: boolean;
  /** 这一轮的状态词（「琢磨中」…，见 workingVerbs.ts）；不说「思考」，免得和消息里模型的「正在思考…」撞 */
  label: string;
  elapsedSeconds: number;
  tip: UsageTip | null;
}>();

const emit = defineEmits<{
  /** 这一格是否在消息区的可视范围里（往上翻走了 → false，活动带补「思考中」）；只在变化时发 */
  "in-view": [inView: boolean];
}>();

const el = ref<HTMLElement | null>(null);

const shown = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

function settle(v: boolean) {
  shown.value = v;
}

watch(
  () => props.active,
  (on) => {
    clearTimeout(timer);
    timer = setTimeout(() => settle(on), on ? SHOW_DELAY_MS : HIDE_DELAY_MS);
  },
  { immediate: true },
);

/** 露出多少算「看得见」 */
const IN_VIEW_RATIO = 0.6;

let root: HTMLElement | null = null;
let lastInView: boolean | null = null;
let raf = 0;

/** 量一次：本行与滚动容器可视区的竖向交叠比例。没有布局（面板被藏起）按看不见算。 */
function measure() {
  const node = el.value;
  if (!node || !root) return;
  const r = node.getBoundingClientRect();
  const v = root.getBoundingClientRect();
  const overlap = Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top);
  const inView = r.height > 0 && v.height > 0 && overlap / r.height >= IN_VIEW_RATIO;
  if (inView === lastInView) return;
  lastInView = inView;
  emit("in-view", inView);
}

function onRootScroll() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    measure();
  });
}

// 计时每跳一秒、开始想的那一刻都重量一次：内容增长、抽屉开合改变容器高度都不发 scroll，靠这里兜
watch(() => [props.elapsedSeconds, props.active], measure, { flush: "post" });

onMounted(() => {
  root = el.value?.closest<HTMLElement>(".chat-messages") ?? null;
  root?.addEventListener("scroll", onRootScroll, { passive: true });
  measure();
});

onBeforeUnmount(() => {
  clearTimeout(timer);
  root?.removeEventListener("scroll", onRootScroll);
  if (raf) cancelAnimationFrame(raf);
  root = null;
});
</script>

<template>
  <div ref="el" class="tline" role="status" :aria-hidden="!shown">
    <div class="tline-row" :class="{ 'tline-row--on': shown }">
      <ThinkingMark :size="16" />
      <span class="tline-text">{{ label }}</span>
      <span class="tline-elapsed">{{ elapsedSeconds }}s</span>
      <Transition name="tline-tip" mode="out-in">
        <UsageTipText v-if="tip && shown" :key="tip.id" class="tline-tip" :text="tip.text" />
      </Transition>
    </div>
  </div>
</template>

<style scoped>
/* 固定高度的槽位：在不在想都占这一格（见文件头第 1 条），里面一行不折行 */
.tline {
  height: 28px;
  padding: 2px 12px 0 32px;
  box-sizing: border-box;
  overflow: hidden;
}
.tline-row {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 24px;
  min-width: 0;
  white-space: nowrap;
  font-size: 12px;
  color: var(--aide-text-muted);
  opacity: 0;
  transform: translateY(2px);
  transition: opacity 0.22s var(--aide-ease), transform 0.22s var(--aide-ease);
  pointer-events: none;
}
.tline-row--on {
  opacity: 1;
  transform: none;
  pointer-events: auto;
}
/* 不在想的时候连动画也停掉（看不见的东西不费 GPU） */
.tline-row:not(.tline-row--on) :deep(*) {
  animation-play-state: paused;
}

.tline-text {
  flex-shrink: 0;
  font-weight: 500;
  background: linear-gradient(
    90deg,
    var(--aide-text-muted) 0%,
    var(--aide-text-muted) 33%,
    var(--aide-agent-accent) 50%,
    var(--aide-text-muted) 67%,
    var(--aide-text-muted) 100%
  );
  background-size: 300% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: tline-shimmer 2.5s linear infinite;
}
@keyframes tline-shimmer {
  0% {
    background-position: 100% center;
  }
  100% {
    background-position: 0% center;
  }
}

.tline-elapsed {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}

/* 轮换提示：窄了就省略号，永远一行（槽高固定） */
.tline-tip {
  margin-left: 4px;
  min-width: 0;
  overflow: hidden;
}
.tline-tip-enter-active,
.tline-tip-leave-active {
  transition: opacity 0.4s var(--aide-ease);
}
.tline-tip-enter-from,
.tline-tip-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .tline-row {
    transition: none;
  }
  .tline-text {
    animation: none;
  }
}
</style>
