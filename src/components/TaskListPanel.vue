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
  gap: 0;
  padding: 4px 10px;
  border-bottom: 1px solid var(--aide-border);
  background: var(--aide-bg-base);
  font-size: 12px;
}

.task-item {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 7px 10px;
  color: var(--aide-text-secondary);
  border-radius: var(--aide-radius-sm);
}

.task-item + .task-item {
  border-top: 1px solid var(--aide-border-subtle);
}

.task-item-completed {
  color: var(--aide-text-muted);
}

.task-item-completed .task-text {
  color: var(--aide-text-muted);
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--aide-text-muted) 60%, transparent);
}

.task-item-in_progress {
  color: var(--aide-text-primary);
}

.task-item-in_progress .task-text {
  color: var(--aide-text-primary);
  font-weight: 600;
}

.task-icon {
  flex-shrink: 0;
  width: 15px;
  height: 15px;
  margin-top: 1px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  transition: all var(--aide-ease-t);
}

/* Completed: gradient + glow checkbox */
.task-item-completed .task-icon {
  background: var(--aide-accent-gradient);
  color: var(--aide-text-on-accent);
  box-shadow: 0 0 8px color-mix(in srgb, var(--aide-accent) 40%, transparent);
}

/* In progress: accent ring */
.task-item-in_progress .task-icon {
  color: var(--aide-accent);
  box-shadow: 0 0 0 2.5px color-mix(in srgb, var(--aide-accent) 20%, transparent);
}

/* Pending: muted border */
.task-item-pending .task-icon {
  color: transparent;
  border: 1.5px solid var(--aide-text-muted);
}

.task-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
</style>