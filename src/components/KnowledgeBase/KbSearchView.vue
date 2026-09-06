<script setup lang="ts">
// 检索结果。
//
// snippet 是后端 ts_headline 产出的片段，**里面混着文档正文（团队可写）**，
// 所以必须整体转义后再按哨兵切出高亮——见 search.rs 里 StartSel=[[HL]] 的说明。
import { escapeHtml } from "@aide/sdk/utils/markdown";
import type { KbSearchResult } from "./kbClient";

const props = defineProps<{ result: KbSearchResult | null; busy: boolean }>();
const emit = defineEmits<{ open: [documentId: string] }>();

function renderSnippet(raw: string): string {
  return escapeHtml(raw)
    .replace(/\[\[HL\]\]/g, "<mark>")
    .replace(/\[\[\/HL\]\]/g, "</mark>");
}
</script>

<template>
  <div class="kb-search">
    <p v-if="props.busy" class="kb-state">检索中…</p>
    <p v-else-if="!props.result" class="kb-state dim">输入关键词开始检索</p>
    <p v-else-if="props.result.hits.length === 0" class="kb-state">
      没有命中「{{ props.result.query }}」
    </p>

    <ul v-else class="kb-hits">
      <li v-for="h in props.result.hits" :key="h.documentId" @click="emit('open', h.documentId)">
        <div class="kb-hit-head">
          <span class="kb-hit-title">{{ h.title }}</span>
          <span class="kb-hit-ver">v{{ h.versionNo }}</span>
        </div>
        <!-- v-html 的输入已整体转义，只保留哨兵切出的 <mark> -->
        <p class="kb-hit-snip" v-html="renderSnippet(h.snippet)" />
      </li>
    </ul>
  </div>
</template>

<style scoped>
.kb-search {
  height: 100%;
  overflow: auto;
  padding: 16px 26px 40px;
}
.kb-state {
  font-size: 12px;
  color: var(--aide-text-muted);
}
.kb-state.dim { opacity: 0.7; }

.kb-hits {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.kb-hits li {
  padding: 10px 12px;
  border: 1px solid var(--aide-border);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color var(--aide-ease-t);
}
.kb-hits li:hover {
  border-color: var(--aide-accent);
}
.kb-hit-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.kb-hit-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--aide-text-primary);
}
.kb-hit-ver {
  font-size: 10px;
  color: var(--aide-text-muted);
}
.kb-hit-snip {
  margin: 5px 0 0;
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--aide-text-muted);
}
.kb-hit-snip :deep(mark) {
  background: color-mix(in srgb, var(--aide-accent) 26%, transparent);
  color: var(--aide-text-primary);
  border-radius: 2px;
  padding: 0 1px;
}
</style>
