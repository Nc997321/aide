<script setup lang="ts">
/** 自动化任务详情（主区）：提示词卡 / playbook 卡 / 统计条 / 运行记录。
 *  点运行行 → 关闭面板并用 ChatPanel 开该次运行的会话转录（运行本身就是会话）。 */
import { computed, ref } from "vue";
import {
  useAutomation,
  scheduleText,
  shortTime,
  formatDurationMs,
} from "../../composables/useAutomation";
import { usePaneLayout } from "../../composables/usePaneLayout";
import { useModal } from "../../composables/useModal";
import { useToast } from "../../composables/useToast";
import { marked } from "../../utils/markdown";
import type { RunRecord, RunUsage } from "../../api/automation";

const auto = useAutomation();
const paneLayout = usePaneLayout();
const modal = useModal();
const { showToast } = useToast();

const task = computed(() => auto.state.tasks.find((t) => t.id === auto.state.selectedTaskId) ?? null);

const PRESET_TEXT: Record<string, string> = {
  auto: "自动模式",
  full: "完全访问",
};
const TRIGGER_TEXT: Record<string, string> = { schedule: "定时", manual: "手动", catchup: "补跑" };

// ── playbook 查看 ──
const playbookOpen = ref(false);
const playbookHtml = ref("");
const playbookLoading = ref(false);

async function openPlaybook() {
  const t = task.value;
  if (!t) return;
  playbookLoading.value = true;
  playbookOpen.value = true;
  try {
    const content = await auto.readPlaybook(t.id);
    playbookHtml.value = content
      ? (marked.parse(content) as string)
      : '<p class="pb-empty">手册尚未生成——首跑成功后会自动蒸馏，也可点「重新提炼」强制下次重建。</p>';
  } catch (e) {
    playbookHtml.value = `<p class="pb-empty">读取失败：${String(e)}</p>`;
  } finally {
    playbookLoading.value = false;
  }
}

async function onRedistill() {
  const t = task.value;
  if (!t) return;
  await auto.redistill(t.id);
  showToast("已标记重新提炼：下次运行将按探索模式执行并重建手册", "success");
}

// ── 操作 ──
async function onRunNow() {
  const t = task.value;
  if (!t) return;
  const err = await auto.runNow(t.id);
  if (err) showToast(err, "danger");
}

async function onDelete() {
  const t = task.value;
  if (!t) return;
  const ok = await modal.confirm(
    "删除自动化任务",
    `确定删除「${t.name}」？任务的运行历史与手册将一并删除。`,
    "删除",
    true,
  );
  if (!ok) return;
  await auto.deleteTask(t.id);
  showToast("已删除", "success");
}

/** 打开某次运行的完整转录：关面板 → ChatPanel 开该 sessionId。 */
function openTranscript(run: RunRecord) {
  if (!run.sessionId) return; // skipped 记录没有会话
  auto.closePanel();
  paneLayout.openSessionInNewTab(run.sessionId);
}

// ── 展示辅助 ──
function runDuration(r: RunRecord): string {
  if (!r.finishedAt) return "…";
  const ms = new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime();
  return formatDurationMs(ms >= 0 ? ms : null);
}

function tokensText(u: RunUsage | null): string {
  if (!u) return "";
  const total = u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
  if (total === 0) return "";
  const k = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total);
  const pct = Math.round((u.cacheReadTokens / total) * 100);
  return `${k}·${pct}%缓`;
}

function runSummary(r: RunRecord): string {
  if (r.error) return `失败 — ${r.error}`;
  if (r.note === "overlap") return "跳过 — 上次运行尚未结束";
  if (r.note === "missed-skip") return "跳过 — 客户端未运行（策略：跳过）";
  if (r.note === "missed-ask") return "跳过 — 客户端未运行（策略：询问）";
  if (r.status === "running") return "正在运行 — 点击查看实时输出";
  // 报告类任务的结论摘要（转录尾行）让列表一眼可读
  if (r.summary) return r.summary;
  return "查看完整转录";
}

const statsView = computed(() => {
  const s = auto.state.stats;
  if (!s || s.runs === 0) return null;
  return {
    runs: s.runs,
    successRate: `${(s.successRate * 100).toFixed(1)}%`,
    fails: s.failed,
    totalCost: `$${s.totalCostUsd.toFixed(2)}`,
    perDay: `$${(s.totalCostUsd / 30).toFixed(3)}`,
    avgDur: formatDurationMs(s.avgDurationMs),
    cacheHit: s.cacheReadRatio !== null ? `${Math.round(s.cacheReadRatio * 100)}%` : "—",
  };
});

const PLAYBOOK_CARD: Record<string, { title: string; desc: string }> = {
  ready: { title: "执行手册已就绪", desc: "每次运行按手册执行——轮数更少、上下文更小。手册可查看/手改/重新提炼。" },
  none: { title: "执行手册未提炼", desc: "首跑按探索模式执行，跑完自动把可复用步骤蒸馏成 playbook.md，之后每次运行成本大幅下降。" },
  stale: { title: "手册待重新提炼", desc: "下次运行将按探索模式执行并重新生成手册。" },
};
</script>

<template>
  <div v-if="!task" class="auto-empty">
    <div class="big">⚡</div>
    <p>在左侧「自动化」分区选择或新建一个任务</p>
  </div>

  <div v-else class="auto-detail">
    <!-- 头部 -->
    <div class="d-head">
      <button
        class="switch"
        :class="{ on: task.enabled }"
        v-tooltip="task.enabled ? '停用任务' : '启用任务'"
        @click="auto.toggleEnabled(task)"
      />
      <h2>{{ task.name }}</h2>
      <span class="chip">{{ scheduleText(task.schedule) }}</span>
      <span class="chip">{{ PRESET_TEXT[task.permissionPreset] }}</span>
      <span v-if="task.workspacePath" class="chip">工作区 {{ task.workspacePath.split(/[\\/]/).pop() }}</span>
      <span v-else class="chip">无工作区</span>
      <span class="spacer" />
      <button class="btn sm" :disabled="task.lastRunStatus === 'running'" @click="onRunNow">▶ 立即运行</button>
      <button class="btn sm" @click="auto.openEditor(task.id)">编辑</button>
      <button class="btn sm danger-ghost" @click="onDelete">删除</button>
    </div>

    <!-- 提示词 -->
    <div class="prompt-card">
      <div class="lbl">提示词</div>
      <div class="prompt-text">{{ task.prompt }}</div>
    </div>

    <!-- playbook 卡片 -->
    <div v-if="task.playbookEnabled" class="playbook-card">
      <span class="ic">⚗</span>
      <span class="t">
        <b>{{ PLAYBOOK_CARD[task.playbookState].title }}</b>
        <span class="d">{{ PLAYBOOK_CARD[task.playbookState].desc }}</span>
      </span>
      <template v-if="task.playbookState === 'ready'">
        <button class="btn sm" @click="openPlaybook">查看手册</button>
        <button class="btn sm" @click="onRedistill">重新提炼</button>
      </template>
      <button v-else-if="task.playbookState === 'stale'" class="btn sm" @click="openPlaybook">查看旧手册</button>
    </div>

    <!-- 统计条 -->
    <div v-if="statsView" class="stats-strip">
      <div class="stat"><div class="k">近 30 天运行</div><div class="v">{{ statsView.runs }}</div></div>
      <div class="stat"><div class="k">成功率</div><div class="v good">{{ statsView.successRate }}</div><div class="sub">{{ statsView.fails }} 次失败</div></div>
      <div class="stat"><div class="k">总成本</div><div class="v">{{ statsView.totalCost }}</div><div class="sub">日均 {{ statsView.perDay }}</div></div>
      <div class="stat"><div class="k">平均耗时</div><div class="v">{{ statsView.avgDur || "—" }}</div></div>
      <div class="stat"><div class="k">缓存命中</div><div class="v">{{ statsView.cacheHit }}</div><div class="sub">cache_read 占比</div></div>
    </div>

    <!-- 运行记录 -->
    <div class="sec-title">运行记录</div>
    <div v-if="auto.state.runsLoading" class="hint">加载中…</div>
    <div v-else-if="auto.state.runs.length === 0" class="hint">还没有运行过。</div>
    <template v-else>
      <div
        v-for="r in auto.state.runs"
        :key="r.runId"
        class="run-row"
        :class="{ fail: r.status === 'failed', clickable: !!r.sessionId }"
        @click="openTranscript(r)"
      >
        <span class="status-dot" :class="r.status === 'succeeded' ? 'ok' : r.status === 'failed' ? 'fail' : r.status === 'running' ? 'running' : 'idle'" />
        <span class="time">{{ shortTime(r.startedAt) }}</span>
        <span class="chip" :class="{ agent: r.trigger === 'catchup' }">{{ TRIGGER_TEXT[r.trigger] }}</span>
        <span class="dur">{{ runDuration(r) }}</span>
        <span v-if="r.rounds" class="chip" :class="{ success: r.mode === 'playbook' }">
          {{ r.mode === "playbook" ? "手册" : "探索" }} {{ r.rounds }}轮
        </span>
        <span class="summary" :class="{ live: r.status === 'running' }">{{ runSummary(r) }}</span>
        <span v-if="tokensText(r.usage)" class="cost">{{ tokensText(r.usage) }}</span>
        <span v-if="r.costUsd !== null" class="cost">${{ r.costUsd.toFixed(3) }}</span>
        <span class="tri">▸</span>
      </div>
    </template>
    <div class="hint">点击运行行 → 以会话转录打开该次运行（流式输出/完整历史，复用 ChatPanel）。</div>

    <!-- 手册查看模态 -->
    <Teleport to="body">
      <div v-if="playbookOpen" class="pb-overlay" @click.self="playbookOpen = false">
        <div class="pb-modal">
          <div class="pb-head">
            <span class="pb-title">执行手册 · {{ task.name }}</span>
            <button class="pb-close" @click="playbookOpen = false">✕</button>
          </div>
          <div class="pb-body">
            <div v-if="playbookLoading" class="pb-empty">加载中…</div>
            <div v-else class="pb-content" v-html="playbookHtml" />
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.auto-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--aide-text-muted);
}
.auto-empty .big {
  font-size: 34px;
  opacity: 0.4;
}

.auto-detail {
  height: 100%;
  overflow-y: auto;
  padding: 18px 22px 32px;
}

.d-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.d-head h2 {
  font-size: 16px;
  font-weight: 600;
}
.spacer {
  flex: 1;
}

.switch {
  width: 30px;
  height: 17px;
  border-radius: 9px;
  position: relative;
  flex-shrink: 0;
  background: var(--aide-surface-active);
  cursor: pointer;
  transition: background var(--aide-ease-t);
  border: none;
  padding: 0;
}
.switch::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--aide-text-muted);
  transition: all var(--aide-ease-t);
}
.switch.on {
  background: var(--aide-accent);
}
.switch.on::after {
  left: 15px;
  background: var(--aide-bg-deep);
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  border-radius: var(--aide-radius-sm);
  border: 1px solid var(--aide-border);
  background: var(--aide-surface-default);
  color: var(--aide-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all var(--aide-ease-t);
  box-shadow: var(--aide-highlight-inset);
}
.btn:hover:not(:disabled) {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn.sm {
  height: 24px;
  padding: 0 9px;
  font-size: 11px;
}
.btn.danger-ghost:hover {
  border-color: var(--aide-danger);
  color: var(--aide-danger);
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 8px;
  border-radius: 99px;
  font-size: 10.5px;
  border: 1px solid var(--aide-border-subtle);
  background: var(--aide-surface-default);
  color: var(--aide-text-muted);
  white-space: nowrap;
}
.chip.success {
  color: var(--aide-success);
  border-color: color-mix(in srgb, var(--aide-success) 28%, transparent);
  background: color-mix(in srgb, var(--aide-success) 10%, transparent);
}
.chip.agent {
  color: var(--aide-agent-accent);
  border-color: color-mix(in srgb, var(--aide-agent-accent) 30%, transparent);
  background: color-mix(in srgb, var(--aide-agent-accent) 10%, transparent);
}

.prompt-card {
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-md);
  background: var(--aide-surface-default);
  padding: 10px 13px;
  margin-bottom: 12px;
}
.prompt-card .lbl {
  font-size: 10.5px;
  color: var(--aide-text-muted);
  font-weight: 700;
  letter-spacing: 0.6px;
  margin-bottom: 4px;
}
.prompt-text {
  font-size: 12px;
  color: var(--aide-text-secondary);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.playbook-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 13px;
  margin-bottom: 14px;
  border: 1px solid color-mix(in srgb, var(--aide-agent-accent) 30%, transparent);
  border-radius: var(--aide-radius-md);
  background: color-mix(in srgb, var(--aide-agent-accent) 6%, transparent);
  font-size: 12px;
}
.playbook-card .ic {
  color: var(--aide-agent-accent);
  font-size: 15px;
}
.playbook-card .t {
  color: var(--aide-text-secondary);
  flex: 1;
  line-height: 1.5;
}
.playbook-card .t b {
  color: var(--aide-text-primary);
  font-weight: 600;
}
.playbook-card .t .d {
  color: var(--aide-text-muted);
  font-size: 11px;
  display: block;
  margin-top: 2px;
}

.stats-strip {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 10px;
  margin-bottom: 16px;
}
.stat {
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  background: var(--aide-bg-raised);
  box-shadow: var(--aide-highlight-inset);
  padding: 10px 13px;
}
.stat .k {
  font-size: 10.5px;
  color: var(--aide-text-muted);
  letter-spacing: 0.4px;
}
.stat .v {
  font-size: 17px;
  font-weight: 600;
  font-family: "Cascadia Code", "Consolas", monospace;
  margin-top: 4px;
}
.stat .v.good {
  color: var(--aide-success);
}
.stat .sub {
  font-size: 10px;
  color: var(--aide-text-muted);
  margin-top: 2px;
  font-family: "Cascadia Code", "Consolas", monospace;
}

.sec-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.8px;
  text-transform: uppercase;
  color: var(--aide-text-muted);
  margin: 4px 0 10px;
}

.run-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-sm);
  background: var(--aide-surface-default);
  margin-bottom: 6px;
  transition: all var(--aide-ease-t);
}
.run-row.clickable {
  cursor: pointer;
}
.run-row.clickable:hover {
  background: var(--aide-surface-hover);
  border-color: var(--aide-border);
}
.run-row.fail {
  border-color: color-mix(in srgb, var(--aide-danger) 25%, transparent);
}
.run-row .time {
  font-family: "Cascadia Code", "Consolas", monospace;
  font-size: 11.5px;
  color: var(--aide-text-secondary);
  width: 112px;
  flex-shrink: 0;
}
.run-row .dur {
  font-family: "Cascadia Code", "Consolas", monospace;
  font-size: 11px;
  color: var(--aide-text-muted);
  width: 56px;
  flex-shrink: 0;
}
.run-row .summary {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: var(--aide-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.run-row .summary.live {
  color: var(--aide-info);
}
.run-row .tri {
  font-size: 14px;
  color: var(--aide-text-muted);
  flex-shrink: 0;
}
.cost {
  font-family: "Cascadia Code", "Consolas", monospace;
  font-size: 11px;
  color: var(--aide-text-secondary);
  flex-shrink: 0;
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
@keyframes auto-pulse {
  50% {
    opacity: 0.35;
  }
}

.hint {
  font-size: 11px;
  color: var(--aide-text-muted);
  margin-top: 12px;
  line-height: 1.6;
}

/* 手册模态 */
.pb-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: var(--aide-bg-overlay);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
}
.pb-modal {
  width: 720px;
  max-width: 100%;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg);
  box-shadow: var(--aide-shadow-lg);
  overflow: hidden;
}
.pb-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--aide-border-subtle);
}
.pb-title {
  font-size: 13px;
  font-weight: 600;
}
.pb-close {
  border: none;
  background: transparent;
  color: var(--aide-text-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 4px;
}
.pb-close:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
.pb-body {
  padding: 16px 20px;
  overflow-y: auto;
}
.pb-content {
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--aide-text-secondary);
}
.pb-content :deep(h1),
.pb-content :deep(h2),
.pb-content :deep(h3) {
  color: var(--aide-text-primary);
  margin: 14px 0 6px;
  font-size: 14px;
}
.pb-content :deep(code) {
  font-family: "Cascadia Code", "Consolas", monospace;
  font-size: 11px;
  background: var(--aide-surface-default);
  padding: 1px 5px;
  border-radius: 4px;
}
.pb-content :deep(pre) {
  background: var(--aide-surface-default);
  border-radius: var(--aide-radius-sm);
  padding: 10px 12px;
  overflow-x: auto;
}
.pb-content :deep(ul) {
  padding-left: 18px;
}
.pb-empty {
  color: var(--aide-text-muted);
  font-size: 12px;
  line-height: 1.7;
}
</style>
