<script setup lang="ts">
import SidebarLeft from "./components/SidebarLeft.vue";
import TerminalPanel from "./components/TerminalPanel.vue";
import FileTree from "./components/FileTree.vue";
import ChangeLogPanel from "./components/ChangeLogPanel.vue";
import ContextMenu from "./components/ContextMenu.vue";
import ModalDialog from "./components/ModalDialog.vue";
import { defineAsyncComponent } from "vue";
const FileViewer = defineAsyncComponent(() => import("./components/FileViewer.vue"));
const SettingsPanel = defineAsyncComponent(() => import("./components/SettingsPanel.vue"));
import GitPanel from "./components/GitPanel.vue";
import WorkbenchTerminal from "./components/WorkbenchTerminal.vue";
import NotificationBanner from "./components/NotificationBanner.vue";
import TitleBar from "./components/titlebar/TitleBar.vue";
import ACommandPalette from "./ui/ACommandPalette.vue";
import { ATabBar } from "./ui";
import type { Tab } from "./ui";
import { useResizable } from "./composables/useResizable";
import { useConversationChanges } from "./composables/useConversationChanges";
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
import { useRunProject } from "./composables/useRunProject";
import { matchShortcut } from "./utils/shortcut";
import { applyTheme, themes } from "./themes";

const leftCollapsed = ref(false);
const rightCollapsed = ref(false);
const rightTab = ref<"files" | "changes" | "git">("files");
const { unstagedFiles, hasChanges, loadStatus, currentBranch } = useGit();

// Session activity for titlebar
import { useSessionState, type SessionStatus } from "./composables/useSessionState";
export interface ActiveSessionInfo {
  id: string;
  name: string;
  status: SessionStatus;
  wsKey: string;
}
const { state: sessionStateMap } = useSessionState();
const activeSessionList = computed<ActiveSessionInfo[]>(() => {
  const allSessions = sidebarRef.value?.sessionsByWorkspace ?? {};
  const lookup = new Map<string, { name: string; wsKey: string }>();
  for (const [wsKey, list] of Object.entries(allSessions)) {
    for (const s of list) lookup.set(s.id, { name: s.name, wsKey });
  }
  const result: ActiveSessionInfo[] = [];
  for (const [id, status] of Object.entries(sessionStateMap)) {
    if (status === "stopped") continue;
    const info = lookup.get(id);
    result.push({
      id,
      name: info?.name || (id.startsWith("new_") ? "新会话" : id.slice(0, 8)),
      status,
      wsKey: info?.wsKey || "",
    });
  }
  result.sort((a, b) => {
    const order: Record<string, number> = { running: 0, attention: 1, waiting: 2 };
    return (order[a.status] ?? 3) - (order[b.status] ?? 3);
  });
  return result;
});

const leftResize = useResizable({
  cssVar: "--aide-left-w",
  initial: 280,
  min: 220,
  max: 450,
  direction: "left",
});

const rightResize = useResizable({
  cssVar: "--aide-right-w",
  initial: 300,
  min: 280,
  max: 500,
  direction: "right",
});
const sidebarRef = ref<InstanceType<typeof SidebarLeft> | null>(null);
const fileTreeRef = ref<InstanceType<typeof FileTree> | null>(null);
const gitPanelRef = ref<InstanceType<typeof GitPanel> | null>(null);
const titleBarRef = ref<InstanceType<typeof TitleBar> | null>(null);
const paletteOpen = ref(false);
const paletteRef = ref<InstanceType<typeof ACommandPalette> | null>(null);
const activeSessionId = ref("");
const settingsVisible = ref(false);
const settingsInitialTab = ref<string | undefined>(undefined);
const terminalPanelRef = ref<InstanceType<typeof TerminalPanel> | null>(null);
const workspacePath = ref("");
const projectName = ref("");
const { settings, update: updateSettings } = useSettings();
const workbenchHeight = ref(settings.workbenchHeight || Math.floor(window.innerHeight * 0.45));
const wb = useWorkbenchTerminal();
const { run: runProject } = useRunProject();

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

// ── Conversation changes badge for the "changes" tab ──
const { rounds } = useConversationChanges(() => activeSessionId.value);
const changeCount = computed(() => {
  let n = 0;
  for (const r of rounds.value) n += r.files.length;
  return n;
});

const tabIconFiles = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7c0-1.1.9-2 2-2h4.6L12 7h7c1.1 0 2 .9 2 2v8c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V7z"/></svg>';
const tabIconChanges = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
const tabIconGit = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';

const rightTabs = computed<Tab[]>(() => [
  { id: "files", label: "文件", icon: tabIconFiles },
  { id: "changes", label: "变更", icon: tabIconChanges, badge: changeCount.value || undefined },
  { id: "git", label: "Git", icon: tabIconGit, badge: unstagedFiles.value.length || undefined },
]);

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
  terminalPanelRef.value?.resetView();
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

function onRunProject() {
  runProject(workspacePath.value);
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
    paletteOpen.value = true;
    return;
  }

  // Esc: collapse workbench if visible (but don't steal from other overlays)
  if (e.key === "Escape" && wb.visible.value && !settingsVisible.value && !paletteOpen.value) {
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
  // Apply default theme before any rendering
  applyTheme(themes["warm-dark"]);

  window.addEventListener("keydown", handleKeydown, { capture: true });

  // Load persisted settings
  const { load: loadSettings } = useSettings();
  await loadSettings();

  // Apply persisted theme (overrides the default warm-dark if user chose differently)
  const themeId = settings.theme || "warm-dark";
  const themeTokens = themes[themeId] || themes["warm-dark"];
  applyTheme(themeTokens);

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
  const { initProviders: initSearchProviders, search: searchProviders } = useSearchProviders();
  initSearchProviders(
    async () => {
      try { return await api.listSessions(); } catch { return []; }
    },
    (sessionId) => { activeSessionId.value = sessionId; },
    () => workspacePath.value,
  );

  // Wire the search function into the palette
  nextTick(() => {
    paletteRef.value?.setSearchFn(async (q: string, limit: number) => {
      const rawResults = await searchProviders(q, limit);
      return rawResults.map((r) => ({
        ...r,
        group: r.icon === "\u{1F4DD}" ? "会话" : r.icon === "\u{1F4C4}" ? "文件" : "其他",
      }));
    });
  });
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeydown, { capture: true });
  wb.dispose();
});
</script>

<template>
  <div class="app-shell">
    <TitleBar
      ref="titleBarRef"
      :project-name="projectName"
      :git-branch="currentBranch"
      :active-sessions="activeSessionList"
      @open-palette="paletteOpen = true"
      @select-session="(s) => sidebarRef?.selectSessionFromWorkspace(s.wsKey, s.id)"
      @run-project="onRunProject"
    />

    <div class="app-layout" :class="{ 'is-dragging': leftResize.isDragging.value || rightResize.isDragging.value }">
      <NotificationBanner
        :sessions="pendingSessionInfos"
        :visible="bannerVisible"
        @navigate="onBannerNavigate"
        @dismiss="onBannerDismiss"
      />

      <!-- Left panel -->
      <div class="panel-left" :class="{ collapsed: leftCollapsed }">
        <div
          class="collapse-toggle collapse-toggle-left"
          v-tooltip="leftCollapsed ? '展开侧栏' : '收起侧栏'"
          @click.stop="leftCollapsed = !leftCollapsed"
        >
          <svg class="collapse-arrow-svg" :style="{ transform: leftCollapsed ? 'rotate(0deg)' : 'rotate(180deg)' }" width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3.5 1.5L7 5L3.5 8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <SidebarLeft
          v-show="!leftCollapsed"
          ref="sidebarRef"
          :active-session-id="activeSessionId"
          @session-changed="onSessionChanged"
          @workspace-changed="onSidebarWsChanged"
          @open-settings="openSettings"
          @open-workbench="wb.toggle(workspacePath)"
          @provider-switch="onProviderSwitch"
          @open-settings-providers="openSettingsProviders"
        />
      </div>

      <!-- Left resize handle -->
      <div
        v-show="!leftCollapsed"
        class="resize-handle"
        :class="{ active: leftResize.isDragging.value }"
        @mousedown="leftResize.onMousedown"
      />

      <!-- Center panel -->
      <div class="panel-center">
        <TerminalPanel
          ref="terminalPanelRef"
          :session-id="activeSessionId"
          :workspace-path="workspacePath"
          @session-updated="onSessionUpdated"
        />
      </div>

      <!-- Right resize handle -->
      <div
        v-show="!rightCollapsed"
        class="resize-handle"
        :class="{ active: rightResize.isDragging.value }"
        @mousedown="rightResize.onMousedown"
      />

      <!-- Right panel -->
      <div class="panel-right" :class="{ collapsed: rightCollapsed }">
        <div
          class="collapse-toggle collapse-toggle-right"
          v-tooltip="rightCollapsed ? '展开侧栏' : '收起侧栏'"
          @click.stop="rightCollapsed = !rightCollapsed"
        >
          <svg class="collapse-arrow-svg" :style="{ transform: rightCollapsed ? 'rotate(180deg)' : 'rotate(0deg)' }" width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3.5 1.5L7 5L3.5 8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <div v-show="!rightCollapsed" class="panel-right-inner">
          <ATabBar :tabs="rightTabs" v-model="rightTab" />

          <div class="tab-content">
            <FileTree v-show="rightTab === 'files'" ref="fileTreeRef" :session-id="activeSessionId" />
            <ChangeLogPanel v-show="rightTab === 'changes'" :session-id="activeSessionId" />
            <GitPanel v-show="rightTab === 'git'" ref="gitPanelRef" />
          </div>
        </div>
      </div>

      <ContextMenu />
      <ModalDialog />
      <SettingsPanel v-if="settingsVisible" :initial-tab="settingsInitialTab" @close="settingsVisible = false" />
      <FileViewer />
      <WorkbenchTerminal :cwd="workspacePath" :height="workbenchHeight" @update:height="onWorkbenchHeightChange" />
    </div>

    <ACommandPalette
      ref="paletteRef"
      :open="paletteOpen"
      @close="paletteOpen = false"
    />
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
  display: grid;
  grid-template-columns:
    var(--aide-left-w, 280px)
    1px
    minmax(400px, 1fr)
    1px
    var(--aide-right-w, 300px);
  grid-template-rows: 1fr;
  flex: 1;
  min-height: 0;
  width: 100%;
  background-color: var(--aide-bg-base);
  user-select: none;
}

.app-layout.is-dragging {
  user-select: none;
  cursor: col-resize;
}

.panel-left {
  height: 100%;
  background-color: var(--aide-bg-deep);
  border-right: 1px solid var(--aide-border);
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
  min-width: 0;
}

.panel-left.collapsed {
  width: 10px !important;
  min-width: 10px;
}

.panel-center {
  height: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background-color: var(--aide-bg-base);
}

.panel-right {
  height: 100%;
  background-color: var(--aide-bg-deep);
  border-left: 1px solid var(--aide-border);
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
  min-width: 0;
}

.panel-right.collapsed {
  width: 10px !important;
  min-width: 10px;
}

.resize-handle {
  width: 1px;
  background: var(--aide-border);
  cursor: col-resize;
  position: relative;
  transition: background 0.15s ease;
}

.resize-handle::after {
  content: '';
  position: absolute;
  left: -3px;
  right: -3px;
  top: 0;
  bottom: 0;
}

.resize-handle:hover,
.resize-handle.active {
  background: var(--aide-accent);
  box-shadow: 0 0 8px color-mix(in srgb, var(--aide-accent) 20%, transparent);
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
  width: 20px;
  height: clamp(72px, 15%, 180px);
  display: flex;
  align-items: center;
  cursor: pointer;
  z-index: 20;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.collapse-toggle::before {
  content: '';
  position: absolute;
  top: 0;
  width: 10px;
  height: 100%;
  background: var(--aide-surface-default);
  border-radius: 3px;
  transition: background-color 0.15s ease;
}

.collapse-toggle:hover {
  opacity: 1;
}

.collapse-toggle:hover::before {
  background: var(--aide-surface-hover);
}

.collapse-toggle-left {
  right: 0;
  justify-content: flex-end;
}

.collapse-toggle-left::before {
  right: 0;
  border-radius: 3px 0 0 3px;
}

.collapse-toggle-right {
  left: 0;
  justify-content: flex-start;
}

.collapse-toggle-right::before {
  left: 0;
  border-radius: 0 3px 3px 0;
}

.collapse-arrow-svg {
  position: relative;
  z-index: 1;
  color: var(--aide-text-muted);
  transition: color 0.15s ease, transform 0.2s ease;
  pointer-events: none;
  margin: 0 2px;
}

.collapse-toggle:hover .collapse-arrow-svg {
  color: var(--aide-text-primary);
}

.panel-left.collapsed .collapse-toggle,
.panel-right.collapsed .collapse-toggle {
  opacity: 1;
}
</style>
