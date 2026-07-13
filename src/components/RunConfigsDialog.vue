<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useRunConfigs } from "../composables/useRunConfigs";
import type { RunConfig, RunTarget } from "../types";

const emit = defineEmits<{ close: [] }>();

const { configs, activeId, add, update, remove, detectAndAdd, addTargets, currentWsKey } =
  useRunConfigs();

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

watch(
  selected,
  (cfg) => {
    if (cfg) draft.value = { ...cfg };
  },
  { immediate: true }
);

const isDirty = computed(
  () => selected.value && (
    draft.value.name !== selected.value.name ||
    draft.value.cwd !== selected.value.cwd ||
    draft.value.command !== selected.value.command
  )
);

async function save() {
  if (!selected.value) return;
  await update({ ...draft.value });
}

// ── CRUD actions ─────────────────────────────────────────────────────────────
async function addNew() {
  const cfg = await add({ name: "新配置", cwd: currentWsKey.value, command: "" });
  selectedId.value = cfg.id;
}

async function deleteSelected() {
  if (!selected.value) return;
  await remove(selected.value.id);
}

// ── Auto-detect ──────────────────────────────────────────────────────────────
const detecting = ref(false);
const detectedTargets = ref<RunTarget[]>([]);
const selectedTargetIds = ref<Set<string>>(new Set());

async function runDetect() {
  detecting.value = true;
  detectedTargets.value = await detectAndAdd(currentWsKey.value);
  selectedTargetIds.value = new Set(detectedTargets.value.map(t => t.cwd));
  detecting.value = false;
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
  const chosen = detectedTargets.value.filter(t =>
    selectedTargetIds.value.has(t.cwd)
  );
  await addTargets(chosen);
  detectedTargets.value = [];
  if (configs.value.length > 0) selectedId.value = configs.value[0].id;
}

function closeDetect() {
  detectedTargets.value = [];
}

// ── Close / save-and-close ───────────────────────────────────────────────────
async function close() {
  if (isDirty.value) await save();
  emit("close");
}
</script>

<template>
  <div class="rcd-backdrop" @click.self="close">
    <div class="rcd-dialog">
      <div class="rcd-header">
        <svg width="14" height="14" viewBox="0 0 10 10" fill="var(--aide-success)" style="flex-shrink:0">
          <polygon points="2,1 9,5 2,9"/>
        </svg>
        <span class="rcd-title">运行配置</span>
        <button class="rcd-close" @click="close">✕</button>
      </div>

      <div class="rcd-body">
        <!-- Left: config list -->
        <div class="rcd-left">
          <div class="rcd-toolbar">
            <button class="rcd-tool" title="新建" @click="addNew">＋</button>
            <button
              class="rcd-tool rcd-tool-danger"
              title="删除"
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
            <button class="rcd-detect-btn" :disabled="detecting" @click="runDetect">
              <svg v-if="!detecting" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
              </svg>
              <span v-if="detecting">检测中…</span>
              <span v-else>自动检测</span>
            </button>
          </div>
        </div>

        <!-- Right: edit form -->
        <div class="rcd-right">
          <template v-if="selected">
            <div class="rcd-form-title">{{ draft.name || '(未命名)' }}</div>

            <div class="rcd-field">
              <label>名称</label>
              <input v-model="draft.name" type="text" placeholder="service-auth" />
            </div>

            <div class="rcd-field">
              <label>工作目录</label>
              <input v-model="draft.cwd" type="text" placeholder="/path/to/module" />
            </div>

            <div class="rcd-field">
              <label>命令</label>
              <input v-model="draft.command" type="text" placeholder="mvn spring-boot:run" />
              <span class="rcd-hint">在工作目录中执行的 shell 命令</span>
            </div>

            <div class="rcd-save-row">
              <button class="rcd-btn-primary" :disabled="!isDirty" @click="save">保存更改</button>
            </div>
          </template>
          <div v-else class="rcd-empty-state">选择左侧配置项进行编辑，或点击 ＋ 新建</div>
        </div>
      </div>

      <!-- Auto-detect results overlay -->
      <div v-if="detectedTargets.length > 0" class="rcd-detect-overlay">
        <div class="rcd-detect-header">检测到以下可运行目标</div>
        <div class="rcd-detect-list">
          <label
            v-for="t in detectedTargets"
            :key="t.cwd"
            class="rcd-detect-item"
          >
            <input
              type="checkbox"
              :checked="selectedTargetIds.has(t.cwd)"
              @change="toggleTarget(t.cwd)"
            />
            <span class="rcd-detect-col">
              <span class="rcd-detect-name">{{ t.name }}</span>
              <span class="rcd-detect-cmd">{{ t.command }}</span>
            </span>
          </label>
        </div>
        <div class="rcd-detect-actions">
          <button class="rcd-btn-ghost" @click="closeDetect">取消</button>
          <button class="rcd-btn-primary" @click="confirmDetected">添加选中项</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rcd-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.rcd-dialog {
  position: relative;
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  width: 660px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--aide-shadow-lg);
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
  display: flex;
  flex-direction: column;
  padding: 20px;
  gap: 12px;
  z-index: 10;
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
  font-family: 'Consolas', 'Menlo', monospace;
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
