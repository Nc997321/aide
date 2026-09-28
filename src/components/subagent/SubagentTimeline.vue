<script setup lang="ts">
import { computed, ref } from "vue";
import type { SubagentBlock, SubagentEntry, ToolCallBlock as ToolCallBlockData } from "@/types/chat";
import ToolCallBlock from "../ToolCallBlock.vue";
import { truncatedLabel } from "@/utils/messageBytes";

type ToolEntry = Extract<SubagentEntry, { type: "tool" }>;

/**
 * 子代理时间线：派发指令（输入）→ 工具步 / 思考 / 文本（过程）→ 最终产出（输出），
 * 按发生顺序排在同一条墨线上（虚线 agentAccent 左尺 + 嵌套工具行）。
 *
 * 单一实现、两处使用：消息流里的子代理块（展开态）与子代理 dock 的阅读区都渲染
 * 这一份 —— 两处的视觉漂移只可能发生在这个文件里。
 */
const props = defineProps<{ block: SubagentBlock }>();

// 派发指令（task prompt）默认折叠——superpowers 的 implementer 契约能上千字，
// 默认只露一行「派发指令 · N 字」，点开看全文。
const promptExpanded = ref(false);
const promptLabel = computed(() => `派发指令 · ${props.block.prompt?.length ?? 0} 字`);

/** 把子代理内部的 tool entry 适配成主线程 ToolCallBlock 的 prop 形状，复用墨线渲染：
 *  子代理的工具步与主线程工具调用同款（铜点 / 虚线左尺 / SVG 箭头 / Bash 的 xterm /
 *  Edit 的 diff），保证嵌套时间线与父线程视觉同构。 */
function asToolBlock(e: ToolEntry): ToolCallBlockData {
  const parentRunning = props.block.isPending;
  return {
    type: "tool_call",
    id: e.toolUseId,
    name: e.toolName,
    input: e.input,
    result: e.result,
    isError: e.isError,
    // P2-1 写入时截断透传：ToolCallBlock 已有 .ti-truncated 渲染路径，零新 UI
    truncated: e.truncated,
    // 子步无独立 pending 流；父还在跑且本步尚无产出 → 视为执行中，复用呼吸点。
    isPending: parentRunning && !e.result && !e.isError,
  };
}
</script>

<template>
  <div class="sa-timeline">
    <!-- 派发指令：主代理派发时塞进 Agent 工具 input 的完整任务描述（如 superpowers
         的 implementer 契约）。作为时间线首项，折叠只露一行标签，点开看全文。 -->
    <div v-if="block.prompt" class="sa-prompt">
      <button class="sa-prompt-toggle" :aria-expanded="promptExpanded" @click="promptExpanded = !promptExpanded">
        <svg class="sa-prompt-glyph" width="12" height="14" viewBox="0 0 12 14" fill="none" aria-hidden="true">
          <!-- 带折角的页面轮廓 -->
          <path d="M2 1.5h5l3 3v8h-8z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
          <!-- 折角 -->
          <path d="M7 1.5v3h3" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
          <!-- 正文行 -->
          <path d="M3.5 7h5M3.5 9h5M3.5 11h3" stroke="currentColor" stroke-width="0.9" stroke-linecap="round" />
        </svg>
        <span class="sa-prompt-label">{{ promptLabel }}</span>
        <svg
          class="sa-chev" :class="{ 'sa-chev--open': promptExpanded }"
          width="8" height="12" viewBox="0 0 8 12" fill="none" aria-hidden="true"
        >
          <path d="M2 1.5l4 4.5-4 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <pre v-if="promptExpanded" class="sa-prompt-body">{{ block.prompt }}</pre>
    </div>

    <!-- 工具步 / 思考 / 文本：工具步直接复用 <ToolCallBlock>，与父线程同款墨线渲染。
         entry.truncated（P2-1 写入时截断）→ text/thinking 尾随省略小标，
         tool 走 asToolBlock 透传给 ToolCallBlock 的 .ti-truncated。 -->
    <template v-for="(entry, i) in block.entries" :key="i">
      <ToolCallBlock v-if="entry.type === 'tool'" :block="asToolBlock(entry)" />
      <p v-else-if="entry.type === 'thinking'" class="sa-thinking">
        {{ entry.text }}<span v-if="entry.truncated" class="sa-truncated">…{{ truncatedLabel(entry.truncated.originalBytes) }}</span>
      </p>
      <p v-else class="sa-text">
        {{ entry.text }}<span v-if="entry.truncated" class="sa-truncated">…{{ truncatedLabel(entry.truncated.originalBytes) }}</span>
      </p>
    </template>

    <!-- 降级占位：子代理 entries/result 大载荷已被摘要替换 -->
    <div v-if="block.truncated" class="sa-truncated">{{ truncatedLabel(block.truncated.originalBytes) }}</div>

    <!-- 最终产出（输出）：时间线尾端，子线程的收束。
         有 entries 时它是工具步之后的总结；无 entries 时它是唯一产出。
         resultTruncated（P2-1 写入时截断）在 pre 后随行小标。 -->
    <div v-if="block.result" class="sa-result-wrap">
      <pre class="sa-result">{{ block.result }}</pre>
      <span v-if="block.resultTruncated" class="sa-truncated">…{{ truncatedLabel(block.resultTruncated.originalBytes) }}</span>
    </div>
    <div v-else-if="!block.entries.length && !block.truncated" class="sa-pending">
      {{ block.asyncLaunched ? "子代理后台运行中…" : "子代理执行中…" }}
    </div>
  </div>
</template>

<style scoped>
/* 子线程时间线：GALLERY .sa-nested 嵌套虚线缩进 */
.sa-timeline {
  margin: 0 12px 10px 22px;
  border-left: 1px dashed color-mix(in srgb, var(--aide-agent-accent) 30%, transparent);
  padding-left: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 嵌套工具头行：GALLERY .sa-nested .tc-head */
.sa-timeline :deep(.ti-row) {
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-sm);
  background: var(--aide-bg-deep);
}

/* 派发指令行 */
.sa-prompt {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sa-prompt-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 12px;
  background: none;
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  color: var(--aide-text-secondary);
  font-family: inherit;
  font-size: 11px;
  text-align: left;
  transition: background var(--aide-ease-t), color var(--aide-ease-t);
}
.sa-prompt-toggle:hover {
  background: color-mix(in srgb, var(--aide-agent-accent) 8%, transparent);
  color: var(--aide-text-primary);
}
.sa-prompt-glyph {
  flex-shrink: 0;
  color: var(--aide-text-muted);
}
.sa-prompt-label {
  flex: 1;
}
.sa-prompt-body {
  margin: 0;
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 11px;
  font-family: var(--aide-font-mono);
  color: var(--aide-text-secondary);
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-sm);
  padding: 6px 8px;
  line-height: 1.5;
}

.sa-text {
  margin: 0;
  font-size: 11px;
  white-space: pre-wrap;
  color: var(--aide-text-secondary);
}
.sa-thinking {
  margin: 0;
  font-size: 11px;
  white-space: pre-wrap;
  color: var(--aide-text-muted);
  font-style: italic;
  opacity: 0.85;
}

.sa-result-wrap {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.sa-result {
  margin: 4px 0 0;
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 11.5px;
  color: var(--aide-text-secondary);
}
.sa-pending {
  padding: 2px 0;
  font-style: italic;
  color: var(--aide-text-muted);
}
.sa-truncated {
  padding: 2px 0;
  font-style: italic;
  color: var(--aide-text-muted);
}

.sa-chev {
  flex-shrink: 0;
  color: var(--aide-text-muted);
  transition: transform var(--aide-ease-t);
}
.sa-chev--open {
  transform: rotate(90deg);
}

.sa-prompt-toggle:focus-visible {
  outline: 1px solid var(--aide-agent-accent);
  outline-offset: 1px;
}

@media (prefers-reduced-motion: reduce) {
  .sa-chev { transition: none; }
}
</style>
