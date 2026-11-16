<script setup lang="ts">
import AInput from "@/ui/AInput.vue";
import { ref, computed, watch } from "vue";
import { vOverlayLayer } from "../directives/overlayLayer";
import { taskDirectoryKey, useRunConfigs } from "../composables/useRunConfigs";
import { useRunProcess } from "../composables/useRunProcess";
import { api } from "../api";
import { useSettings } from "../composables/useSettings";
import { useWorkspaceJdk } from "../composables/useWorkspaceJdk";
import Icon from "./Icon.vue";
import type { ProjectTaskCandidate, RunConfig } from "../types";

const emit = defineEmits<{
  close: [];
}>();

const { configs, activeId, add, update, remove, applyCandidates, currentWsKey } =
  useRunConfigs();
const { runStates, start, stop, restart, runAction } = useRunProcess();
const error = ref("");
const executing = ref(false);
const { settings } = useSettings();
const { jdkHome } = useWorkspaceJdk();

// ── List selection ──────────────────────────────────────────────────────────
const selectedId = ref(activeId.value || configs.value[0]?.id || "");
const selected = computed<RunConfig | null>(
  () => configs.value.find(c => c.id === selectedId.value) ?? null
);

watch(
  () => configs.value,
  (list) => {
    if (!list.find(c => c.id === selectedId.value)) {
      selectedId.value = list[0]?.id ?? "";
    }
  }
);

// ── Edit form (local draft) ─────────────────────────────────────────────────
const draft = ref<RunConfig>({ id: "", name: "", cwd: "", command: "" });
const envText = ref("");
const requiredText = ref("");

function formatEnv(config: RunConfig) {
  return Object.entries(config.env ?? {}).map(([key, value]) => `${key}=${value}`).join("\n");
}

watch(
  selected,
  (cfg) => {
    error.value = "";
    if (cfg) {
      draft.value = { ...cfg };
      envText.value = formatEnv(cfg);
      requiredText.value = (cfg.requiredEnv ?? []).join(", ");
    }
  },
  { immediate: true }
);

const isDirty = computed(
  () => selected.value && (
    draft.value.name !== selected.value.name ||
    draft.value.cwd !== selected.value.cwd ||
    draft.value.command !== selected.value.command ||
    draft.value.packageCommand !== selected.value.packageCommand ||
    draft.value.cleanCommand !== selected.value.cleanCommand ||
    draft.value.envFile !== selected.value.envFile ||
    envText.value !== formatEnv(selected.value) ||
    requiredText.value !== (selected.value.requiredEnv ?? []).join(", ")
  )
);

// ── JDK 只读展示（工作区级，2026-08-08 起不再有 per-config 选择器）──
// 一个工作区 = 一个 JDK，所有模块共享——点任何模块看到的都是同一份。修改入口
// 在标题栏 LSP 面板（注册表管理 + 工作区选择器都在那里）。这里只读展示：
// 注册表命中 → 名称 · 版本；未命中（被移出注册表但仍在磁盘）→ 路径 + 警示；
// 空 → 系统默认。
const workspaceJdkLabel = computed(() => {
  const home = jdkHome.value;
  if (!home) return "";
  const entry = (settings.jdkRegistry ?? []).find((e) => e.path === home);
  return entry ? `${entry.name} · Java ${entry.version}` : `${home}（不在注册表）`;
});

async function save() {
  if (!selected.value) return true;
  const env: Array<[string, string]> = [];
  const keyPattern = /^[A-Za-z_][A-Za-z_0-9]*$/;
  const requiredEnv = [...new Set(requiredText.value.split(/[\s,，]+/).filter(Boolean))];
  for (const line of envText.value.split("\n")) {
    if (!line.trim()) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    if (separator < 1 || !keyPattern.test(key) || key.toUpperCase() === "JAVA_HOME") {
      error.value = "环境变量请逐行使用 KEY=VALUE。JAVA_HOME 由工作区 JDK 管理。";
      return false;
    }
    env.push([key, line.slice(separator + 1)]);
  }
  if (requiredEnv.some(key => !keyPattern.test(key))) {
    error.value = "必填变量名称无效";
    return false;
  }
  try {
    await update({ ...draft.value, env: Object.fromEntries(env), requiredEnv });
    return true;
  } catch (cause) {
    error.value = String(cause);
    return false;
  }
}

const running = computed(() => runStates.value[selectedId.value] === "running");
const packageRunning = computed(() => runStates.value[`${selectedId.value}__package`] === "running");
const cleanRunning = computed(() => runStates.value[`${selectedId.value}__clean`] === "running");

async function execute(action: "run" | "stop" | "package" | "clean") {
  const id = selected.value?.id;
  if (!id || executing.value) return;
  executing.value = true;
  error.value = "";
  try {
    if (action !== "stop" && isDirty.value && !await save()) return;
    const config = configs.value.find(item => item.id === id);
    if (!config) return;
    if (action === "stop") await stop(id);
    else if (action === "run") {
      if (runStates.value[id] === "running") await restart(config);
      else await start(config);
    } else {
      await runAction(config, action);
    }
    if (action !== "stop") emit("close");
  } catch (cause) {
    error.value = String(cause);
  } finally {
    executing.value = false;
  }
}

// ── CRUD actions ─────────────────────────────────────────────────────────────
async function addNew() {
  try {
    if (isDirty.value && !await save()) return;
    const cfg = await add({ name: "新配置", cwd: currentWsKey.value, command: "" });
    selectedId.value = cfg.id;
  } catch (cause) {
    error.value = String(cause);
  }
}

async function deleteSelected() {
  if (!selected.value) return;
  try {
    await remove(selected.value.id);
  } catch (cause) {
    error.value = String(cause);
  }
}

// ── Auto-detect ──────────────────────────────────────────────────────────────
const detecting = ref(false);
const applying = ref(false);
const detectedTargets = ref<ProjectTaskCandidate[] | null>(null);
const detectionWarning = ref("");
const scanLimited = ref(false);
const scanDirectory = ref("");
const pendingDirectories = ref<string[]>([]);
const detectedWorkspace = ref("");
const selectedTargetIds = ref<Set<string>>(new Set());

function existingFor(target: ProjectTaskCandidate) {
  return configs.value.find(config => taskDirectoryKey(config.cwd) === taskDirectoryKey(target.cwd));
}

function actionable(target: ProjectTaskCandidate) {
  return Boolean(target.command || target.packageCommand || target.cleanCommand);
}

function changed(target: ProjectTaskCandidate) {
  const existing = existingFor(target);
  return !existing || Boolean(
    (target.command && target.command !== existing.command) ||
    (target.packageCommand && target.packageCommand !== existing.packageCommand) ||
    (target.cleanCommand && target.cleanCommand !== existing.cleanCommand) ||
    (target.sources?.length && JSON.stringify(target.requiredEnv ?? []) !== JSON.stringify(existing.requiredEnv ?? [])),
  );
}

async function runDetect(subdirectory?: string) {
  if (detecting.value || applying.value) return;
  if (isDirty.value && !await save()) return;
  const ws = currentWsKey.value;
  detecting.value = true;
  error.value = "";
  try {
    const result = await api.discoverProjectTasks(ws, subdirectory);
    if (ws !== currentWsKey.value) return;
    detectedWorkspace.value = ws;
    if (subdirectory) {
      const combined = new Map((detectedTargets.value ?? []).map(target => [taskDirectoryKey(target.cwd), target]));
      for (const target of result.candidates) {
        const key = taskDirectoryKey(target.cwd);
        const previous = combined.get(key);
        if (previous && !actionable(target)) continue;
        if (previous) selectedTargetIds.value.delete(previous.cwd);
        combined.set(key, target);
      }
      detectedTargets.value = [...combined.values()];
      for (const target of result.candidates) {
        if (actionable(target) && !existingFor(target)) selectedTargetIds.value.add(target.cwd);
      }
    } else {
      detectedTargets.value = result.candidates;
      selectedTargetIds.value = new Set(result.candidates.filter(t => actionable(t) && !existingFor(t)).map(t => t.cwd));
    }
    detectionWarning.value = result.warning ?? "";
    const remaining = subdirectory && !result.scanLimited
      ? pendingDirectories.value.filter(path => {
          const key = taskDirectoryKey(path);
          const scope = taskDirectoryKey(subdirectory);
          return key !== scope && !key.startsWith(`${scope}/`);
        })
      : subdirectory ? pendingDirectories.value : [];
    pendingDirectories.value = [...new Set([...remaining, ...(result.pendingDirectories ?? [])])];
    scanLimited.value = Boolean(subdirectory) || Boolean(result.scanLimited);
    scanDirectory.value = "";
  } catch (cause) {
    error.value = String(cause);
  } finally {
    detecting.value = false;
  }
}

function toggleTarget(cwd: string) {
  if (selectedTargetIds.value.has(cwd)) {
    selectedTargetIds.value.delete(cwd);
  } else {
    selectedTargetIds.value.add(cwd);
  }
  selectedTargetIds.value = new Set(selectedTargetIds.value);
}

async function confirmDetected() {
  const chosen = detectedTargets.value?.filter(t => selectedTargetIds.value.has(t.cwd)) ?? [];
  if (applying.value || chosen.length === 0) return;
  applying.value = true;
  error.value = "";
  try {
    await applyCandidates(chosen, detectedWorkspace.value);
    detectedTargets.value = null;
    selectedId.value = existingFor(chosen[0])?.id ?? selectedId.value;
  } catch (cause) {
    error.value = String(cause);
  } finally {
    applying.value = false;
  }
}

function closeDetect() {
  if (detecting.value && detectedWorkspace.value === currentWsKey.value) return;
  detectedTargets.value = null;
  error.value = "";
}

watch(currentWsKey, closeDetect);

// ── Close / save-and-close ───────────────────────────────────────────────────
async function close() {
  if (applying.value || executing.value) return;
  if (isDirty.value && !await save()) return;
  emit("close");
}
</script>

<template>
  <div class="rcd-backdrop" v-overlay-layer @click.self="close">
    <div class="rcd-dialog" :class="{ 'rcd-show-results': detectedTargets }">
      <div class="rcd-header" :inert="Boolean(detectedTargets)">
        <svg width="14" height="14" viewBox="0 0 10 10" fill="var(--aide-success)" style="flex-shrink:0">
          <polygon points="2,1 9,5 2,9"/>
        </svg>
        <span class="rcd-title">项目任务</span>
        <button class="rcd-close" @click="close">✕</button>
      </div>

      <div class="rcd-body" :inert="Boolean(detectedTargets)">
        <!-- Left: config list -->
        <div class="rcd-left">
          <div class="rcd-toolbar">
            <button class="rcd-tool" v-tooltip="'新建'" @click="addNew">＋</button>
            <button
              class="rcd-tool rcd-tool-danger"
              v-tooltip="'删除'"
              :disabled="!selected"
              @click="deleteSelected"
            >－</button>
          </div>

          <div class="rcd-list">
            <div
              v-for="cfg in configs"
              :key="cfg.id"
              class="rcd-list-item"
              :class="{ active: cfg.id === selectedId }"
              @click="selectedId = cfg.id"
            >
              <span class="rcd-list-name">{{ cfg.name }}</span>
            </div>
            <div v-if="configs.length === 0" class="rcd-list-empty">暂无配置</div>
          </div>

          <div class="rcd-list-footer">
            <button class="rcd-detect-btn" :disabled="detecting" @click="runDetect()">
              <svg v-if="!detecting" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
              </svg>
              <span v-if="detecting">Haiku 分析中…</span>
              <span v-else>识别项目任务</span>
            </button>
          </div>
        </div>

        <!-- Right: edit form -->
        <div class="rcd-right">
          <template v-if="selected">
            <div class="rcd-form-title">{{ draft.name || '(未命名)' }}</div>
            <span v-if="running" class="rcd-hint">进程运行中</span>
            <div class="rcd-task-actions">
              <button class="rcd-btn-primary" :disabled="executing || !draft.command.trim()" @click="execute('run')">{{ running ? '重启' : '运行' }}</button>
              <button v-if="running" class="rcd-btn-ghost" :disabled="executing" @click="execute('stop')">停止</button>
              <button v-if="draft.packageCommand" class="rcd-btn-ghost" :disabled="executing || packageRunning || cleanRunning" @click="execute('package')">{{ packageRunning ? '打包中…' : '打包' }}</button>
              <button v-if="draft.cleanCommand" class="rcd-btn-ghost" :disabled="executing || packageRunning || cleanRunning" @click="execute('clean')">{{ cleanRunning ? '清理中…' : '清理' }}</button>
            </div>
            <p v-if="error && !detectedTargets" class="rcd-error" role="alert">{{ error }}</p>

            <div class="rcd-field">
              <label>名称</label>
              <AInput unstyled v-model="draft.name" type="text" placeholder="service-auth" />
            </div>

            <div class="rcd-field">
              <label>工作目录</label>
              <AInput unstyled v-model="draft.cwd" type="text" placeholder="/path/to/module" />
            </div>

            <div class="rcd-field">
              <label>运行命令</label>
              <AInput unstyled v-model="draft.command" type="text" placeholder="mvn spring-boot:run" />
              <span class="rcd-hint">在工作目录中执行的 shell 命令</span>
            </div>

            <details class="rcd-task-details" :key="selectedId">
              <summary>构建命令与启动环境</summary>
              <div class="rcd-field">
                <label for="rcd-package">打包命令</label>
                <AInput id="rcd-package" unstyled v-model="draft.packageCommand" type="text" />
              </div>
              <div class="rcd-field">
                <label for="rcd-clean">清理命令</label>
                <AInput id="rcd-clean" unstyled v-model="draft.cleanCommand" type="text" />
              </div>
              <div class="rcd-field">
                <label for="rcd-env-file">环境文件</label>
                <AInput id="rcd-env-file" unstyled v-model="draft.envFile" type="text" placeholder=".env.local（相对工作目录）" />
                <span class="rcd-hint">每次执行重新读取。支持单行 KEY=VALUE，变量值按字面传入。</span>
              </div>
              <div class="rcd-field">
                <label for="rcd-required">必填环境变量</label>
                <AInput id="rcd-required" unstyled v-model="requiredText" type="text" placeholder="MODEL_ENDPOINT, DATABASE_URL" />
              </div>
              <div class="rcd-field">
                <label for="rcd-env">环境变量覆盖</label>
                <textarea id="rcd-env" v-model="envText" rows="3" spellcheck="false" placeholder="每行一个 KEY=VALUE" />
                <span class="rcd-hint">覆盖值保存在当前 Host 的任务配置中。密钥可通过环境文件提供。</span>
              </div>
              <p v-if="draft.sources?.length" class="rcd-hint">识别依据 · {{ draft.sources.join('、') }}</p>
            </details>

            <div class="rcd-field">
              <label>JDK（工作区级）</label>
              <div class="rcd-jdk-readonly">
                <span class="jdk-ico" :class="{ muted: !workspaceJdkLabel }">
                  <Icon name="java" :size="13" />
                </span>
                <span v-if="workspaceJdkLabel" class="jdk-val">{{ workspaceJdkLabel }}</span>
                <span v-else class="jdk-val shared">(系统默认) — 使用 PATH 中的 java</span>
              </div>
              <div class="rcd-jdk-hint">
                <span v-if="workspaceJdkLabel" class="rcd-hint">所有模块共享 · 修改：<span class="arrow">标题栏 → 语言环境</span></span>
                <span v-else class="rcd-hint">按工作区选择：<span class="arrow">标题栏 → 语言环境 → 本工作区 JDK</span></span>
              </div>
            </div>

            <div class="rcd-save-row">
              <button class="rcd-btn-primary" :disabled="!isDirty" @click="save">保存更改</button>
            </div>
          </template>
          <div v-else class="rcd-empty-state">
            <p v-if="error && !detectedTargets" class="rcd-error" role="alert">{{ error }}</p>
            <span v-else>识别项目任务，或点击 ＋ 新建</span>
          </div>
        </div>
      </div>

      <!-- Auto-detect results overlay -->
      <div v-if="detectedTargets" class="rcd-detect-overlay">
        <div class="rcd-detect-header">确认项目任务</div>
        <p v-if="detectionWarning" class="rcd-hint" role="status">{{ detectionWarning }}</p>
        <details v-if="pendingDirectories.length" class="rcd-scan-directories" open>
          <summary>可补扫的目录（{{ pendingDirectories.length }}）</summary>
          <div class="rcd-task-actions">
            <button v-for="path in pendingDirectories" :key="path" type="button" class="rcd-btn-ghost"
              :disabled="detecting || applying" @click="runDetect(path)">补扫 {{ path }}</button>
          </div>
        </details>
        <form v-if="scanLimited" class="rcd-task-actions" @submit.prevent="runDetect(scanDirectory.trim())">
          <AInput v-model="scanDirectory" aria-label="工作区相对子目录" placeholder="工作区相对子目录，如 code/frontend" :disabled="detecting || applying" />
          <button class="rcd-btn-ghost" type="submit" :disabled="!scanDirectory.trim() || detecting || applying">{{ detecting ? '识别中…' : '继续识别子目录' }}</button>
        </form>
        <p v-if="error" class="rcd-error" role="alert">{{ error }}</p>
        <p v-if="!detectedTargets.length" class="rcd-hint">未发现项目任务</p>
        <div class="rcd-detect-list">
          <label
            v-for="t in detectedTargets"
            :key="t.cwd"
            class="rcd-detect-item"
          >
            <input
              type="checkbox"
              :checked="selectedTargetIds.has(t.cwd)"
              :disabled="!actionable(t) || !changed(t) || applying"
              @change="toggleTarget(t.cwd)"
            />
            <span class="rcd-detect-col">
              <span class="rcd-detect-name">{{ t.name }} · {{ !actionable(t) ? '启动方式待确认' : !existingFor(t) ? '新增' : changed(t) ? '有更新' : '无变化' }}</span>
              <span class="rcd-hint">{{ t.cwd }}</span>
              <span v-if="t.command" class="rcd-detect-cmd">运行 · {{ t.command }}</span>
              <span v-if="existingFor(t)?.command && t.command && existingFor(t)?.command !== t.command" class="rcd-hint">现有运行命令 · {{ existingFor(t)?.command }}</span>
              <span v-if="t.packageCommand" class="rcd-detect-cmd">打包 · {{ t.packageCommand }}</span>
              <span v-if="existingFor(t)?.packageCommand && t.packageCommand && existingFor(t)?.packageCommand !== t.packageCommand" class="rcd-hint">现有打包命令 · {{ existingFor(t)?.packageCommand }}</span>
              <span v-if="t.cleanCommand" class="rcd-detect-cmd">清理 · {{ t.cleanCommand }}</span>
              <span v-if="existingFor(t)?.cleanCommand && t.cleanCommand && existingFor(t)?.cleanCommand !== t.cleanCommand" class="rcd-hint">现有清理命令 · {{ existingFor(t)?.cleanCommand }}</span>
              <span v-if="t.requiredEnv?.length" class="rcd-hint">必填变量 · {{ t.requiredEnv.join('、') }}</span>
              <span v-if="existingFor(t) && t.sources?.length && JSON.stringify(t.requiredEnv ?? []) !== JSON.stringify(existingFor(t)?.requiredEnv ?? [])" class="rcd-hint">现有必填变量 · {{ existingFor(t)?.requiredEnv?.join('、') || '无' }} → {{ t.requiredEnv?.join('、') || '无' }}</span>
              <span v-if="t.sources?.length" class="rcd-hint">依据 · {{ t.sources.join('、') }}</span>
            </span>
          </label>
        </div>
        <div class="rcd-detect-actions">
          <button class="rcd-btn-ghost" :disabled="detecting || applying" @click="closeDetect">关闭</button>
          <button class="rcd-btn-primary" :disabled="detecting || applying || !selectedTargetIds.size" @click="confirmDetected">保存选中任务</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rcd-task-actions {
  display: flex;
  flex-wrap: wrap;
  gap: calc(var(--aide-space-unit) * 2);
}
.rcd-scan-directories .rcd-task-actions {
  max-height: 8em;
  overflow-y: auto;
  overflow-wrap: anywhere;
}
.rcd-task-details {
  color: var(--aide-text-secondary);
}
.rcd-task-details summary {
  cursor: pointer;
}
.rcd-task-details .rcd-field {
  margin-block-start: calc(var(--aide-space-unit) * 2);
}
.rcd-task-details textarea {
  resize: vertical;
  background: var(--aide-bg-deep);
  color: var(--aide-text-primary);
  border: 1px solid var(--aide-border);
}
.rcd-error {
  color: var(--aide-danger);
  overflow-wrap: anywhere;
}
.rcd-backdrop {
  position: fixed;
  inset: 0;
  background: var(--aide-bg-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.rcd-dialog {
  position: relative;
  background: var(--aide-bg-raised);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg);
  width: 660px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  overflow: hidden;
}

.rcd-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--aide-border);
  flex-shrink: 0;
}
.rcd-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--aide-text-primary);
  flex: 1;
}
.rcd-close {
  background: none;
  border: none;
  color: var(--aide-text-muted);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 5px;
  border-radius: 3px;
  line-height: 1;
  transition: background 0.1s, color 0.1s;
}
.rcd-close:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}

.rcd-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* ── Left panel ── */
.rcd-left {
  width: 200px;
  flex-shrink: 0;
  border-right: 1px solid var(--aide-border);
  display: flex;
  flex-direction: column;
  background: var(--aide-bg-base, var(--aide-bg-deep));
}

.rcd-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--aide-border);
}
.rcd-tool {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  border-radius: var(--aide-radius-sm);
  color: var(--aide-text-secondary);
  font-size: 14px;
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
}
.rcd-tool:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
.rcd-tool-danger:hover {
  background: color-mix(in srgb, var(--aide-danger) 15%, transparent);
  color: var(--aide-danger);
}
.rcd-tool:disabled {
  opacity: 0.35;
  cursor: default;
}

.rcd-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}
.rcd-list-item {
  padding: 7px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  color: var(--aide-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background 0.1s;
}
.rcd-list-item:hover {
  background: var(--aide-surface-hover);
}
.rcd-list-item.active {
  background: var(--aide-surface-default);
  color: var(--aide-accent, var(--aide-info));
  font-weight: 500;
}
.rcd-list-name { display: block; }
.rcd-list-empty {
  padding: 16px 10px;
  font-size: 12px;
  color: var(--aide-text-muted);
  text-align: center;
}

.rcd-list-footer {
  padding: 8px;
  border-top: 1px solid var(--aide-border);
}
.rcd-detect-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px;
  border: 1px dashed var(--aide-border);
  background: none;
  border-radius: 6px;
  cursor: pointer;
  color: var(--aide-text-muted);
  font-size: 11.5px;
  font-family: inherit;
  transition: all 0.12s;
}
.rcd-detect-btn:hover {
  border-color: var(--aide-accent, var(--aide-info));
  color: var(--aide-accent, var(--aide-info));
  background: color-mix(in srgb, var(--aide-accent, var(--aide-info)) 8%, transparent);
}
.rcd-detect-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ── Right panel ── */
.rcd-right {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 20px;
  overflow-y: auto;
}

.rcd-form-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--aide-text-primary);
  margin-bottom: 4px;
}

.rcd-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.rcd-field label {
  font-size: 11px;
  color: var(--aide-text-muted);
  font-weight: 500;
  letter-spacing: 0.03em;
}
.rcd-field input {
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  color: var(--aide-text-primary);
  font-size: 12.5px;
  padding: 7px 10px;
  outline: none;
  font-family: inherit;
  transition: border-color 0.12s;
}
.rcd-field input:focus {
  border-color: var(--aide-accent, var(--aide-info));
}
.rcd-hint {
  font-size: 10.5px;
  color: var(--aide-text-muted);
}

/* JDK 只读展示（工作区级）：虚线框 + 非输入控件视觉，一眼区别于可编辑字段。
   修改入口在标题栏 LSP 面板，这里只指路。 */
.rcd-jdk-readonly {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 1px dashed var(--aide-border);
  border-radius: var(--aide-radius-sm);
  background: rgba(0, 0, 0, 0.12);
}
.rcd-jdk-readonly .jdk-ico {
  color: var(--aide-accent, var(--aide-info));
  flex-shrink: 0;
  display: flex;
}
.rcd-jdk-readonly .jdk-ico.muted {
  color: var(--aide-text-muted);
}
.rcd-jdk-readonly .jdk-val {
  font-size: 12px;
  color: var(--aide-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rcd-jdk-readonly .jdk-val.shared {
  color: var(--aide-text-muted);
}

/* JDK 字段下的提示行：共享语义说明 + 指路标题栏 */
.rcd-jdk-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 1px;
}
.rcd-jdk-hint .arrow {
  color: var(--aide-accent, var(--aide-info));
}

.rcd-save-row {
  margin-top: 4px;
}

.rcd-empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--aide-text-muted);
  text-align: center;
  padding: 20px;
}

/* ── Auto-detect overlay ── */
.rcd-detect-overlay {
  position: absolute;
  inset: 0;
  background: var(--aide-bg-deep);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  display: flex;
  flex-direction: column;
  padding: 20px;
  gap: 12px;
  z-index: 10;
}
.rcd-show-results > :is(.rcd-header, .rcd-body) {
  visibility: hidden;
}
.rcd-detect-header {
  font-size: 13px;
  font-weight: 600;
  color: var(--aide-text-primary);
}
.rcd-detect-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  overflow-y: auto;
}
.rcd-detect-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--aide-border);
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.1s;
}
.rcd-detect-item:has(input:checked) {
  background: var(--aide-surface-default);
  border-color: var(--aide-surface-hover);
}
.rcd-detect-item input[type="checkbox"] {
  margin-top: 2px;
  flex-shrink: 0;
  accent-color: var(--aide-accent, var(--aide-info));
}
.rcd-detect-col {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rcd-detect-name {
  font-size: 12px;
  color: var(--aide-text-primary);
  font-weight: 500;
}
.rcd-detect-cmd {
  font-size: 10.5px;
  color: var(--aide-text-muted);
  font-family: var(--aide-font-mono);
}
.rcd-detect-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* ── Shared buttons ── */
.rcd-btn-primary,
.rcd-btn-ghost {
  padding: 6px 16px;
  border-radius: 6px;
  font-size: 12.5px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.12s;
}
.rcd-btn-primary {
  background: var(--aide-accent, var(--aide-info));
  color: var(--aide-bg-deep);
  border: none;
}
.rcd-btn-primary:hover {
  opacity: 0.9;
}
.rcd-btn-primary:disabled {
  opacity: 0.4;
  cursor: default;
}
.rcd-btn-ghost {
  background: transparent;
  color: var(--aide-text-muted);
  border: 1px solid var(--aide-border);
}
.rcd-btn-ghost:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
</style>
