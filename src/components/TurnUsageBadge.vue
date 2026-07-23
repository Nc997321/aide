<script setup lang="ts">
/**
 * 一轮 assistant 消息的 token/费用小徽章——用 ↓/↑ 方向图标代替之前的
 * "36108→150170 tokens" 文字箭头。之前的箭头写法容易被误读成"从 A 涨到 B"，
 * 其实左右是两个独立的量（喂给模型的输入 / 模型吐出来的输出），跟网络监控里
 * 下载/上传箭头是同一套视觉语言，不需要额外解释就能看懂方向。
 *
 * 精确数字、cache 命中明细、费用放进 title tooltip，徽章本身只给"量级感"
 * （36.1k 而不是 36108），细节留给想深究的人去悬停查看。
 */
import { computed } from "vue";
import type { TurnUsage } from "@/types/chat";
import { formatCompactNumber } from "@/utils/format";

const props = defineProps<{ usage: TurnUsage }>();

const tooltip = computed(() => {
  const u = props.usage;
  const lines = [
    `输入 ${u.inputTokens.toLocaleString()} tokens`,
    `输出 ${u.outputTokens.toLocaleString()} tokens（含本轮所有工具调用/子代理产出）`,
  ];
  if (u.cacheReadInputTokens > 0 || u.cacheCreationInputTokens > 0) {
    lines.push(
      `缓存命中 ${u.cacheReadInputTokens.toLocaleString()} · 新写入缓存 ${u.cacheCreationInputTokens.toLocaleString()}`,
    );
  }
  lines.push(`这一轮花费 $${u.costUsd.toFixed(4)}`);
  return lines.join("\n");
});
</script>

<template>
  <div class="turn-usage" :title="tooltip">
    <span class="tu-item tu-in">↓ {{ formatCompactNumber(usage.inputTokens) }}</span>
    <span class="tu-item tu-out">↑ {{ formatCompactNumber(usage.outputTokens) }}</span>
    <span class="tu-cost">${{ usage.costUsd.toFixed(4) }}</span>
  </div>
</template>

<style scoped>
.turn-usage {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-family: var(--aide-font-mono);
  cursor: default;
}

.tu-item {
  display: inline-flex;
  align-items: center;
  gap: 1px;
}

/* ↓ 输入（喂给模型看的）：偏中性的信息色，呼应项目里"info"语义 */
.tu-in {
  color: var(--aide-info);
}

/* ↑ 输出（模型吐出来的，含工具调用/子代理产出）：偏强调的成功色，
 * 跟 ToolCallBlock 的 diff "+N" 用同一套绿色语言，都是"产出/增量"的意思 */
.tu-out {
  color: var(--aide-success);
}

.tu-cost {
  color: var(--aide-text-muted);
}
</style>
