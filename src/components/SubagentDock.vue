<script setup lang="ts">
import { computed } from "vue";
import type { SubagentBlock } from "@/types/chat";
import SubagentTimeline from "./subagent/SubagentTimeline.vue";
import { subagentStatus, subagentStepCount } from "@/utils/subagent";

/**
 * 子代理面板：活动抽屉（activity/ActivityDrawer）的「子代理」tab——子代理列表 + 时间线阅读区。
 *
 * 为什么要有它：子代理块活在消息流里，定稿后被折进过程胶囊、跑起来又被新内容顶走，
 * 「现在有几个在跑」根本看不见。运行状态由活动带的 chip 常驻（2026-10-16 起，取代原来
 * 这里自带的状态条），点开看这块面板。
 *
 * 视觉身份延续消息流里子代理块那一套：agentAccent 左条 + 大写字距的类型名。
 *
 * 数据来自 useChatSession 的 per-session store（subagent_start/end 累积），
 * 开合与清理语义在 toggleSubagentDock（结束的留着回看，关面板才清）。
 */
const props = defineProps<{
  sessionId: string | null;
  subagents: SubagentBlock[];
  open: boolean;
  selectedId: string | null;
}>();

const emit = defineEmits<{
  "update:selectedId": [id: string];
}>();

const running = computed(() => props.subagents.filter((s) => s.isPending));
const finished = computed(() => props.subagents.filter((s) => !s.isPending));
const selected = computed(() => props.subagents.find((s) => s.id === props.selectedId) ?? null);

/** 列表分组：运行中置顶，已完成的留在下面可回看（空组不占位）。 */
const groups = computed(() =>
  [
    { key: "run", label: "运行中", items: running.value },
    { key: "done", label: "已完成", items: finished.value },
  ].filter((g) => g.items.length > 0),
);

/** 列表项标题：描述优先，没有就退回子代理类型。 */
function itemName(block: SubagentBlock): string {
  return block.description || block.agentName;
}

/** 列表项副标题：类型 · 步数（步数是「干了多少活」最省字的表达）。 */
function itemMeta(block: SubagentBlock): string {
  return `${block.agentName} · ${subagentStepCount(block)} 步`;
}

const STATUS_GLYPH: Record<ReturnType<typeof subagentStatus>, string> = {
  run: "●",
  done: "✓",
  err: "✗",
};

function onSelect(block: SubagentBlock) {
  emit("update:selectedId", block.id);
}
</script>

<template>
  <div v-if="open" class="sadock">

    <div v-if="open" class="sadock-panel">
      <div class="sadock-list">
        <div v-if="subagents.length === 0" class="sadock-empty">本会话还没派发过子代理</div>
        <template v-for="g in groups" :key="g.key">
          <div class="sadock-grp">{{ g.label }}</div>
          <button
            v-for="block in g.items"
            :key="block.id"
            :class="['sadock-item', block.id === selectedId ? 'sadock-item--sel' : '']"
            v-tooltip="block.description"
            @click="onSelect(block)"
          >
            <span :class="['sadock-st', `sadock-st--${subagentStatus(block)}`]">{{ STATUS_GLYPH[subagentStatus(block)] }}</span>
            <span class="sadock-item-main">
              <span class="sadock-item-name">{{ itemName(block) }}</span>
              <span class="sadock-item-meta">{{ itemMeta(block) }}</span>
            </span>
          </button>
        </template>
      </div>

      <!-- 阅读区：普通滚动容器（内容多长都滚得到），头部是消息流那块的头行放大版，
           正文是与内联块展开态同一个组件（subagent/SubagentTimeline.vue）。 -->
      <div class="sadock-out">
        <template v-if="selected">
          <div class="sadock-out-head">
            <span class="sadock-role">Agent</span>
            <span class="sadock-type">{{ selected.agentName }}</span>
            <span class="sadock-out-desc">{{ selected.description }}</span>
            <span v-if="selected.model" class="sadock-out-model">{{ selected.model }}</span>
            <span class="sadock-out-steps">{{ subagentStepCount(selected) }} 步</span>
          </div>
          <div class="sadock-body">
            <SubagentTimeline :block="selected" />
          </div>
        </template>
        <div v-else class="sadock-empty">选择左侧子代理查看时间线</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 撑满活动抽屉的主体；外框归抽屉，左条延续子代理身份 */
.sadock {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.sadock-panel {
  display: flex;
  height: 100%;
  border-left: 3px solid var(--aide-agent-accent);
  background: linear-gradient(90deg, color-mix(in srgb, var(--aide-agent-accent) 5%, transparent), var(--aide-bg-raised) 26%);
  overflow: hidden;
}

.sadock-list {
  width: 238px;
  flex: none;
  border-right: 1px solid var(--aide-border);
  padding: 6px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sadock-grp {
  padding: 6px 9px 3px;
  font-size: 10px;
  letter-spacing: 0.5px;
  color: var(--aide-text-muted);
  text-transform: uppercase;
}

.sadock-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  background: none;
  border: none;
  border-radius: var(--aide-radius-md);
  cursor: pointer;
  text-align: left;
  transition: background var(--aide-ease-t);
}
.sadock-item:hover {
  background: var(--aide-surface-default);
}
.sadock-item--sel {
  background: color-mix(in srgb, var(--aide-agent-accent) 14%, transparent);
}

.sadock-st {
  flex-shrink: 0;
  width: 14px;
  text-align: center;
  font-size: 11px;
}
.sadock-st--run {
  color: var(--aide-agent-accent);
  animation: sadock-pulse 1.6s infinite;
}
.sadock-st--done {
  color: var(--aide-success);
}
.sadock-st--err {
  color: var(--aide-danger);
}
@keyframes sadock-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.sadock-item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.sadock-item-name {
  font-size: 12.5px;
  color: var(--aide-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sadock-item-meta {
  font-family: var(--aide-font-mono);
  font-size: 10.5px;
  color: var(--aide-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sadock-out {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sadock-out-head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--aide-border-subtle);
  font-size: 11.5px;
  color: var(--aide-text-secondary);
}
.sadock-role {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--aide-text-primary);
}
.sadock-type {
  flex-shrink: 0;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--aide-agent-accent);
  background: color-mix(in srgb, var(--aide-agent-accent) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-agent-accent) 25%, transparent);
  border-radius: 3px;
  padding: 1px 5px;
}
.sadock-out-desc {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--aide-text-muted);
}
.sadock-out-model {
  flex-shrink: 0;
  font-family: var(--aide-font-mono);
  font-size: 10px;
  color: var(--aide-text-muted);
  border: 1px solid var(--aide-border);
  border-radius: 4px;
  padding: 0 4px;
}
.sadock-out-steps {
  flex-shrink: 0;
  font-family: var(--aide-font-mono);
  font-size: 10.5px;
  color: var(--aide-agent-accent);
  font-variant-numeric: tabular-nums;
}

/* 阅读区：普通滚动容器，内容多长都滚得到。
   ⚠️ 子项必须 flex-shrink: 0 —— 否则带 overflow:hidden 的子块会被压扁裁掉、
   容器永不溢出（胶囊展开体 2026-09-28 踩过的同一个坑，见 ProcessGroup.vue）。 */
.sadock-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sadock-body > * {
  flex-shrink: 0;
}

.sadock-empty {
  padding: 14px;
  font-size: 12px;
  color: var(--aide-text-muted);
  text-align: center;
}

@media (prefers-reduced-motion: reduce) {
  .sadock-st--run { animation: none; }
}
</style>
