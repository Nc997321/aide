<script setup lang="ts">
import { computed, ref } from "vue";
import type { KbRefBlock } from "@/types/chat";
import { useKbSelections } from "@/composables/useKbSelections";

/**
 * 用户气泡里的「知识库选区」卡片：用户在知识库文档里圈定的一段 + 当时写的意见。
 *
 * 折叠行一眼看清三件事：**哪篇文档的哪一处**（《标题》· 第 N 行）、**用户要什么**（意见）、
 * **这一处现在怎么样了**（只有本次运行里发出去的才有实时状态：处理中 / 已改 / 没改成）。
 * 点开才看被圈的原文——它是给 AI 的授权范围，用户也该能核对「我圈的就是这段」。
 * 不认识这个块的客户端会整块跳过（消息不消失），所以这里不用管降级形态。
 */
const props = defineProps<{ block: KbRefBlock }>();
const expanded = ref(false);

const kbSel = useKbSelections();
/** 实时状态：store 里有这条（本次运行发出的）才显示；重开历史时没有，卡片就是纯静态的。 */
const live = computed(() => kbSel.records[props.block.selectionId]);

const lines = computed(() =>
  props.block.lineStart === props.block.lineEnd ? `第 ${props.block.lineStart} 行` : `第 ${props.block.lineStart}–${props.block.lineEnd} 行`,
);

const statusChip = computed<{ text: string; tone: "work" | "ok" | "bad" | "idle" } | null>(() => {
  const r = live.value;
  if (!r) return null;
  switch (r.status) {
    case "sent":
    case "working":
      return { text: "AI 处理中", tone: "work" };
    case "done":
      return { text: `已改 · v${r.versionNo ?? ""}`, tone: "ok" };
    case "refused":
      return { text: "没有改成", tone: "bad" };
    case "noop":
      return { text: "未改动", tone: "idle" };
    default:
      return null;
  }
});
</script>

<template>
  <div class="kr" :class="{ 'kr--open': expanded }">
    <button class="kr-head" :aria-expanded="expanded" @click="expanded = !expanded">
      <svg class="kr-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M7 3h7l5 5v13H7z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
        <path d="M14 3v5h5M10 13h6M10 17h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
      <span class="kr-title" v-tooltip="`知识库《${block.title}》`">{{ block.title || "未命名文档" }}</span>
      <span class="kr-lines">{{ lines }}</span>
      <span class="kr-comment" :class="{ 'kr-comment--empty': !block.comment }">{{ block.comment || "（仅指出这一处）" }}</span>
      <span v-if="statusChip" class="kr-status" :class="`kr-status--${statusChip.tone}`">
        <i v-if="statusChip.tone === 'work'" class="kr-pulse" aria-hidden="true" />
        {{ statusChip.text }}
      </span>
      <span class="kr-caret tri" :class="{ 'kr-caret--open': expanded }" aria-hidden="true" />
    </button>
    <div v-if="expanded" class="kr-body">
      <div class="kr-scope">
        <span class="kr-scope-tag" :class="{ 'kr-scope-tag--wide': !block.precise }">{{ block.precise ? "精确选中" : "已扩大到整块" }}</span>
        <span>AI 只被允许修改下面这一段</span>
      </div>
      <pre class="kr-quote">{{ block.text }}</pre>
      <p v-if="live?.status === 'refused' && live.message" class="kr-note kr-note--bad">{{ live.message }}</p>
      <p v-else-if="live?.warning" class="kr-note kr-note--warn">写入后核对发现文档里同时有别的改动，请到「历史」里确认。</p>
    </div>
  </div>
</template>

<style scoped>
.kr {
  margin: 4px 0;
  font-size: 11.5px;
  border: 1px solid var(--aide-border-subtle);
  border-left: 3px solid var(--aide-accent);
  border-radius: var(--aide-radius-md);
  background: var(--aide-bg-base);
  overflow: hidden;
  box-shadow: var(--aide-highlight-inset);
}
.kr-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 12px;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  font: inherit;
  font-size: 12px;
  color: var(--aide-text-secondary);
  transition: background var(--aide-ease-t);
}
.kr-head:hover {
  background: var(--aide-surface-default);
}
.kr-head:focus-visible {
  outline: 2px solid var(--aide-accent);
  outline-offset: -2px;
}
.kr-icon {
  flex-shrink: 0;
  color: var(--aide-accent);
}
.kr-title {
  flex-shrink: 1;
  min-width: 0;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--aide-text-primary);
}
.kr-lines {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 9px;
  font-size: 10.5px;
  color: var(--aide-accent);
  background: var(--aide-accent-subtle);
}
.kr-comment {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--aide-text-primary);
}
.kr-comment--empty {
  color: var(--aide-text-muted);
}
.kr-status {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px;
  border-radius: 9px;
  font-size: 10.5px;
  font-weight: 600;
}
.kr-status--work {
  color: var(--aide-agent-accent);
  background: color-mix(in srgb, var(--aide-agent-accent) 12%, transparent);
}
.kr-status--ok {
  color: var(--aide-success);
  background: color-mix(in srgb, var(--aide-success) 12%, transparent);
}
.kr-status--bad {
  color: var(--aide-danger);
  background: color-mix(in srgb, var(--aide-danger) 12%, transparent);
}
.kr-status--idle {
  color: var(--aide-text-muted);
  background: var(--aide-surface-default);
}
.kr-pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--aide-agent-accent);
  animation: kr-pulse 1.1s ease-in-out infinite;
}
.kr-caret {
  flex-shrink: 0;
  color: var(--aide-text-muted);
  transition: transform var(--aide-ease-t);
}
.kr-caret--open {
  transform: rotate(90deg);
}
.kr-body {
  padding: 8px 12px 12px;
  border-top: 1px solid var(--aide-border-subtle);
}
.kr-scope {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  color: var(--aide-text-muted);
}
.kr-scope-tag {
  padding: 1px 7px;
  border-radius: 9px;
  font-size: 10.5px;
  color: var(--aide-accent);
  background: var(--aide-accent-subtle);
}
.kr-scope-tag--wide {
  color: var(--aide-warning);
  background: color-mix(in srgb, var(--aide-warning) 12%, transparent);
}
.kr-quote {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  padding: 9px 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.65;
  color: var(--aide-text-primary);
  background: color-mix(in srgb, var(--aide-accent) 7%, var(--aide-surface-default));
  border-left: 2px solid color-mix(in srgb, var(--aide-accent) 55%, transparent);
  border-radius: var(--aide-radius-sm);
}
.kr-note {
  margin: 8px 0 0;
  font-size: 11.5px;
}
.kr-note--bad {
  color: var(--aide-danger);
}
.kr-note--warn {
  color: var(--aide-warning);
}
@keyframes kr-pulse {
  0%, 100% { opacity: 0.35; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1.1); }
}
@media (prefers-reduced-motion: reduce) {
  .kr-pulse { animation: none; }
}
</style>
