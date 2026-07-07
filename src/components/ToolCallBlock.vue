<script setup lang="ts">
import { ref, computed } from "vue";
import type { ToolCallBlock } from "@/types/chat";
import BashOutputBlock from "./BashOutputBlock.vue";
import { parseEditInput, buildEditDiffLines, type EditDiffStats } from "@/utils/editDiff";
import { summarizeToolInput } from "@/utils/toolSummary";

const props = defineProps<{ block: ToolCallBlock }>();
const expanded = ref(false);

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
  <div class="tool-item">
    <button class="ti-row" @click="expanded = !expanded">
      <span
        :class="['ti-dot', block.isPending ? 'ti-dot--run' : block.isError ? 'ti-dot--err' : '']"
      ></span>
      <span class="ti-name">{{ block.name }}</span>
      <span class="ti-summary">{{ inputSummary }}</span>
      <span v-if="editDiff" class="ti-diff">
        <span class="stat-add">+{{ editDiff.addCount }}</span>
        <span class="stat-del">-{{ editDiff.delCount }}</span>
      </span>
      <svg
        :class="['ti-chev', expanded ? 'ti-chev--open' : '']"
        width="8" height="12" viewBox="0 0 8 12" fill="none" aria-hidden="true"
      >
        <path
          d="M2 1.5l4 4.5-4 4.5"
          stroke="currentColor" stroke-width="1.4"
          stroke-linecap="round" stroke-linejoin="round"
        />
      </svg>
    </button>
    <div v-if="expanded" class="ti-body">
      <BashOutputBlock v-if="isBash && block.result" :content="block.result" :is-error="block.isError ?? false" />
      <pre v-else-if="editDiff" class="ti-result ti-diff-view"><span v-for="(line, i) in editDiff.lines" :key="i" :class="line.cls">{{ line.text }}</span></pre>
      <pre v-else-if="block.result" class="ti-result">{{ block.result }}</pre>
      <div v-else class="ti-pending">等待结果…</div>
    </div>
  </div>
</template>

<style scoped>
.tool-item {
  font-size: 11.5px;
}

.ti-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 3px 4px 3px 0;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  color: var(--aide-text-muted);
  border-radius: var(--aide-radius-sm);
  transition: color 0.12s;
}

.ti-row:hover {
  color: var(--aide-text-secondary);
}
.ti-row:hover .ti-name {
  color: var(--aide-text-primary);
}

/* 状态节点：完成灰点 / 失败红点 / 执行中铜色呼吸点（spec·图标语言） */
.ti-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--aide-surface-active);
  flex-shrink: 0;
}
.ti-dot--err {
  background: var(--aide-danger);
}
.ti-dot--run {
  background: var(--aide-accent);
  animation: ti-pulse 1.2s ease-in-out infinite;
}
@keyframes ti-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.ti-name {
  font-weight: 600;
  color: var(--aide-text-secondary);
  flex-shrink: 0;
  min-width: 38px;
}

.ti-summary {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'Cascadia Code', 'Consolas', monospace;
}

.ti-diff {
  flex-shrink: 0;
  display: flex;
  gap: 4px;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  font-size: 11px;
}
.stat-add { color: var(--aide-success); }
.stat-del { color: var(--aide-danger); }

.ti-chev {
  flex-shrink: 0;
  color: var(--aide-text-muted);
  transition: transform 0.12s;
}
.ti-chev--open {
  transform: rotate(90deg);
}

/* 展开区：铜色点线左标尺，正文渲染逻辑不变 */
.ti-body {
  margin: 2px 0 6px 2px;
  padding: 6px 8px 6px 11px;
  border-left: 1px dotted rgba(212, 165, 116, 0.25);
}

.ti-result {
  max-height: 160px;
  overflow: auto;
  white-space: pre-wrap;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  font-size: 11px;
  color: var(--aide-text-secondary);
  margin: 0;
}
.ti-diff-view {
  white-space: pre;
}

.ti-pending {
  font-style: italic;
  color: var(--aide-text-muted);
}
</style>
