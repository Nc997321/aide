<script setup lang="ts">
import { computed, ref } from "vue";
import type { PageRefBlock } from "@/types/chat";

/**
 * 用户气泡里的「页面选区」卡片：浏览器里点选的一个元素 + 用户当时写的意见。
 *
 * 折叠行就是全部（与子代理块同一思路）：`◎ 元素标签 · 意见`；点开才看 HTML / 样式 / 位置 /
 * 来源线索。意见是用户的话，必须在折叠态就看得见；HTML 是给 agent 的，默认不占地方。
 * 不认识这个块的客户端会整块跳过（消息不消失），所以这里不需要考虑降级形态。
 */
const props = defineProps<{ block: PageRefBlock }>();

const expanded = ref(false);

/** 选择器末段当标题——整条 CSS 路径太长，末段（`button.primary`）才是用户认得的那个东西。 */
const label = computed(() => {
  const parts = props.block.selector.split(/\s*>\s*/);
  return parts[parts.length - 1] || props.block.tag;
});

const styleLine = computed(() =>
  Object.entries(props.block.styles ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("; "),
);

const rectLine = computed(() => {
  const r = props.block.rect;
  if (!r) return "";
  const vp = props.block.viewport ? ` · 视口 ${Math.round(props.block.viewport.w)}×${Math.round(props.block.viewport.h)}` : "";
  return `(${Math.round(r.x)}, ${Math.round(r.y)}) ${Math.round(r.w)}×${Math.round(r.h)}${vp}`;
});
</script>

<template>
  <div class="pr">
    <button class="pr-head" :aria-expanded="expanded" @click="expanded = !expanded">
      <span class="pr-mark" aria-hidden="true">◎</span>
      <span class="pr-label" v-tooltip="block.selector">{{ label }}</span>
      <span class="pr-comment" :class="{ 'pr-comment--empty': !block.comment }">{{ block.comment || "（仅指出这个元素）" }}</span>
      <span class="pr-caret tri" :class="{ 'pr-caret--open': expanded }" aria-hidden="true"></span>
    </button>
    <div v-if="expanded" class="pr-body">
      <div class="pr-row"><span class="pr-k">页面</span><span class="pr-v">{{ block.title ? `${block.title} · ` : "" }}{{ block.url }}</span></div>
      <div class="pr-row"><span class="pr-k">选择器</span><code class="pr-v">{{ block.selector }}</code></div>
      <div v-if="block.source" class="pr-row"><span class="pr-k">来源线索</span><code class="pr-v">{{ block.source }}</code><span class="pr-note">开发构建，仅供参考</span></div>
      <div v-if="rectLine" class="pr-row"><span class="pr-k">位置</span><span class="pr-v">{{ rectLine }}</span></div>
      <div v-if="styleLine" class="pr-row"><span class="pr-k">样式</span><span class="pr-v">{{ styleLine }}</span></div>
      <pre class="pr-html">{{ block.html }}</pre>
    </div>
  </div>
</template>

<style scoped>
.pr {
  margin: 4px 0;
  font-size: 11.5px;
  border: 1px solid var(--aide-border-subtle);
  border-left: 3px solid var(--aide-accent);
  border-radius: var(--aide-radius-md);
  background: var(--aide-bg-base);
  overflow: hidden;
}
.pr-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 12px;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  font-size: 12px;
  color: var(--aide-text-secondary);
  transition: background var(--aide-ease-t);
}
.pr-head:hover {
  background: var(--aide-surface-default);
}
.pr-head:focus-visible {
  outline: 2px solid var(--aide-accent);
  outline-offset: -2px;
}
.pr-mark {
  flex-shrink: 0;
  color: var(--aide-accent);
}
.pr-label {
  flex-shrink: 0;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--aide-font-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--aide-text-primary);
}
.pr-comment {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--aide-text-primary);
}
.pr-comment--empty {
  color: var(--aide-text-muted);
}
.pr-caret {
  flex-shrink: 0;
  color: var(--aide-text-muted);
}
.pr-caret--open {
  transform: rotate(90deg);
}
.pr-body {
  padding: 4px 12px 10px;
  border-top: 1px solid var(--aide-border-subtle);
  color: var(--aide-text-secondary);
}
.pr-row {
  display: flex;
  gap: 8px;
  padding: 3px 0;
  align-items: baseline;
}
.pr-k {
  flex: 0 0 56px;
  color: var(--aide-text-muted);
}
.pr-v {
  min-width: 0;
  overflow-wrap: anywhere;
}
.pr-note {
  color: var(--aide-text-muted);
  font-size: 10.5px;
}
.pr-html {
  margin: 6px 0 0;
  padding: 8px 10px;
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--aide-font-mono);
  font-size: 11px;
  background: var(--aide-surface-default);
  border-radius: var(--aide-radius-sm);
}
</style>
