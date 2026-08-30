/** 自动化面板的状态中枢：模块级 reactive 单例（useNotifications 范式）。
 *
 *  主区挂载语义：`view` 非 null 时 App.vue 用 AutomationMain 盖住 PaneLayout
 *  （v-show 保活聊天区）。选中会话（onSessionChanged）时 App 调 closePanel() 切回聊天。
 *
 *  实时刷新：监听 chat-event 通道的 automation_run_finished（调度器在运行终态发出），
 *  刷新任务列表 + 当前详情的 runs/stats。 */
import { reactive } from "vue";
import { listen } from "../api";
import { useNotifications } from "./useNotifications";
import {
  automationApi,
  type AutomationTask,
  type AutomationTaskInput,
  type RunRecord,
  type RunStats,
  type Schedule,
} from "../api/automation";

const state = reactive({
  loaded: false,
  tasks: [] as AutomationTask[],
  /** 侧栏树里当前选中的任务 */
  selectedTaskId: null as string | null,
  /** 主区视图：null = 聊天（面板关闭） */
  view: null as "detail" | "editor" | null,
  /** editor 编辑对象；null + view=editor = 新建 */
  editingTaskId: null as string | null,
  runs: [] as RunRecord[],
  stats: null as RunStats | null,
  runsLoading: false,
  /** 调度器眼里的运行中任务（lastRunStatus=running），驱动侧栏呼吸点 */
  runningIds: new Set<string>(),
});

let listenerReady = false;

async function refreshTasks(): Promise<void> {
  state.tasks = await automationApi.list();
  state.runningIds = new Set(state.tasks.filter((t) => t.lastRunStatus === "running").map((t) => t.id));
  state.loaded = true;
}

async function loadRuns(id: string): Promise<void> {
  state.runsLoading = true;
  try {
    state.runs = await automationApi.runs(id, 100);
  } finally {
    state.runsLoading = false;
  }
}

async function loadStats(id: string): Promise<void> {
  state.stats = await automationApi.stats(id);
}

/** 侧栏点选任务：打开详情并拉运行记录/统计。 */
async function selectTask(id: string): Promise<void> {
  state.selectedTaskId = id;
  state.view = "detail";
  state.editingTaskId = null;
  await Promise.all([loadRuns(id), loadStats(id)]);
}

function openEditor(taskId: string | null): void {
  state.editingTaskId = taskId;
  if (taskId) state.selectedTaskId = taskId;
  state.view = "editor";
}

function backToDetail(): void {
  state.view = state.selectedTaskId ? "detail" : null;
  state.editingTaskId = null;
}

/** 关闭面板回聊天（选中会话/删除当前任务后由 App 或组件调用）。 */
function closePanel(): void {
  state.view = null;
  state.editingTaskId = null;
}

async function saveTask(input: AutomationTaskInput): Promise<AutomationTask> {
  const saved = state.editingTaskId
    ? await automationApi.update(state.editingTaskId, input)
    : await automationApi.create(input);
  await refreshTasks();
  state.selectedTaskId = saved.id;
  state.view = "detail";
  state.editingTaskId = null;
  await Promise.all([loadRuns(saved.id), loadStats(saved.id)]);
  return saved;
}

async function deleteTask(id: string): Promise<void> {
  await automationApi.remove(id);
  const wasSelected = state.selectedTaskId === id;
  await refreshTasks();
  if (wasSelected) {
    state.selectedTaskId = state.tasks[0]?.id ?? null;
    if (state.selectedTaskId) {
      await Promise.all([loadRuns(state.selectedTaskId), loadStats(state.selectedTaskId)]);
      state.view = "detail";
    } else {
      closePanel();
    }
  }
}

async function toggleEnabled(task: AutomationTask): Promise<void> {
  await automationApi.setEnabled(task.id, !task.enabled);
  await refreshTasks();
}

async function runNow(id: string): Promise<string | null> {
  try {
    await automationApi.runNow(id);
    await refreshTasks();
    if (state.selectedTaskId === id) await loadRuns(id);
    return null;
  } catch (e) {
    return String(e);
  }
}

async function redistill(id: string): Promise<void> {
  await automationApi.redistill(id);
  await refreshTasks();
}

async function readPlaybook(id: string): Promise<string | null> {
  return automationApi.playbook(id);
}

function ensureListener(): void {
  if (listenerReady) return;
  listenerReady = true;
  void listen("chat-event", (e) => {
    const p = e.payload as {
      type?: string;
      automation_task_id?: string;
      task_name?: string;
      fire?: string;
    };
    // 运行/蒸馏终态：刷新任务表 + 当前详情的 runs/stats
    if (p?.type === "automation_run_finished") {
      void refreshTasks().then(() => {
        const id = p.automation_task_id;
        if (id && state.selectedTaskId === id && state.view === "detail") {
          void Promise.all([loadRuns(id), loadStats(id)]);
        }
      });
      return;
    }
    // 错过触发（策略=询问）：转推应用内通知中心（warning 级，落盘可复看）
    if (p?.type === "automation_missed" && p.automation_task_id) {
      useNotifications().push({
        severity: "warning",
        source: "自动化",
        title: `「${p.task_name ?? "任务"}」错过定时触发`,
        body: `预定的 ${p.fire ?? ""} 未执行（客户端未运行）。到自动化面板可手动补跑。`,
        timestamp: Date.now(),
        dedupKey: `automation-missed-${p.automation_task_id}-${p.fire ?? ""}`,
      });
    }
  });
}

/** App.vue onMounted 调用一次：拉任务表 + 注册终态监听。 */
async function init(): Promise<void> {
  ensureListener();
  await refreshTasks();
}

// ── 展示辅助（组件共用的纯函数） ──

const WEEKDAY_CN = ["", "一", "二", "三", "四", "五", "六", "日"];

/** 调度的人类可读摘要（侧栏节点/详情 chip 用）。 */
export function scheduleText(s: Schedule): string {
  switch (s.kind) {
    case "daily":
      return `每天 ${s.time}`;
    case "weekly": {
      const days = [...s.weekdays].sort((a, b) => a - b).map((d) => `周${WEEKDAY_CN[d] ?? d}`);
      return `每${days.length > 1 ? days.join("、") : days[0]} ${s.time}`;
    }
    case "monthly":
      return `每月 ${s.day} 日 ${s.time}`;
    case "interval": {
      const unit = s.unit === "minutes" ? "分钟" : s.unit === "hours" ? "小时" : "天";
      return `每 ${s.every} ${unit}`;
    }
    case "once":
      return `单次 · ${s.at.replace("T", " ").slice(5, 16)}`;
  }
}

/** "2026-08-21T18:30:00" → "08-21 18:30" */
export function shortTime(iso: string | null): string {
  return iso ? iso.replace("T", " ").slice(5, 16) : "";
}

export function formatDurationMs(ms: number | null): string {
  if (ms === null) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}`;
}

export function useAutomation() {
  return {
    // 裸 state 暴露（useSessionState/useNotifications 同款惯例）——组件只读用，
    // 变更只经下面这几个动作，靠 review 纪律而非类型系统强制。
    state,
    refreshTasks,
    selectTask,
    openEditor,
    backToDetail,
    closePanel,
    saveTask,
    deleteTask,
    toggleEnabled,
    runNow,
    redistill,
    readPlaybook,
    init,
  };
}
