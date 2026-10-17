<script setup lang="ts">
import { computed } from "vue";
import type { BgTask, SubagentBlock } from "@/types/chat";
import SubagentDock from "../SubagentDock.vue";
import BgTaskDock from "../BgTaskDock.vue";
import SubsessionPanel from "../subsession/SubsessionPanel.vue";
import { toggleBgDock, toggleSubagentDock } from "@/composables/useChatSession";
import { toggleSubsessionDrawer, useSubsessions } from "@/composables/useSubsessions";
import type { ActivityTab } from "./activityChips";

/**
 * 活动抽屉（2026-10-16 会话组成重排）：子会话 / 子代理 / 后台任务三块面板合成一个，按 tab 切换。
 * 子代理与后台任务的面板是两个 dock 组件（它们只剩面板，状态条由活动带接管）。
 *
 * 开合状态：子代理 / 后台任务仍是 store 里的两个字段（带各自的清理语义，store 保证互斥）；
 * 子会话 tab 的开合在 useSubsessions（按父会话记）。三者互斥由 openActivityTab 统一收口。
 */
const props = defineProps<{
  sessionId: string | null;
  subagents: SubagentBlock[];
  subagentOpen: boolean;
  subagentSelectedId: string | null;
  bgTasks: BgTask[];
  bgOpen: boolean;
  bgSelectedId: string | null;
  /** 子会话 tab 是否开着（useSubsessions.drawerOpen[sessionId]） */
  subsessionOpen: boolean;
}>();

const emit = defineEmits<{
  "update:subagentSelectedId": [id: string];
  "update:bgSelectedId": [id: string];
}>();

const tab = computed<ActivityTab | null>(() =>
  props.subsessionOpen ? "subsession" : props.subagentOpen ? "subagent" : props.bgOpen ? "bg" : null,
);

const subs = useSubsessions();
const subsessionCount = computed(() => subs.childrenOfSession(props.sessionId).length);

const subagentRunning = computed(() => props.subagents.filter((s) => s.isPending).length);
const bgRunning = computed(() => props.bgTasks.filter((t) => t.status === "running").length);

function openTab(next: ActivityTab) {
  if (!props.sessionId || tab.value === next) return;
  openActivityTab(props.sessionId, next, props);
}

function close() {
  if (props.sessionId) openActivityTab(props.sessionId, null, props);
}
</script>

<script lang="ts">
/**
 * 活动抽屉开到哪个 tab（null = 收起）。三个 tab 互斥：先按各自语义关掉其余的
 * （子代理 / 后台任务的关闭带清理），再开目标。活动带的 chip 与抽屉的 tab 头都走这里。
 */
export function openActivityTab(
  sid: string,
  next: "subsession" | "subagent" | "bg" | null,
  open: { subagentOpen: boolean; bgOpen: boolean; subsessionOpen: boolean },
): void {
  if (next !== "subagent" && open.subagentOpen) toggleSubagentDock(sid);
  if (next !== "bg" && open.bgOpen) toggleBgDock(sid);
  if (next !== "subsession" && open.subsessionOpen) toggleSubsessionDrawer(sid, false);
  if (next === "subagent" && !open.subagentOpen) toggleSubagentDock(sid);
  if (next === "bg" && !open.bgOpen) toggleBgDock(sid);
  if (next === "subsession" && !open.subsessionOpen) toggleSubsessionDrawer(sid, true);
}
</script>

<template>
  <section v-if="tab" class="adrawer" aria-label="活动面板">
    <div class="adrawer-head" role="tablist">
      <button
        v-if="subsessionCount > 0 || tab === 'subsession'"
        type="button"
        role="tab"
        class="adrawer-tab"
        :class="{ 'adrawer-tab--on': tab === 'subsession' }"
        :aria-selected="tab === 'subsession'"
        @click="openTab('subsession')"
      >
        子会话<span v-if="subsessionCount" class="adrawer-n">{{ subsessionCount }}</span>
      </button>
      <button
        type="button"
        role="tab"
        class="adrawer-tab"
        :class="{ 'adrawer-tab--on': tab === 'subagent' }"
        :aria-selected="tab === 'subagent'"
        @click="openTab('subagent')"
      >
        子代理<span v-if="subagentRunning" class="adrawer-n">{{ subagentRunning }}</span>
      </button>
      <button
        type="button"
        role="tab"
        class="adrawer-tab"
        :class="{ 'adrawer-tab--on': tab === 'bg' }"
        :aria-selected="tab === 'bg'"
        @click="openTab('bg')"
      >
        后台任务<span v-if="bgRunning" class="adrawer-n">{{ bgRunning }}</span>
      </button>
      <span class="adrawer-grow"></span>
      <button type="button" class="adrawer-close" @click="close">收起</button>
    </div>
    <div class="adrawer-body">
      <SubsessionPanel v-if="tab === 'subsession' && sessionId" :parent-id="sessionId" />
      <SubagentDock
        v-else-if="tab === 'subagent'"
        :session-id="sessionId"
        :subagents="subagents"
        :open="subagentOpen"
        :selected-id="subagentSelectedId"
        @update:selected-id="(id: string) => emit('update:subagentSelectedId', id)"
      />
      <BgTaskDock
        v-else
        :session-id="sessionId"
        :tasks="bgTasks"
        :open="bgOpen"
        :selected-id="bgSelectedId"
        @update:selected-id="(id: string) => emit('update:bgSelectedId', id)"
      />
    </div>
  </section>
</template>

<style scoped>
.adrawer {
  flex: none;
  display: flex;
  flex-direction: column;
  height: min(360px, 42vh);
  min-height: 200px;
  margin-top: 6px;
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg);
  background: var(--aide-bg-raised);
  box-shadow: var(--aide-shadow-sm), var(--aide-highlight-inset);
  overflow: hidden;
}

.adrawer-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 36px;
  padding: 0 8px;
  border-bottom: 1px solid var(--aide-border);
}

.adrawer-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--aide-radius-sm);
  background: none;
  color: var(--aide-text-muted);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}
.adrawer-tab:hover {
  color: var(--aide-text-secondary);
}
.adrawer-tab--on {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

.adrawer-n {
  font-family: var(--aide-font-mono);
  font-size: 11px;
  color: var(--aide-accent);
}

.adrawer-grow {
  flex: 1;
}

.adrawer-close {
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  background: none;
  color: var(--aide-text-secondary);
  font-family: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.adrawer-close:hover {
  background: var(--aide-surface-hover);
}

.adrawer-body {
  flex: 1;
  min-height: 0;
}
</style>
