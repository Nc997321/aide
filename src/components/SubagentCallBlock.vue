<script setup lang="ts">
import { computed, ref } from "vue";
import type { SubagentBlock } from "@/types/chat";
import SubagentTimeline from "./subagent/SubagentTimeline.vue";
import NarrationIcon from "./narration/NarrationIcon.vue";
import { subagentStatus, subagentStepCount } from "@/utils/subagent";

/**
 * 消息流里的子代理块：一句旁白（2026-10-20）——「派了一个助手去「…」，用了 8 步」，
 * 点开才在原位展开完整时间线。「有几个在跑 / 跑到哪了」交给输入框上方的子代理 dock
 * （SubagentDock），消息流只留「这一轮派过谁、结果如何」。
 */
const props = defineProps<{ block: SubagentBlock }>();

const expanded = ref(false);

/** 状态三态：跑 / 完成 / 出错 —— 摘要胶囊、左条、文字色都据它取。 */
const status = computed(() => subagentStatus(props.block));

const stepCount = computed(() => subagentStepCount(props.block));

/** 头行旁白（2026-10-20 旁白改版）：一句话说派助手做什么、做到哪了。 */
const sentence = computed(() => {
  const n = stepCount.value;
  const desc = props.block.description || props.block.agentName;
  if (status.value === "run") return { head: "助手正在", desc, tail: n > 0 ? `…（第 ${n} 步）` : "…" };
  if (status.value === "err") return { head: "派了一个助手去", desc, tail: n > 0 ? `，${n} 步后没成功` : "，没成功" };
  return { head: "派了一个助手去", desc, tail: n > 0 ? `，用了 ${n} 步` : "" };
});

/** 悬停提示：助手类型与模型（不进正文，免得句子里冒出英文类型名）。 */
const headTip = computed(() =>
  [`助手类型：${props.block.agentName}`, props.block.model ? `模型：${props.block.model}` : ""].filter(Boolean).join("\n"),
);
</script>

<template>
  <div class="sa narr-row" :class="`sa--${status}`">
    <!-- 头行就是一句旁白；点开在原位展开完整时间线（与子代理 dock 同一份实现） -->
    <button class="sa-head" :aria-expanded="expanded" @click="expanded = !expanded">
      <span class="sa-icon"><NarrationIcon name="person" /></span>
      <span :class="['sa-text', { 'aide-narr-live': status === 'run' }]" v-tooltip="headTip"
        >{{ sentence.head }}<span class="sa-desc">「{{ sentence.desc }}」</span><span :class="{ 'sa-err': status === 'err' }">{{ sentence.tail }}</span></span
      >
      <svg
        class="sa-chev" :class="{ 'sa-chev--open': expanded }"
        width="8" height="12" viewBox="0 0 8 12" fill="none" aria-hidden="true"
      >
        <path d="M2 1.5l4 4.5-4 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <div v-if="expanded" class="sa-body">
      <SubagentTimeline :block="block" />
    </div>
  </div>
</template>

<style scoped>
.sa-head {
  display: flex;
  align-items: center;
  gap: 9px;
  width: calc(100% + 16px);
  margin: 0 -8px;
  padding: 2px 8px;
  background: none;
  border: none;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  text-align: left;
  font: inherit;
  transition: background var(--aide-ease-t);
}
.sa-head:hover {
  background: var(--aide-surface-default);
}
.sa-icon {
  flex-shrink: 0;
  display: inline-flex;
  color: var(--aide-text-muted);
}
.sa--run .sa-icon { color: var(--aide-accent); }
.sa--err .sa-icon { color: var(--aide-danger); }
.sa-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  line-height: 1.6;
  color: var(--aide-text-secondary);
}
.sa-text:not(.aide-narr-live) .sa-desc {
  color: var(--aide-text-primary);
}
.sa-text:not(.aide-narr-live) .sa-err {
  color: var(--aide-danger);
}
.sa-chev {
  flex-shrink: 0;
  margin-left: auto;
  color: var(--aide-text-muted);
  opacity: 0;
  transition: opacity var(--aide-ease-t), transform var(--aide-ease-t);
}
.sa-head:hover .sa-chev,
.sa-chev--open {
  opacity: 1;
}
.sa-chev--open {
  transform: rotate(90deg);
}
.sa-head:focus-visible {
  outline: 1px solid var(--aide-accent);
  outline-offset: 1px;
}
/* 展开的时间线：缩进 + 细竖线，与合并旁白的展开同一个样子 */
.sa-body {
  margin: 2px 0 4px 6px;
  padding-left: 14px;
  border-left: 1px solid var(--aide-border-subtle);
}
@media (prefers-reduced-motion: reduce) {
  .sa-chev { transition: none; }
}
</style>
