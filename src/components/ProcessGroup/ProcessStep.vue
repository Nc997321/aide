<script setup lang="ts">
import type { BgTask } from "@/types/chat";
import { isChangeTool, type ProcessBlock } from "@/utils/blockSegments";
import ToolCallBlock from "../ToolCallBlock.vue";
import SubagentCallBlock from "../SubagentCallBlock.vue";
import ThinkingBlock from "../ThinkingBlock.vue";

withDefaults(defineProps<{
  block: ProcessBlock;
  current?: boolean;
  showThinking: boolean;
  workspacePath?: string;
  bgTasks?: BgTask[];
}>(), { current: false });
const expanded = defineModel<boolean>("expanded", { default: false });
const emit = defineEmits<{ "open-bg-dock": [taskId: string] }>();
</script>

<template>
  <ToolCallBlock
    v-if="block.type === 'tool_call'"
    v-model:expanded="expanded"
    :block="block"
    :current="current && isChangeTool(block.name)"
    :workspace-path="workspacePath"
    :bg-tasks="bgTasks"
    @open-bg-dock="emit('open-bg-dock', $event)"
  >
    <template #summary-extra><slot name="summary-extra" /></template>
    <template #history><slot name="history" /></template>
  </ToolCallBlock>
  <SubagentCallBlock v-else-if="block.type === 'subagent'" v-model:expanded="expanded" :block="block">
    <template #summary-extra><slot name="summary-extra" /></template>
    <template #history><slot name="history" /></template>
  </SubagentCallBlock>
  <ThinkingBlock
    v-else
    v-model:expanded="expanded"
    presentation="process"
    :text="block.text"
    :truncated="block.truncated"
    :streaming="current"
    :show-content="showThinking"
  >
    <template #summary-extra><slot name="summary-extra" /></template>
    <template #history><slot name="history" /></template>
  </ThinkingBlock>
</template>
