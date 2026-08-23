<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import type { BgTask } from "@/types/chat";
import { toggleBgDock } from "@/composables/useChatSession";
import { api } from "@/api";
import { buildXtermTheme } from "../utils/xterm";
import { MONO_FONT_STACK } from "../utils/fonts";
import { windowsPtyConfig } from "../utils/platform";
import { useSettings } from "../composables/useSettings";

/**
 * 后台任务 dock：状态条（常驻）+ 底部展开面板（任务列表 + xterm 实时输出）。
 * 布局对齐 PermissionDialog 的 inline dock 模式——占真实布局空间挤压消息区，
 * 不是浮层（滚动置底由 ChatPanel 的 RO 双观察自动兜底，不需要数据层触发器）。
 *
 * 数据全部来自 useChatSession 的 per-session store（bg_task_* 事件累积）；
 * 开合/清理语义在 toggleBgDock（结束的任务下次点开时才清）。
 */
const props = defineProps<{
  sessionId: string | null;
  tasks: BgTask[];
  open: boolean;
  selectedId: string | null;
}>();

const emit = defineEmits<{
  "update:selectedId": [id: string];
}>();

const { settings } = useSettings();

const runningTasks = computed(() => props.tasks.filter((t) => t.status === "running"));
const selectedTask = computed(() => props.tasks.find((t) => t.id === props.selectedId) ?? null);

/** 状态条：有任务或面板开着才出现。 */
const barVisible = computed(() => props.tasks.length > 0 || props.open);

const barText = computed(() => {
  const n = runningTasks.value.length;
  if (n > 0) return `${n} 个后台任务运行中`;
  const anyFailed = props.tasks.some((t) => t.status === "failed");
  return anyFailed ? "✗ 有后台任务失败" : "✓ 后台任务全部完成";
});

/** 状态条上的运行中命令名（第一个 + 余量提示）。 */
const barNames = computed(() => {
  const names = runningTasks.value.map((t) => t.command || t.description || t.id);
  if (names.length === 0) return "";
  const first = names[0].length > 40 ? names[0].slice(0, 40) + "…" : names[0];
  return names.length > 1 ? `${first} 等 ${names.length} 个` : first;
});

function onToggle() {
  if (props.sessionId) toggleBgDock(props.sessionId);
}

function onSelect(task: BgTask) {
  emit("update:selectedId", task.id);
}

/** 终止后台任务：fire-and-forget——终态经 bg_task_ended(status:"stopped") 回来，
 *  列表图标/时长自动收尾，不需要本地乐观更新。 */
function onStop(task: BgTask, e: MouseEvent) {
  e.stopPropagation(); // 不触发选中切换
  if (!props.sessionId || task.status !== "running") return;
  api.stopBgTask(props.sessionId, task.id).catch(() => {});
}

// ── 运行时长：面板开着且有运行中任务时每秒走表 ────────────────────────────
const nowTs = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | null = null;

function fmtDuration(task: BgTask): string {
  const end = task.endedAt ?? nowTs.value;
  const s = Math.max(0, Math.floor((end - task.startedAt) / 1000));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

watch(
  () => props.open && runningTasks.value.length > 0,
  (ticking) => {
    if (ticking && !clockTimer) {
      clockTimer = setInterval(() => {
        nowTs.value = Date.now();
      }, 1000);
    } else if (!ticking && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  },
  { immediate: true },
);

// ── xterm 输出区：单 Terminal 复用，切任务全量重写、同任务只写新增后缀 ──────
const termEl = ref<HTMLDivElement>();
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
/** 已写入终端的内容快照——新 output 以它为前缀就只写后缀，否则（截头/换任务）全量重写。 */
let writtenSoFar = "";
/** 终端当前呈现的是哪个任务的输出——不同任务即使输出有前缀重合也必须全量重写。 */
let writtenTaskId: string | null = null;

function disposeTerminal() {
  resizeObserver?.disconnect();
  resizeObserver = null;
  terminal?.dispose();
  terminal = null;
  fitAddon = null;
  writtenSoFar = "";
  writtenTaskId = null;
}

async function initTerminal() {
  await nextTick();
  if (!termEl.value || terminal) return;
  const wpCfg = windowsPtyConfig();
  terminal = new Terminal({
    theme: buildXtermTheme(),
    scrollback: 5000,
    disableStdin: true,
    fontSize: 12,
    fontFamily: settings.terminalFontFamily || MONO_FONT_STACK,
    ...(wpCfg ? { windowsPty: wpCfg } : {}),
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(termEl.value);
  fitAddon.fit();
  resizeObserver = new ResizeObserver(() => fitAddon?.fit());
  resizeObserver.observe(termEl.value);
  writeTaskOutput(selectedTask.value, true);
}

/** 把任务输出写进终端。full=true 强制全量重写（切任务/截头后前缀对不上时）。 */
function writeTaskOutput(task: BgTask | null, full = false) {
  if (!terminal) return;
  const output = task?.output ?? "";
  const sameTask = (task?.id ?? null) === writtenTaskId;
  if (!full && sameTask && output.startsWith(writtenSoFar)) {
    const suffix = output.slice(writtenSoFar.length);
    if (suffix) terminal.write(suffix.replace(/\n/g, "\r\n"));
    writtenSoFar = output;
    return;
  }
  terminal.reset();
  if (output) terminal.write(output.replace(/\n/g, "\r\n"));
  writtenSoFar = output;
  writtenTaskId = task?.id ?? null;
}

// 面板开合：开 → 建终端；关 → 销毁（下次开重建并重放存量输出）
watch(
  () => props.open,
  async (open) => {
    if (open) await initTerminal();
    else disposeTerminal();
  },
);

// 输出增量 / 选中切换：前缀匹配只写后缀，否则全量重写
watch([selectedTask, () => selectedTask.value?.output], ([task]) => {
  if (!props.open || !terminal) return;
  writeTaskOutput(task ?? null);
});

// 主题切换：跟随 settings.theme 重建 xterm 配色（token 派生，三主题通用）
watch(
  () => settings.theme,
  async () => {
    await nextTick();
    if (terminal) terminal.options.theme = buildXtermTheme();
  },
);

onBeforeUnmount(() => {
  disposeTerminal();
  if (clockTimer) {
    clearInterval(clockTimer);
    clockTimer = null;
  }
});

const STATUS_ICON: Record<BgTask["status"], string> = {
  running: "●",
  completed: "✓",
  failed: "✗",
  stopped: "■",
};

function taskName(task: BgTask): string {
  return task.description || task.command || task.id;
}
</script>

<template>
  <div v-if="barVisible" class="bgtask">
    <button class="bgtask-bar" :aria-expanded="open" @click="onToggle">
      <span :class="['bgtask-dot', runningTasks.length > 0 ? 'bgtask-dot--run' : 'bgtask-dot--idle']"></span>
      <span class="bgtask-bar-text">{{ barText }}</span>
      <span v-if="barNames" class="bgtask-bar-names">{{ barNames }}</span>
      <span class="bgtask-caret">{{ open ? "▾" : "▴" }}</span>
    </button>

    <div v-if="open" class="bgtask-dock">
      <div class="bgtask-list">
        <div v-if="tasks.length === 0" class="bgtask-empty">暂无后台任务</div>
        <button
          v-for="task in tasks"
          :key="task.id"
          :class="['bgtask-item', task.id === selectedId ? 'bgtask-item--sel' : '']"
          v-tooltip="task.summary || task.command || ''"
          @click="onSelect(task)"
        >
          <span :class="['bgtask-st', `bgtask-st--${task.status}`]">{{ STATUS_ICON[task.status] }}</span>
          <span class="bgtask-item-main">
            <span class="bgtask-item-name">{{ taskName(task) }}</span>
            <span v-if="task.command && task.command !== taskName(task)" class="bgtask-item-cmd">{{ task.command }}</span>
          </span>
          <span class="bgtask-item-dur">{{ fmtDuration(task) }}</span>
          <span
            v-if="task.status === 'running'"
            class="bgtask-stop"
            v-tooltip="'终止该任务'"
            @click="onStop(task, $event)"
          >■</span>
        </button>
      </div>
      <div class="bgtask-out">
        <div v-if="!selectedTask" class="bgtask-empty">选择左侧任务查看输出</div>
        <div v-show="selectedTask" ref="termEl" class="bgtask-term"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bgtask {
  flex: none;
  display: flex;
  flex-direction: column;
  margin: 0 12px;
}

/* 状态条：常驻，点击开合 dock */
.bgtask-bar {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 6px 12px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  color: var(--aide-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: border-color var(--aide-ease-t);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
}
.bgtask-bar:hover {
  border-color: var(--aide-border-strong);
}

.bgtask-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.bgtask-dot--run {
  background: var(--aide-success);
  animation: bgtask-pulse 1.6s infinite;
}
.bgtask-dot--idle {
  background: var(--aide-surface-active);
}
@keyframes bgtask-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.bgtask-bar-text {
  font-weight: 600;
  color: var(--aide-text-primary);
  white-space: nowrap;
}
.bgtask-bar-names {
  font-family: var(--aide-font-mono);
  font-size: 11px;
  color: var(--aide-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bgtask-caret {
  margin-left: auto;
  font-size: 14px; /* 全项目三角箭头统一 14px */
  color: var(--aide-text-muted);
  flex-shrink: 0;
}

/* dock 面板：挤压消息区的真实布局块 */
.bgtask-dock {
  display: flex;
  height: 220px;
  margin-top: 6px;
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg);
  background: var(--aide-bg-raised);
  overflow: hidden;
  box-shadow: var(--aide-shadow-sm), var(--aide-highlight-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
}

.bgtask-list {
  width: 230px;
  flex: none;
  border-right: 1px solid var(--aide-border);
  padding: 6px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.bgtask-item {
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
.bgtask-item:hover {
  background: var(--aide-surface-default);
}
.bgtask-item--sel {
  background: var(--aide-accent-subtle);
}

.bgtask-st {
  flex-shrink: 0;
  font-size: 11px;
  width: 14px;
  text-align: center;
}
.bgtask-st--running {
  color: var(--aide-success);
  animation: bgtask-pulse 1.6s infinite;
}
.bgtask-st--completed {
  color: var(--aide-success);
}
.bgtask-st--failed {
  color: var(--aide-danger);
}
.bgtask-st--stopped {
  color: var(--aide-warning);
}

.bgtask-item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.bgtask-item-name {
  font-size: 12.5px;
  color: var(--aide-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bgtask-item-cmd {
  font-family: var(--aide-font-mono);
  font-size: 10.5px;
  color: var(--aide-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bgtask-item-dur {
  flex-shrink: 0;
  font-family: var(--aide-font-mono);
  font-size: 10.5px;
  color: var(--aide-text-muted);
  font-variant-numeric: tabular-nums;
}

/* 终止按钮：仅运行中任务显示，嵌在列表项 button 里（stopPropagation 不触发选中） */
.bgtask-stop {
  flex-shrink: 0;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: var(--aide-radius-sm);
  color: var(--aide-text-muted);
  transition: all var(--aide-ease-t);
}
.bgtask-stop:hover {
  color: var(--aide-danger);
  background: color-mix(in srgb, var(--aide-danger) 14%, transparent);
}

.bgtask-out {
  flex: 1;
  min-width: 0;
  padding: 8px;
  display: flex;
  flex-direction: column;
}

.bgtask-empty {
  padding: 14px;
  font-size: 12px;
  color: var(--aide-text-muted);
  text-align: center;
}
</style>

<style>
/* 非 scoped：xterm 动态 DOM 需要全局样式（对齐 BashOutputBlock 的处理） */
.bgtask-term {
  flex: 1;
  min-height: 0;
  border-radius: var(--aide-radius-md);
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border-subtle);
  overflow: hidden;
  box-shadow: var(--aide-shadow-inset);
}
.bgtask-term .xterm {
  height: 100%;
  padding: 6px 8px;
}
.bgtask-term .xterm-viewport {
  overflow-y: auto !important;
}
</style>
