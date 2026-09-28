<script setup lang="ts">
import { computed } from "vue";
import type { SubagentBlock } from "@/types/chat";
import SubagentTimeline from "./subagent/SubagentTimeline.vue";
import { toggleSubagentDock } from "@/composables/useChatSession";
import { subagentStatus, subagentStepCount } from "@/utils/subagent";

/**
 * 子代理 dock：状态条（常驻）+ 底部展开面板（子代理列表 + 时间线阅读区）。
 * 布局同 BgTaskDock —— inline dock，占真实布局空间挤压消息区，不是浮层。
 *
 * 为什么要有它：子代理块活在消息流里，定稿后被折进过程胶囊、跑起来又被新内容顶走，
 * 「现在有几个在跑」根本看不见。dock 把「运行中」提到输入框上方常驻可见。
 *
 * 视觉身份与后台任务刻意区分（同屏时不该靠读字分辨）：agentAccent 左条 + 节点字形
 * （图标语义＝中心派发子节点）+ 大写字距的类型名，全是消息流里子代理块那一套；
 * 后台任务保持中性底 + 绿点 + 圆点状态。
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

/** 状态条：有子代理或面板开着才出现。 */
const barVisible = computed(() => props.subagents.length > 0 || props.open);

/** 状态条读数：运行中把数量单独拆出来（数字染 accent、用等宽字），其余态给整句。 */
const barState = computed(() => {
  const n = running.value.length;
  if (n > 0) return { count: n, text: "个子代理运行中" };
  const anyFailed = props.subagents.some((s) => s.isError);
  return { count: null, text: anyFailed ? "✗ 有子代理失败" : "✓ 子代理全部完成" };
});

/** 状态条上的名字（第一个运行中的 + 余量提示）。 */
const barNames = computed(() => {
  const names = running.value.map(itemName);
  if (names.length === 0) return "";
  const first = names[0].length > 40 ? names[0].slice(0, 40) + "…" : names[0];
  return names.length > 1 ? `${first} 等 ${names.length} 个` : first;
});

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

function onToggle() {
  if (props.sessionId) toggleSubagentDock(props.sessionId);
}

function onSelect(block: SubagentBlock) {
  emit("update:selectedId", block.id);
}
</script>

<template>
  <div v-if="barVisible" class="sadock">
    <!-- 状态条：常驻，点击开合。左条 + 节点字形 + 大写字距类型名 = 子代理身份，
         与后台任务条（中性底 + 绿点）刻意区分。 -->
    <button class="sadock-bar" :aria-expanded="open" @click="onToggle">
      <svg
        class="sadock-glyph" width="14" height="14" viewBox="0 0 16 16" fill="none"
        stroke="currentColor" stroke-width="1.2" aria-hidden="true"
      >
        <!-- 节点图：中心节点派发子节点（icons.ts 的 agent 字形） -->
        <path d="M8 8L3.8 4.5M8 8L3.8 11.5M8 8L12.5 8" />
        <circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none" />
        <circle cx="3.8" cy="4.5" r="1.3" fill="currentColor" stroke="none" />
        <circle cx="3.8" cy="11.5" r="1.3" fill="currentColor" stroke="none" />
        <circle cx="12.5" cy="8" r="1.3" fill="currentColor" stroke="none" />
      </svg>
      <span class="sadock-bar-text">
        <span v-if="barState.count !== null" class="sadock-bar-n">{{ barState.count }}</span>
        <span>{{ barState.text }}</span>
      </span>
      <span v-if="barNames" class="sadock-bar-names">{{ barNames }}</span>
      <span class="sadock-caret">{{ open ? "▾" : "▴" }}</span>
    </button>

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
.sadock {
  flex: none;
  display: flex;
  flex-direction: column;
  margin: 8px 12px 0;
}

/* 状态条：agentAccent 左条 + 同色微染底 —— 与消息流里的子代理块同一道条 */
.sadock-bar {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 6px 12px;
  border: 1px solid color-mix(in srgb, var(--aide-agent-accent) 28%, transparent);
  border-left: 3px solid var(--aide-agent-accent);
  border-radius: var(--aide-radius-md);
  background: linear-gradient(90deg, color-mix(in srgb, var(--aide-agent-accent) 10%, transparent), var(--aide-bg-raised) 46%);
  color: var(--aide-text-secondary);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
  transition: border-color var(--aide-ease-t);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
}
.sadock-bar:hover {
  border-color: color-mix(in srgb, var(--aide-agent-accent) 45%, transparent);
}

.sadock-glyph {
  flex-shrink: 0;
  color: var(--aide-agent-accent);
}

/* inline-flex + gap：数字与措辞分开渲染（数字单独染色），间距交给布局，
   不靠模板里的空格（否则会多出/丢掉空白） */
.sadock-bar-text {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  font-weight: 600;
  color: var(--aide-text-primary);
  white-space: nowrap;
}
.sadock-bar-n {
  font-family: var(--aide-font-mono);
  color: var(--aide-agent-accent);
  font-variant-numeric: tabular-nums;
}
.sadock-bar-names {
  font-family: var(--aide-font-mono);
  font-size: 11px;
  color: var(--aide-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sadock-caret {
  margin-left: auto;
  font-size: 14px; /* 全项目三角箭头统一 14px */
  color: var(--aide-text-muted);
  flex-shrink: 0;
}

/* 面板：挤压消息区的真实布局块（同 BgTaskDock），左条延续子代理身份 */
.sadock-panel {
  display: flex;
  height: 300px;
  margin-top: 6px;
  border: 1px solid color-mix(in srgb, var(--aide-agent-accent) 25%, transparent);
  border-left: 3px solid var(--aide-agent-accent);
  border-radius: var(--aide-radius-lg);
  background: linear-gradient(90deg, color-mix(in srgb, var(--aide-agent-accent) 5%, transparent), var(--aide-bg-raised) 26%);
  overflow: hidden;
  box-shadow: var(--aide-shadow-sm), var(--aide-highlight-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
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
