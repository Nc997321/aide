<script setup lang="ts">
/** 主线程思考块——sidecar 把 assistant 消息 content 里的 thinking block 整块转发
 *  （partial-off 下非逐字）。视觉对齐子代理 .sa-thinking（灰斜体小字 + info 色调），
 *  独立成组件与 ToolCallBlock / SubagentCallBlock 同级。
 *
 *  思考可能很长（实测上万字），用 details 原生折叠（零状态），默认只露「思考 · N 字」，
 *  点开看全文。落在 .msg-turn（铜书脊）里，不套独立卡片避免双层边条，只用 info 淡
 *  左边条区分正文。text 空时 sidecar 不发本组件，故此处 text 必非空。 */
defineProps<{ text: string }>();
</script>

<template>
  <details class="thinking">
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