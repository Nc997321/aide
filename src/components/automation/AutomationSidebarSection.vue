<script setup lang="ts">
/** 侧栏「自动化」分区：分区树里的根分区之一（会话工作区树之下），
 *  VS Code 资源管理器范式——可折叠、hover 出新建按钮、有任务在跑时亮呼吸点。
 *  数据全走 useAutomation 单例；选中任务 → 主区 AutomationDetail。 */
import { ref } from "vue";
import { useAutomation, scheduleText, shortTime } from "../../composables/useAutomation";
import SidebarSectionHead from "../SidebarSectionHead.vue";
import type { AutomationTask } from "../../api/automation";

const auto = useAutomation();
const collapsed = ref(false);

function dotClass(t: AutomationTask): string {
  if (t.lastRunStatus === "running") return "running";
  if (!t.enabled) return "idle";
  if (t.lastRunStatus === "failed") return "fail";
  if (t.lastRunStatus === "succeeded") return "ok";
  return "idle";
}

/** 节点第二行的状态摘要 */
function metaText(t: AutomationTask): string {
  if (t.lastRunStatus === "running") return "running";
  if (!t.enabled) return "已暂停";
  if (!t.lastRunAt) return "从未运行";
  const status = t.lastRunStatus === "failed" ? "失败" : t.lastRunStatus === "skipped" ? "跳过" : "成功";
  return `上次 ${shortTime(t.lastRunAt)} · ${status}`;
}
</script>

<template>
  <div class="auto-sec">
    <SidebarSectionHead
      icon="⚡"
      label="自动化"
      :count="auto.state.tasks.length || undefined"
      :live="auto.state.runningIds.size > 0"
      live-title="有任务正在运行"
      :expanded="!collapsed"
      @toggle="collapsed = !collapsed"
    >
      <template #actions>
        <button class="sec-act-btn" v-tooltip="'新建自动化任务'" @click="auto.openEditor(null)">＋</button>
      </template>
    </SidebarSectionHead>

    <!-- 任务节点 -->
    <div v-if="!collapsed" class="sec-children">
      <div v-if="auto.state.tasks.length === 0" class="sec-empty">
        还没有任务，点 ＋ 新建一个定时助手
      </div>
      <div
        v-for="t in auto.state.tasks"
        :key="t.id"
        class="task-node"
        :class="{ on: auto.state.selectedTaskId === t.id && auto.state.view !== null }"
        @click="auto.selectTask(t.id)"
      >
        <div class="r1">
          <span class="status-dot" :class="dotClass(t)" />
          <span class="nm">{{ t.name }}<span v-if="!t.enabled" class="off">停</span></span>
          <span class="sched">{{ scheduleText(t.schedule) }}</span>
        </div>
        <div class="r2" :class="{ live: t.lastRunStatus === 'running' }">{{ metaText(t) }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.auto-sec {
  margin-top: 8px;
  border-top: 1px solid var(--aide-border-subtle);
  padding-top: 8px;
}

.sec-children {
  padding: 0 10px 0 14px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sec-empty {
  font-size: 11px;
  color: var(--aide-text-muted);
  padding: 8px 10px;
  line-height: 1.6;
}

.task-node {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: var(--aide-radius-sm);
  border: 1px solid transparent;
  cursor: pointer;
  transition: all var(--aide-ease-t);
}
.task-node:hover {
  background: var(--aide-surface-hover);
}
.task-node.on {
  background: var(--aide-accent-subtle);
  border-color: color-mix(in srgb, var(--aide-accent) 35%, transparent);
}

.r1 {
  display: flex;
  align-items: center;
  gap: 7px;
}
.nm {
  font-size: 12px;
  font-weight: 600;
  color: var(--aide-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.nm .off {
  color: var(--aide-text-muted);
  font-weight: 400;
  font-size: 10px;
  margin-left: 4px;
}
.sched {
  font-size: 10px;
  color: var(--aide-text-muted);
  font-family: "Cascadia Code", "Consolas", monospace;
  flex-shrink: 0;
}
.r2 {
  font-size: 10.5px;
  color: var(--aide-text-muted);
  padding-left: 14px;
}
.r2.live {
  color: var(--aide-info);
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--aide-text-muted);
}
.status-dot.ok {
  background: var(--aide-success);
}
.status-dot.fail {
  background: var(--aide-danger);
}
.status-dot.running {
  background: var(--aide-info);
  animation: auto-pulse 1.2s infinite;
}
.status-dot.idle {
  background: var(--aide-text-muted);
}
</style>
