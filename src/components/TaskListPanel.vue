<script setup lang="ts">
import { computed } from "vue";
import type { TaskItem } from "@/types/chat";
import Icon from "./Icon.vue";
import { useTaskListCollapse } from "@/composables/useTaskListCollapse";

const props = defineProps<{ tasks: TaskItem[] }>();

/**
 * 自动折叠状态机：tasks 长度增长 → 展开 + 起计时，STABLE_MS 内无新 task 增长则判定
 * 「创建批次结束」自动收起成摘要条，把高度还给消息区/输入框（解决 todo 过长覆盖输入框）。
 * 手动 toggle 取消计时器；状态变化（长度不变）不触发展开，折叠态下进度仍在摘要条实时更新。
 */
const { collapsed, toggleCollapse } = useTaskListCollapse(() => props.tasks.length);

/** 状态 → Icon.vue 字形 key。进行中带呼吸动画，复用主线程工具步的执行中语义。 */
function iconKey(status: TaskItem["status"]): string {
  if (status === "completed") return "task-done";
  if (status === "in_progress") return "task-run";
  return "task-pending";
}

function displayText(task: TaskItem): string {
  return task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject;
}

// —— 摘要条聚合 ——
const total = computed(() => props.tasks.length);
const completedCount = computed(() => props.tasks.filter((t) => t.status === "completed").length);
const inProgressTask = computed(() => props.tasks.find((t) => t.status === "in_progress") ?? null);

/** 摘要条图标态：全完成 → completed；有进行中 → in_progress；否则 pending（映射 .task-icon 配色）。 */
const summaryIconState = computed<TaskItem["status"]>(() => {
  if (total.value > 0 && completedCount.value === total.value) return "completed";
  if (inProgressTask.value) return "in_progress";
  return "pending";
});
const summaryIconKey = computed(() => iconKey(summaryIconState.value));

/** 摘要条当前文本：进行中显示 activeForm||subject，否则「N 项待办」/「全部完成」。 */
const summaryCurrent = computed(() => {
  if (inProgressTask.value) return displayText(inProgressTask.value);
  if (total.value > 0 && completedCount.value === total.value) return "全部完成";
  return `${total.value - completedCount.value} 项待办`;
});
/** 摘要条文本配色态：in_progress 强调，其余 muted。 */
const summaryCurrentState = computed(() => {
  if (inProgressTask.value) return "in_progress";
  if (total.value > 0 && completedCount.value === total.value) return "all-done";
  return "pending-only";
});
</script>

<template>
  <div class="task-list-panel">
    <!-- 摘要条：常驻头部，点击 toggle 展开/收起 -->
    <button
      class="task-summary"
      type="button"
      :aria-expanded="!collapsed"
      v-tooltip="collapsed ? '展开待办清单' : '收起待办清单'"
      @click="toggleCollapse"
    >
      <Icon
        class="task-summary-icon"
        :class="`task-summary-icon--${summaryIconState}`"
        :name="summaryIconKey"
        :size="13"
        :pulse="summaryIconState === 'in_progress'"
      />
      <span class="task-summary-count">{{ completedCount }}/{{ total }}</span>
      <span class="task-summary-current" :class="`task-summary-current--${summaryCurrentState}`">{{ summaryCurrent }}</span>
      <span class="task-summary-caret" :class="{ 'task-summary-caret--open': !collapsed }" aria-hidden="true"></span>
    </button>
    <!-- body：grid-template-rows 0fr→1fr 高度过渡（现代 Chromium/WebView2 原生支持，
         无需测高），收起时 overflow:hidden 把列表藏进 0 高度行 -->
    <div class="task-list-body-wrap" :class="{ 'task-list-body-wrap--open': !collapsed && total > 0 }">
      <TransitionGroup name="task" tag="div" class="task-list-body">
        <div
          v-for="task in props.tasks"
          :key="task.id"
          class="task-item"
          :class="`task-item-${task.status}`"
        >
          <Icon class="task-icon" :name="iconKey(task.status)" :size="13" :pulse="task.status === 'in_progress'" />
          <span class="task-text">{{ displayText(task) }}</span>
        </div>
      </TransitionGroup>
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

/* —— 摘要条（常驻，收起后只占一行，把高度还给消息区/输入框） —— */
.task-summary {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 10px;
  border: none;
  background: transparent;
  color: var(--aide-text-secondary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  border-radius: var(--aide-radius-sm);
  text-align: left;
  width: 100%;
  transition: background var(--aide-ease-t);
}
.task-summary:hover {
  background: var(--aide-surface-default);
}

.task-summary-icon {
  flex-shrink: 0;
  width: 15px;
  height: 15px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  transition: all var(--aide-ease-t);
}
/* 复用 .task-item 图标的配色语义（completed gradient / in_progress ring / pending border） */
.task-summary-icon--completed {
  background: var(--aide-accent-gradient);
  color: var(--aide-accent);
  box-shadow: 0 0 8px color-mix(in srgb, var(--aide-accent) 40%, transparent);
}
.task-summary-icon--in_progress {
  color: var(--aide-accent);
  box-shadow: 0 0 0 2.5px color-mix(in srgb, var(--aide-accent) 20%, transparent);
}
.task-summary-icon--pending {
  color: transparent;
  border: 1.5px solid var(--aide-text-muted);
}

.task-summary-count {
  flex-shrink: 0;
  font-size: 10.5px;
  color: var(--aide-text-muted);
}

.task-summary-current {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-summary-current--in_progress {
  color: var(--aide-text-primary);
  font-weight: 600;
}
.task-summary-current--all-done,
.task-summary-current--pending-only {
  color: var(--aide-text-muted);
  font-weight: 400;
}

.task-summary-caret {
  flex-shrink: 0;
  width: 0;
  height: 0;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  border-left: 5px solid var(--aide-text-muted);
  opacity: 0.7;
  transition: transform var(--aide-ease-t);
}
.task-summary-caret--open {
  transform: rotate(90deg);
}

/* —— body：grid 0fr→1fr 高度过渡 —— */
.task-list-body-wrap {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--aide-ease-t);
}
.task-list-body-wrap--open {
  grid-template-rows: 1fr;
}
.task-list-body {
  overflow: hidden;
  min-height: 0;
}

/* —— 新 task 入场：从上淡入下落，贴近 Claude 逐个 TaskCreate「一条条建出来」的观感 —— */
.task-enter-from {
  opacity: 0;
  transform: translateY(-6px);
}
.task-enter-active {
  transition: opacity 0.26s var(--aide-ease-t), transform 0.26s var(--aide-ease-t);
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

/* Completed: gradient + glow checkbox。盒体必须是 accent（currentColor→.f 填充），
   勾由 Icon.vue 的 .k 以 bgDeep 刻反色——暗色主题=铜盒深勾，浅色主题=粉盒浅勾。
   之前误用 text-on-accent 作盒色，浅色主题下盒子变黑、勾几乎不可见。 */
.task-item-completed .task-icon {
  background: var(--aide-accent-gradient);
  color: var(--aide-accent);
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

@media (prefers-reduced-motion: reduce) {
  .task-summary-caret,
  .task-summary-icon,
  .task-icon {
    transition: none;
  }
  .task-list-body-wrap {
    transition: none;
  }
  .task-enter-active {
    transition: none;
  }
}
</style>