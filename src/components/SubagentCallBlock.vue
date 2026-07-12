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
        <span class="sa-type" :title="`子代理类型：${block.agentName}`">{{ block.agentName }}</span>
        <span class="sa-desc">{{ block.description }}</span>
        <span v-if="block.model" class="sa-model" :title="`子代理使用的模型：${block.model}`">{{ block.model }}</span>
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
/* 子代理块 = 主线程墨线的一条分支。
 * 左侧铜色细线 + 方括号节点（分支括号）标识嵌套子线程；展开后整条子线程时间线
 * （派发指令 → 工具步 → 最终产出）挂在虚线铜色左尺上，工具步复用 ToolCallBlock
 * 的墨线渲染。所有色值/圆角走现有 token，零 emoji，箭头全 SVG。 */
.sa {
  position: relative;
  display: flex;
  align-items: stretch;
  margin: 4px 0;
  font-size: 11.5px;
}

/* ── 分支括号 ── */
.sa-rail {
  flex-shrink: 0;
  position: relative;
  width: 9px;
  margin-right: 7px;
  border-left: 1px solid rgba(212, 165, 116, 0.35);
}
.sa-node {
  position: absolute;
  left: -1px;
  top: 0;
  width: 9px;
  height: 9px;
  box-sizing: border-box;
  /* 方括号节点：上 + 左 + 下三边描边、右边开口，字面即「围合一个子线程」。
     左描边压在 .sa-rail 的铜色垂线上共线（left:-1），顶在行顶（top:0），
     读作「分支自此处离开主脊、向右展开」——垂线自方括号底向下延伸进时间线，无上桩。
     尖角（无圆角）与 ToolCallGroup 的圆环节点形成形状对比。 */
  border-top: 1.5px solid var(--aide-accent);
  border-left: 1.5px solid var(--aide-accent);
  border-bottom: 1.5px solid var(--aide-accent);
}
/* 完成 = 空心铜括号（组级，区别于工具步的灰点）；运行 = 实心铜括号呼吸；出错 = 实心红括号。
 * 两级状态用色区分层级：组级节点铜、内部工具步灰（ToolCallBlock）。 */
.sa--done .sa-node { background: var(--aide-bg-base); }
.sa--run .sa-node {
  background: var(--aide-accent);
  animation: sa-pulse 1.2s ease-in-out infinite;
}
.sa--err .sa-node {
  background: var(--aide-danger);
  border-color: var(--aide-danger);
}
@keyframes sa-pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(212, 165, 116, 0.5); }
  50% { opacity: 0.55; box-shadow: 0 0 0 4px rgba(212, 165, 116, 0); }
}

.sa-content { flex: 1; min-width: 0; }

/* ── 折叠行 ── */
.sa-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 3px 2px;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  color: var(--aide-text-muted);
  border-radius: var(--aide-radius-sm);
  transition: color 0.12s;
}
.sa-head:hover { color: var(--aide-text-secondary); }
.sa-head:hover .sa-desc { color: var(--aide-text-secondary); }

.sa-role {
  flex-shrink: 0;
  font-weight: 500;
  color: var(--aide-text-muted);
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
  color: var(--aide-accent);
  background: var(--aide-accent-subtle);
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
  transition: color 0.12s;
}
.sa-model {
  flex-shrink: 0;
  font-size: 10px;
  font-family: 'Cascadia Code', 'Consolas', monospace;
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
  color: var(--aide-text-muted);
  transition: transform 0.12s;
}
.sa-chev--open { transform: rotate(90deg); }

/* ── 子线程时间线：虚线铜色左尺，承载派发指令 → 工具步 → 最终产出 ── */
.sa-timeline {
  margin: 4px 0 2px 2px;
  padding: 1px 0 5px 10px;
  border-left: 1px dotted rgba(212, 165, 116, 0.22);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 派发指令行：时间线首项，可折叠 */
.sa-prompt { display: flex; flex-direction: column; gap: 4px; }
.sa-prompt-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 2px 4px;
  background: none;
  border: none;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  color: var(--aide-text-secondary);
  font-family: inherit;
  font-size: 11px;
  text-align: left;
  transition: background 0.1s, color 0.1s;
}
.sa-prompt-toggle:hover {
  background: var(--aide-accent-subtle);
  color: var(--aide-text-primary);
}
.sa-prompt-glyph { flex-shrink: 0; color: var(--aide-text-muted); }
.sa-prompt-label { flex: 1; }
.sa-prompt-body {
  margin: 0;
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 11px;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  color: var(--aide-text-secondary);
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  padding: 6px 8px;
  line-height: 1.5;
}

/* thinking 弱化，呼应原生 CLI 的内心戏处理 */
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

/* 最终产出：时间线尾端，子线程的收束 */
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

/* 键盘可达：两个 toggle 的聚焦环走铜色，与墨线语言同源 */
.sa-head:focus-visible,
.sa-prompt-toggle:focus-visible {
  outline: 1px solid var(--aide-accent);
  outline-offset: 1px;
}

@media (prefers-reduced-motion: reduce) {
  .sa--run .sa-node { animation: none; }
  .sa-chev { transition: none; }
}
</style>