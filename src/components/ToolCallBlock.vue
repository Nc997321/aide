<script setup lang="ts">
import { ref, computed } from "vue";
import type { ToolCallBlock } from "@/types/chat";
import BashOutputBlock from "./BashOutputBlock.vue";
import { parseEditInput, buildEditDiffLines, type EditDiffStats } from "@/utils/editDiff";
import { summarizeToolInput } from "@/utils/toolSummary";

const props = defineProps<{ block: ToolCallBlock }>();
const expanded = ref(false);

const statusIcon = computed(() => {
  if (props.block.isPending) return "⏳";
  if (props.block.isError) return "❌";
  return "✅";
});

const isBash = computed(() => props.block.name === "Bash");

/** Edit 工具且非错误时的 diff 数据；null 表示回退到普通结果文本展示。 */
const editDiff = computed<EditDiffStats | null>(() => {
  if (props.block.name !== "Edit" || props.block.isError) return null;
  const parsed = parseEditInput(props.block.input);
  if (!parsed) return null;
  return buildEditDiffLines(parsed);
});

const inputSummary = computed(() => summarizeToolInput(props.block.name, props.block.input));
</script>

<template>
  <div class="tool-block">
    <button class="tool-header" @click="expanded = !expanded">
      <span class="tool-status">{{ statusIcon }}</span>
      <span class="tool-name">{{ block.name }}</span>
      <span class="tool-summary">{{ inputSummary }}</span>
      <span v-if="editDiff" class="tool-diff-stat">
        <span class="stat-add">+{{ editDiff.addCount }}</span>
        <span class="stat-del">-{{ editDiff.delCount }}</span>
      </span>
      <span class="tool-chevron">{{ expanded ? "▲" : "▼" }}</span>
    </button>
    <div v-if="expanded" class="tool-body">
      <BashOutputBlock v-if="isBash && block.result" :content="block.result" :is-error="block.isError ?? false" />
      <pre v-else-if="editDiff" class="tool-result tool-diff"><span v-for="(line, i) in editDiff.lines" :key="i" :class="line.cls">{{ line.text }}</span></pre>
      <pre v-else-if="block.result" class="tool-result">{{ block.result }}</pre>
      <div v-else class="tool-pending">等待结果…</div>
    </div>
  </div>
</template>

<style scoped>
.tool-block {
  margin: 4px 0;
  border-radius: var(--aide-radius-sm);
  border: 1px solid var(--aide-border);
  background: var(--aide-bg-raised);
  font-size: 12px;
  overflow: hidden;
}

.tool-header {
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

.tool-header:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}

.tool-status {
  flex-shrink: 0;
  font-size: 11px;
}

.tool-name {
  font-weight: 600;
  color: var(--aide-text-secondary);
  flex-shrink: 0;
}

.tool-summary {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  color: var(--aide-text-muted);
}

.tool-chevron {
  flex-shrink: 0;
  font-size: 9px;
}

.tool-body {
  border-top: 1px solid var(--aide-border);
  padding: 6px 8px;
}

.tool-result {
  max-height: 160px;
  overflow: auto;
  white-space: pre-wrap;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  font-size: 11px;
  color: var(--aide-text-secondary);
  margin: 0;
}

.tool-diff {
  white-space: pre;
}

.tool-diff-stat {
  flex-shrink: 0;
  display: flex;
  gap: 4px;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  font-size: 11px;
}

.stat-add {
  color: var(--aide-success);
}

.stat-del {
  color: var(--aide-danger);
}

.tool-pending {
  font-style: italic;
  color: var(--aide-text-muted);
}
</style>
