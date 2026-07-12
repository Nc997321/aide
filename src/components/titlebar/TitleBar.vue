<script setup lang="ts">
import { ref, computed } from "vue";
import WindowControls from "./WindowControls.vue";
import SidebarToggle from "./SidebarToggle.vue";
import NotificationBell from "./NotificationBell.vue";
import Icon from "../Icon.vue";
import type { SessionStatus } from "../../composables/useSessionState";
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
  runStatus?: "idle" | "running" | "stopped" | "crashed";
  leftCollapsed?: boolean;
  rightCollapsed?: boolean;
}>();

const emit = defineEmits<{
  "open-palette": [];
  "select-session": [session: ActiveSessionInfo];
  "run-project": [];
  "select-run-config": [id: string];
  "edit-run-configs": [];
  "stop-project": [];
  "restart-project": [];
  "toggle-left": [];
  "toggle-right": [];
  "open-folder": [];
}>();

function onSelectSession(s: ActiveSessionInfo) {
  panelOpen.value = false;
  emit("select-session", s);
}

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

// Run config dropdown
const configDropOpen = ref(false);
let configCloseTimer: ReturnType<typeof setTimeout> | null = null;

function showConfigDrop() {
  if (configCloseTimer) { clearTimeout(configCloseTimer); configCloseTimer = null; }
  configDropOpen.value = true;
}
function hideConfigDrop() {
  configCloseTimer = setTimeout(() => { configDropOpen.value = false; }, 150);
}
function selectConfig(id: string) {
  configDropOpen.value = false;
  emit("select-run-config", id);
}
function openEditor() {
  configDropOpen.value = false;
  emit("edit-run-configs");
}

const runningCount = computed(() =>
  (props.activeSessions ?? []).filter(s => s.status === "running").length
);

const isRunning = computed(() => props.runStatus === "running");
const showRestartBtn = computed(() =>
  props.runStatus === "running" || props.runStatus === "stopped" || props.runStatus === "crashed"
);
const runDotClass = computed(() => {
  switch (props.runStatus) {
    case "running":  return "run-dot run-dot-running";
    case "stopped":  return "run-dot run-dot-stopped";
    case "crashed":  return "run-dot run-dot-crashed";
    default:         return "";
  }
});
</script>

<template>
  <div class="titlebar" data-tauri-drag-region>
    <!-- Left: brand + project context -->
    <div class="titlebar-left" data-tauri-drag-region>
      <div class="titlebar-logo" data-tauri-drag-region>
        <img class="titlebar-logo-icon" src="/icon.png" alt="Aide" />
        <span class="titlebar-logo-text">Aide</span>
      </div>

      <template v-if="projectName">
        <span class="titlebar-sep">/</span>
        <span class="titlebar-project">{{ projectName }}</span>
      </template>

      <SidebarToggle
        side="left"
        :collapsed="!!leftCollapsed"
        @toggle="$emit('toggle-left')"
      />

      <span v-if="gitBranch" class="titlebar-branch">
        <svg class="titlebar-branch-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="6" y1="3" x2="6" y2="15"/>
          <circle cx="18" cy="6" r="3"/>
          <circle cx="6" cy="18" r="3"/>
          <path d="M18 9a9 9 0 0 1-9 9"/>
        </svg>
        {{ gitBranch }}
      </span>

      <!-- Run config selector: shown when configs exist for this workspace -->
      <template v-if="projectName && runConfigs && runConfigs.length > 0">
        <div
          class="run-group"
          @mouseenter="showConfigDrop"
          @mouseleave="hideConfigDrop"
        >
          <!-- Config name selector — includes status dot -->
          <button
            class="run-config-sel"
            v-tooltip="'切换运行配置'"
            @click.stop="configDropOpen = !configDropOpen"
          >
            <span v-if="runDotClass" :class="runDotClass" />
            <span class="run-config-name">{{ activeRunConfig?.name ?? '─' }}</span>
            <svg class="run-config-chevron" width="8" height="5" viewBox="0 0 8 5" fill="currentColor">
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

          <!-- Restart button (visible when process has been started at least once) -->
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

          <!-- Config dropdown panel -->
          <Transition name="config-drop">
            <div
              v-if="configDropOpen"
              class="config-drop-panel"
              @mouseenter="showConfigDrop"
              @mouseleave="hideConfigDrop"
            >
              <div
                v-for="cfg in runConfigs"
                :key="cfg.id"
                class="config-drop-item"
                :class="{ active: cfg.id === activeRunConfig?.id }"
                @click="selectConfig(cfg.id)"
              >
                <span class="config-drop-check">{{ cfg.id === activeRunConfig?.id ? '✓' : '' }}</span>
                <span class="config-drop-col">
                  <span class="config-drop-name">{{ cfg.name }}</span>
                  <span class="config-drop-cmd">{{ cfg.command }}</span>
                </span>
              </div>
              <div class="config-drop-sep" />
              <div class="config-drop-action" @click="openEditor">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
                编辑运行配置…
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

      <!-- 打开目录 / 新建工作空间 -->
      <button
        class="titlebar-open-folder-btn"
        v-tooltip="'打开目录 / 新建工作空间'"
        @click.stop="$emit('open-folder')"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 7C3 5.89543 3.89543 5 5 5H9.58579C9.851 5 10.1054 5.10536 10.2929 5.29289L12 7H19C20.1046 7 21 7.89543 21 9V17C21 18.1046 20.1046 19 19 19H5C3.89543 19 3 18.1046 3 17V7Z"/>
          <path d="M3 9L9 9L11 11L21 11"/>
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
      <WindowControls />
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
  gap: 6px;
  flex-shrink: 0;
}

.titlebar-logo-icon {
  width: 16px;
  height: 16px;
  object-fit: contain;
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
  padding: 2px 8px 2px 5px;
  border-radius: 10px;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  transition: all 0.15s;
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
  border: 1px solid var(--aide-surface-hover);
  border-radius: var(--aide-radius-md);
  box-shadow: var(--aide-shadow-lg);
  padding: 6px 0;
  z-index: 900;
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
  transition: opacity 0.12s ease, transform 0.12s ease;
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
  color: color-mix(in srgb, var(--aide-success) 150%, white);
}

/* ── Config dropdown panel ── */

.config-drop-panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  min-width: 240px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-surface-hover);
  border-radius: var(--aide-radius-md);
  box-shadow: var(--aide-shadow-lg);
  z-index: 950;
  overflow: hidden;
}

.config-drop-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 12px;
  cursor: pointer;
  transition: background 0.1s;
}
.config-drop-item:hover {
  background: var(--aide-surface-default);
}
.config-drop-item.active .config-drop-name {
  color: var(--aide-accent, var(--aide-info));
}

.config-drop-check {
  width: 12px;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--aide-accent, var(--aide-info));
  margin-top: 1px;
}

.config-drop-col {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.config-drop-name {
  font-size: 12px;
  color: var(--aide-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.config-drop-cmd {
  font-size: 10.5px;
  color: var(--aide-text-muted);
  font-family: 'Consolas', 'Menlo', monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.config-drop-sep {
  height: 1px;
  background: var(--aide-border);
  margin: 2px 0;
}

.config-drop-action {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  cursor: pointer;
  color: var(--aide-text-muted);
  font-size: 12px;
  transition: background 0.1s, color 0.1s;
}
.config-drop-action:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

/* ── Dropdown transition ── */

.config-drop-enter-active,
.config-drop-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.config-drop-enter-from,
.config-drop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* ── Run status dot ── */

.run-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.run-dot-running {
  background: var(--aide-success);
  box-shadow: 0 0 5px color-mix(in srgb, var(--aide-success) 60%, transparent);
  animation: run-dot-pulse 2s ease-in-out infinite;
}

.run-dot-stopped {
  background: var(--aide-text-muted);
}

.run-dot-crashed {
  background: var(--aide-error, #f38ba8);
}

@keyframes run-dot-pulse {
  0%, 100% { opacity: 0.7; }
  50% { opacity: 1; }
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
  color: var(--aide-error, #f38ba8);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.12s, color 0.12s;
}
.run-stop-btn:hover {
  background: color-mix(in srgb, var(--aide-error, #f38ba8) 12%, transparent);
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

/* ── Open folder button ── */

.titlebar-open-folder-btn {
  display: flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; background: none; border: 1px solid transparent;
  border-radius: var(--aide-radius-sm); color: var(--aide-text-secondary);
  cursor: pointer; flex-shrink: 0; transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.titlebar-open-folder-btn:hover {
  background: var(--aide-surface-hover);
  border-color: var(--aide-border);
  color: var(--aide-text-primary);
}
</style>
