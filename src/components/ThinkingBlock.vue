<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
/** 主线程思考块——partial=on 时 sidecar 把 thinking_delta 逐字转发（流式），partial=off /
 *  历史回放走 thinking 整块。视觉对齐子代理 .sa-thinking（灰斜体小字 + agentAccent 色调），独立成
 *  组件与 ToolCallBlock / SubagentCallBlock 同级。
 *
 *  思考可能很长（实测上万字），用 details 原生折叠。流式期（streaming=true）默认展开看逐字
 *  生成，结束自动折叠；用户手动点一次后 userOverride 接管（用户意愿优先于流式默认）。
 *  落在 .msg-turn（铜书脊）里，不套独立卡片避免双层边条，只用 agentAccent 淡左边条区分正文。
 *  text 空时 sidecar 不发本组件，故此处 text 必非空。 */
const props = defineProps<{ text: string; streaming?: boolean }>();

/** 用户是否手动 toggle 过——一旦操作，details 开合完全由用户决定，流式默认不再覆盖。 */
const userOverride = ref(false);
const userOpen = ref(false);
const open = computed(() => (userOverride.value ? userOpen.value : !!props.streaming));
const bodyRef = ref<HTMLDivElement | undefined>();
// 流式期：thinking-body 限高 320px + 钉底跟随（逐字增长时内部滚到底），让用户看到
// 最新生成的内容；否则视窗停在顶部，新内容在底部生成却看不到，需手动下拉内部滚动条。
// 结束后停止跟随，用户可自由上下滚看全文。
//
// 流式期 body 用 overflow:hidden 而非 auto（.thinking--streaming 类）——滚动陷阱根因：
// body 是嵌套滚动容器，思考上万字时内部滚动范围几千 px，滚轮落在其上会被整个吃掉
// （Chromium 只在嵌套容器滚到边界后才链式传给外层对话区），且 B 方案下思考 delta 结束
// → text 整块到达之间有长空窗，钉底已停、details 仍开，用户在块内上滚后所有向下滚轮
// 全被吞——对话定格在该轮位置。overflow:hidden 的盒子不是滚轮手势目标（滚轮直接穿透
// 链到对话区）但仍可编程滚动（钉底 scrollTop 赋值照常），流式期实时跟随模式下块内
// 手动滚动本就被钉底接管，不损失能力；流式结束/手动展开回到 overflow:auto 阅读模式。
watch(
  () => props.text,
  () => {
    if (props.streaming && bodyRef.value) {
      nextTick(() => {
        if (bodyRef.value) bodyRef.value.scrollTop = bodyRef.value.scrollHeight;
      });
    }
  },
);
function onToggle(e: Event) {
  const target = e.target as HTMLDetailsElement;
  // 程序化 :open 变化也触发 toggle——此时 target.open 与 computed open 一致，不是
  // 用户操作，忽略；只有用户点击导致两者不一致时才接管（避免流式自动展开/折叠
  // 污染 userOverride，使结束折叠失效）。
  if (target.open === open.value) return;
  userOverride.value = true;
  userOpen.value = target.open;
}
</script>

<template>
  <details class="thinking" :class="{ 'thinking--streaming': streaming }" :open="open" @toggle="onToggle">
    <summary class="thinking-head">
      <span class="thinking-caret" aria-hidden="true"></span>
      <span class="thinking-label">思考</span>
      <span class="thinking-count">{{ text.length }} 字</span>
    </summary>
    <div ref="bodyRef" class="thinking-body">{{ text }}</div>
  </details>
</template>

<style scoped>
.thinking { margin: 2px 0; }

.thinking-head {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
  list-style: none;
  padding: 2px 0;
  font-size: 12px;
  color: var(--aide-text-muted);
}
.thinking-head::-webkit-details-marker { display: none; }

.thinking-caret {
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  border-left: 5px solid var(--aide-text-muted);
  opacity: 0.7;
  transition: transform var(--aide-ease-t);
}
.thinking[open] .thinking-caret { transform: rotate(90deg); }

.thinking-label { font-weight: 600; color: var(--aide-text-secondary); }
.thinking-count {
  font-size: 10.5px;
  font-family: var(--aide-font-mono);
  color: var(--aide-text-muted);
}

.thinking-body {
  margin: 4px 0 6px;
  padding: 4px 10px;
  border-left: 2px solid color-mix(in srgb, var(--aide-agent-accent) 40%, transparent);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--aide-text-muted);
  font-style: italic;
  opacity: 0.85;
  white-space: pre-wrap;
  max-height: 320px;
  overflow: auto;
}

/* 流式期滚轮穿透：hidden 不是滚轮手势目标，滚轮直达对话区；钉底仍可编程滚动。
   详见组件头部注释（滚动陷阱根因）。阅读模式（非流式）保持 auto 原生内滚。 */
.thinking--streaming .thinking-body { overflow: hidden; }

@media (prefers-reduced-motion: reduce) {
  .thinking-caret { transition: none; }
}
</style>