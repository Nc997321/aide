<script setup lang="ts">
import { ref, computed } from "vue";
import type { SubagentBlock, SubagentEntry } from "@/types/chat";
import { summarizeToolInput } from "@/utils/toolSummary";

const props = defineProps<{ block: SubagentBlock }>();
const expanded = ref(false);

const statusIcon = computed(() => {
  if (props.block.isPending) return "⏳";
  if (props.block.isError) return "❌";
  return "✅";
});

function stepSummary(entry: Extract<SubagentEntry, { type: "tool" }>): string {
  return summarizeToolInput(entry.toolName, entry.input);
}
</script>

<template>
  <div class="subagent-block">
    <button class="subagent-header" @click="expanded = !expanded">
      <span class="subagent-status">{{ statusIcon }}</span>
      <span class="subagent-icon">🧩</span>
      <span class="subagent-name">{{ block.agentName }}</span>
      <span v-if="block.model" class="subagent-model" :title="`子代理使用的模型：${block.model}`">{{ block.model }}</span>
      <span class="subagent-desc">{{ block.description }}</span>
      <span v-if="block.isPending && block.entries.length" class="subagent-step-count">
        {{ block.entries.length }} 项
      </span>
      <span class="subagent-chevron">{{ expanded ? "▲" : "▼" }}</span>
    </button>
    <div v-if="expanded" class="subagent-body">
      <ol v-if="block.entries.length" class="subagent-entries">
        <li v-for="(entry, i) in block.entries" :key="i" class="subagent-entry" :class="`entry-${entry.type}`">
          <template v-if="entry.type === 'tool'">
            <span class="step-tool">{{ entry.toolName }}</span>
            <span class="step-summary">{{ stepSummary(entry) }}</span>
          </template>
          <p v-else class="entry-text-body">{{ entry.text }}</p>
        </li>
      </ol>
      <pre v-if="block.result" class="subagent-result">{{ block.result }}</pre>
      <div v-else-if="!block.entries.length" class="subagent-pending">子代理执行中…</div>
    </div>
  </div>
</template>

<style scoped>
/* 左侧色条 + 独立底色，让子代理卡片一眼区别于普通 ToolCallBlock（同尺寸但视觉上
 * 明确"这是一个嵌套的子进程"，而不是主流程里的一次工具调用）。 */
.subagent-block {
  margin: 4px 0;
  border-radius: var(--aide-radius-sm);
  border: 1px solid var(--aide-border);
  border-left: 3px solid var(--aide-accent);
  background: color-mix(in srgb, var(--aide-accent) 6%, var(--aide-bg-raised));
  font-size: 12px;
  overflow: hidden;
}

.subagent-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 8px;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--aide-text-muted);
  text-align: left;
  transition: background 0.1s;
}

.subagent-header:hover {
  background: color-mix(in srgb, var(--aide-accent) 10%, transparent);
  color: var(--aide-text-primary);
}

.subagent-status {
  flex-shrink: 0;
  font-size: 11px;
}

.subagent-icon {
  flex-shrink: 0;
  font-size: 11px;
}

.subagent-name {
  font-weight: 600;
  color: var(--aide-accent);
  flex-shrink: 0;
}

.subagent-model {
  flex-shrink: 0;
  font-size: 10px;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  color: var(--aide-text-muted);
  border: 1px solid var(--aide-border);
  border-radius: 4px;
  padding: 0 4px;
}

.subagent-desc {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--aide-text-muted);
}

.subagent-step-count {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--aide-text-muted);
  font-style: italic;
}

.subagent-chevron {
  flex-shrink: 0;
  font-size: 9px;
}

.subagent-body {
  border-top: 1px solid var(--aide-border);
  padding: 6px 8px;
}

.subagent-entries {
  margin: 0 0 6px;
  padding-left: 16px;
  max-height: 240px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.subagent-entry {
  font-size: 11px;
}

.subagent-entry.entry-tool {
  display: flex;
  gap: 6px;
}

.step-tool {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--aide-text-secondary);
}

.step-summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  color: var(--aide-text-muted);
}

.entry-text-body {
  margin: 0;
  white-space: pre-wrap;
  color: var(--aide-text-secondary);
}

/* thinking 弱化样式，呼应原生 CLI 里 thinking 的视觉弱化处理——一眼能跟正式回复
 * 的文本区分开，不用去读内容就知道"这是内心戏还是真的在说话"。 */
.subagent-entry.entry-thinking .entry-text-body {
  color: var(--aide-text-muted);
  font-style: italic;
  opacity: 0.85;
}

.subagent-result {
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 12px;
  color: var(--aide-text-secondary);
  margin: 0;
}

.subagent-pending {
  font-style: italic;
  color: var(--aide-text-muted);
}
</style>
