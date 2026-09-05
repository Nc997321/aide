<script setup lang="ts">
/** 侧栏「自动化」分区：分区树里的根分区之一（会话工作区树之下），
 *  大导航行范式——可折叠、右槽位 计数⇄⋯（⋯ = 新建任务菜单）、
 *  有任务在跑时亮呼吸点。数据全走 useAutomation 单例；
 *  选中任务 → 主区 AutomationDetail。 */
import { ref } from "vue";
import { useAutomation, scheduleText, shortTime } from "../../composables/useAutomation";
import { useContextMenu } from "../../composables/useContextMenu";
import { automationSectionMenuItems } from "../../menus/contextMenus";
import SidebarSectionHead from "../SidebarSectionHead.vue";
import type { AutomationTask } from "../../api/automation";

const auto = useAutomation();
const { show } = useContextMenu();
const collapsed = ref(false);

/** 导航行 ⋯：新建任务入口（与右键体系同一个 useContextMenu）。 */
function onSectionMenu(e: MouseEvent) {
  show(e.clientX, e.clientY, automationSectionMenuItems(() => auto.openEditor(null)));
}

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
      label="自动化"
      :count="auto.state.tasks.length || undefined"
      :live="auto.state.runningIds.size > 0"
      live-title="有任务正在运行"
      :expanded="!collapsed"
      @toggle="collapsed = !collapsed"
      @menu="onSectionMenu"
    >
      <template #icon>
        <!-- 闹钟：定时任务的直觉符号（原闪电与「技能/AI 能力」的语义撞车） -->
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="13.5" r="7.5"/>
          <path d="M7 8L4.4 5.4"/>
          <path d="M17 8L19.6 5.4"/>
          <path d="M7.6 19.5L5.8 21.4"/>
          <path d="M16.4 19.5L18.2 21.4"/>
          <path d="M12 9.8V13.5l2.6 1.7"/>
        </svg>
      </template>
    </SidebarSectionHead>

    <!-- 任务节点（行式，与会话行同一语言） -->
    <div v-if="!collapsed" class="sec-children">
      <div v-if="auto.state.tasks.length === 0" class="sec-empty">
        还没有任务，点上方 ⋯ 新建一个定时助手
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
  margin-top: 2px;
}

.sec-children {
  padding: 3px 0 6px;
  display: flex;
  flex-direction: column;
  /* 与会话分区同一语言（v3.1 层级修正方案A）：沿分区头 chevron 中轴（28px）
     右移 + 1px 引导线，任务节点是「自动化」的子级 */
  margin-left: 28px;
  border-left: 1px solid var(--aide-border-subtle);
}

.sec-empty {
  font-size: 11.5px;
  color: var(--aide-text-muted);
  padding: 10px 12px 10px 20px;
  margin: 3px 8px 0 7px;
  line-height: 1.6;
}

/* 行式任务节点：与会话行同一语言（20px 缩进 / 常态淡底 / 选中 accent 竖条） */
.task-node {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px 10px 20px;
  margin: 3px 8px 0 7px;
  background: var(--aide-surface-default);
  border-radius: var(--aide-radius-md);
  cursor: pointer;
  transition: background var(--aide-ease-t);
}
.task-node:hover {
  background: var(--aide-surface-hover);
}
.task-node.on {
  background: var(--aide-accent-subtle);
}
.task-node.on::before {
  content: "";
  position: absolute;
  left: 12px;
  top: 9px;
  bottom: 9px;
  width: 3px;
  border-radius: 2px;
  background: var(--aide-accent);
}

.r1 {
  display: flex;
  align-items: center;
  gap: 8px;
}
.nm {
  font-size: 13px;
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
  font-size: 10.5px;
  color: var(--aide-text-muted);
  font-family: "Cascadia Code", "Consolas", monospace;
  flex-shrink: 0;
}
.r2 {
  font-size: 11.5px;
  color: var(--aide-text-muted);
  /* 与状态点同列：点是整卡的缩进锚，meta 行左缘对齐点的左缘（都是 20px） */
  padding-left: 0;
  line-height: 1.45;
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
@keyframes auto-pulse {
  50% {
    opacity: 0.35;
  }
}
</style>
