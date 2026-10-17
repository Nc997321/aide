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
 * 往上翻历史、看不到这一行时，活动带补一个精简的「思考中」：本行用 IntersectionObserver 报告自己在不在
 * 可视区（`in-view`），ChatPanel 据此告诉活动带。中断按钮始终在活动带。
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
  elapsedSeconds: number;
  tip: UsageTip | null;
}>();

const emit = defineEmits<{
  /** 这一格是否在消息区的可视范围里（往上翻走了 → false，活动带补「思考中」） */
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

let io: IntersectionObserver | null = null;
onMounted(() => {
  const node = el.value;
  if (!node || typeof IntersectionObserver === "undefined") return;
  io = new IntersectionObserver(([entry]) => emit("in-view", entry.isIntersecting), {
    root: node.closest(".chat-messages"),
    threshold: 0.6,
  });
  io.observe(node);
});

onBeforeUnmount(() => {
  clearTimeout(timer);
  io?.disconnect();
  io = null;
});
</script>

<template>
  <div ref="el" class="tline" role="status" :aria-hidden="!shown">
    <div class="tline-row" :class="{ 'tline-row--on': shown }">
      <ThinkingMark :size="16" />
      <span class="tline-text">正在思考</span>
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
