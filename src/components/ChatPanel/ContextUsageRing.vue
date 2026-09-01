<script setup lang="ts">
/**
 * ContextUsageRing —— 上下文用量的静态环形指示（发送按钮左侧）。
 *
 * 纯展示 + 点击转发：单色进度环只表达「用了几成」（分段明细收进弹层
 * ContextUsagePanel）。几何取自 usage.html 原型的 ring（36 视图坐标 / 20px 渲染）。
 * 进度弧颜色状态联动：正常 accent → ≥80% warning → 超限 danger（设计稿 §3.1）。
 * 全配色走 var(--aide-*)，不硬编码 hex。
 */
import { computed } from "vue";
import type { ContextUsage } from "@/types/chat";
import { clampPct } from "./contextUsage";

const props = defineProps<{
  /** 会话的上下文用量快照；null（无数据/旧 sidecar）时不渲染由父守卫，进来就保证非空。 */
  usage: ContextUsage;
}>();

const emit = defineEmits<{
  /** 用户点击环形 → 请求打开用量弹层（锚定本元素，父负责）。 */
  (e: "open"): void;
}>();

// SVG 36 视图坐标里的圆半径（原型同款）；CIRC = 周长，dashoffset 全量=空环。
const RADIUS = 15;
const CIRC = 2 * Math.PI * RADIUS;

const pct = computed(() => clampPct(props.usage.percentage));
const dashOffset = computed(() => CIRC * (1 - pct.value / 100));
const level = computed(() =>
  pct.value >= 100 ? "danger" : pct.value >= 80 ? "warning" : "ok",
);
const tooltip = computed(
  () =>
    `上下文用量：${props.usage.totalTokens.toLocaleString()} / ${props.usage.maxTokens.toLocaleString()} tokens`,
);
</script>

<template>
  <button
    type="button"
    class="usage-ring"
    :class="`usage-ring--${level}`"
    :aria-label="tooltip"
    v-tooltip="tooltip"
    @click="emit('open')"
  >
    <svg width="20" height="20" viewBox="0 0 36 36" aria-hidden="true">
      <circle class="usage-ring__track" cx="18" cy="18" :r="RADIUS" fill="none" stroke-width="3" />
      <circle
        class="usage-ring__arc"
        cx="18"
        cy="18"
        :r="RADIUS"
        fill="none"
        stroke-width="3"
        stroke-linecap="round"
        :stroke-dasharray="CIRC"
        :stroke-dashoffset="dashOffset"
        transform="rotate(-90 18 18)"
      />
    </svg>
  </button>
</template>

<style scoped>
.usage-ring {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  background: none;
  border-radius: 50%;
  cursor: pointer;
  color: var(--aide-text-muted);
  transition: background var(--aide-ease-t);
}
.usage-ring:hover {
  background: var(--aide-surface-hover);
}
.usage-ring__track {
  stroke: var(--aide-border-strong);
}
.usage-ring__arc {
  stroke: var(--aide-accent);
  transition: stroke-dashoffset var(--aide-ease-t), stroke 0.15s ease;
}
.usage-ring--warning .usage-ring__arc {
  stroke: var(--aide-warning);
}
.usage-ring--danger .usage-ring__arc {
  stroke: var(--aide-danger);
}
</style>