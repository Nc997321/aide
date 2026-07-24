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
    <button class="tg-summary" :aria-expanded="expanded" @click="expanded = !expanded">
      <template v-if="running">
        <span class="tg-label">正在执行</span> <span class="tg-name">{{ running.name }}</span>
        <span class="tg-kinds">{{ runningSummary }}</span>
        <span v-if="doneCount > 0" class="tg-label"> · 已完成 {{ doneCount }}</span>
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
/* 工具组：GALLERY .tc-group-row 计数胶囊卡片 */
.tool-group {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
}

/* 时间线节点在卡片化组中不再显示 */
.tg-node {
  display: none;
}

.tg-summary {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  text-align: left;
  font-size: 12px;
  color: var(--aide-text-secondary);
  padding: 8px 12px;
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-md);
  cursor: pointer;
  box-shadow: var(--aide-highlight-inset);
  transition: background var(--aide-ease-t);
}
.tg-summary:hover {
  background: var(--aide-surface-default);
}

/* 计数胶囊 */
.tg-n {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 19px;
  height: 19px;
  padding: 0 6px;
  border-radius: 99px;
  background: var(--aide-surface-active);
  border: 1px solid var(--aide-border);
  font-size: 10.5px;
  font-weight: 600;
  color: var(--aide-text-primary);
}

/* 固定项不可收缩：收缩压力只落在 .tg-kinds 上，否则长命令会把
   "正在执行"/工具名挤成逐字竖排（匿名文本项 flex-shrink 默认 1） */
.tg-label {
  flex-shrink: 0;
  white-space: nowrap;
}

.tg-name {
  color: var(--aide-accent);
  font-weight: 600;
  flex-shrink: 0;
  white-space: nowrap;
}
.tg-name,
.tg-kinds {
  font-family: var(--aide-font-mono);
}
.tg-kinds {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--aide-text-muted);
}
.tg-err {
  color: var(--aide-danger);
}

.tg-items {
  display: flex;
  flex-direction: column;
  margin-left: 8px;
}
</style>
