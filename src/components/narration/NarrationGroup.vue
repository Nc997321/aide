<script setup lang="ts">
/**
 * 合并旁白（2026-10-20 旁白改版，取代过程卡）：相邻的 ≥2 次同类工具调用说成一句
 * （「读了 5 个文件：a.ts、b.ts 等」）。点开 → 逐条子句（每条是一行 ToolCallBlock，
 * 再点开看原始细节：输出、diff、参数）。
 *
 * 只有一次调用时不走这里——ChatMessage 直接渲染 ToolCallBlock（它的头行就是一句旁白，
 * 点开直接是细节，没有中间这层）。
 */
import { computed, ref } from "vue";
import type { BgTask, ToolCallBlock as ToolCall } from "@/types/chat";
import ToolCallBlock from "../ToolCallBlock.vue";
import NarrationIcon from "./NarrationIcon.vue";
import NarrationText from "./NarrationText.vue";
import { narrate } from "@aide/sdk/utils/narration";
import { buildChangeInfo } from "@/utils/changeCard";
import { isChangeTool } from "@/utils/blockSegments";

const props = defineProps<{
  blocks: ToolCall[];
  workspacePath?: string;
  bgTasks?: BgTask[];
}>();

const emit = defineEmits<{
  "open-bg-dock": [taskId: string];
}>();

const expanded = ref(false);

const narration = computed(() => narrate(props.blocks));

/** 修改类合并句的总 +N −M。 */
const diffStat = computed(() => {
  let add = 0;
  let del = 0;
  let any = false;
  for (const b of props.blocks) {
    if (!isChangeTool(b.name) || b.isError) continue;
    const info = buildChangeInfo(b.name, b.input);
    if (!info) continue;
    any = true;
    add += info.addCount;
    del += info.delCount;
  }
  return any ? { add, del } : null;
});

const iconState = computed(() => {
  const n = narration.value;
  return n.live ? "run" : n.denied ? "deny" : n.error ? "err" : "";
});

const deniedLabel = computed(() => (narration.value.denied?.kind === "policy" ? "规则拒绝" : "已拒绝"));
</script>

<template>
  <div class="ng narr-row">
    <button class="ng-row" type="button" :aria-expanded="expanded" @click="expanded = !expanded">
      <span :class="['ng-icon', iconState && `ng-icon--${iconState}`]"><NarrationIcon :name="narration.icon" /></span>
      <NarrationText class="ng-text" :segs="narration.segs" :live="narration.live" />
      <span v-if="diffStat" class="ng-diff">
        <span class="stat-add">+{{ diffStat.add }}</span>
        <span v-if="diffStat.del > 0" class="stat-del">-{{ diffStat.del }}</span>
      </span>
      <span v-if="narration.denied" class="ng-pill">{{ deniedLabel }}</span>
      <svg
        :class="['ng-chev', { 'ng-chev--open': expanded }]"
        width="8" height="12" viewBox="0 0 8 12" fill="none" aria-hidden="true"
      >
        <path d="M2 1.5l4 4.5-4 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <div v-if="expanded" class="ng-kids">
      <ToolCallBlock
        v-for="b in blocks"
        :key="b.id"
        :block="b"
        :workspace-path="workspacePath"
        :bg-tasks="bgTasks"
        @open-bg-dock="(taskId: string) => emit('open-bg-dock', taskId)"
      />
    </div>
  </div>
</template>

<style scoped>
.ng-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: calc(100% + 16px);
  margin: 0 -8px;
  padding: 2px 8px;
  background: none;
  border: none;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: var(--aide-text-secondary);
  transition: background var(--aide-ease-t);
}
.ng-row:hover {
  background: var(--aide-surface-default);
}
.ng-icon {
  flex-shrink: 0;
  display: inline-flex;
  color: var(--aide-text-muted);
}
.ng-icon--run { color: var(--aide-accent); }
.ng-icon--err { color: var(--aide-danger); }
.ng-icon--deny { color: var(--aide-warning); }
.ng-text {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--aide-text-secondary);
}
.ng-diff {
  flex-shrink: 0;
  display: flex;
  gap: 4px;
  font-family: var(--aide-font-mono);
  font-size: 11px;
}
.stat-add { color: var(--aide-success); }
.stat-del { color: var(--aide-danger); }
.ng-pill {
  flex-shrink: 0;
  font-size: 10.5px;
  padding: 1px 8px;
  border-radius: 999px;
  white-space: nowrap;
  color: var(--aide-warning);
  background: color-mix(in srgb, var(--aide-warning) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-warning) 25%, transparent);
}
.ng-chev {
  flex-shrink: 0;
  margin-left: auto;
  color: var(--aide-text-muted);
  opacity: 0;
  transition: opacity var(--aide-ease-t), transform var(--aide-ease-t);
}
.ng-row:hover .ng-chev,
.ng-chev--open {
  opacity: 1;
}
.ng-chev--open {
  transform: rotate(90deg);
}
/* 子句：缩进 + 一条细竖线，表明它们是上面那句的展开 */
.ng-kids {
  margin: 2px 0 4px 6px;
  padding-left: 14px;
  border-left: 1px solid var(--aide-border-subtle);
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.ng-kids :deep(.tool-item + .tool-item) {
  margin-top: 0;
}
.ng-kids :deep(.ti-narr) {
  font-size: 12.5px;
}
</style>
