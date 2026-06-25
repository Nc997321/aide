<script setup lang="ts">
import { ref, computed } from "vue";
import WindowControls from "./WindowControls.vue";
import type { SessionStatus } from "../../composables/useSessionState";

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
}>();

const emit = defineEmits<{
  "open-palette": [];
  "select-session": [session: ActiveSessionInfo];
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

const runningCount = computed(() =>
  (props.activeSessions ?? []).filter(s => s.status === "running").length
);
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

      <span v-if="gitBranch" class="titlebar-branch">
        <svg class="titlebar-branch-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="6" y1="3" x2="6" y2="15"/>
          <circle cx="18" cy="6" r="3"/>
          <circle cx="6" cy="18" r="3"/>
          <path d="M18 9a9 9 0 0 1-9 9"/>
        </svg>
        {{ gitBranch }}
      </span>
    </div>

    <!-- Center: search trigger -->
    <button class="titlebar-search-trigger" @click="$emit('open-palette')">
      <svg class="titlebar-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"/>
        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      <span class="titlebar-search-text">搜索...</span>
      <kbd class="titlebar-search-kbd">Ctrl+P</kbd>
    </button>

    <!-- Right: activity indicator + window controls -->
    <div class="titlebar-right">
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
</style>
