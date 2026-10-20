<script setup lang="ts">
/** 一句旁白的文字：按片段 tone 上色（对象亮一点、文件名等宽、失败标红）。
 *  live = 进行中，整句走流光（global.css 的 .aide-narr-live）。 */
import type { NarrSeg } from "@aide/sdk/utils/narration";

defineProps<{ segs: NarrSeg[]; live?: boolean }>();
</script>

<template>
  <span :class="['narr-text', { 'aide-narr-live': live }]"
    ><span
      v-for="(s, i) in segs"
      :key="i"
      :class="s.tone ? `narr-${s.tone}` : undefined"
    >{{ s.text }}</span
  ></span>
</template>

<style scoped>
.narr-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 流光期间统一一个颜色在走，片段各自的颜色会打断光带 */
.narr-text:not(.aide-narr-live) .narr-obj {
  color: var(--aide-text-primary);
}
.narr-text:not(.aide-narr-live) .narr-mono {
  color: var(--aide-text-primary);
}
.narr-mono {
  font-family: var(--aide-font-mono);
  font-size: 0.92em;
}
.narr-text:not(.aide-narr-live) .narr-err {
  color: var(--aide-danger);
}
.narr-text:not(.aide-narr-live) .narr-meta {
  color: var(--aide-text-muted);
}
</style>
