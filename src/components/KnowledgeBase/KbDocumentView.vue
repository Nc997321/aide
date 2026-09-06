<script setup lang="ts">
// 文档正文。第一版只读（编辑与版本回滚是下一批）。
//
// 渲染走 ./markdown.ts 的 renderKbMarkdown：默认拒绝原始 HTML + 链接协议白名单。
// 样式复用全局 .msg-text（聊天消息同一套观感，含 hljs 语法色），
// 这里只补 .msg-text 没覆盖到的标题/表格/引用/列表几条。
import { computed } from "vue";
import { renderKbMarkdown } from "./markdown";
import type { KbDocument } from "./kbClient";

const props = defineProps<{ doc: KbDocument }>();

const html = computed(() => renderKbMarkdown(props.doc.content ?? ""));

const updated = computed(() => {
  const d = new Date(props.doc.updatedAt);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
});
</script>

<template>
  <article class="kb-doc">
    <header class="kb-doc-head">
      <h1>{{ doc.title }}</h1>
      <div class="kb-meta">
        <span class="kb-ver">v{{ doc.versionNo }}</span>
        <span v-if="updated">{{ updated }}</span>
        <span class="kb-slug">{{ doc.slug }}</span>
      </div>
    </header>

    <!-- v-html 的内容来自 renderKbMarkdown，已做默认拒绝处理，见 ./markdown.ts -->
    <div class="kb-body msg-text" v-html="html" />

    <p v-if="!doc.content" class="kb-empty">这篇文档还没有正文。</p>
  </article>
</template>

<style scoped>
.kb-doc {
  height: 100%;
  overflow: auto;
  padding: 20px 26px 40px;
}
.kb-doc-head {
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--aide-border);
}
.kb-doc-head h1 {
  margin: 0 0 6px;
  font-size: 17px;
  font-weight: 600;
  color: var(--aide-text-primary);
  line-height: 1.4;
}
.kb-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--aide-text-muted);
}
.kb-ver {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--aide-bg-deep);
  color: var(--aide-accent);
}
.kb-slug {
  font-family: var(--aide-font-mono);
  opacity: 0.7;
}
.kb-body {
  font-size: 13px;
  line-height: 1.75;
  color: var(--aide-text-primary);
}
.kb-empty {
  font-size: 12px;
  color: var(--aide-text-muted);
}

/* ── .msg-text 未覆盖的 Markdown 元素 ──
   :deep() 是必需的：v-html 产出的节点不带 scoped 的 data 属性。 */
.kb-body :deep(h1),
.kb-body :deep(h2),
.kb-body :deep(h3),
.kb-body :deep(h4) {
  margin: 18px 0 8px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--aide-text-primary);
}
.kb-body :deep(h1) { font-size: 16px; }
.kb-body :deep(h2) { font-size: 15px; }
.kb-body :deep(h3) { font-size: 14px; }
.kb-body :deep(h4) { font-size: 13px; }
.kb-body :deep(> *:first-child) { margin-top: 0; }

.kb-body :deep(ul),
.kb-body :deep(ol) {
  margin: 6px 0;
  padding-left: 22px;
}
.kb-body :deep(li) { margin: 3px 0; }

.kb-body :deep(blockquote) {
  margin: 8px 0;
  padding: 2px 12px;
  border-left: 3px solid var(--aide-accent);
  color: var(--aide-text-muted);
}

.kb-body :deep(table) {
  margin: 10px 0;
  border-collapse: collapse;
  font-size: 12px;
}
.kb-body :deep(th),
.kb-body :deep(td) {
  padding: 5px 10px;
  border: 1px solid var(--aide-border);
}
.kb-body :deep(th) {
  background: var(--aide-bg-deep);
  font-weight: 600;
}

.kb-body :deep(a) {
  color: var(--aide-accent);
  text-decoration: none;
}
.kb-body :deep(a:hover) { text-decoration: underline; }

.kb-body :deep(img) {
  max-width: 100%;
  border-radius: 6px;
}
.kb-body :deep(hr) {
  margin: 14px 0;
  border: none;
  border-top: 1px solid var(--aide-border);
}
</style>
