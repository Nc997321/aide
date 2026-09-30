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
    <p v-else-if="!props.result" class="kb-state">输入关键词开始检索</p>
    <p v-else-if="props.result.hits.length === 0" class="kb-state">
      没有命中「{{ props.result.query }}」<br />
      <small>换个词试试——检索的是正文，中文按词切</small>
    </p>

    <template v-else>
      <p class="kb-count">{{ props.result.hits.length }} 条命中</p>
      <ul class="kb-hits">
        <li v-for="h in props.result.hits" :key="h.documentId" @click="emit('open', h.documentId)">
          <div class="kb-hit-head">
            <span class="kb-hit-title">{{ h.title }}</span>
            <span class="kb-hit-ver">v{{ h.versionNo }}</span>
          </div>
          <!-- v-html 的输入已整体转义，只保留哨兵切出的 <mark> -->
          <p class="kb-hit-snip" v-html="renderSnippet(h.snippet)" />
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
/* 结果是一条一条的，不是一叠卡片：分隔靠 hairline，不靠边框盒子。
   悬停用一条通栏底色（负外边距实现），不画框。 */

.kb-search {
  height: 100%;
  overflow: auto;
  padding: 40px 24px 88px;
}
.kb-search > * {
  max-width: 720px;
  margin-left: auto;
  margin-right: auto;
}

/* ⚠️ 这里只写上下外边距：左右交给上面 `.kb-search > *` 的 auto 居中。
   写成 `margin: 0 0 8px` 会把 auto 覆盖成 0，整条竖轴就往左掉。 */
.kb-state {
  margin-top: 0;
  margin-bottom: 0;
  font-size: 13px;
  line-height: 1.8;
  color: var(--aide-text-secondary);
}
.kb-state small { font-size: 11.5px; color: var(--aide-text-muted); }

.kb-count {
  margin-top: 0;
  margin-bottom: 8px;
  font-size: 11.5px;
  color: var(--aide-text-muted);
}

.kb-hits {
  list-style: none;
  margin-top: 0;
  margin-bottom: 0;
  padding: 0;
}
.kb-hits li {
  padding: 14px 12px;
  margin: 0 -12px;
  border-bottom: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  transition: background var(--aide-ease-t);
}
.kb-hits li:last-child { border-bottom: none; }
.kb-hits li:hover { background: var(--aide-surface-hover); }
.kb-hit-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.kb-hit-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--aide-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-hit-ver {
  flex: none;
  font-size: 11.5px;
  color: var(--aide-text-muted);
  font-variant-numeric: tabular-nums;
}
.kb-hit-snip {
  margin: 6px 0 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--aide-text-muted);
}
.kb-hit-snip :deep(mark) {
  background: var(--aide-accent-subtle);
  color: var(--aide-text-primary);
  border-radius: 3px;
  padding: 0 2px;
}
</style>
