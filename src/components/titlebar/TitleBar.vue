<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from "vue";
import WindowControls from "./WindowControls.vue";
import SidebarToggle from "./SidebarToggle.vue";
import NotificationBell from "./NotificationBell.vue";
import LspIndicator from "./LspIndicator.vue";
import AppLogo from "../AppLogo.vue";
import Icon from "../Icon.vue";
import { isWindows } from "../../utils/platform";
import type { SessionStatus } from "../../composables/useSessionState";
import type { RunStatus } from "../../composables/useRunProcess";
import type { RunConfig } from "../../types";

interface ActiveSessionInfo {
  id: string;
  name: string;
  status: SessionStatus;
  wsKey: string;
}

const props = defineProps<{
  projectName?: string;
  gitBranch?: string;
  activeSessions?: ActiveSessionInfo[];
  runConfigs?: RunConfig[];
  activeRunConfig?: RunConfig | null;
  // 每配置独立运行状态（键 = RunConfig.id）——支持多模块并行。主按钮显示
  // 「选中配置」的状态，下拉每行显示「该行配置」的状态，互不干扰。
  runStates?: Record<string, RunStatus>;
  leftCollapsed?: boolean;
  rightCollapsed?: boolean;
  // 当前工作区根路径（LSP 徽章/面板用）
  workspaceRoot?: string;
}>();

const emit = defineEmits<{
  "open-palette": [];
  "select-session": [session: ActiveSessionInfo];
  "run-project": [id?: string];
  "select-run-config": [id: string];
  "edit-run-configs": [];
  "stop-project": [id?: string];
  "restart-project": [];
  "toggle-left": [];
  "toggle-right": [];
  "open-workbench": [];
  "open-folder": [];
}>();

function onSelectSession(s: ActiveSessionInfo) {
  panelOpen.value = false;
  emit("select-session", s);
}

// LspIndicator 程序化展开：App.vue 预防式 JDK 提示「去配置 JDK」→ 领到这里。
const lspIndicatorRef = ref<InstanceType<typeof LspIndicator> | null>(null);
function openLspPanel() {
  lspIndicatorRef.value?.openPanel();
}
defineExpose({ openLspPanel });

const STATUS_LABEL: Record<string, string> = {
  running: "运行中",
  waiting: "已就绪",
  attention: "待确认",
};

const STATUS_CLASS: Record<string, string> = {
  running: "status-running",
  waiting: "status-waiting",
  attention: "status-attention",
};

const panelOpen = ref(false);
let closeTimer: ReturnType<typeof setTimeout> | null = null;

function showPanel() {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  panelOpen.value = true;
}
function hidePanel() {
  closeTimer = setTimeout(() => { panelOpen.value = false; }, 150);
}

// Run config dropdown — click-to-open, searchable, keyboard-navigable.
// 运行状态按配置独立跟踪（runStates: configId -> RunStatus），支持多模块并行：
// 主按钮反映「选中配置」的状态，下拉每行反映「该行配置」的状态，互不干扰。
const configDropOpen = ref(false);
const runQuery = ref("");
const highlightIndex = ref(0);
const searchInput = ref<HTMLInputElement | null>(null);
const listRef = ref<HTMLElement | null>(null);

const showSearch = computed(() => (props.runConfigs?.length ?? 0) > 6);
const filteredConfigs = computed(() => {
  const q = runQuery.value.trim().toLowerCase();
  const all = props.runConfigs ?? [];
  return q ? all.filter(c => c.name.toLowerCase().includes(q)) : all;
});

function openConfigDrop() {
  configDropOpen.value = true;
  runQuery.value = "";
  highlightIndex.value = 0;
  nextTick(() => searchInput.value?.focus());
}
function closeConfigDrop() {
  configDropOpen.value = false;
}
function toggleConfigDrop() {
  if (configDropOpen.value) closeConfigDrop(); else openConfigDrop();
}
function selectConfig(id: string) {
  emit("select-run-config", id);
  closeConfigDrop();
}
// Run a specific config directly from its row's ▶ button, without changing
// the active/default config the main play button targets.
function runDirect(id: string) {
  emit("run-project", id);
  closeConfigDrop();
}
function openEditor() {
  closeConfigDrop();
  emit("edit-run-configs");
}
function onQueryInput() {
  highlightIndex.value = 0;
}
function onDropKeydown(e: KeyboardEvent) {
  const items = filteredConfigs.value;
  if (e.key === "Escape") { e.preventDefault(); closeConfigDrop(); return; }
  if (e.key === "ArrowDown") { e.preventDefault(); highlightIndex.value = Math.min(highlightIndex.value + 1, items.length - 1); return; }
  if (e.key === "ArrowUp")   { e.preventDefault(); highlightIndex.value = Math.max(highlightIndex.value - 1, 0); return; }
  if (e.key === "Enter")     { e.preventDefault(); const c = items[highlightIndex.value]; if (c) runDirect(c.id); return; }
}

// Keep the highlighted row scrolled into view while navigating by keyboard.
watch([highlightIndex, filteredConfigs], () => {
  if (!configDropOpen.value) return;
  nextTick(() => {
    const el = listRef.value?.querySelector<HTMLElement>(".cdrop-item.kbd-hl");
    el?.scrollIntoView({ block: "nearest" });
  });
});

// Click outside the run-group closes the dropdown.
function onDocClick(e: MouseEvent) {
  if (!configDropOpen.value) return;
  const t = e.target as HTMLElement | null;
  if (t && !t.closest(".run-group")) closeConfigDrop();
}
onMounted(() => document.addEventListener("click", onDocClick));
onUnmounted(() => document.removeEventListener("click", onDocClick));

const runningCount = computed(() =>
  (props.activeSessions ?? []).filter(s => s.status === "running").length
);

// 取某配置的运行状态（缺省 idle——从未启动过）。
function statusOf(cfgId: string | undefined): RunStatus {
  if (!cfgId) return "idle";
  return props.runStates?.[cfgId] ?? "idle";
}
// 主按钮绑定「选中配置」的状态：running 显 ⏹（停它），否则显 ▶（跑它，不影响
// 其他并行模块）。切到没启动的配置 → ▶，正是预期。
const selectedStatus = computed<RunStatus>(() =>
  props.activeRunConfig ? statusOf(props.activeRunConfig.id) : "idle"
);
const isRunning = computed(() => selectedStatus.value === "running");
// 重启 = 停止当前并立即重新启动，仅对「正在运行」的配置有意义——与 ⏹ 停止按钮
// 并列。停止/崩溃/未启动后重启按钮必须消失，只留 ▶ 运行按钮（要再跑点 ▶ 即可），
// 不再常驻——否则停止后重启按钮残留（2026-08-12 修复）。
const showRestartBtn = computed(() => selectedStatus.value === "running");
// 某行是否正在跑（供下拉每行常驻显示停止态）。
function isRowRunning(cfg: RunConfig): boolean {
  return statusOf(cfg.id) === "running";
}
</script>

<template>
  <div class="titlebar" data-tauri-drag-region>
    <!-- Left: brand + project context -->
    <div class="titlebar-left" data-tauri-drag-region>
      <div class="titlebar-logo" data-tauri-drag-region>
        <AppLogo :size="15" />
        <span class="titlebar-logo-text">Aide</span>
      </div>

      <SidebarToggle
        side="left"
        :collapsed="!!leftCollapsed"
        @toggle="$emit('toggle-left')"
      />

      <!-- 打开目录 / 新建工作空间 -->
      <button
        class="titlebar-open-folder-btn"
        v-tooltip="'打开目录 / 新建工作空间'"
        @click.stop="$emit('open-folder')"
      >
        <span class="titlebar-open-folder-text">打开目录</span>
      </button>

      <!-- Run config selector: shown when configs exist for this workspace -->
      <template v-if="projectName && runConfigs && runConfigs.length > 0">
        <div class="run-group" @click.stop>
          <!-- Config name selector (running state is shown by the play/stop button) -->
          <button
            class="run-config-sel"
            :class="{ open: configDropOpen }"
            v-tooltip="'切换运行配置'"
            @click.stop="toggleConfigDrop"
          >
            <span class="run-config-name">{{ activeRunConfig?.name ?? '─' }}</span>
            <svg class="run-config-chevron" :class="{ open: configDropOpen }" width="8" height="5" viewBox="0 0 8 5" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M0.5 0.5L4 4L7.5 0.5"/>
            </svg>
          </button>

          <!-- Stop button (only when running) -->
          <button
            v-if="isRunning"
            class="run-stop-btn"
            v-tooltip="'停止'"
            @click.stop="$emit('stop-project')"
          >
            <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
              <rect x="1" y="1" width="6" height="6" rx="0.5"/>
            </svg>
          </button>

          <!-- Play button (when idle / stopped / crashed) -->
          <button
            v-else
            class="run-play-btn"
            v-tooltip="'运行'"
            @click.stop="$emit('run-project')"
          >
            <svg width="8" height="8" viewBox="0 0 10 10" fill="currentColor">
              <polygon points="2,1 9,5 2,9"/>
            </svg>
          </button>

          <!-- Restart button (only when running — 停止/崩溃后消失，避免残留) -->
          <button
            v-if="showRestartBtn"
            class="run-restart-btn"
            v-tooltip="'重启'"
            @click.stop="$emit('restart-project')"
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="1 4 1 10 7 10"/>
              <path d="M3.51 15a9 9 0 1 0 .49-3.13"/>
            </svg>
          </button>

          <!-- Config dropdown panel: search + scrollable list + footer -->
          <Transition name="config-drop">
            <div v-if="configDropOpen" class="config-drop-panel" @click.stop>
              <div v-if="showSearch" class="cdrop-search">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>
                </svg>
                <input
                  ref="searchInput"
                  v-model="runQuery"
                  type="text"
                  placeholder="筛选运行配置…"
                  autocomplete="off"
                  spellcheck="false"
                  @input="onQueryInput"
                  @keydown="onDropKeydown"
                />
                <span class="cdrop-count">{{ filteredConfigs.length }}/{{ runConfigs!.length }}</span>
              </div>

              <div ref="listRef" class="cdrop-list">
                <div
                  v-for="(cfg, i) in filteredConfigs"
                  :key="cfg.id"
                  class="cdrop-item"
                  :class="{ active: cfg.id === activeRunConfig?.id, 'kbd-hl': i === highlightIndex, running: isRowRunning(cfg) }"
                  v-tooltip="cfg.command"
                  @click="selectConfig(cfg.id)"
                  @mouseenter="highlightIndex = i"
                >
                  <span class="cdrop-check">{{ cfg.id === activeRunConfig?.id ? '✓' : '' }}</span>
                  <span class="cdrop-name">{{ cfg.name }}</span>
                  <!-- 该行正在跑：常驻停止按钮（不靠 hover 显隐），点了停掉它；
                       否则照旧 hover/键盘高亮才显的 ▶ 运行按钮。 -->
                  <button v-if="isRowRunning(cfg)" class="cdrop-stop" @click.stop="$emit('stop-project', cfg.id)">
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><rect x="1" y="1" width="6" height="6" rx="0.5"/></svg>
                  </button>
                  <button v-else class="cdrop-run" @click.stop="runDirect(cfg.id)">
                    <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 9,5 2,9"/></svg>
                  </button>
                </div>
                <div v-if="filteredConfigs.length === 0" class="cdrop-empty">没有匹配的运行配置</div>
              </div>

              <div class="cdrop-sep" />
              <div class="cdrop-action" @click="openEditor">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
                编辑运行配置…
              </div>
              <div v-if="showSearch" class="cdrop-foot">
                <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
                <span><kbd>Enter</kbd> 运行</span>
                <span><kbd>Esc</kbd> 关闭</span>
              </div>
            </div>
          </Transition>
        </div>
      </template>

      <!-- Fallback run button when no configs detected yet -->
      <button
        v-else-if="projectName"
        class="titlebar-run-btn"
        v-tooltip="'运行项目'"
        @click.stop="$emit('run-project')"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
          <polygon points="2,1 9,5 2,9"/>
        </svg>
      </button>

      <!-- 工作台终端 (Ctrl+`)：运行按钮右边，独立元素始终可见
           （不进 run-group 的 v-if/v-else-if，否则无项目时按钮消失） -->
      <button
        class="titlebar-icon-btn"
        v-tooltip="'工作台终端 (Ctrl+`)'"
        @click.stop="$emit('open-workbench')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="4 17 10 11 4 5"/>
          <line x1="12" y1="19" x2="20" y2="19"/>
        </svg>
      </button>

    </div>

    <!-- Center: search trigger -->
    <button class="titlebar-search-trigger" @click="$emit('open-palette')">
      <Icon class="titlebar-search-icon" name="search" :size="13" />
      <span class="titlebar-search-text">搜索...</span>
      <kbd class="titlebar-search-kbd">Ctrl+P</kbd>
    </button>

    <!-- Right: activity indicator + window controls -->
    <div class="titlebar-right">
      <NotificationBell />
      <LspIndicator ref="lspIndicatorRef" :workspace-root="workspaceRoot" />
      <div
        v-if="(activeSessions ?? []).length > 0"
        class="titlebar-activity"
        @mouseenter="showPanel"
        @mouseleave="hidePanel"
      >
        <span class="activity-dot" :class="{ pulsing: runningCount > 0 }" />
        <span class="activity-count">{{ activeSessions!.length }}</span>

        <!-- Hover panel -->
        <Transition name="activity-panel">
          <div v-if="panelOpen" class="activity-panel" @mouseenter="showPanel" @mouseleave="hidePanel">
            <div class="activity-panel-header">活跃会话</div>
            <div
              v-for="s in activeSessions"
              :key="s.id"
              class="activity-panel-item"
              @click="onSelectSession(s)"
            >
              <span class="activity-item-dot" :class="STATUS_CLASS[s.status]" />
              <span class="activity-item-name">{{ s.name }}</span>
              <span class="activity-item-status">{{ STATUS_LABEL[s.status] || s.status }}</span>
            </div>
          </div>
        </Transition>
      </div>
      <SidebarToggle
        side="right"
        :collapsed="!!rightCollapsed"
        @toggle="$emit('toggle-right')"
      />
      <WindowControls v-if="isWindows()" />
    </div>
  </div>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  height: 42px;
  flex-shrink: 0;
  background:
    linear-gradient(180deg, var(--aide-border-subtle) 0%, transparent 100%),
    var(--aide-bg-deep);
  border-bottom: 1px solid var(--aide-border);
  padding: 0 0 0 14px;
  user-select: none;
}

/* ── Left section ── */

.titlebar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  min-width: 0;
}

.titlebar-logo {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-shrink: 0;
}

.titlebar-logo-text {
  font-size: 12px;
  font-weight: 700;
  color: var(--aide-text-secondary);
  letter-spacing: 0.5px;
}

.titlebar-sep {
  color: var(--aide-text-muted);
  font-size: 12px;
  opacity: 0.4;
}

.titlebar-project {
  font-size: 12px;
  font-weight: 500;
  color: var(--aide-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 160px;
}

.titlebar-branch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 500;
  color: var(--aide-text-muted);
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  padding: 2px 8px 2px 5px;
  border-radius: 99px;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  box-shadow: var(--aide-highlight-inset);
}

.titlebar-branch-icon {
  flex-shrink: 0;
  opacity: 0.7;
}

.titlebar-run-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  background: none;
  border: 1px solid transparent;
  border-radius: var(--aide-radius-sm);
  color: var(--aide-success);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.titlebar-run-btn:hover {
  background: color-mix(in srgb, var(--aide-success) 12%, transparent);
  border-color: color-mix(in srgb, var(--aide-success) 30%, transparent);
}

/* ── Center: search ── */

.titlebar-search-trigger {
  flex: 1;
  max-width: 360px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  padding: 5px 12px;
  color: var(--aide-text-muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  box-shadow: var(--aide-highlight-inset);
  transition: all var(--aide-ease-t);
}

.titlebar-search-trigger:hover {
  background: var(--aide-surface-hover);
  border-color: var(--aide-surface-hover);
}

.titlebar-search-icon {
  flex-shrink: 0;
  opacity: 0.6;
}

.titlebar-search-text {
  flex: 1;
  text-align: left;
}

.titlebar-search-kbd {
  margin-left: auto;
  background: var(--aide-bg-deep);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  color: var(--aide-text-muted);
  border: 1px solid var(--aide-border);
  font-family: inherit;
}

/* ── Right section ── */

.titlebar-right {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  height: 100%;
}

.titlebar-activity {
  position: relative;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 12px;
  height: 100%;
  cursor: default;
}

.activity-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--aide-success);
}

.activity-dot.pulsing {
  box-shadow: 0 0 6px color-mix(in srgb, var(--aide-success) 50%, transparent);
  animation: activity-pulse 2s ease-in-out infinite;
}

@keyframes activity-pulse {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}

.activity-count {
  font-size: 11px;
  font-weight: 600;
  color: var(--aide-text-secondary);
  min-width: 12px;
}

/* ── Hover panel ── */

.activity-panel {
  position: absolute;
  top: 100%;
  right: 0;
  min-width: 200px;
  max-width: 280px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-md);
  box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  padding: 6px 0;
  z-index: 900;
  backdrop-filter: var(--aide-surface-blur);
}

.activity-panel-header {
  padding: 6px 14px 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--aide-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-bottom: 1px solid var(--aide-border);
  margin-bottom: 4px;
}

.activity-panel-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  cursor: pointer;
  transition: background 0.1s;
}

.activity-panel-item:hover {
  background: var(--aide-surface-default);
}

.activity-item-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.activity-item-dot.status-running {
  background: var(--aide-success);
  box-shadow: 0 0 4px color-mix(in srgb, var(--aide-success) 40%, transparent);
}

.activity-item-dot.status-waiting {
  background: var(--aide-info);
}

.activity-item-dot.status-attention {
  background: var(--aide-warning);
  box-shadow: 0 0 4px color-mix(in srgb, var(--aide-warning) 40%, transparent);
}

.activity-item-name {
  flex: 1;
  font-size: 12px;
  color: var(--aide-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.activity-item-status {
  font-size: 10px;
  color: var(--aide-text-muted);
  flex-shrink: 0;
}

/* ── Panel transition ── */

.activity-panel-enter-active,
.activity-panel-leave-active {
  transition: opacity var(--aide-ease-t), transform var(--aide-ease-t);
}

.activity-panel-enter-from,
.activity-panel-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* ── Run config group ── */

.run-group {
  position: relative;
  display: flex;
  align-items: center;
  gap: 1px;
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  overflow: visible;
  box-shadow: var(--aide-highlight-inset);
}

.run-config-sel {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 7px 3px 8px;
  background: none;
  border: none;
  border-right: 1px solid var(--aide-border);
  border-radius: 0;
  color: var(--aide-text-primary);
  font-size: 11.5px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.12s;
  max-width: 130px;
}
.run-config-sel:hover {
  background: var(--aide-surface-hover);
}
.run-config-sel.open {
  background: var(--aide-surface-hover);
}

.run-config-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100px;
}

.run-config-chevron {
  flex-shrink: 0;
  opacity: 0.5;
  stroke: currentColor;
  fill: none;
  stroke-width: 1.5;
  transition: transform 0.14s ease;
}
.run-config-chevron.open {
  transform: rotate(180deg);
}

.run-play-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  background: none;
  border: none;
  color: var(--aide-success);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.12s, color 0.12s;
}
.run-play-btn:hover {
  background: color-mix(in srgb, var(--aide-success) 12%, transparent);
  color: var(--aide-success);
}

/* ── Config dropdown panel ── */
/* Click-to-open, searchable, keyboard-navigable. Running state is shown only
   by the main play/stop button — no per-row or selector status dots here. */

.config-drop-panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  width: 300px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-md);
  box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  z-index: 950;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  backdrop-filter: var(--aide-surface-blur);
}

.cdrop-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 11px;
  border-bottom: 1px solid var(--aide-border);
}
.cdrop-search svg {
  color: var(--aide-text-muted);
  flex-shrink: 0;
}
.cdrop-search input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--aide-text-primary);
  font-size: 12.5px;
  font-family: inherit;
}
.cdrop-search input::placeholder {
  color: var(--aide-text-muted);
}
.cdrop-count {
  font-size: 10.5px;
  color: var(--aide-text-muted);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.cdrop-list {
  max-height: 320px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px 0;
  scrollbar-width: thin;
  scrollbar-color: var(--aide-surface-active) transparent;
}
.cdrop-list::-webkit-scrollbar {
  width: 8px;
}
.cdrop-list::-webkit-scrollbar-thumb {
  background: var(--aide-surface-active);
  border-radius: 4px;
  border: 2px solid var(--aide-bg-raised);
}
.cdrop-list::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--aide-surface-active) 60%, var(--aide-text-muted));
}

.cdrop-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 11px;
  cursor: pointer;
  transition: background 0.1s;
}
.cdrop-item:hover,
.cdrop-item.kbd-hl {
  background: var(--aide-surface-default);
}
.cdrop-item.active .cdrop-name {
  color: var(--aide-accent, var(--aide-info));
}

.cdrop-check {
  width: 12px;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--aide-accent, var(--aide-info));
  text-align: center;
}

.cdrop-name {
  flex: 1;
  font-size: 12.5px;
  color: var(--aide-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cdrop-run {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  display: none;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--aide-success);
  border-radius: 4px;
}
.cdrop-item:hover .cdrop-run,
.cdrop-item.kbd-hl .cdrop-run {
  display: flex;
}
.cdrop-run:hover {
  background: color-mix(in srgb, var(--aide-success) 14%, transparent);
}

/* 正在跑的配置行：停止按钮常驻可见（不靠 hover 显隐），danger 色；行名加粗，
   让用户一眼看出这行在跑（而非卡在 hover 才显的 ▶ 运行按钮）。 */
.cdrop-stop {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--aide-danger);
  border-radius: 4px;
}
.cdrop-stop:hover {
  background: color-mix(in srgb, var(--aide-danger) 14%, transparent);
}
.cdrop-item.running .cdrop-name {
  color: var(--aide-text-primary);
  font-weight: 600;
}

.cdrop-empty {
  padding: 22px 12px;
  text-align: center;
  color: var(--aide-text-muted);
  font-size: 12px;
}

.cdrop-sep {
  height: 1px;
  background: var(--aide-border);
  margin: 3px 0;
}

.cdrop-action {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 11px;
  cursor: pointer;
  color: var(--aide-text-muted);
  font-size: 12px;
  transition: background 0.1s, color 0.1s;
}
.cdrop-action:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

.cdrop-foot {
  padding: 6px 11px;
  border-top: 1px solid var(--aide-border);
  font-size: 10.5px;
  color: var(--aide-text-muted);
  display: flex;
  gap: 12px;
  align-items: center;
}
.cdrop-foot kbd {
  font-family: inherit;
  font-size: 10px;
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border);
  border-radius: 3px;
  padding: 0 4px;
  color: var(--aide-text-secondary);
}

/* ── Dropdown transition ── */

.config-drop-enter-active,
.config-drop-leave-active {
  transition: opacity var(--aide-ease-t), transform var(--aide-ease-t);
}
.config-drop-enter-from,
.config-drop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* ── Stop button ── */

.run-stop-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  background: none;
  border: none;
  color: var(--aide-danger);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.12s, color 0.12s;
}
.run-stop-btn:hover {
  background: color-mix(in srgb, var(--aide-danger) 12%, transparent);
}

/* ── Restart button ── */

.run-restart-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  background: none;
  border: none;
  border-left: 1px solid var(--aide-border);
  color: var(--aide-text-muted);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.12s, color 0.12s;
}
.run-restart-btn:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}

/* ── Workbench terminal button ── */
/* 标题栏左部的 icon-only 边框按钮，与「打开目录」同语言（边框 + radius-sm），
   供工作台终端、未来其它 icon 入口复用。 */
.titlebar-icon-btn {
  display: flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; background: none; border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm); color: var(--aide-text-secondary);
  cursor: pointer; flex-shrink: 0; transition: background 0.12s, border-color 0.12s, color 0.12s;
  font-family: inherit;
}
.titlebar-icon-btn:hover {
  background: var(--aide-surface-hover);
  border-color: color-mix(in srgb, var(--aide-text-secondary) 30%, transparent);
  color: var(--aide-text-primary);
}

/* ── Open folder button ── */

.titlebar-open-folder-btn {
  display: flex; align-items: center; justify-content: center;
  height: 26px; padding: 0 10px; background: none; border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm); color: var(--aide-text-secondary);
  cursor: pointer; flex-shrink: 0; transition: background 0.12s, border-color 0.12s, color 0.12s;
  font-family: inherit;
}
.titlebar-open-folder-btn:hover {
  background: var(--aide-surface-hover);
  border-color: color-mix(in srgb, var(--aide-text-secondary) 30%, transparent);
  color: var(--aide-text-primary);
}
.titlebar-open-folder-text {
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}
</style>
