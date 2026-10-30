<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { BgTask } from "@/types/chat";
import { processHead, type ProcessSegment } from "@/utils/blockSegments";
import ProcessStep from "./ProcessGroup/ProcessStep.vue";

const props = defineProps<{
  segment: ProcessSegment;
  finalized: boolean;
  showThinking: boolean;
  workspacePath?: string;
  bgTasks?: BgTask[];
}>();
const emit = defineEmits<{ "open-bg-dock": [taskId: string] }>();

const expanded = ref(false);
const head = computed(() => processHead(props.segment.blocks));
const history = computed(() => props.segment.blocks.filter(block =>
  block !== head.value && (block.type !== "thinking" || props.showThinking),
));
const failedCount = computed(() => history.value.filter(block =>
  block.type !== "thinking" && block.isError,
).length);
const stepKey = computed(() => head.value.type === "thinking" ? "thinking" : head.value.id);
// 当前指令交接或回答结束时收起；结果回填、正文和思考增量不撤掉当前 diff。
watch([stepKey, () => props.segment.current, () => props.finalized], () => { expanded.value = false; });
</script>

<template>
  <div class="process-group">
    <ProcessStep
      :key="stepKey"
      v-model:expanded="expanded"
      :block="head"
      :current="segment.current"
      :show-thinking="showThinking"
      :workspace-path="workspacePath"
      :bg-tasks="bgTasks"
      @open-bg-dock="emit('open-bg-dock', $event)"
    >
      <template #summary-extra>
        <span v-if="history.length" class="process-count">{{ history.length }} 项历史</span>
        <span v-if="failedCount" class="process-errors">{{ failedCount }} 项未成功</span>
      </template>
      <template #history>
        <div v-if="history.length" class="process-history">
          <div class="process-history-label">历史过程</div>
          <ProcessStep
            v-for="(block, index) in history"
            :key="block.type === 'thinking' ? `thinking-${index}` : block.id"
            :block="block"
            :show-thinking="showThinking"
            :workspace-path="workspacePath"
            :bg-tasks="bgTasks"
            @open-bg-dock="emit('open-bg-dock', $event)"
          />
        </div>
      </template>
    </ProcessStep>
  </div>
</template>

<style scoped>
.process-count,
.process-errors {
  flex-shrink: 0;
  font-size: 11px;
  line-height: 1.6;
  white-space: nowrap;
}
.process-count { color: var(--aide-text-muted); }
.process-errors { color: var(--aide-danger); }
.process-history {
  display: flex;
  flex-direction: column;
  gap: var(--aide-space-unit);
  margin: calc(var(--aide-space-unit) * 2) 0 var(--aide-space-unit) calc(var(--aide-space-unit) * 1.5);
  padding-left: calc(var(--aide-space-unit) * 3.5);
  border-left: 1px solid var(--aide-border-subtle);
}
.process-history-label { font-size: 11px; color: var(--aide-text-muted); }
</style>
