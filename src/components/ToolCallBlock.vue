<script setup lang="ts">
import { ref, computed } from "vue";
import type { ToolCallBlock } from "@/types/chat";
import BashOutputBlock from "./BashOutputBlock.vue";

const props = defineProps<{ block: ToolCallBlock }>();
const expanded = ref(false);

const statusIcon = computed(() => {
  if (props.block.isPending) return "⏳";
  if (props.block.isError) return "❌";
  return "✅";
});

const isBash = computed(() => props.block.name === "Bash");
const inputSummary = computed(() => {
  const input = props.block.input as Record<string, unknown>;
  if (props.block.name === "Bash") return String(input?.command ?? "");
  if (["Read", "Write", "Edit"].includes(props.block.name))
    return String(input?.file_path ?? "");
  return JSON.stringify(input).slice(0, 80);
});
</script>

<template>
  <div class="tool-block">
    <button class="tool-header" @click="expanded = !expanded">
      <span class="tool-status">{{ statusIcon }}</span>
      <span class="tool-name">{{ block.name }}</span>
      <span class="tool-summary">{{ inputSummary }}</span>
      <span class="tool-chevron">{{ expanded ? "▲" : "▼" }}</span>
    </button>
    <div v-if="expanded" class="tool-body">
      <BashOutputBlock v-if="isBash && block.result" :content="block.result" :is-error="block.isError ?? false" />
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

.tool-pending {
  font-style: italic;
  color: var(--aide-text-muted);
}
</style>
