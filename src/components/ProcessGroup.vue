<script setup lang="ts">
/**
 * 过程胶囊（ProcessGroup）：定稿消息里 ≥2 个连续过程段（思考/查询工具组/子代理）
 * 合并成的折叠卡——收起（默认）= 一行摘要「过程 | N 段思考 · M 次工具调用」；
 * 展开 = 段内各段按原序渲染（复用 ThinkingBlock / ToolCallGroup / SubagentCallBlock）。
 *
 * 只装"过程"：文本块（回复）与变更卡从不在段内——分段层保证（blockSegments.ts
 * 二阶段），这里不做防御。process 段只在定稿后产生，故内部没有流式态要处理
 * （ThinkingBlock 不传 streaming、ToolCallGroup 不传 live）。展开状态不持久化，
 * 随窗口化卸载重置（与 ToolCallGroup 一致）。
 */
import { computed, ref } from "vue";
import type { BgTask } from "@/types/chat";
import ToolCallGroup from "./ToolCallGroup.vue";
import ThinkingBlock from "./ThinkingBlock.vue";
import SubagentCallBlock from "./SubagentCallBlock.vue";
import { processStats, type Segment } from "@/utils/blockSegments";

const props = defineProps<{
  /** process 段内的原始段（原序）：tool_group / block(thinking) / block(subagent) */
  segments: Segment[];
  /** 后台任务列表（ChatMessage 链透传）——段内 ToolCallGroup 的徽章数据源 */
  bgTasks?: BgTask[];
}>();

const emit = defineEmits<{
  /** 工具卡片徽章点击：打开后台任务 dock 并选中该任务 */
  "open-bg-dock": [taskId: string];
}>();

const expanded = ref(false);

const stats = computed(() => processStats(props.segments));

/** 摘要：「4 段思考 · 9 次工具调用 · 1 个子代理」，缺项不出现；失败数单独红色徽章。 */
const summary = computed(() => {
  const parts: string[] = [];
  if (stats.value.thinkingCount > 0) parts.push(`${stats.value.thinkingCount} 段思考`);
  if (stats.value.toolTotal > 0) parts.push(`${stats.value.toolTotal} 次工具调用`);
  if (stats.value.subagentCount > 0) parts.push(`${stats.value.subagentCount} 个子代理`);
  return parts.join(" · ");
});
</script>

<template>
  <div class="process-group" :class="{ 'process-group--open': expanded }">
    <button class="pg-head" :aria-expanded="expanded" @click="expanded = !expanded">
      <span class="pg-caret" aria-hidden="true"></span>
      <span class="pg-pill">过程</span>
      <span class="pg-summary">{{ summary }}</span>
      <span v-if="stats.toolErrorCount > 0" class="pg-err">{{ stats.toolErrorCount }} 失败</span>
    </button>
    <div v-if="expanded" class="pg-body">
      <template v-for="seg in segments" :key="seg.index">
        <ToolCallGroup
          v-if="seg.kind === 'tool_group'"
          :blocks="seg.blocks"
          :bg-tasks="bgTasks"
          @open-bg-dock="(taskId: string) => emit('open-bg-dock', taskId)"
        />
        <ThinkingBlock
          v-else-if="seg.kind === 'block' && seg.block.type === 'thinking'"
          :text="seg.block.text"
        />
        <SubagentCallBlock
          v-else-if="seg.kind === 'block' && seg.block.type === 'subagent'"
          :block="(seg.block as any)"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 过程胶囊：视觉沿用 ToolCallGroup 的摘要卡语言（bg-base + 细边 + 内高光） */
.process-group {
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-md);
  box-shadow: var(--aide-highlight-inset);
  overflow: hidden;
}

.pg-head {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px 12px;
  cursor: pointer;
  border: 0;
  background: transparent;
  text-align: left;
  font-size: 12px;
  color: var(--aide-text-secondary);
  transition: background var(--aide-ease-t);
}
.pg-head:hover {
  background: var(--aide-surface-default);
}

.pg-caret {
  flex-shrink: 0;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  border-left: 5px solid var(--aide-text-muted);
  opacity: 0.7;
  transition: transform var(--aide-ease-t);
}
.pg-head[aria-expanded="true"] .pg-caret {
  transform: rotate(90deg);
}

.pg-pill {
  flex-shrink: 0;
  padding: 1px 8px;
  border-radius: 99px;
  background: var(--aide-surface-active);
  border: 1px solid var(--aide-border);
  font-size: 10.5px;
  font-weight: 600;
  color: var(--aide-text-primary);
}

.pg-summary {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--aide-text-muted);
}

.pg-err {
  flex-shrink: 0;
  color: var(--aide-danger);
}

/* 展开体：限高内滚（阅读模式，同 ThinkingBlock 非流式的 overflow:auto） */
.pg-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--aide-border-subtle);
  padding: 10px 12px;
  max-height: 440px;
  overflow: auto;
}

@media (prefers-reduced-motion: reduce) {
  .pg-caret {
    transition: none;
  }
}
</style>
