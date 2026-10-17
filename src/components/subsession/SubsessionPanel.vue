<script setup lang="ts">
/**
 * 子会话面板：活动抽屉的「子会话」tab（子会话设计 §8.5-2 / 线框 A2）。
 *
 * 左边按「需要你 / 进行中 / 空闲」分组列出本会话的子会话，右边是选中项的详情：任务、待办进度、
 * 最近一次回报，以及 打开（在父会话旁边分屏）/ 停止这一轮。
 *
 * 数据：父子关系与最近回报来自 useSubsessions（可回种的缓存，打开时用 `list_subsessions` 回种一次）；
 * 在跑 / 等批准看 useSessionState——与侧栏流光同一份，不另开状态源。本端从没收到过某个子会话的事件
 * （比如刚重开窗口）时，用 Host 回种时给的运行态兜底显示。
 */
import { computed, onMounted, ref, watch } from "vue";
import { api } from "@/api";
import { useSubsessions, seedChildren } from "@/composables/useSubsessions";
import { useSessionState } from "@/composables/useSessionState";
import { usePaneLayout } from "@/composables/usePaneLayout";
import { tasksOf } from "@/composables/useChatSession";
import type { ChildActivity } from "../activity/activityChips";

const props = defineProps<{ parentId: string }>();

const subs = useSubsessions();
const { state } = useSessionState();
const { openSessionBeside } = usePaneLayout();

/** Host 回种时报的运行态（本端没有该子会话状态时兜底用）。 */
const hostStatus = ref<Record<string, string>>({});

async function reseed() {
  try {
    const list = await api.listSubsessions(props.parentId);
    seedChildren(props.parentId, list);
    hostStatus.value = Object.fromEntries(list.map((c) => [c.id, c.status]));
  } catch (e) {
    console.warn("[SubsessionPanel] list_subsessions 失败:", e);
  }
}
onMounted(reseed);
watch(() => props.parentId, reseed);

function activityOf(id: string): ChildActivity {
  const local = state[id];
  if (local) return local as ChildActivity;
  const host = hostStatus.value[id];
  if (host === "waiting_approval") return "attention";
  if (host === "running") return "running";
  return "waiting";
}

const children = computed(() => subs.childrenOfSession(props.parentId));

const groups = computed(() => {
  const need = children.value.filter((c) => activityOf(c.id) === "attention");
  const run = children.value.filter((c) => activityOf(c.id) === "running");
  const idle = children.value.filter((c) => {
    const a = activityOf(c.id);
    return a !== "attention" && a !== "running";
  });
  return [
    { key: "need", label: "需要你", items: need },
    { key: "run", label: "进行中", items: run },
    { key: "idle", label: "空闲", items: idle },
  ].filter((g) => g.items.length > 0);
});

const selectedId = ref<string | null>(null);
const selected = computed(
  () => children.value.find((c) => c.id === selectedId.value) ?? groups.value[0]?.items[0] ?? null,
);

const STATUS_LABEL: Record<ChildActivity, string> = {
  attention: "待批准",
  running: "运行中",
  waiting: "空闲",
  stopped: "已停止",
};
const REPORT_LABEL: Record<string, string> = { done: "已完成", error: "出错", interrupted: "被打断" };

const selectedTasks = computed(() => (selected.value ? tasksOf(selected.value.id) : []));
const selectedTodo = computed(() => {
  const t = selectedTasks.value;
  if (!t.length) return null;
  return { done: t.filter((x) => x.status === "completed").length, total: t.length };
});

const runningIds = computed(() =>
  children.value.filter((c) => {
    const a = activityOf(c.id);
    return a === "running" || a === "attention";
  }).map((c) => c.id),
);

function stop(id: string) {
  api.interruptSession(id).catch((e: unknown) => console.warn("[SubsessionPanel] 停止失败:", e));
}

function stopAll() {
  for (const id of runningIds.value) stop(id);
}
</script>

<template>
  <div class="ssp">
    <div class="ssp-list">
      <div v-if="children.length === 0" class="ssp-empty">本会话还没派过子会话</div>
      <template v-for="g in groups" :key="g.key">
        <div class="ssp-grp">{{ g.label }}</div>
        <button
          v-for="c in g.items"
          :key="c.id"
          type="button"
          class="ssp-item"
          :class="{ 'ssp-item--sel': selected?.id === c.id }"
          @click="selectedId = c.id"
        >
          <span class="ssp-dot" :class="`ssp-dot--${activityOf(c.id)}`" aria-hidden="true"></span>
          <span class="ssp-item-main">
            <span class="ssp-item-name">{{ c.title }}</span>
            <span class="ssp-item-meta">
              {{ STATUS_LABEL[activityOf(c.id)] }}<template v-if="c.lastReport"> · {{ c.lastReport.firstLine }}</template>
            </span>
          </span>
        </button>
      </template>
      <button v-if="runningIds.length > 1" type="button" class="ssp-stop-all" @click="stopAll">
        停止全部（{{ runningIds.length }}）
      </button>
    </div>
    <div class="ssp-detail">
      <template v-if="selected">
        <div class="ssp-detail-head">
          <span class="ssp-dot" :class="`ssp-dot--${activityOf(selected.id)}`" aria-hidden="true"></span>
          <span class="ssp-detail-title">{{ selected.title }}</span>
          <span class="ssp-detail-status">{{ STATUS_LABEL[activityOf(selected.id)] }}</span>
          <span class="ssp-grow"></span>
          <button
            v-if="activityOf(selected.id) === 'running' || activityOf(selected.id) === 'attention'"
            type="button"
            class="ssp-btn"
            @click="stop(selected.id)"
          >停止这一轮</button>
          <button type="button" class="ssp-btn ssp-btn--pri" @click="openSessionBeside(selected.id)">
            {{ activityOf(selected.id) === "attention" ? "去处理" : "打开" }}
          </button>
        </div>
        <div v-if="selectedTodo" class="ssp-todo">
          <span>计划</span>
          <span class="ssp-bar" aria-hidden="true"><i :style="{ width: `${Math.round((selectedTodo.done / selectedTodo.total) * 100)}%` }"></i></span>
          <span class="ssp-mono">{{ selectedTodo.done }}/{{ selectedTodo.total }}</span>
        </div>
        <div v-if="selected.task" class="ssp-sec">
          <div class="ssp-sec-label">任务</div>
          <div class="ssp-sec-text">{{ selected.task }}</div>
        </div>
        <div v-if="selected.lastReport" class="ssp-sec">
          <div class="ssp-sec-label">最近回报 · {{ REPORT_LABEL[selected.lastReport.status] ?? "已完成" }}</div>
          <div class="ssp-sec-text">{{ selected.lastReport.firstLine || "（这一轮没有文字回复）" }}</div>
        </div>
        <div v-if="!selected.task && !selected.lastReport" class="ssp-hint">
          打开子会话可以看它的完整过程、直接插话，权限请求也在那里批。
        </div>
      </template>
      <div v-else class="ssp-empty">选择左侧子会话查看</div>
    </div>
  </div>
</template>

<style scoped>
.ssp {
  display: flex;
  height: 100%;
  border-left: 3px solid var(--aide-info);
}

.ssp-list {
  width: 250px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  border-right: 1px solid var(--aide-border);
  overflow-y: auto;
}

.ssp-grp {
  padding: 6px 8px 2px;
  font-size: 11px;
  color: var(--aide-text-muted);
}

.ssp-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: var(--aide-radius-sm);
  background: none;
  color: var(--aide-text-secondary);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.ssp-item:hover {
  background: var(--aide-surface-hover);
}
.ssp-item--sel {
  background: var(--aide-surface-default);
  border-color: var(--aide-border-strong);
  color: var(--aide-text-primary);
}
.ssp-item-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.ssp-item-name {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ssp-item-meta {
  font-size: 11px;
  color: var(--aide-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssp-dot {
  flex: none;
  width: 7px;
  height: 7px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--aide-text-muted);
}
.ssp-dot--running {
  background: var(--aide-success);
}
.ssp-dot--attention {
  background: var(--aide-warning);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--aide-warning) 18%, transparent);
}
.ssp-dot--waiting {
  background: var(--aide-info);
}

.ssp-stop-all {
  margin-top: auto;
  padding: 6px 8px;
  border: 1px solid color-mix(in srgb, var(--aide-danger) 30%, var(--aide-border));
  border-radius: var(--aide-radius-sm);
  background: none;
  color: var(--aide-danger);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.ssp-detail {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 14px;
  overflow-y: auto;
}
.ssp-detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ssp-detail-head .ssp-dot {
  margin-top: 0;
}
.ssp-detail-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--aide-text-primary);
}
.ssp-detail-status {
  flex: none;
  font-size: 11.5px;
  color: var(--aide-text-muted);
}
.ssp-grow {
  flex: 1;
}

.ssp-btn {
  flex: none;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  background: var(--aide-surface-default);
  color: var(--aide-text-secondary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}
.ssp-btn:hover {
  background: var(--aide-surface-hover);
}
.ssp-btn--pri {
  border-color: color-mix(in srgb, var(--aide-accent) 45%, transparent);
  background: var(--aide-accent-subtle);
  color: var(--aide-text-primary);
}

.ssp-todo {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--aide-text-secondary);
}
.ssp-bar {
  width: 90px;
  height: 4px;
  border-radius: 2px;
  background: var(--aide-surface-default);
  overflow: hidden;
}
.ssp-bar i {
  display: block;
  height: 100%;
  background: var(--aide-success);
}
.ssp-mono {
  font-family: var(--aide-font-mono);
  font-size: 11px;
}

.ssp-sec-label {
  margin-bottom: 3px;
  font-size: 11px;
  color: var(--aide-text-muted);
}
.ssp-sec-text {
  font-size: 12.5px;
  color: var(--aide-text-secondary);
  white-space: pre-wrap;
  max-height: 9em;
  overflow-y: auto;
}

.ssp-hint,
.ssp-empty {
  font-size: 12px;
  color: var(--aide-text-muted);
  padding: 8px;
}
</style>
