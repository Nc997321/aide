<script setup lang="ts">
import type { TaskItem } from "@/types/chat";

const props = defineProps<{ tasks: TaskItem[] }>();

function statusIcon(status: TaskItem["status"]): string {
  if (status === "completed") return "✅";
  if (status === "in_progress") return "🔧";
  return "⬜";
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
      <span class="task-icon">{{ statusIcon(task.status) }}</span>
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
  gap: 6px;
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
  font-size: 11px;
}

.task-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
