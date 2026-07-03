<script setup lang="ts">
import { ref, computed } from "vue";
import type { SubagentBlock } from "@/types/chat";

const props = defineProps<{ block: SubagentBlock }>();
const expanded = ref(false);

const statusIcon = computed(() => {
  if (props.block.isPending) return "⏳";
  if (props.block.isError) return "❌";
  return "✅";
});
</script>

<template>
  <div class="subagent-block">
    <button class="subagent-header" @click="expanded = !expanded">
      <span class="subagent-status">{{ statusIcon }}</span>
      <span class="subagent-icon">🧩</span>
      <span class="subagent-name">{{ block.agentName }}</span>
      <span class="subagent-desc">{{ block.description }}</span>
      <span class="subagent-chevron">{{ expanded ? "▲" : "▼" }}</span>
    </button>
    <div v-if="expanded" class="subagent-body">
      <pre v-if="block.result" class="subagent-result">{{ block.result }}</pre>
      <div v-else class="subagent-pending">子代理执行中…</div>
    </div>
  </div>
</template>

<style scoped>
.subagent-block {
  margin: 4px 0;
  border-radius: var(--aide-radius-sm);
  border: 1px solid var(--aide-border);
  background: var(--aide-bg-raised);
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
  background: var(--aide-surface-hover);
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
  color: var(--aide-text-secondary);
  flex-shrink: 0;
}

.subagent-desc {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--aide-text-muted);
}

.subagent-chevron {
  flex-shrink: 0;
  font-size: 9px;
}

.subagent-body {
  border-top: 1px solid var(--aide-border);
  padding: 6px 8px;
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
