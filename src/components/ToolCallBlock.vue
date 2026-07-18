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
    <button class="ti-row" :aria-expanded="expanded" @click="expanded = !expanded">
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
/* 工具调用块：GALLERY .toolcall 卡片化头行 + chevron 旋转 + 状态色 */
.tool-item {
  font-size: 11.5px;
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-md);
  background: var(--aide-bg-base);
  overflow: hidden;
  box-shadow: var(--aide-highlight-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
}

.tool-item + .tool-item {
  margin-top: 10px;
}

.ti-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px 12px;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  font-size: 12px;
  color: var(--aide-text-secondary);
  transition: background var(--aide-ease-t);
}

.ti-row:hover {
  background: var(--aide-surface-default);
}

/* 状态节点：完成灰点 / 失败红点 / 执行中 warning 色 */
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
  background: var(--aide-warning);
}

.ti-name {
  font-weight: 600;
  color: var(--aide-text-primary);
  flex-shrink: 0;
  min-width: 38px;
}

.ti-summary {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  font-size: 11px;
  color: var(--aide-text-muted);
}

.ti-diff {
  margin-left: auto;
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
  font-size: 9px;
  color: var(--aide-text-muted);
  transition: transform var(--aide-ease-t);
}
.ti-chev--open {
  transform: rotate(90deg);
}

/* 展开体：GALLERY .tc-body — bg-deep 井 + 内凹 */
.ti-body {
  border-top: 1px solid var(--aide-border-subtle);
  background: var(--aide-bg-deep);
}

.ti-result {
  max-height: 160px;
  overflow: auto;
  white-space: pre-wrap;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--aide-text-secondary);
  margin: 0;
  padding: 11px 14px;
}
.ti-diff-view {
  white-space: pre;
  padding: 6px 0;
}

.ti-pending {
  padding: 11px 14px;
  font-style: italic;
  color: var(--aide-text-muted);
}
</style>
