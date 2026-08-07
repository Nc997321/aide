<script setup lang="ts">
import { ref, computed } from "vue";
/** 主线程思考块——partial=on 时 sidecar 把 thinking_delta 逐字转发（流式），partial=off /
 *  历史回放走 thinking 整块。视觉对齐子代理 .sa-thinking（灰斜体小字 + info 色调），独立成
 *  组件与 ToolCallBlock / SubagentCallBlock 同级。
 *
 *  思考可能很长（实测上万字），用 details 原生折叠。流式期（streaming=true）默认展开看逐字
 *  生成，结束自动折叠；用户手动点一次后 userOverride 接管（用户意愿优先于流式默认）。
 *  落在 .msg-turn（铜书脊）里，不套独立卡片避免双层边条，只用 info 淡左边条区分正文。
 *  text 空时 sidecar 不发本组件，故此处 text 必非空。 */
const props = defineProps<{ text: string; streaming?: boolean }>();

/** 用户是否手动 toggle 过——一旦操作，details 开合完全由用户决定，流式默认不再覆盖。 */
const userOverride = ref(false);
const userOpen = ref(false);
const open = computed(() => (userOverride.value ? userOpen.value : !!props.streaming));
function onToggle(e: Event) {
  userOverride.value = true;
  userOpen.value = (e.target as HTMLDetailsElement).open;
}
</script>

<template>
  <details class="thinking" :open="open" @toggle="onToggle">
    <summary class="thinking-head">
      <span class="thinking-caret" aria-hidden="true"></span>
      <span class="thinking-label">思考</span>
      <span class="thinking-count">{{ text.length }} 字</span>
    </summary>
    <div class="thinking-body">{{ text }}</div>
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
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid var(--aide-text-muted);
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
  border-left: 2px solid color-mix(in srgb, var(--aide-info) 40%, transparent);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--aide-text-muted);
  font-style: italic;
  opacity: 0.85;
  white-space: pre-wrap;
  max-height: 320px;
  overflow: auto;
}

@media (prefers-reduced-motion: reduce) {
  .thinking-caret { transition: none; }
}
</style>