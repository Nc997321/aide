<script setup lang="ts">
import type { TaskItem } from "@/types/chat";
import Icon from "./Icon.vue";

const props = defineProps<{ tasks: TaskItem[] }>();

/** 状态 → Icon.vue 字形 key。进行中带呼吸动画，复用主线程工具步的执行中语义。 */
function iconKey(status: TaskItem["status"]): string {
  if (status === "completed") return "task-done";
  if (status === "in_progress") return "task-run";
  return "task-pending";
}

function displayText(task: TaskItem): string {
  return task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject;
}
</script>

<template>
  <div class="task-list-panel">
    <div
      v-for="task in props.tasks"
      :key="task.id"
      class="task-item"
      :class="`task-item-${task.status}`"
    >
      <Icon class="task-icon" :name="iconKey(task.status)" :size="13" :pulse="task.status === 'in_progress'" />
      <span class="task-text">{{ displayText(task) }}</span>
    </div>
  </div>
</template>

<style scoped>
.task-list-panel {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--aide-border);
  background: var(--aide-bg-raised);
  font-size: 12px;
}

.task-item {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--aide-text-secondary);
}

.task-item-completed {
  color: var(--aide-text-muted);
  text-decoration: line-through;
}

.task-item-in_progress {
  color: var(--aide-text-primary);
  font-weight: 600;
}

.task-icon {
  flex-shrink: 0;
  color: var(--aide-accent);
}

.task-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>