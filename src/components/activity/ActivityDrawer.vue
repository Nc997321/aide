<script setup lang="ts">
import { computed } from "vue";
import type { BgTask, SubagentBlock } from "@/types/chat";
import SubagentDock from "../SubagentDock.vue";
import BgTaskDock from "../BgTaskDock.vue";
import { toggleBgDock, toggleSubagentDock } from "@/composables/useChatSession";
import type { ActivityTab } from "./activityChips";

/**
 * 活动抽屉（2026-10-16 会话组成重排）：原先子代理 dock 与后台任务 dock 各自的展开面板
 * 合成一个，按 tab 切换。面板内容是两个 dock 组件（2026-10-16 起它们只剩面板，状态条由活动带接管）。
 *
 * 开合状态仍是 store 里的两个字段（bgDockOpen / subagentDockOpen，带各自的清理语义）；
 * store 保证同一时刻最多一个为 true，所以「开着哪个 tab」直接由它们推出。
 */
const props = defineProps<{
  sessionId: string | null;
  subagents: SubagentBlock[];
  subagentOpen: boolean;
  subagentSelectedId: string | null;
  bgTasks: BgTask[];
  bgOpen: boolean;
  bgSelectedId: string | null;
}>();

const emit = defineEmits<{
  "update:subagentSelectedId": [id: string];
  "update:bgSelectedId": [id: string];
}>();

const tab = computed<ActivityTab | null>(() =>
  props.subagentOpen ? "subagent" : props.bgOpen ? "bg" : null,
);

const subagentRunning = computed(() => props.subagents.filter((s) => s.isPending).length);
const bgRunning = computed(() => props.bgTasks.filter((t) => t.status === "running").length);

/** 切 tab：已开着的不动；没开的打开（store 会先关掉另一个）。 */
function openTab(next: ActivityTab) {
  const sid = props.sessionId;
  if (!sid || tab.value === next) return;
  if (next === "subagent") toggleSubagentDock(sid);
  else toggleBgDock(sid);
}

function close() {
  const sid = props.sessionId;
  if (!sid) return;
  if (props.subagentOpen) toggleSubagentDock(sid);
  if (props.bgOpen) toggleBgDock(sid);
}
</script>

<template>
  <section v-if="tab" class="adrawer" aria-label="活动面板">
    <div class="adrawer-head" role="tablist">
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
      <SubagentDock
        v-if="tab === 'subagent'"
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
