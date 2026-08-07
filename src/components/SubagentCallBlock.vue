<script setup lang="ts">
import { ref, computed } from "vue";
import type { SubagentBlock, SubagentEntry, ToolCallBlock as ToolCallBlockData } from "@/types/chat";
import ToolCallBlock from "./ToolCallBlock.vue";

type ToolEntry = Extract<SubagentEntry, { type: "tool" }>;

const props = defineProps<{ block: SubagentBlock }>();
const expanded = ref(false);
// 派发指令（task prompt）默认折叠——superpowers 的 implementer 契约能上千字，
// 默认只露一行「派发指令 · N 字」，点开看全文。
const promptExpanded = ref(false);

const status = computed<"done" | "run" | "err">(() => {
  if (props.block.isPending) return "run";
  if (props.block.isError) return "err";
  return "done";
});

const stepCount = computed(() => props.block.entries.filter((e) => e.type === "tool").length);

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
    // 子步无独立 pending 流；父还在跑且本步尚无产出 → 视为执行中，复用呼吸点。
    isPending: parentRunning && !e.result && !e.isError,
  };
}
</script>

<template>
  <div class="sa" :class="`sa--${status}`">
    <!-- 分支括号：左侧铜色细线 + 方括号节点，标识「这是一段被嵌套的子线程」——
         不是卡片盒子，而是主线程墨线的一条分支。方括号（上+左+下描边、右开口）
         字面即「围合一个子线程」，与 ToolCallGroup 的圆环节点（主脊上的里程碑点）
         形状区分、材质同源。 -->
    <span class="sa-rail" aria-hidden="true">
      <span class="sa-node"></span>
    </span>

    <div class="sa-content">
      <!-- 折叠行：角色 + 类型 pill + 描述 + 模型 + 步数 + 箭头 -->
      <button class="sa-head" :aria-expanded="expanded" @click="expanded = !expanded">
        <span class="sa-role">Agent</span>
        <span class="sa-type" v-tooltip="`子代理类型：${block.agentName}`">{{ block.agentName }}</span>
        <span class="sa-desc">{{ block.description }}</span>
        <span v-if="block.model" class="sa-model" v-tooltip="`子代理使用的模型：${block.model}`">{{ block.model }}</span>
        <span v-if="block.isPending && stepCount" class="sa-steps">{{ stepCount }} 步</span>
        <svg
          class="sa-chev" :class="{ 'sa-chev--open': expanded }"
          width="8" height="12" viewBox="0 0 8 12" fill="none" aria-hidden="true"
        >
          <path d="M2 1.5l4 4.5-4 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>

      <!-- 展开体：子线程的完整时间线，挂在虚线铜色左尺上。
           派发指令（输入）→ 工具步 / 思考 / 文本（过程）→ 最终产出（输出），按发生顺序
           排在同一条墨线上，嵌套关系编码在线条里，不靠卡片盒子暗示。 -->
      <div v-if="expanded" class="sa-timeline">
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

        <!-- 工具步 / 思考 / 文本：工具步直接复用 <ToolCallBlock>，与父线程同款墨线渲染 -->
        <template v-for="(entry, i) in block.entries" :key="i">
          <ToolCallBlock v-if="entry.type === 'tool'" :block="asToolBlock(entry)" />
          <p v-else-if="entry.type === 'thinking'" class="sa-thinking">{{ entry.text }}</p>
          <p v-else class="sa-text">{{ entry.text }}</p>
        </template>

        <!-- 最终产出（输出）：时间线尾端，子线程的收束。
             有 entries 时它是工具步之后的总结；无 entries 时它是唯一产出。 -->
        <pre v-if="block.result" class="sa-result">{{ block.result }}</pre>
        <div v-else-if="!block.entries.length" class="sa-pending">
          {{ block.asyncLaunched ? "子代理后台运行中…" : "子代理执行中…" }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 子代理：GALLERY .subagent — info 左边条 + 渐变背景 + 嵌套虚线 */
.sa {
  position: relative;
  display: flex;
  align-items: stretch;
  margin: 4px 0;
  font-size: 11.5px;
  border: 1px solid var(--aide-border-subtle);
  border-left: 3px solid var(--aide-info);
  border-radius: var(--aide-radius-md);
  background: linear-gradient(90deg, color-mix(in srgb, var(--aide-info) 5%, transparent), var(--aide-bg-base) 40%);
  overflow: hidden;
  box-shadow: var(--aide-highlight-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
}

/* GALLERY 子代理不再需要左侧括号节点，改用 info 色左边条 */
.sa-rail {
  display: none;
}

.sa-content {
  flex: 1;
  min-width: 0;
  padding: 2px 0;
}

/* 折叠行：复用 GALLERY .tc-head 卡片头行 */
.sa-head {
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
.sa-head:hover {
  background: var(--aide-surface-default);
}

.sa-role {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--aide-text-primary);
}
.sa-type {
  flex-shrink: 0;
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--aide-info);
  background: color-mix(in srgb, var(--aide-info) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-info) 25%, transparent);
  border-radius: 3px;
  padding: 1px 5px;
}
.sa-desc {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--aide-text-muted);
  transition: color var(--aide-ease-t);
}
.sa-head:hover .sa-desc {
  color: var(--aide-text-secondary);
}
.sa-model {
  flex-shrink: 0;
  font-size: 10px;
  font-family: var(--aide-font-mono);
  color: var(--aide-text-muted);
  border: 1px solid var(--aide-border);
  border-radius: 4px;
  padding: 0 4px;
}
.sa-steps {
  flex-shrink: 0;
  font-size: 10px;
  font-style: italic;
  color: var(--aide-text-muted);
}
.sa-chev {
  flex-shrink: 0;
  font-size: 9px;
  color: var(--aide-text-muted);
  transition: transform var(--aide-ease-t);
}
.sa-chev--open {
  transform: rotate(90deg);
}

/* 子线程时间线：GALLERY .sa-nested 嵌套虚线缩进 */
.sa-timeline {
  margin: 0 12px 10px 22px;
  border-left: 1px dashed color-mix(in srgb, var(--aide-info) 30%, transparent);
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
  background: color-mix(in srgb, var(--aide-info) 8%, transparent);
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

.sa-head:focus-visible,
.sa-prompt-toggle:focus-visible {
  outline: 1px solid var(--aide-info);
  outline-offset: 1px;
}

@media (prefers-reduced-motion: reduce) {
  .sa-chev { transition: none; }
}
</style>