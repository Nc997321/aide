<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useTerminalSearch } from "../../composables/useTerminalSearch";

/**
 * 终端搜索条：纯视图层，状态全部来自 useTerminalSearch。
 * 视觉配方与 CodeEditor.vue 的 .cm-panel.cm-search / .cm-textfield / .cm-button
 * 严格一致（bg-raised 面板、12px 输入框、accent focus ring），让终端与编辑器
 * 两处搜索 UI 观感统一。
 */
const { query, caseSensitive, activeResults, close, findNext, findPrev } = useTerminalSearch();

const inputRef = ref<HTMLInputElement>();

// 输入 / 大小写开关变化 → 增量搜索（沿用当前选区，不跳下一处）
watch([query, caseSensitive], () => findNext(true));

onMounted(() => {
  nextTick(() => {
    inputRef.value?.focus();
    inputRef.value?.select();
    // 重新打开时 composable 里可能留着上次查询词（或从终端选区播种的），补跑一次
    if (query.value) findNext(true);
  });
});

/** 供父组件在 Ctrl+F 重新聚焦时调用 */
function focusInput() {
  inputRef.value?.focus();
  inputRef.value?.select();
}
defineExpose({ focusInput });

const countText = computed(() => {
  if (!query.value) return "";
  const r = activeResults.value;
  if (!r || r.count === 0) return "无结果";
  if (r.index < 0) return `${r.count}+`; // 超 highlightLimit，序号不可得
  return `${r.index + 1}/${r.count}`;
});
</script>

<template>
  <div class="wb-search" @keydown.stop>
    <input
      ref="inputRef"
      v-model="query"
      class="wb-search-input"
      placeholder="搜索"
      spellcheck="false"
      @keydown.enter.exact.prevent="findNext()"
      @keydown.shift.enter.prevent="findPrev()"
      @keydown.escape.prevent="close()"
    />
    <span class="wb-search-count">{{ countText }}</span>
    <button
      class="wb-search-btn wb-search-btn--toggle"
      :class="{ on: caseSensitive }"
      v-tooltip="'区分大小写'"
      @click="caseSensitive = !caseSensitive"
    >Aa</button>
    <button class="wb-search-btn" v-tooltip="'上一个 (Shift+Enter)'" @click="findPrev()">↑</button>
    <button class="wb-search-btn" v-tooltip="'下一个 (Enter)'" @click="findNext()">↓</button>
    <button class="wb-search-btn" v-tooltip="'关闭 (Esc)'" @click="close()">✕</button>
  </div>
</template>

<style scoped>
/* 面板：同 .cm-panel.cm-search（bg-raised + shadow-sm + 6px 8px） */
.wb-search {
  position: absolute;
  top: 6px;
  right: 14px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  box-shadow: var(--aide-shadow-sm);
}

/* 输入框：同 .cm-textfield（bg-deep + border + radius-sm + 12px + inset 阴影） */
.wb-search-input {
  width: 180px;
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border);
  color: var(--aide-text-primary);
  border-radius: var(--aide-radius-sm);
  padding: 2px 6px;
  font-size: 12px;
  font-family: inherit;
  outline: none;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.3); /* structural overlay, not theme-color */
}
.wb-search-input:focus {
  border-color: var(--aide-accent);
  box-shadow: var(--aide-accent-ring);
}
.wb-search-input::placeholder {
  color: var(--aide-text-muted);
}

.wb-search-count {
  min-width: 40px;
  text-align: center;
  font-size: 11px;
  color: var(--aide-text-muted);
  user-select: none;
  white-space: nowrap;
}

/* 按钮：同 .cm-button（surface-default + border + radius-sm + 12px） */
.wb-search-btn {
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  color: var(--aide-text-secondary);
  border-radius: var(--aide-radius-sm);
  padding: 2px 7px;
  font-size: 12px;
  line-height: 1.2;
  cursor: pointer;
  box-shadow: var(--aide-highlight-inset);
  transition: background 0.12s, color 0.12s;
}
.wb-search-btn:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
.wb-search-btn:active {
  background: var(--aide-surface-active);
}
.wb-search-btn--toggle.on {
  background: var(--aide-surface-active);
  color: var(--aide-accent);
  border-color: var(--aide-accent);
}
</style>
