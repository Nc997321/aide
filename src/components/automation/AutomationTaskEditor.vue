<script setup lang="ts">
/** 自动化任务编辑器（新建/编辑共用）。分区表单：基本 / 执行配置 / 权限与安全 /
 *  调度 / 手册与通知。保存走 useAutomation.saveTask（create/update 由 editingTaskId 裁决）。 */
import { computed, onMounted, reactive, ref } from "vue";
import { useAutomation } from "../../composables/useAutomation";
import { useWorkspaces } from "../../composables/useWorkspaces";
import { useToast } from "../../composables/useToast";
import { EFFORT_OPTIONS } from "@aide/sdk/utils/effort";
import { mcpServerApi } from "../../api/customization";
import ThemedSelect from "../ThemedSelect.vue";
import DirTreePicker from "../DirTreePicker.vue";
import type { AutomationTaskInput, Schedule } from "../../api/automation";

const auto = useAutomation();
const { workspaces } = useWorkspaces();
const { showToast } = useToast();

const editing = computed(() => auto.state.tasks.find((t) => t.id === auto.state.editingTaskId) ?? null);

// ── 表单状态 ──
const form = reactive({
  name: "",
  prompt: "",
  workspacePath: "",
  model: "",
  effort: "high",
  permissionPreset: "auto" as "auto" | "full",
  connectors: [] as string[],
  schedKind: "cron" as "cron" | "interval" | "once",
  cronFreq: "daily" as "daily" | "weekly" | "monthly",
  time: "18:30",
  weekdays: [1] as number[],
  monthDay: 1,
  every: 2,
  everyUnit: "hours" as "minutes" | "hours" | "days",
  onceDate: "",
  onceTime: "10:00",
  validFrom: "",
  validTo: "",
  missedPolicy: "catchup" as "catchup" | "skip" | "ask",
  playbookEnabled: true,
  notifySuccess: true,
  notifyFailure: true,
});

// 编辑模式：用现有任务回填
if (editing.value) {
  const t = editing.value;
  form.name = t.name;
  form.prompt = t.prompt;
  form.workspacePath = t.workspacePath ?? "";
  form.model = t.model;
  form.effort = t.effort;
  form.permissionPreset = t.permissionPreset;
  form.connectors = [...t.connectors];
  form.validFrom = t.validFrom ?? "";
  form.validTo = t.validTo ?? "";
  form.missedPolicy = t.missedPolicy;
  form.playbookEnabled = t.playbookEnabled;
  form.notifySuccess = t.notifySuccess;
  form.notifyFailure = t.notifyFailure;
  const s = t.schedule;
  if (s.kind === "interval") {
    form.schedKind = "interval";
    form.every = s.every;
    form.everyUnit = s.unit;
  } else if (s.kind === "once") {
    form.schedKind = "once";
    const [d, tm] = s.at.split("T");
    form.onceDate = d ?? "";
    form.onceTime = (tm ?? "10:00").slice(0, 5);
  } else {
    form.schedKind = "cron";
    form.cronFreq = s.kind;
    form.time = s.time;
    if (s.kind === "weekly") form.weekdays = [...s.weekdays];
    if (s.kind === "monthly") form.monthDay = s.day;
  }
}

// ── 选项 ──
// 工作目录三态：""=不绑定（任务目录作 cwd）/ 已注册工作区路径 / "__custom__"+自选路径。
// 自选路径不受信任（受限模式：不读该目录的 CLAUDE.md/.claude），需要完整信任先登记为工作区。
const CUSTOM_WS = "__custom__";
const showDirPicker = ref(false);

function isRegisteredWs(p: string): boolean {
  return workspaces.value.some((w) => !w.missing && w.name === p);
}

/** ThemedSelect 的代理值：自选路径折叠成 __custom__ 项展示。 */
const wsSelect = computed({
  get: () => {
    if (form.workspacePath === "") return "";
    return isRegisteredWs(form.workspacePath) ? form.workspacePath : CUSTOM_WS;
  },
  set: (v: string) => {
    if (v === CUSTOM_WS) {
      showDirPicker.value = true; // 先展开选择器，选到路径才改 workspacePath
      return;
    }
    showDirPicker.value = false;
    form.workspacePath = v;
  },
});

const workspaceOptions = computed(() => {
  const opts = [
    { value: "", label: "（不绑定，以任务目录为工作目录）" },
    ...workspaces.value
      .filter((w) => !w.missing && w.name)
      .map((w) => ({
        value: w.name,
        label: `${w.name.split(/[\\/]/).filter(Boolean).pop() ?? w.name} — ${w.name}`,
      })),
  ];
  // 编辑时遇到自选路径：原样保留为可见选项
  if (form.workspacePath && !isRegisteredWs(form.workspacePath)) {
    opts.push({ value: form.workspacePath, label: `📁 ${form.workspacePath}` });
  }
  opts.push({ value: CUSTOM_WS, label: "自定义目录…" });
  return opts;
});

function onCustomDirPick(p: string | string[]) {
  if (typeof p === "string" && p) form.workspacePath = p;
}

const STATIC_MODELS = [
  { value: "", label: "跟随提供商默认" },
  { value: "claude-sonnet-5", label: "Sonnet 5（推荐：自动化够用且便宜）" },
  { value: "claude-opus-5", label: "Opus 5（重推理任务）" },
  { value: "claude-fable-5", label: "Fable 5（成本 ×3.3，慎用）" },
];
const modelOptions = computed(() => {
  // 编辑时遇到列表外的自定义模型（第三方 provider），原样保留为一个选项
  const cur = form.model;
  if (cur && !STATIC_MODELS.some((m) => m.value === cur)) {
    return [...STATIC_MODELS, { value: cur, label: cur }];
  }
  return STATIC_MODELS;
});

const effortOptions = EFFORT_OPTIONS.map((o) =>
  o.value === "high" ? { ...o, label: `${o.label}（默认）` } : o,
);

const freqOptions = [
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "monthly", label: "每月" },
];
const everyUnitOptions = [
  { value: "minutes", label: "分钟" },
  { value: "hours", label: "小时" },
  { value: "days", label: "天" },
];
const missedPolicyOptions = [
  { value: "catchup", label: "下次启动客户端时补跑一次" },
  { value: "skip", label: "直接跳过，等下一个周期" },
  { value: "ask", label: "启动时通知我" },
];
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

// 连接器：内置两个 + 用户配置的 MCP server（名字即 server key）
const connectorOptions = ref<string[]>(["aide-codegraph", "aide-docs"]);
onMounted(async () => {
  try {
    const items = await mcpServerApi.list();
    const names = items
      .map((it) => (it as { name?: string }).name)
      .filter((n): n is string => !!n);
    connectorOptions.value = [...new Set([...connectorOptions.value, ...names])];
  } catch {
    /* 用户 MCP 清单拉取失败就只显示内置连接器 */
  }
});

function toggleConnector(name: string) {
  const i = form.connectors.indexOf(name);
  if (i === -1) form.connectors.push(name);
  else form.connectors.splice(i, 1);
}

function toggleWeekday(d: number) {
  const i = form.weekdays.indexOf(d);
  if (i === -1) form.weekdays.push(d);
  else form.weekdays.splice(i, 1);
}

const PRESETS = [
  {
    value: "auto",
    label: "自动模式",
    rec: "推荐",
    desc: "读文件、写文件、执行安全命令都自动放行；高危操作自动拒绝。无人值守的默认档",
    danger: false,
  },
  {
    value: "full",
    label: "完全访问",
    rec: "",
    desc: "不做任何拦截，含任意终端命令。仅在你完全信任提示词时使用",
    danger: true,
  },
] as const;

// ── 保存 ──
const saving = ref(false);

function buildSchedule(): Schedule {
  if (form.schedKind === "interval") {
    return { kind: "interval", every: Math.max(1, Math.floor(form.every)), unit: form.everyUnit };
  }
  if (form.schedKind === "once") {
    return { kind: "once", at: `${form.onceDate}T${form.onceTime}` };
  }
  if (form.cronFreq === "weekly") {
    return { kind: "weekly", time: form.time, weekdays: [...form.weekdays].sort((a, b) => a - b) };
  }
  if (form.cronFreq === "monthly") {
    return { kind: "monthly", time: form.time, day: form.monthDay };
  }
  return { kind: "daily", time: form.time };
}

function validate(): string | null {
  if (!form.name.trim()) return "名称不能为空";
  if (!form.prompt.trim()) return "提示词不能为空";
  if (form.schedKind === "cron" && form.cronFreq === "weekly" && form.weekdays.length === 0)
    return "每周任务至少选择一个星期几";
  if (form.schedKind === "once" && !form.onceDate) return "单次任务需要选择日期";
  return null;
}

async function save(andRun: boolean) {
  const err = validate();
  if (err) {
    showToast(err, "danger");
    return;
  }
  saving.value = true;
  try {
    const input: AutomationTaskInput = {
      name: form.name.trim(),
      prompt: form.prompt.trim(),
      workspacePath: form.workspacePath || null,
      model: form.model,
      effort: form.effort,
      permissionPreset: form.permissionPreset,
      connectors: form.connectors,
      schedule: buildSchedule(),
      validFrom: form.validFrom || null,
      validTo: form.validTo || null,
      missedPolicy: form.missedPolicy,
      playbookEnabled: form.playbookEnabled,
      notifySuccess: form.notifySuccess,
      notifyFailure: form.notifyFailure,
      enabled: editing.value?.enabled ?? true,
    };
    const saved = await auto.saveTask(input);
    showToast(andRun ? "已保存，正在运行…" : "已保存", "success");
    if (andRun) {
      const runErr = await auto.runNow(saved.id);
      if (runErr) showToast(runErr, "danger");
    }
  } catch (e) {
    showToast(String(e), "danger");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="auto-editor">
    <div class="e-head">
      <span class="back-link" @click="auto.backToDetail()"><span class="tri">◂</span> 返回</span>
      <h2>{{ editing ? `编辑 · ${editing.name}` : "新建自动化任务" }}</h2>
    </div>

    <div class="form-wrap">
      <!-- 基本 -->
      <div class="form-section">
        <div class="fs-title">基本</div>
        <div class="field">
          <label>名称</label>
          <input class="input" v-model="form.name" placeholder="例如：每日提交汇总" />
        </div>
        <div class="field">
          <label>工作目录<span class="opt">可选；不绑定则以任务目录（~/.aide/automations/&lt;id&gt;/）为工作目录</span></label>
          <ThemedSelect v-model="wsSelect" :options="workspaceOptions" block />
          <div v-if="showDirPicker" class="dir-picker">
            <DirTreePicker mode="directory" @update:model-value="onCustomDirPick" />
          </div>
          <div v-if="form.workspacePath && !isRegisteredWs(form.workspacePath)" class="hint">
            自选目录以受限模式运行（不读该目录的 CLAUDE.md / .claude 配置）；需要完整信任请先把它登记为工作区。
          </div>
        </div>
        <div class="field">
          <label>提示词</label>
          <textarea class="textarea" v-model="form.prompt" placeholder="汇总过去 24 小时的 git 提交，写一段可发群的日报…" />
        </div>
      </div>

      <!-- 执行配置 -->
      <div class="form-section">
        <div class="fs-title">执行配置</div>
        <div class="grid2">
          <div class="field">
            <label>模型<span class="opt">按任务指定，不继承主会话</span></label>
            <ThemedSelect v-model="form.model" :options="modelOptions" block />
          </div>
          <div class="field">
            <label>思考强度 effort</label>
            <ThemedSelect v-model="form.effort" :options="effortOptions" block />
          </div>
        </div>
      </div>

      <!-- 权限与安全 -->
      <div class="form-section">
        <div class="fs-title">权限与安全</div>
        <div class="field">
          <label>权限预设</label>
          <div class="radio-cards cols2">
            <div
              v-for="p in PRESETS"
              :key="p.value"
              class="rcard"
              :class="{ on: form.permissionPreset === p.value, 'danger-zone': p.danger }"
              @click="form.permissionPreset = p.value"
            >
              <div class="rt">{{ p.label }} <span v-if="p.rec" class="badge-rec">{{ p.rec }}</span></div>
              <div class="rd">{{ p.desc }}</div>
            </div>
          </div>
        </div>
        <div class="field">
          <label>预授权连接器<span class="opt">任务内免确认使用</span></label>
          <div class="chip-row">
            <span
              v-for="c in connectorOptions"
              :key="c"
              class="chip pick"
              :class="{ on: form.connectors.includes(c) }"
              @click="toggleConnector(c)"
            >mcp:{{ c }}</span>
          </div>
          <div class="hint">未勾选的连接器在任务中根本不可见（MCP server 不挂载），勾选的白名单由策略钩子强制执行。</div>
        </div>
      </div>

      <!-- 调度 -->
      <div class="form-section">
        <div class="fs-title">调度</div>
        <div class="field">
          <div class="seg-tabs">
            <button class="seg-tab" :class="{ on: form.schedKind === 'cron' }" @click="form.schedKind = 'cron'">周期</button>
            <button class="seg-tab" :class="{ on: form.schedKind === 'interval' }" @click="form.schedKind = 'interval'">按间隔</button>
            <button class="seg-tab" :class="{ on: form.schedKind === 'once' }" @click="form.schedKind = 'once'">单次</button>
          </div>

          <div v-if="form.schedKind === 'cron'" class="sched-pane">
            <div class="sched-row">
              <ThemedSelect v-model="form.cronFreq" :options="freqOptions" />
              <input class="input" type="time" v-model="form.time" />
              <span class="hint-inline">建议避开上午高峰，排队更少</span>
            </div>
            <div v-if="form.cronFreq === 'weekly'" class="chip-row" style="margin-top:10px">
              <span
                v-for="(label, i) in WEEKDAYS"
                :key="i"
                class="chip pick"
                :class="{ on: form.weekdays.includes(i + 1) }"
                @click="toggleWeekday(i + 1)"
              >{{ label }}</span>
            </div>
            <div v-if="form.cronFreq === 'monthly'" class="sched-row" style="margin-top:10px">
              每月 <input class="input num-input" type="number" v-model.number="form.monthDay" min="1" max="31" /> 日
              <span class="hint-inline">超过当月天数时按月末执行</span>
            </div>
          </div>

          <div v-else-if="form.schedKind === 'interval'" class="sched-pane">
            <div class="sched-row">
              每 <input class="input num-input" type="number" v-model.number="form.every" min="1" />
              <ThemedSelect v-model="form.everyUnit" :options="everyUnitOptions" />
              执行一次
            </div>
          </div>

          <div v-else class="sched-pane">
            <div class="sched-row">
              <input class="input" type="date" v-model="form.onceDate" />
              <input class="input" type="time" v-model="form.onceTime" />
              <span class="hint-inline">执行后自动停用，保留历史</span>
            </div>
          </div>
        </div>

        <div class="field">
          <label>生效日期区间<span class="opt">可选，留空始终生效</span></label>
          <div class="sched-row">
            <input class="input" type="date" v-model="form.validFrom" />
            <span style="color:var(--aide-text-muted)">至</span>
            <input class="input" type="date" v-model="form.validTo" />
          </div>
        </div>

        <div class="field">
          <label>错过触发时（客户端未运行）</label>
          <ThemedSelect v-model="form.missedPolicy" :options="missedPolicyOptions" block />
        </div>
      </div>

      <!-- 手册与通知 -->
      <div class="form-section">
        <div class="fs-title">执行手册与通知</div>
        <div class="field">
          <label class="check-label">
            <input type="checkbox" v-model="form.playbookEnabled" />
            <span>自动提炼执行手册（推荐）
              <span class="check-desc">
                首跑后自动把可复用步骤蒸馏成 playbook.md + 脚本，后续运行注入手册——轮数更少、上下文更小，每次运行省约 3–5×。手册可随时查看/手改/重新提炼。
              </span>
            </span>
          </label>
        </div>
        <div class="field">
          <label>通知</label>
          <div class="check-row">
            <label><input type="checkbox" v-model="form.notifySuccess" /> 完成时（含成本摘要）</label>
            <label><input type="checkbox" v-model="form.notifyFailure" /> 失败时</label>
          </div>
        </div>
      </div>

      <div class="form-foot">
        <button class="btn" :disabled="saving" @click="auto.backToDetail()">取消</button>
        <button class="btn" :disabled="saving" @click="save(false)">保存</button>
        <button class="btn primary" :disabled="saving" @click="save(true)">保存并立即运行一次</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.auto-editor {
  height: 100%;
  overflow-y: auto;
  padding: 18px 22px 32px;
}
.e-head {
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: 720px;
  margin: 0 auto 14px;
}
.e-head h2 {
  font-size: 16px;
  font-weight: 600;
}
.back-link {
  color: var(--aide-text-muted);
  font-size: 12px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.back-link:hover {
  color: var(--aide-accent);
}
.back-link .tri {
  font-size: 14px;
}

.form-wrap {
  max-width: 720px;
  margin: 0 auto;
}
.form-section {
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  background: var(--aide-bg-raised);
  box-shadow: var(--aide-highlight-inset);
  padding: 14px 16px;
  margin-bottom: 14px;
}
.fs-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.8px;
  text-transform: uppercase;
  color: var(--aide-text-muted);
  margin-bottom: 12px;
}
.field {
  margin-bottom: 12px;
}
.field:last-child {
  margin-bottom: 0;
}
.field > label {
  display: block;
  font-size: 12px;
  color: var(--aide-text-secondary);
  margin-bottom: 5px;
}
.field > label .opt {
  color: var(--aide-text-muted);
  font-size: 11px;
  margin-left: 4px;
}
.input,
.textarea {
  width: 100%;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
  font-size: 12.5px;
  font-family: inherit;
  padding: 7px 10px;
  outline: none;
  transition: border-color var(--aide-ease-t), box-shadow var(--aide-ease-t);
  box-shadow: var(--aide-shadow-inset);
}
.input:focus,
.textarea:focus {
  border-color: var(--aide-accent);
  box-shadow: var(--aide-accent-ring);
}
.textarea {
  min-height: 96px;
  resize: vertical;
  line-height: 1.6;
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.num-input {
  width: 90px;
  font-family: "Cascadia Code", "Consolas", monospace;
}
.hint {
  font-size: 11px;
  color: var(--aide-text-muted);
  margin-top: 5px;
  line-height: 1.6;
}
.hint-inline {
  font-size: 11px;
  color: var(--aide-text-muted);
}

.radio-cards {
  display: grid;
  gap: 8px;
}
.radio-cards.cols2 {
  grid-template-columns: repeat(2, 1fr);
}
.rcard {
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  padding: 9px 11px;
  cursor: pointer;
  transition: all var(--aide-ease-t);
  background: var(--aide-surface-default);
}
.rcard:hover {
  border-color: var(--aide-border-strong);
}
.rcard.on {
  border-color: var(--aide-accent);
  background: var(--aide-accent-subtle);
  box-shadow: 0 0 0 1px var(--aide-accent);
}
.rcard .rt {
  font-size: 12px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}
.rcard .rd {
  font-size: 11px;
  color: var(--aide-text-muted);
  margin-top: 4px;
  line-height: 1.55;
}
.rcard.on .rd {
  color: var(--aide-text-secondary);
}
.rcard.danger-zone.on {
  border-color: var(--aide-danger);
  background: color-mix(in srgb, var(--aide-danger) 8%, transparent);
  box-shadow: 0 0 0 1px var(--aide-danger);
}
.badge-rec {
  font-size: 9.5px;
  color: var(--aide-accent);
  border: 1px solid color-mix(in srgb, var(--aide-accent) 40%, transparent);
  padding: 0 5px;
  border-radius: 99px;
  font-weight: 500;
}

.chip-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 11px;
  border-radius: 99px;
  font-size: 11.5px;
  border: 1px solid var(--aide-border-subtle);
  background: var(--aide-surface-default);
  color: var(--aide-text-muted);
  white-space: nowrap;
}
.chip.pick {
  cursor: pointer;
  transition: all var(--aide-ease-t);
}
.chip.pick:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-secondary);
}
.chip.pick.on {
  color: var(--aide-accent);
  border-color: var(--aide-accent);
  background: var(--aide-accent-subtle);
}

.seg-tabs {
  display: inline-flex;
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  padding: 2px;
  gap: 2px;
}
.seg-tab {
  border: none;
  background: transparent;
  color: var(--aide-text-muted);
  font-size: 12px;
  padding: 4px 16px;
  border-radius: 6px;
  cursor: pointer;
  transition: all var(--aide-ease-t);
}
.seg-tab.on {
  background: var(--aide-surface-active);
  color: var(--aide-text-primary);
  box-shadow: var(--aide-highlight-inset);
}
.sched-pane {
  margin-top: 12px;
}
.sched-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.sched-row .input {
  width: auto;
}
.sched-row .input[type="time"],
.sched-row .input[type="date"] {
  font-family: "Cascadia Code", "Consolas", monospace;
}

.check-label {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  cursor: pointer;
  font-size: 12px;
  color: var(--aide-text-secondary);
}
.check-label input {
  margin-top: 2px;
}
.check-desc {
  display: block;
  font-size: 11px;
  color: var(--aide-text-muted);
  margin-top: 3px;
  line-height: 1.6;
}
.check-row {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--aide-text-secondary);
}
.check-row label {
  display: flex;
  gap: 6px;
  align-items: center;
  cursor: pointer;
}

.dir-picker {
  margin-top: 8px;
  max-height: 260px;
  overflow: auto;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  background: var(--aide-surface-default);
}

.form-foot {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 18px;
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
.btn.primary {
  background: var(--aide-accent-gradient);
  border-color: transparent;
  color: var(--aide-text-on-accent);
  font-weight: 600;
  box-shadow: var(--aide-accent-glow);
}
.btn.primary:hover:not(:disabled) {
  filter: brightness(1.1);
}
</style>
