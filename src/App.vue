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
import { useWorkbenchTerminal } from "./composables/useWorkbenchTerminal";
import { api } from "./api";
import { ref, onMounted, onUnmounted, nextTick, watch, computed } from "vue";
import { useSettings } from "./composables/useSettings";
import { useWindowFocus } from "./composables/useWindowFocus";
import { useNotification, pendingSessions, clearPending } from "./composables/useNotification";
import { useGit } from "./composables/useGit";

const leftWidth = ref(280);
const rightWidth = ref(300);
const changeLogHeight = ref(220);
const changeLogCollapsed = ref(false);
const rightTab = ref<"files" | "git">("files");
const { unstagedFiles, hasChanges, loadStatus } = useGit();
const isDraggingLeft = ref(false);
const isDraggingRight = ref(false);
const isDraggingChangeLog = ref(false);
const sidebarRef = ref<InstanceType<typeof SidebarLeft> | null>(null);
const fileTreeRef = ref<InstanceType<typeof FileTree> | null>(null);
const gitPanelRef = ref<InstanceType<typeof GitPanel> | null>(null);
const activeSessionId = ref("");
const settingsVisible = ref(false);
const workspacePath = ref("");
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
    changeLogHeight.value = Math.max(100, Math.min(500, startHeight - ev.clientY + startY));
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

async function onFileTreeWsChanged(path: string) {
  workspacePath.value = path;
  activeSessionId.value = "";
  await sidebarRef.value?.loadSessions();
  if (rightTab.value === "git") gitPanelRef.value?.reload();
}

async function onSidebarWsChanged(path: string) {
  workspacePath.value = path;
  activeSessionId.value = "";
  await fileTreeRef.value?.loadRoot();
  if (rightTab.value === "git") gitPanelRef.value?.reload();
}

function handleKeydown(e: KeyboardEvent) {
  // Ctrl+`: toggle workbench terminal
  if (e.ctrlKey && e.key === "`") {
    e.preventDefault();
    wb.toggle(workspacePath.value);
    return;
  }
  // Esc: collapse workbench if visible (but don't steal from other overlays)
  if (e.key === "Escape" && wb.visible.value && !settingsVisible.value) {
    wb.hide();
    return;
  }
  // Ctrl+N: new session
  if (e.ctrlKey && e.key === "n") {
    e.preventDefault();
    sidebarRef.value?.newSession();
  }
}

onMounted(async () => {
  window.addEventListener("keydown", handleKeydown);

  // Load persisted settings
  const { load: loadSettings } = useSettings();
  await loadSettings();

  // Start tracking window focus for notifications
  const { init: initWindowFocus } = useWindowFocus();
  initWindowFocus();

  // Initialize notification watcher
  useNotification();

  // Seed workbench cwd from the current project root.
  try {
    const info = await api.getProjectInfo();
    if (info?.root) workspacePath.value = info.root;
  } catch (_) { /* best effort */ }
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeydown);
  wb.dispose();
});
</script>

<template>
  <div class="app-layout">
    <!-- Notification banner for completed sessions -->
    <NotificationBanner
      :sessions="pendingSessionInfos"
      :visible="bannerVisible"
      @navigate="onBannerNavigate"
      @dismiss="onBannerDismiss"
    />

    <!-- Left panel -->
    <div class="panel-left" :style="{ width: leftWidth + 'px' }">
      <SidebarLeft ref="sidebarRef" :active-session-id="activeSessionId" @session-changed="onSessionChanged" @workspace-changed="onSidebarWsChanged" @open-settings="() => settingsVisible = true" @open-workbench="wb.toggle(workspacePath)" />
    </div>

    <!-- Resize handle left -->
    <div
      class="resize-handle"
      :class="{ active: isDraggingLeft }"
      @mousedown="onLeftResizeStart"
    />

    <!-- Center panel -->
    <div class="panel-center">
      <TerminalPanel :session-id="activeSessionId" @session-updated="onSessionUpdated" />
    </div>

    <!-- Resize handle right -->
    <div
      class="resize-handle"
      :class="{ active: isDraggingRight }"
      @mousedown="onRightResizeStart"
    />

    <!-- Right panel -->
    <div class="panel-right" :style="{ width: rightWidth + 'px' }">
      <!-- Tab bar -->
      <div class="right-tab-bar">
        <button
          class="right-tab"
          :class="{ active: rightTab === 'files' }"
          @click="rightTab = 'files'"
        >
          <span class="right-tab-icon">📁</span>
          <span class="right-tab-label">文件</span>
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
      <template v-if="rightTab === 'files'">
        <FileTree ref="fileTreeRef" :session-id="activeSessionId" @workspace-changed="onFileTreeWsChanged" />
        <div
          v-show="!changeLogCollapsed"
          class="resize-handle-h"
          :class="{ active: isDraggingChangeLog }"
          @mousedown="onChangeLogResizeStart"
        />
        <ChangeLogPanel :session-id="activeSessionId" :style="{ height: changeLogCollapsed ? 'auto' : changeLogHeight + 'px' }" @collapse-changed="(v) => changeLogCollapsed = v" />
      </template>

      <template v-else>
        <GitPanel ref="gitPanelRef" />
      </template>
    </div>

    <ContextMenu />
    <ModalDialog />
    <SettingsPanel v-if="settingsVisible" @close="settingsVisible = false" />
    <FileViewer />
    <WorkbenchTerminal :cwd="workspacePath" :height="workbenchHeight" @update:height="onWorkbenchHeightChange" />
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  height: 100%;
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
