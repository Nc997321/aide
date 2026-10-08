<script setup lang="ts">
import { computed } from "vue";
import { tipSegments } from "./usageTips";

/** 一条使用小提示的正文：「小提示」前缀 + 文案（`反引号` 段渲染成行内代码）。
 *  只管排版；出场/退场时机由宿主（思考行 / 输入框）决定。 */
const props = defineProps<{ text: string }>();
const segments = computed(() => tipSegments(props.text));
</script>

<template>
  <span class="usage-tip">
    <span class="usage-tip-label">小提示</span>
    <span class="usage-tip-body"><template v-for="(s, i) in segments" :key="i"><code v-if="s.code" class="usage-tip-code">{{ s.text }}</code><template v-else>{{ s.text }}</template></template></span>
  </span>
</template>

<style scoped>
.usage-tip {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  font-size: 11px;
  color: var(--aide-text-muted);
}

.usage-tip-label {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--aide-accent);
  background: var(--aide-accent-subtle);
  padding: 0 4px;
  border-radius: 3px;
}

.usage-tip-body {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage-tip-code {
  font-family: var(--aide-font-mono);
  font-size: 10.5px;
  color: var(--aide-text-secondary);
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-radius: 3px;
  padding: 0 3px;
}
</style>
