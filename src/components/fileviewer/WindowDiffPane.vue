<script setup lang="ts">
import { computed } from "vue";
import DiffViewer from "./DiffViewer.vue";
import { estimateDiffHeight } from "../../utils/diffHeight";
import { useSettings } from "../../composables/useSettings";
import type { WindowDiff, WindowDiffPart } from "../../composables/useFileViewer";

/**
 * 文件窗的 diff 内容：一段或多段。
 *
 * - 单段（git 全文 diff：HEAD → 当前）→ 铺满窗口，与既有 git diff 窗一致；
 * - 多段（某一轮内的工具片段）→ 按行数估算高度依次堆叠，超出窗口内滚。
 *   段之间**不合并**：合并要把 N 段重算成一段，行号语义会失真，而片段视图的价值
 *   恰恰是「文件里的真实位置」（每段带 firstLine 偏移显示真实行号）。
 */
const props = defineProps<{
  diff: WindowDiff;
  filePath: string;
}>();

const { settings } = useSettings();

/** 多段：堆叠 + 内滚（单段铺满，走 CSS flex:1）。 */
const multi = computed(() => props.diff.parts.length > 1);

function partStyle(part: WindowDiffPart): Record<string, string> | undefined {
  if (!multi.value) return undefined;
  return { minHeight: `${estimateDiffHeight(part.pair, settings.fontSize)}px` };
}
</script>

<template>
  <div class="wdp">
    <div v-if="diff.note" class="wdp-note">{{ diff.note }}</div>
    <div class="wdp-parts" :class="{ 'wdp-parts--scroll': multi }">
      <div
        v-for="(part, i) in diff.parts"
        :key="i"
        class="wdp-part"
        :class="{ 'wdp-part--multi': multi }"
        :style="partStyle(part)"
      >
        <div v-if="multi" class="wdp-part-head">片段 {{ i + 1 }} / {{ diff.parts.length }}</div>
        <DiffViewer
          :pair="part.pair"
          :file-path="filePath"
          :first-line-number="part.firstLine"
          :show-badge="!multi"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.wdp {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* 视图来源说明（累计视图 vs 本轮片段），常驻条：不写清就会被当成同一件事 */
.wdp-note {
  flex-shrink: 0;
  padding: 4px 10px;
  font-size: 10px;
  font-style: italic;
  color: var(--aide-text-muted);
  border-bottom: 1px solid var(--aide-border-subtle);
}

.wdp-parts {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.wdp-parts--scroll {
  overflow-y: auto;
}

.wdp-part {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

/* 多段：按估算高度撑开（min-height 由 partStyle 给），窗口不够高时整列内滚 */
.wdp-part--multi {
  flex: 1 0 auto;
  overflow: hidden;
}

.wdp-part-head {
  flex-shrink: 0;
  padding: 4px 10px 2px;
  font-size: 10px;
  color: var(--aide-text-muted);
}

.wdp-parts--scroll::-webkit-scrollbar {
  width: 8px;
}
.wdp-parts--scroll::-webkit-scrollbar-track {
  background: transparent;
}
.wdp-parts--scroll::-webkit-scrollbar-thumb {
  background: var(--aide-surface-hover);
  border-radius: 4px;
}
</style>
