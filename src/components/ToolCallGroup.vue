<script setup lang="ts">
/**
 * 连续工具调用的墨线折叠组（spec·墨线装帧）：
 * 收起（默认）= 挂在铜色垂线上的一行摘要；live 态摘要实时显示正在执行的工具；
 * 展开 = 组内逐条 ToolCallBlock 墨线行。展开状态不持久化，随窗口化卸载重置。
 */
import { computed, ref } from "vue";
import type { ToolCallBlock as ToolCallBlockData } from "@/types/chat";
import ToolCallBlock from "./ToolCallBlock.vue";
import { groupStats } from "@/utils/blockSegments";
import { summarizeToolInput } from "@/utils/toolSummary";

const props = defineProps<{
  blocks: ToolCallBlockData[];
  /** 消息仍在流式生成且本组是最后一段——摘要行进入"正在执行"实时态 */
  live?: boolean;
}>();

const expanded = ref(false);

const stats = computed(() => groupStats(props.blocks));

/** 种类分布按次数降序取前 3，剩余归"…" */
const kindsLabel = computed(() => {
  const top = stats.value.kinds
    .slice(0, 3)
    .map((k) => `${k.name} ×${k.count}`)
    .join(" · ");
  return stats.value.kinds.length > 3 ? `${top} · …` : top;
});

/** 流式态下正在执行的那条（组尾的 pending 块）；null 表示按完成态渲染摘要 */
const running = computed(() => {
  if (!props.live) return null;
  const last = props.blocks[props.blocks.length - 1];
  return last?.isPending ? last : null;
});

const doneCount = computed(() => props.blocks.filter((b) => !b.isPending).length);

const runningSummary = computed(() =>
  running.value ? summarizeToolInput(running.value.name, running.value.input) : "",
);
</script>

<template>
  <div class="tool-group">
    <span :class="['tg-node', running ? 'tg-node--live' : '']"></span>
    <button class="tg-summary" @click="expanded = !expanded">
      <template v-if="running">
        正在执行 <span class="tg-name">{{ running.name }}</span>
        <span class="tg-kinds">{{ runningSummary }}</span>
        <template v-if="doneCount > 0"> · 已完成 {{ doneCount }}</template>
      </template>
      <template v-else>
        <span class="tg-n">{{ stats.total }}</span> 次工具调用
        <span class="tg-kinds">{{ kindsLabel }}</span>
        <span v-if="stats.errorCount > 0" class="tg-err"> · {{ stats.errorCount }} 失败</span>
      </template>
    </button>
    <div v-if="expanded" class="tg-items">
      <ToolCallBlock v-for="b in blocks" :key="b.id" :block="b" />
    </div>
  </div>
</template>

<style scoped>
/* 墨线：1px 铜色垂线 + 行首节点，替代原来的卡片盒子 */
.tool-group {
  position: relative;
  border-left: 1px solid rgba(212, 165, 116, 0.35);
  margin-left: 5px;
  padding: 2px 0 2px 14px;
}

.tg-node {
  position: absolute;
  left: -5px;
  top: 9px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--aide-bg-base);
  border: 1.5px solid var(--aide-accent);
}
.tg-node--live {
  background: var(--aide-accent);
  animation: tg-pulse 1.2s ease-in-out infinite;
}
@keyframes tg-pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(212, 165, 116, 0.5); }
  50% { opacity: 0.55; box-shadow: 0 0 0 4px rgba(212, 165, 116, 0); }
}

.tg-summary {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  color: var(--aide-text-secondary);
  padding: 3px 0;
  transition: color 0.12s;
}
.tg-summary:hover {
  color: var(--aide-text-primary);
}

.tg-n,
.tg-name {
  color: var(--aide-accent);
  font-weight: 600;
}
.tg-name,
.tg-kinds {
  font-family: 'Cascadia Code', 'Consolas', monospace;
}
.tg-kinds {
  color: var(--aide-text-muted);
  margin-left: 8px;
  overflow-wrap: anywhere;
}
.tg-err {
  color: var(--aide-danger);
}

.tg-items {
  display: flex;
  flex-direction: column;
}
</style>
