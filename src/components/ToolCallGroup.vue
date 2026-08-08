<script setup lang="ts">
/**
 * 连续工具调用的墨线折叠组（spec·墨线装帧）：
 * 收起（默认）= 挂在铜色垂线上的一行摘要；live 态摘要实时显示正在执行的工具；
 * 展开 = 组内逐条 ToolCallBlock 墨线行。展开状态不持久化，随窗口化卸载重置。
 */
import { computed, ref } from "vue";
import type { ToolCallBlock as ToolCallBlockData, BgTask } from "@/types/chat";
import ToolCallBlock from "./ToolCallBlock.vue";
import { groupStats } from "@/utils/blockSegments";
import { summarizeToolInput } from "@/utils/toolSummary";

const props = defineProps<{
  blocks: ToolCallBlockData[];
  /** 消息仍在流式生成且本组是最后一段——摘要行进入"正在执行"实时态 */
  live?: boolean;
  /** 后台任务列表（ChatMessage 链透传）——组内 Bash 转入后台时摘要行/卡片显示徽章 */
  bgTasks?: BgTask[];
}>();

const emit = defineEmits<{
  /** 卡片徽章点击：打开后台任务 dock 并选中该任务 */
  "open-bg-dock": [taskId: string];
}>();

const expanded = ref(false);

const stats = computed(() => groupStats(props.blocks));

/** 组内转入后台且仍在运行的任务数——收起态摘要行的提示徽标 */
const bgRunningCount = computed(
  () =>
    (props.bgTasks ?? []).filter(
      (t) => t.status === "running" && props.blocks.some((b) => b.id === t.toolUseId),
    ).length,
);

/** 种类分布按次数降序取前 3，剩余归"…" */
const kindsLabel = computed(() => {
  const top = stats.value.kinds
    .slice(0, 3)
    .map((k) => `${k.name} ×${k.count}`)
    .join(" · ");
  return stats.value.kinds.length > 3 ? `${top} · …` : top;
});

/** 流式态下正在执行的那条（组尾的 pending 块）；null 表示按完成态渲染摘要 */
const running = computed(() => {
  if (!props.live) return null;
  const last = props.blocks[props.blocks.length - 1];
  return last?.isPending ? last : null;
});

const doneCount = computed(() => props.blocks.filter((b) => !b.isPending).length);

const runningSummary = computed(() =>
  running.value ? summarizeToolInput(running.value.name, running.value.input) : "",
);
</script>

<template>
  <div class="tool-group">
    <span :class="['tg-node', running ? 'tg-node--live' : '']"></span>
    <button class="tg-summary" :aria-expanded="expanded" @click="expanded = !expanded">
      <template v-if="running">
        <span class="tg-label">正在执行</span> <span class="tg-name">{{ running.name }}</span>
        <span class="tg-kinds tg-kinds--path" v-tooltip="runningSummary"><bdo dir="ltr">{{ runningSummary }}</bdo></span>
        <span v-if="doneCount > 0" class="tg-label"> · 已完成 {{ doneCount }}</span>
      </template>
      <template v-else>
        <span class="tg-n">{{ stats.total }}</span> 次工具调用
        <span class="tg-kinds">{{ kindsLabel }}</span>
        <span v-if="stats.errorCount > 0" class="tg-err"> · {{ stats.errorCount }} 失败</span>
      </template>
      <span v-if="bgRunningCount > 0" class="tg-bg">● {{ bgRunningCount }} 后台运行中</span>
    </button>
    <div v-if="expanded" class="tg-items">
      <ToolCallBlock
        v-for="b in blocks"
        :key="b.id"
        :block="b"
        :bg-tasks="bgTasks"
        @open-bg-dock="(taskId: string) => emit('open-bg-dock', taskId)"
      />
    </div>
  </div>
</template>

<style scoped>
/* 工具组：GALLERY .tc-group-row 计数胶囊卡片 */
.tool-group {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
}

/* 时间线节点在卡片化组中不再显示 */
.tg-node {
  display: none;
}

.tg-summary {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  text-align: left;
  font-size: 12px;
  color: var(--aide-text-secondary);
  padding: 8px 12px;
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-md);
  cursor: pointer;
  box-shadow: var(--aide-highlight-inset);
  transition: background var(--aide-ease-t);
}
.tg-summary:hover {
  background: var(--aide-surface-default);
}

/* 计数胶囊 */
.tg-n {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 19px;
  height: 19px;
  padding: 0 6px;
  border-radius: 99px;
  background: var(--aide-surface-active);
  border: 1px solid var(--aide-border);
  font-size: 10.5px;
  font-weight: 600;
  color: var(--aide-text-primary);
}

/* 固定项不可收缩：收缩压力只落在 .tg-kinds 上，否则长命令会把
   "正在执行"/工具名挤成逐字竖排（匿名文本项 flex-shrink 默认 1） */
.tg-label {
  flex-shrink: 0;
  white-space: nowrap;
}

.tg-name {
  color: var(--aide-accent);
  font-weight: 600;
  flex-shrink: 0;
  white-space: nowrap;
}
.tg-name,
.tg-kinds {
  font-family: var(--aide-font-mono);
}
.tg-kinds {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--aide-text-muted);
}
/* 正在执行摘要（多为 file_path / 命令）：左侧省略，保住末尾文件名 */
.tg-kinds--path {
  direction: rtl;
  text-align: left;
}
.tg-err {
  color: var(--aide-danger);
}

/* 组内后台任务提示：与 ToolCallBlock 的 ti-bgchip 同一配方 */
.tg-bg {
  flex-shrink: 0;
  margin-left: auto;
  font-size: 10.5px;
  padding: 1px 8px;
  border-radius: 999px;
  color: var(--aide-agent-accent);
  background: color-mix(in srgb, var(--aide-agent-accent) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-agent-accent) 25%, transparent);
  white-space: nowrap;
  animation: tg-bg-pulse 1.6s infinite;
}
@keyframes tg-bg-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

.tg-items {
  display: flex;
  flex-direction: column;
  margin-left: 8px;
}
</style>
