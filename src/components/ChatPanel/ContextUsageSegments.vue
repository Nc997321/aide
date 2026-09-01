<script setup lang="ts">
/**
 * ContextUsageSegments —— 上下文用量的分段彩条（弹层内专用）。
 *
 * 每个分类一段（宽 = tokens/完整窗），段间 2px surface 间隙；末尾「保留用于
 * 模型响应」的条纹段占 [maxTokens, rawMaxTokens] 区间（不是分类，不占色板，
 * 画底层被分类段压盖——正常态分类段走不到那里，超限态可见重叠）。track 余下
 * 空白即空闲区。数据缺省（无 categories）时只画条纹段。
 */
import { computed } from "vue";
import type { ContextUsage } from "@/types/chat";
import { chartVarFor, formatTokens } from "./contextUsage";

const props = defineProps<{
  usage: ContextUsage;
}>();

interface Segment {
  readonly name: string;
  readonly tokens: number;
  readonly isDeferred: boolean;
  readonly color: string;
  readonly widthPct: number;
}

/** 宽度基准 = 完整窗（含保留区）；缺省回退 maxTokens（旧数据无条纹段口径）。 */
const total = computed(() => props.usage.rawMaxTokens ?? props.usage.maxTokens);

const segments = computed<readonly Segment[]>(() =>
  (props.usage.categories ?? [])
    .filter((c) => c.tokens > 0)
    .map((c) => ({
      name: c.name,
      tokens: c.tokens,
      isDeferred: c.isDeferred ?? false,
      color: chartVarFor(c.name),
      widthPct: (c.tokens / Math.max(1, total.value)) * 100,
    })),
);

/** 保留区占完整窗的比例；无 rawMaxTokens 或 maxTokens≥rawMax 时不画。 */
const reservedPct = computed(() => {
  const { rawMaxTokens, maxTokens } = props.usage;
  if (!rawMaxTokens || rawMaxTokens <= maxTokens) return 0;
  return ((rawMaxTokens - maxTokens) / rawMaxTokens) * 100;
});
</script>

<template>
  <div class="usage-segments">
    <div
      v-for="s in segments"
      :key="s.name"
      class="usage-segments__seg"
      :class="{ 'usage-segments__seg--deferred': s.isDeferred }"
      :style="{ width: `${s.widthPct}%`, background: s.color }"
      v-tooltip="`${s.name} ~${formatTokens(s.tokens)}`"
    />
    <div class="usage-segments__free" />
    <div
      v-if="reservedPct > 0"
      class="usage-segments__reserved"
      :style="{ width: `${reservedPct}%` }"
      v-tooltip="'保留用于模型响应'"
    />
  </div>
</template>

<style scoped>
.usage-segments {
  display: flex;
  gap: 2px;
  height: 8px;
  border-radius: 4px;
  background: var(--aide-surface-hover);
  overflow: hidden;
}
.usage-segments__seg {
  min-width: 2px;
  border-radius: 2px;
  transition: opacity 0.15s ease;
}
.usage-segments__seg:hover {
  opacity: 0.85;
}
.usage-segments__seg--deferred {
  opacity: 0.6;
}
.usage-segments__free {
  flex: 1;
}
/* 保留区：45° 条纹 + 中性半透明——不是分类，不占色板 */
.usage-segments__reserved {
  min-width: 2px;
  border-radius: 2px;
  background: repeating-linear-gradient(
    45deg,
    var(--aide-border-strong),
    var(--aide-border-strong) 2px,
    transparent 2px,
    transparent 5px
  );
  opacity: 0.55;
}
</style>