<script setup lang="ts">
import SidebarLeft from "./components/SidebarLeft.vue";
import TerminalPanel from "./components/TerminalPanel.vue";
import FileTree from "./components/FileTree.vue";
import ChangeLogPanel from "./components/ChangeLogPanel.vue";
import ContextMenu from "./components/ContextMenu.vue";
import ModalDialog from "./components/ModalDialog.vue";
import FileViewer from "./components/FileViewer.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import GitPanel from "./components/GitPanel.vue";
import WorkbenchTerminal from "./components/WorkbenchTerminal.vue";
import NotificationBanner from "./components/NotificationBanner.vue";
import TitleBar from "./components/titlebar/TitleBar.vue";
import { useWorkbenchTerminal } from "./composables/useWorkbenchTerminal";
import { api } from "./api";
import { ref, onMounted, onUnmounted, nextTick, watch, computed } from "vue";
import { useSettings } from "./composables/useSettings";
import { useWindowFocus } from "./composables/useWindowFocus";
import { useNotification, pendingSessions, clearPending } from "./composables/useNotification";
import { useGit } from "./composables/useGit";
import { useSearchProviders } from "./composables/useSearchProviders";
import { useProviders } from "./composables/useProviders";
import { useGitWatcher } from "./composables/useGitWatcher";
import { matchShortcut } from "./utils/shortcut";

const leftWidth = ref(280);
const rightWidth = ref(300);
const changeLogHeight = ref(300);
const changeLogCollapsed = ref(false);
const leftCollapsed = ref(false);
const rightCollapsed = ref(false);
const rightTab = ref<"files" | "git">("files");
const { unstagedFiles, hasChanges, loadStatus } = useGit();
const isDraggingLeft = ref(false);
const isDraggingRight = ref(false);
const isDraggingChangeLog = ref(false);
const sidebarRef = ref<InstanceType<typeof SidebarLeft> | null>(null);
const fileTreeRef = ref<InstanceType<typeof FileTree> | null>(null);
const gitPanelRef = ref<InstanceType<typeof GitPanel> | null>(null);
const titleBarRef = ref<InstanceType<typeof TitleBar> | null>(null);
const activeSessionId = ref("");
const settingsVisible = ref(false);
const settingsInitialTab = ref<string | undefined>(undefined);
const terminalPanelRef = ref<InstanceType<typeof TerminalPanel> | null>(null);
const workspacePath = ref("");
const projectName = ref("");
const { settings, update: updateSettings } = useSettings();
const workbenchHeight = ref(settings.workbenchHeight || Math.floor(window.innerHeight * 0.45));
const wb = useWorkbenchTerminal();

// Persist workbench height changes to settings
function onWorkbenchHeightChange(v: number) {
  workbenchHeight.value = v;
  updateSettings({ workbenchHeight: v });
}

// ── Notification banner for completed sessions ──
const { isFocused } = useWindowFocus();
const bannerVisible = ref(false);

interface PendingSessionInfo {
  id: string;
  name: string;
  wsKey: string;
  wsName: string;
}

const pendingSessionInfos = ref<PendingSessionInfo[]>([]);

// When window regains focus, check for pending sessions and show banner
watch(isFocused, async (focused, wasFocused) => {
  if (focused && wasFocused === false) {
    // Window just regained focus
    // Also check Rust-side pending notification (in case frontend missed it)
    const rustPending = await api.getPendingNotification();
    if (rustPending) {
      pendingSessions.add(rustPending);
    }

    if (pendingSessions.size > 0) {
      // Build the pending session info list
      const infos: PendingSessionInfo[] = [];
      const [sessions, workspaces, projectInfo] = await Promise.all([
        api.listSessions(),
        api.listWorkspaces(),
        api.getProjectInfo(),
      ]);

      // Find the current workspace by matching project root
      const currentWs = workspaces.find(w => w.name === projectInfo.root);
      const wsKey = currentWs?.key || "";
      const wsName = currentWs?.name || projectInfo.root;

      for (const id of pendingSessions) {
        const session = sessions.find(s => s.id === id);
        if (session) {
          infos.push({
            id,
            name: session.name,
            wsKey,
            wsName,
          });
        }
      }

      pendingSessionInfos.value = infos;
      bannerVisible.value = true;
    }
  }
});

function onBannerNavigate(sessionId: string, wsKey: string) {
  bannerVisible.value = false;
  clearPending([sessionId]);
  sidebarRef.value?.selectSessionFromWorkspace(wsKey, sessionId);
}

function onBannerDismiss() {
  bannerVisible.value = false;
  clearPending();
}

function onLeftResizeStart(e: MouseEvent) {
  isDraggingLeft.value = true;
  const startX = e.clientX;
  const startWidth = leftWidth.value;
  const onMove = (ev: MouseEvent) => {
    leftWidth.value = Math.max(200, Math.min(450, startWidth + ev.clientX - startX));
  };
  const onUp = () => {
    isDraggingLeft.value = false;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function onRightResizeStart(e: MouseEvent) {
  isDraggingRight.value = true;
  const startX = e.clientX;
  const startWidth = rightWidth.value;
  const onMove = (ev: MouseEvent) => {
    rightWidth.value = Math.max(200, Math.min(500, startWidth - ev.clientX + startX));
  };
  const onUp = () => {
    isDraggingRight.value = false;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function onChangeLogResizeStart(e: MouseEvent) {
  isDraggingChangeLog.value = true;
  const startY = e.clientY;
  const startHeight = changeLogHeight.value;
  const onMove = (ev: MouseEvent) => {
    changeLogHeight.value = Math.max(100, Math.min(600, startHeight + ev.clientY - startY));
  };
  const onUp = () => {
    isDraggingChangeLog.value = false;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function onSessionChanged(id: string) {
  activeSessionId.value = id;
}

async function onSessionUpdated(newId?: string) {
  if (newId) {
    // Migration: swap the placeholder entry in-place instead of reloading
    // the entire list (avoids the loading indicator flash).
    const oldId = activeSessionId.value;
    activeSessionId.value = newId;
    await nextTick();
    await sidebarRef.value?.migrateSession(oldId, newId);
  } else {
    await sidebarRef.value?.loadSessions();
  }
}

async function onSidebarWsChanged(path: string) {
  workspacePath.value = path;
  projectName.value = path.split(/[\\/]/).filter(Boolean).pop() || path;
  activeSessionId.value = "";
  await fileTreeRef.value?.loadRoot();
  if (rightTab.value === "git") gitPanelRef.value?.reload();
}

const { setActiveProvider, load: loadProviders } = useProviders();

async function onProviderSwitch(providerId: string) {
  await setActiveProvider(providerId);
  const sid = activeSessionId.value;
  if (sid) {
    terminalPanelRef.value?.restartSession(sid);
  }
}

function openSettingsProviders() {
  settingsInitialTab.value = "providers";
  settingsVisible.value = true;
}

function openSettings() {
  settingsInitialTab.value = undefined;
  settingsVisible.value = true;
}

function handleKeydown(e: KeyboardEvent) {
  // ── App-level shortcuts (fire regardless of focus, including inside xterm.js) ──

  // Ctrl+`: toggle workbench terminal — checked FIRST, before any potentially-
  // throwing settings lookups. Use e.code (physical key, layout-independent)
  // rather than e.key (which Ctrl may alter on some platforms).
  if (e.ctrlKey && (e.code === "Backquote" || e.key === "`")) {
    e.preventDefault();
    e.stopPropagation();
    wb.toggle(workspacePath.value);
    return;
  }

  const searchShortcut = settings.keybindings?.searchOpen || "Ctrl+P";

  // Search open (configurable, default Ctrl+P) — highest priority
  if (matchShortcut(e, searchShortcut)) {
    e.preventDefault();
    e.stopPropagation();
    titleBarRef.value?.searchBox?.open();
    return;
  }

  // Esc: collapse workbench if visible (but don't steal from other overlays)
  if (e.key === "Escape" && wb.visible.value && !settingsVisible.value) {
    wb.hide();
    return;
  }
  // Ctrl+N: new session
  if (e.ctrlKey && (e.code === "KeyN" || e.key === "n")) {
    e.preventDefault();
    e.stopPropagation();
    sidebarRef.value?.newSession();
  }
}

onMounted(async () => {
  window.addEventListener("keydown", handleKeydown, { capture: true });

  // Load persisted settings
  const { load: loadSettings } = useSettings();
  await loadSettings();

  // Load provider configuration
  await loadProviders();

  // Start tracking window focus for notifications
  const { init: initWindowFocus } = useWindowFocus();
  initWindowFocus();

  // Initialize notification watcher
  useNotification();

  // Start git fingerprint watcher (auto-refresh on external changes)
  useGitWatcher();

  // Seed workbench cwd from the current project root.
  try {
    const info = await api.getProjectInfo();
    if (info?.root) { workspacePath.value = info.root; projectName.value = info.name; }
  } catch (_) { /* best effort */ }

  // Initialize search providers for the title bar search box
  const { initProviders: initSearchProviders } = useSearchProviders();
  initSearchProviders(
    async () => {
      try { return await api.listSessions(); } catch { return []; }
    },
    (sessionId) => { activeSessionId.value = sessionId; },
    () => workspacePath.value,
  );
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeydown, { capture: true });
  wb.dispose();
});
</script>

<template>
  <div class="app-shell">
    <TitleBar ref="titleBarRef" />

    <div class="app-layout">
      <!-- Notification banner for completed sessions -->
    <NotificationBanner
      :sessions="pendingSessionInfos"
      :visible="bannerVisible"
      @navigate="onBannerNavigate"
      @dismiss="onBannerDismiss"
    />

    <!-- Left panel -->
    <div class="panel-left" :class="{ collapsed: leftCollapsed }" :style="{ width: leftCollapsed ? '10px' : leftWidth + 'px' }">
      <div
        class="collapse-toggle collapse-toggle-left"
        :title="leftCollapsed ? '展开侧栏' : '收起侧栏'"
        @click.stop="leftCollapsed = !leftCollapsed"
      >
        <span class="collapse-arrow">{{ leftCollapsed ? '▶' : '◀' }}</span>
      </div>
      <SidebarLeft v-show="!leftCollapsed" ref="sidebarRef" :active-session-id="activeSessionId" @session-changed="onSessionChanged" @workspace-changed="onSidebarWsChanged" @open-settings="openSettings" @open-workbench="wb.toggle(workspacePath)" @provider-switch="onProviderSwitch" @open-settings-providers="openSettingsProviders" />
    </div>

    <!-- Resize handle left -->
    <div
      v-show="!leftCollapsed"
      class="resize-handle"
      :class="{ active: isDraggingLeft }"
      @mousedown="onLeftResizeStart"
    />

    <!-- Center panel -->
    <div class="panel-center">
      <TerminalPanel ref="terminalPanelRef" :session-id="activeSessionId" @session-updated="onSessionUpdated" />
    </div>

    <!-- Resize handle right -->
    <div
      v-show="!rightCollapsed"
      class="resize-handle"
      :class="{ active: isDraggingRight }"
      @mousedown="onRightResizeStart"
    />

    <!-- Right panel -->
    <div class="panel-right" :class="{ collapsed: rightCollapsed }" :style="{ width: rightCollapsed ? '10px' : rightWidth + 'px' }">
      <div
        class="collapse-toggle collapse-toggle-right"
        :title="rightCollapsed ? '展开侧栏' : '收起侧栏'"
        @click.stop="rightCollapsed = !rightCollapsed"
      >
        <span class="collapse-arrow">{{ rightCollapsed ? '◀' : '▶' }}</span>
      </div>
      <div v-show="!rightCollapsed" class="panel-right-inner">
      <!-- Tab bar -->
      <div class="right-tab-bar">
        <button
          class="right-tab"
          :class="{ active: rightTab === 'files' }"
          @click="rightTab = 'files'"
        >
          <span class="right-tab-icon">📁</span>
          <span class="right-tab-label">{{ projectName || "项目" }}</span>
        </button>
        <button
          class="right-tab"
          :class="{ active: rightTab === 'git' }"
          @click="rightTab = 'git'"
        >
          <span class="right-tab-icon">⎇</span>
          <span class="right-tab-label">Git</span>
          <span v-if="hasChanges" class="right-tab-badge">{{ unstagedFiles.length }}</span>
        </button>
      </div>

      <!-- Files tab: FileTree + ChangeLog -->
      <div v-show="rightTab === 'files'" class="tab-content">
        <FileTree ref="fileTreeRef" :session-id="activeSessionId" />
        <div
          v-show="!changeLogCollapsed"
          class="resize-handle-h"
          :class="{ active: isDraggingChangeLog }"
          @mousedown="onChangeLogResizeStart"
        />
        <ChangeLogPanel :session-id="activeSessionId" :style="{ height: changeLogCollapsed ? 'auto' : changeLogHeight + 'px' }" @collapse-changed="(v) => changeLogCollapsed = v" />
      </div>

      <div v-show="rightTab === 'git'" class="tab-content">
        <GitPanel ref="gitPanelRef" />
      </div>
      </div> <!-- .panel-right-inner -->
    </div>

    <ContextMenu />
    <ModalDialog />
    <SettingsPanel v-if="settingsVisible" :initial-tab="settingsInitialTab" @close="settingsVisible = false" />
    <FileViewer />
    <WorkbenchTerminal :cwd="workspacePath" :height="workbenchHeight" @update:height="onWorkbenchHeightChange" />
    </div>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
}

.app-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  width: 100%;
  background-color: var(--bg-primary);
  user-select: none;
}

.panel-left {
  flex-shrink: 0;
  height: 100%;
  background-color: var(--bg-secondary);
  border-right: 1px solid var(--surface);
  display: flex;
  flex-direction: column;
  position: relative;
  transition: width 0.2s ease;
  overflow: hidden;
}

.panel-center {
  flex: 1;
  height: 100%;
  min-width: 400px;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-primary);
}

.panel-right {
  flex-shrink: 0;
  height: 100%;
  background-color: var(--bg-secondary);
  border-left: 1px solid var(--surface);
  display: flex;
  flex-direction: column;
  position: relative;
  transition: width 0.2s ease;
  overflow: hidden;
}

.resize-handle {
  width: 3px;
  cursor: col-resize;
  background-color: transparent;
  transition: background-color 0.15s;
  flex-shrink: 0;
  z-index: 10;
}

.resize-handle:hover,
.resize-handle.active {
  background-color: var(--accent);
}

.resize-handle-h {
  height: 3px;
  cursor: row-resize;
  background-color: transparent;
  transition: background-color 0.15s;
  flex-shrink: 0;
  z-index: 10;
}

.resize-handle-h:hover,
.resize-handle-h.active {
  background-color: var(--accent);
}

/* ── Collapse toggles (hover-reveal centered strip) ── */

.panel-right-inner {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.tab-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.collapse-toggle {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 20px;          /* wide invisible hover target */
  height: clamp(72px, 15%, 180px);
  display: flex;
  align-items: center;
  cursor: pointer;
  z-index: 20;
  opacity: 0;
  transition: opacity 0.2s;
}

/* Visible strip (pseudo-element inside the 20px hover zone) */
.collapse-toggle::before {
  content: '';
  position: absolute;
  top: 0;
  width: 10px;
  height: 100%;
  background: var(--surface);
  border-radius: 3px;
  transition: background-color 0.15s;
}

.collapse-toggle:hover {
  opacity: 1;
}

.collapse-toggle:hover::before {
  background: var(--surface-hover);
}

/* Left toggle: arrow hugs right edge so it stays visible when collapsed */
.collapse-toggle-left {
  right: 0;
  justify-content: flex-end;
}

.collapse-toggle-left::before {
  right: 0;
  border-radius: 3px 0 0 3px;
}

/* Right toggle: arrow hugs left edge so it stays visible when collapsed */
.collapse-toggle-right {
  left: 0;
  justify-content: flex-start;
}

.collapse-toggle-right::before {
  left: 0;
  border-radius: 0 3px 3px 0;
}

.collapse-arrow {
  position: relative;
  z-index: 1;
  font-size: 10px;
  color: var(--text-muted);
  transition: color 0.15s;
  line-height: 1;
  pointer-events: none;
  margin: 0 1px;
}

.collapse-toggle:hover .collapse-arrow {
  color: var(--text-primary);
}

/* Always visible when panel is collapsed (user needs to find the expand button) */
.panel-left.collapsed .collapse-toggle,
.panel-right.collapsed .collapse-toggle {
  opacity: 1;
}

/* ── Right panel tab bar ── */

.right-tab-bar {
  display: flex;
  border-bottom: 1px solid var(--surface);
  flex-shrink: 0;
  background: var(--bg-tertiary);
}

.right-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 0;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 11.5px;
  font-family: inherit;
  transition: all 0.12s;
}

.right-tab:hover {
  color: var(--text-secondary);
  background: var(--surface);
}

.right-tab.active {
  color: var(--text-primary);
  border-bottom-color: var(--accent);
}

.right-tab-icon {
  font-size: 13px;
}

.right-tab-label {
  font-weight: 500;
}

.right-tab-badge {
  background: var(--accent);
  color: #1e1e2e;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 8px;
  min-width: 14px;
  text-align: center;
  line-height: 1.4;
}
</style>
