<script setup lang="ts">
/**
 * 子会话回报卡片（父会话消息流里；Host 投递的 user_message，display 带 subsession_report）。
 *
 * **不是用户气泡**：左对齐的系统卡片、蓝色描边——这条消息是 Host 代子会话送来的，不是用户说的话。
 * 默认收起成标题 + 状态 + 前几行，展开看全文；「打开子会话」在父会话旁边分屏打开。
 */
import { computed, ref } from "vue";
import type { SubsessionReportBlock } from "@/types/chat";
import { renderMarkdown } from "@/utils/markdown";
import { usePaneLayout } from "@/composables/usePaneLayout";

const props = defineProps<{ block: SubsessionReportBlock }>();

const expanded = ref(false);
const { openSessionBeside } = usePaneLayout();

const STATUS: Record<string, { label: string; tone: string }> = {
  done: { label: "已完成", tone: "done" },
  error: { label: "出错", tone: "err" },
  interrupted: { label: "被打断", tone: "warn" },
};
const ORIGIN: Record<string, string> = {
  task: "执行派发的任务",
  user_task: "执行你派的任务",
  parent: "回应追加指令",
  user: "由你在子会话里触发",
};

const status = computed(() => STATUS[props.block.status] ?? STATUS.done);
const origin = computed(() => ORIGIN[props.block.origin] ?? "");
/** 收起态只露前几行（按行数截，长段落由 CSS 行数限制兜底）。 */
const PREVIEW_LINES = 4;
const lines = computed(() => props.block.text.split("\n"));
const hasMore = computed(() => lines.value.length > PREVIEW_LINES || props.block.text.length > 360);
const shownText = computed(() =>
  expanded.value || !hasMore.value ? props.block.text : lines.value.slice(0, PREVIEW_LINES).join("\n"),
);
const html = computed(() => renderMarkdown(shownText.value || "（这一轮没有文字回复）"));
</script>

<template>
  <section class="ssr" :class="`ssr--${status.tone}`" aria-label="子会话回报">
    <header class="ssr-head">
      <span class="ssr-dot" aria-hidden="true"></span>
      <span class="ssr-kind">子会话回报</span>
      <span class="ssr-title">{{ block.title }}</span>
      <span class="ssr-status">{{ status.label }}</span>
      <span class="ssr-grow"></span>
      <span v-if="origin" class="ssr-origin">{{ origin }}</span>
    </header>
    <!-- 内容来自 renderMarkdown（与主对话同一渲染管道，已转义） -->
    <div class="ssr-body msg-text" :class="{ 'ssr-body--clamped': !expanded && hasMore }" v-html="html"></div>
    <p v-if="block.truncated && expanded" class="ssr-note">回报过长已截断，完整内容在子会话里。</p>
    <footer class="ssr-actions">
      <button v-if="hasMore" type="button" class="ssr-link" @click="expanded = !expanded">
        {{ expanded ? "收起" : "展开全文" }}
      </button>
      <button type="button" class="ssr-link" @click="openSessionBeside(block.childId)">打开子会话</button>
    </footer>
  </section>
</template>

<style scoped>
.ssr {
  --ssr-tone: var(--aide-info);
  margin: 2px 0;
  border: 1px solid color-mix(in srgb, var(--ssr-tone) 30%, var(--aide-border));
  border-radius: var(--aide-radius-md);
  background: color-mix(in srgb, var(--ssr-tone) 5%, var(--aide-bg-base));
  overflow: hidden;
}
.ssr--err {
  --ssr-tone: var(--aide-danger);
}
.ssr--warn {
  --ssr-tone: var(--aide-warning);
}

.ssr-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--aide-border-subtle);
  font-size: 12px;
  color: var(--aide-text-secondary);
  min-width: 0;
}
.ssr-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ssr-tone);
}
.ssr-kind {
  flex: none;
  color: var(--ssr-tone);
}
.ssr-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--aide-text-primary);
}
.ssr-status {
  flex: none;
  padding: 0 7px;
  border-radius: 9px;
  font-size: 11px;
  background: var(--aide-surface-default);
  color: var(--aide-text-secondary);
}
.ssr-grow {
  flex: 1;
}
.ssr-origin {
  flex: none;
  font-size: 11px;
  color: var(--aide-text-muted);
}

.ssr-body {
  padding: 8px 12px 2px;
  font-size: 13px;
}
.ssr-body--clamped {
  max-height: 7.5em;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(to bottom, currentColor 60%, transparent);
  mask-image: linear-gradient(to bottom, currentColor 60%, transparent);
}

.ssr-note {
  margin: 4px 12px 0;
  font-size: 11.5px;
  color: var(--aide-text-muted);
}

.ssr-actions {
  display: flex;
  gap: 14px;
  padding: 4px 12px 8px;
}
.ssr-link {
  padding: 0;
  border: 0;
  background: none;
  font-family: inherit;
  font-size: 12px;
  color: var(--aide-accent);
  cursor: pointer;
}
.ssr-link:hover {
  color: var(--aide-accent-hover);
}
</style>
