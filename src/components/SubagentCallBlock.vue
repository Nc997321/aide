<script setup lang="ts">
import { ref, computed } from "vue";
import type { SubagentBlock, SubagentEntry } from "@/types/chat";
import { summarizeToolInput } from "@/utils/toolSummary";

type ToolEntry = Extract<SubagentEntry, { type: "tool" }>;

const props = defineProps<{ block: SubagentBlock }>();
const expanded = ref(false);

// 派发指令（task prompt）默认折叠——superpowers 的 implementer 契约填完能上千字，
// 默认只露一行「派发指令（N 字）」，点开看全文。
const promptExpanded = ref(false);
// 每个工具步的输出各自折叠——用 Set<index> 存展开态，entries 是 append-only、index 稳定。
// 整体重赋值触发响应式（避免 Set 原地改不触发更新）。
const expandedSteps = ref(new Set<number>());

const statusIcon = computed(() => {
  if (props.block.isPending) return "⏳";
  if (props.block.isError) return "❌";
  return "✅";
});

const promptLabel = computed(() => `派发指令（${props.block.prompt?.length ?? 0} 字）`);

function stepSummary(entry: ToolEntry): string {
  return summarizeToolInput(entry.toolName, entry.input);
}

function resultLineCount(entry: ToolEntry): string {
  if (!entry.result) return "";
  return String(entry.result.split("\n").length);
}

function isStepExpanded(i: number): boolean {
  return expandedSteps.value.has(i);
}

function toggleStep(i: number): void {
  const s = new Set(expandedSteps.value);
  if (s.has(i)) s.delete(i);
  else s.add(i);
  expandedSteps.value = s;
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
      <!-- 派发指令（task prompt）：主代理派发时塞进 Agent 工具 input 的完整任务描述，
           如 superpowers 的 implementer 契约。默认折叠，点开看全文。 -->
      <div v-if="block.prompt" class="prompt-section">
        <button class="prompt-toggle" @click="promptExpanded = !promptExpanded">
          <span class="prompt-label">{{ promptLabel }}</span>
          <span class="prompt-chevron">{{ promptExpanded ? "▲" : "▼" }}</span>
        </button>
        <pre v-if="promptExpanded" class="prompt-body">{{ block.prompt }}</pre>
      </div>

      <ol v-if="block.entries.length" class="subagent-entries">
        <li v-for="(entry, i) in block.entries" :key="i" class="subagent-entry" :class="`entry-${entry.type}`">
          <template v-if="entry.type === 'tool'">
            <button
              class="step-row"
              :class="{ 'has-result': !!entry.result, 'is-error': !!entry.isError }"
              :disabled="!entry.result"
              @click="entry.result && toggleStep(i)"
            >
              <span class="step-tool">{{ entry.toolName }}</span>
              <span class="step-summary">{{ stepSummary(entry) }}</span>
              <span v-if="entry.result && !isStepExpanded(i)" class="step-result-hint">{{ resultLineCount(entry) }} 行</span>
              <span v-if="entry.result" class="step-chevron">{{ isStepExpanded(i) ? "▾" : "▸" }}</span>
            </button>
            <pre v-if="entry.result && isStepExpanded(i)" class="step-result" :class="{ 'is-error': entry.isError }">{{ entry.result }}</pre>
          </template>
          <p v-else class="entry-text-body">{{ entry.text }}</p>
        </li>
      </ol>
      <pre v-if="block.result" class="subagent-result">{{ block.result }}</pre>
      <div v-else-if="!block.entries.length" class="subagent-pending">
        {{ block.asyncLaunched ? "子代理后台运行中…" : "子代理执行中…" }}
      </div>
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
  display: block;
}

/* 工具步：一行按钮（工具名 + 入参摘要 + 折叠提示），有 result 才可点开。
 * 没产出的步（result 为空、还在跑或该工具无输出）不可点，避免空展开。 */
.step-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 2px 4px;
  background: none;
  border: none;
  border-radius: 4px;
  cursor: default;
  color: inherit;
  text-align: left;
  font-family: inherit;
  font-size: inherit;
  transition: background 0.1s;
}
.step-row.has-result {
  cursor: pointer;
}
.step-row.has-result:hover {
  background: color-mix(in srgb, var(--aide-accent) 8%, transparent);
}
.step-row.is-error .step-tool {
  color: var(--aide-danger);
}

.step-tool {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--aide-text-secondary);
}

.step-summary {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  color: var(--aide-text-muted);
}

.step-result-hint {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--aide-text-muted);
  opacity: 0.7;
}

.step-chevron {
  flex-shrink: 0;
  font-size: 9px;
  color: var(--aide-text-muted);
}

/* 工具步输出：缩进、限高可滚，呼应主线程 ToolCallBlock 的输出折叠。出错用 danger 描边。 */
.step-result {
  margin: 2px 0 4px 14px;
  max-height: 200px;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 11px;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  color: var(--aide-text-secondary);
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-border);
  border-radius: 4px;
  padding: 4px 6px;
}
.step-result.is-error {
  border-color: color-mix(in srgb, var(--aide-danger) 40%, transparent);
  color: var(--aide-danger);
}

/* 派发指令区：置于步骤列表之上，默认折叠只露一行标签，点开看完整 task prompt。 */
.prompt-section {
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px dashed var(--aide-border);
}

.prompt-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 3px 4px;
  background: none;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  color: var(--aide-text-secondary);
  font-family: inherit;
  font-size: 11px;
  text-align: left;
  transition: background 0.1s;
}
.prompt-toggle:hover {
  background: color-mix(in srgb, var(--aide-accent) 8%, transparent);
  color: var(--aide-text-primary);
}

.prompt-label {
  flex: 1;
  font-weight: 500;
}

.prompt-chevron {
  flex-shrink: 0;
  font-size: 9px;
  color: var(--aide-text-muted);
}

.prompt-body {
  margin: 4px 0 0;
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 11px;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  color: var(--aide-text-secondary);
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-border);
  border-radius: 4px;
  padding: 6px 8px;
  line-height: 1.5;
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
