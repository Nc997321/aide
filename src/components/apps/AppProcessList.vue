<script setup lang="ts">
/** 应用进程的清单（标题栏徽标的下拉、应用面板顶条的下拉共用）。
 *  只负责画行和「结束」的两次确认；数据与结束动作都在 useAppProcesses。 */
import { ref } from "vue";
import type { AppProcess } from "@aide/sdk/types/apps";
import { workspaceLabelFromPath } from "@aide/sdk/composables/useSessionWorkspaces";

import { describeProcess, processTone, useAppProcesses } from "../../composables/useAppProcesses";
import { errorText } from "../../utils/errors";

defineProps<{
  items: AppProcess[];
  /** 当前显示的工作区根；不在这里的行标出工作区名，点它切过去。 */
  currentWorkspace: string;
}>();

const { now, kill, gotoWorkspace } = useAppProcesses();
/** 结束要点两次：第一次只是亮出确认（同卸载）。 */
const confirming = ref<string | null>(null);
const failure = ref<string | null>(null);

async function end(p: AppProcess) {
  if (confirming.value !== p.runId) {
    confirming.value = p.runId;
    return;
  }
  confirming.value = null;
  failure.value = null;
  try {
    // 状态只认 Host：等它发「清单变了」，不本地改
    await kill(p.runId);
  } catch (e) {
    failure.value = errorText(e);
  }
}
</script>

<template>
  <div class="proc-list">
    <div v-if="items.length === 0" class="proc-empty">现在没有进程在运行</div>
    <div v-for="p in items" :key="p.runId" class="proc-row" :class="{ 'proc-row--done': !p.running }">
      <span class="proc-dot" :class="`proc-dot--${processTone(p)}`" />
      <code class="proc-cmd" v-tooltip="p.cwd ? `${p.command}（在 ${p.cwd}）` : p.command">{{ p.command }}</code>
      <button
        v-if="p.running"
        class="proc-btn"
        :class="{ 'proc-btn--danger': confirming === p.runId }"
        @click="end(p)"
        @blur="confirming = null"
      >
        {{ confirming === p.runId ? "确认结束" : "结束" }}
      </button>
      <div class="proc-meta">
        <span v-if="p.workspace === currentWorkspace" class="proc-ws proc-ws--here">
          {{ workspaceLabelFromPath(p.workspace) }} · 当前
        </span>
        <button v-else class="proc-ws proc-ws--other" v-tooltip="`切到 ${p.workspace}`" @click="gotoWorkspace(p.workspace)">
          {{ workspaceLabelFromPath(p.workspace) }} ↗
        </button>
        <span>{{ describeProcess(p, now) }}</span>
      </div>
    </div>
    <div v-if="failure" class="proc-failure">{{ failure }}</div>
  </div>
</template>

<style scoped>
.proc-list {
  font-size: 12px;
}

.proc-empty {
  padding: 16px 12px;
  color: var(--aide-text-muted);
  text-align: center;
}

.proc-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 3px 8px;
  padding: 7px 12px;
}

.proc-row + .proc-row {
  border-top: 1px solid var(--aide-border-subtle);
}

.proc-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--aide-text-muted);
}

.proc-dot--running {
  background: var(--aide-success);
  animation: proc-pulse 1.6s ease-in-out infinite;
}

.proc-dot--ok {
  background: var(--aide-success);
}

.proc-dot--failed {
  background: var(--aide-danger);
}

@keyframes proc-pulse {
  50% {
    opacity: 0.35;
  }
}

@media (prefers-reduced-motion: reduce) {
  .proc-dot--running {
    animation: none;
  }
}

.proc-cmd {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--aide-font-mono);
  color: var(--aide-text-primary);
}

.proc-row--done .proc-cmd {
  color: var(--aide-text-muted);
}

.proc-meta {
  grid-column: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: var(--aide-text-muted);
  font-variant-numeric: tabular-nums;
}

.proc-btn {
  grid-column: 3;
  grid-row: 1 / span 2;
  padding: 2px 10px;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  background: transparent;
  color: var(--aide-text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.proc-btn:hover {
  color: var(--aide-text-primary);
}

.proc-btn--danger {
  border-color: var(--aide-danger);
  color: var(--aide-danger);
}

.proc-ws {
  padding: 0 6px;
  border: 0;
  border-radius: var(--aide-radius-sm);
  font-size: 11px;
  line-height: 18px;
  background: var(--aide-surface-default);
  color: var(--aide-text-secondary);
}

.proc-ws--here {
  background: var(--aide-accent-subtle);
  color: var(--aide-accent);
}

.proc-ws--other {
  cursor: pointer;
}

.proc-ws--other:hover {
  color: var(--aide-accent);
}

.proc-failure {
  padding: 6px 12px;
  color: var(--aide-danger);
  overflow-wrap: anywhere;
}
</style>
