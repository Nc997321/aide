<script setup lang="ts">
/**
 * 值守回报卡片（会话自己的值守投进来的那条消息；display 带 watch_report）。
 *
 * **不是用户气泡**：左对齐的系统卡片——这条消息是值守自动送来的，不是用户说的话。
 * 默认露前几行新内容，展开看全部；结束回报标出原因。
 */
import { computed, ref } from "vue";
import type { WatchReportBlock } from "@/types/chat";

const props = defineProps<{ block: WatchReportBlock }>();

const expanded = ref(false);
const PREVIEW_LINES = 6;
const ended = computed(() => props.block.kind === "ended");
const hasMore = computed(() => props.block.added.length > PREVIEW_LINES);
const shown = computed(() => (expanded.value ? props.block.added : props.block.added.slice(0, PREVIEW_LINES)));
const summary = computed(() => {
  const parts: string[] = [];
  if (props.block.added.length) parts.push(`新增 ${props.block.added.length} 行`);
  if (props.block.removed) parts.push(`消失 ${props.block.removed} 行`);
  return parts.join(" · ");
});
</script>

<template>
  <section class="wrc" :class="{ 'wrc--ended': ended }" aria-label="值守回报">
    <header class="wrc-head">
      <span class="wrc-dot" aria-hidden="true"></span>
      <span class="wrc-kind">{{ ended ? "值守结束" : "值守回报" }}</span>
      <span class="wrc-title">{{ block.title }}</span>
      <span class="wrc-grow"></span>
      <span class="wrc-at">{{ block.at }}</span>
    </header>
    <p v-if="block.focus" class="wrc-meta">盯着：{{ block.focus }}<span v-if="block.source"> · {{ block.source }}</span></p>
    <pre v-if="shown.length" class="wrc-lines">{{ shown.join("\n") }}</pre>
    <p v-if="ended && block.reason" class="wrc-reason">{{ block.reason }}</p>
    <footer v-if="summary || hasMore" class="wrc-foot">
      <span class="wrc-summary">{{ summary }}<span v-if="block.truncated">（只保留了最后一部分）</span></span>
      <span class="wrc-grow"></span>
      <button v-if="hasMore" type="button" class="wrc-link" @click="expanded = !expanded">
        {{ expanded ? "收起" : "展开全部" }}
      </button>
    </footer>
  </section>
</template>

<style scoped>
.wrc {
  --wrc-tone: var(--aide-info);
  margin: 2px 0;
  border: 1px solid color-mix(in srgb, var(--wrc-tone) 30%, var(--aide-border));
  border-radius: var(--aide-radius-md);
  background: color-mix(in srgb, var(--wrc-tone) 5%, var(--aide-bg-base));
  overflow: hidden;
}
.wrc--ended {
  --wrc-tone: var(--aide-text-muted);
}
.wrc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px 4px;
  font-size: 12px;
}
.wrc-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--wrc-tone);
  flex: none;
}
.wrc-kind {
  color: var(--wrc-tone);
  font-weight: 600;
}
.wrc-title {
  color: var(--aide-text-primary);
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wrc-grow {
  flex: 1;
}
.wrc-at,
.wrc-summary {
  color: var(--aide-text-muted);
  font-size: 11px;
}
.wrc-meta,
.wrc-reason {
  margin: 0;
  padding: 0 12px 6px;
  font-size: 12px;
  color: var(--aide-text-secondary);
}
.wrc-lines {
  margin: 0 12px 8px;
  padding: 6px 8px;
  max-height: 260px;
  overflow: auto;
  font-family: var(--aide-font-mono);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--aide-text-primary);
  background: var(--aide-bg-deep);
  border-radius: var(--aide-radius-sm);
}
.wrc-foot {
  display: flex;
  align-items: center;
  padding: 0 12px 7px;
}
.wrc-link {
  border: none;
  background: none;
  padding: 0;
  font-size: 12px;
  color: var(--aide-accent);
  cursor: pointer;
}
.wrc-link:hover {
  text-decoration: underline;
}
</style>
