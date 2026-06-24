<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useContextMenu } from "../composables/useContextMenu";
import { useSessionState } from "../composables/useSessionState";
import { useUpdate } from "../composables/useUpdate";
import { useProviders } from "../composables/useProviders";
import { sessionMenuItems } from "../menus/contextMenus";
import { api } from "../api";
import { open } from "@tauri-apps/plugin-shell";
import { getVersion } from "@tauri-apps/api/app";
import { ACard, AStatusDot } from "../ui";
import type { Session, WorkspaceInfo } from "../types";

const props = defineProps<{
  activeSessionId: string;
}>();

const emit = defineEmits<{
  "session-changed": [id: string];
  "workspace-changed": [path: string];
  "open-settings": [];
  "open-workbench": [];
  "provider-switch": [providerId: string];
  "open-settings-providers": [];
}>();

const sessionsByWorkspace = ref<Record<string, Session[]>>({});
const workspaces = ref<WorkspaceInfo[]>([]);
const activeWorkspace = ref("");
const expandedWorkspaces = ref(new Set<string>());
const searchQuery = ref("");
const loading = ref(true);

// Current active workspace's sessions (backward compat for external callers)
const sessions = computed(() => sessionsByWorkspace.value[activeWorkspace.value] ?? []);

function workspaceLabel(ws: WorkspaceInfo): string {
  const parts = ws.name.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || ws.name;
}

const filteredWorkspaces = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return workspaces.value;
  return workspaces.value.filter(
    (ws) => workspaceLabel(ws).toLowerCase().includes(q) || ws.name.toLowerCase().includes(q),
  );
});

// Sessions for a specific workspace (for template use, respects search filter)
function wsSessions(wsKey: string): Session[] {
  const list = sessionsByWorkspace.value[wsKey] ?? [];
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (s) => s.name.toLowerCase().includes(q) || s.last_message.toLowerCase().includes(q),
  );
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}天前`;
  return `${Math.floor(days / 7)}周前`;
}

async function loadWorkspaces() {
  try {
    workspaces.value = await api.listWorkspaces();
  } catch (_e) {
    workspaces.value = [];
  }
}

async function loadSessions() {
  loading.value = true;
  const wsKey = activeWorkspace.value;

  // Save the active placeholder session so it survives the refresh
  const currentList = sessionsByWorkspace.value[wsKey] ?? [];
  const activePlaceholder = (props.activeSessionId?.startsWith("new_"))
    ? currentList.find(s => s.id === props.activeSessionId)
    : null;

  try {
    const loaded = await api.listSessions();
    const filtered = loaded.filter(s => !s.id.startsWith("new_"));
    if (activePlaceholder) {
      filtered.unshift(activePlaceholder);
    }
    sessionsByWorkspace.value[wsKey] = filtered;
  } catch (_e) {
    sessionsByWorkspace.value[wsKey] = [];
  }

  loading.value = false;

  const list = sessionsByWorkspace.value[wsKey] ?? [];
  if (list.length === 0) {
    await newSession();
    return;
  }
  if (!props.activeSessionId || props.activeSessionId.startsWith("new_")) {
    emit("session-changed", list[0].id);
  }
}

// Load sessions for a specific (non-active) workspace
async function loadWsSessions(wsKey: string) {
  try {
    const loaded = await api.listSessionsForWorkspace(wsKey);
    sessionsByWorkspace.value[wsKey] = loaded;
  } catch (_e) {
    sessionsByWorkspace.value[wsKey] = [];
  }
}

const { show } = useContextMenu();
const { state: sessionState } = useSessionState();
const { updateAvailable, latestVersion, downloadUrl, dismissUpdate } = useUpdate();

// ── Provider selector ──
const {
  displayList: providerDisplayList,
  activeProviderId,
  activeProvider,
  setActiveProvider,
  SYSTEM_DEFAULT_ID,
} = useProviders();
const providerDropdownOpen = ref(false);
const providerSelectorRef = ref<HTMLDivElement | null>(null);

function toggleProviderDropdown() {
  providerDropdownOpen.value = !providerDropdownOpen.value;
}

async function onProviderSelect(id: string) {
  providerDropdownOpen.value = false;
  if (id === activeProviderId.value) return;

  const sid = props.activeSessionId;
  if (sid) {
    try {
      const hasSession = await api.ptyHasSession(sid);
      if (hasSession) {
        emit("provider-switch", id);
        return;
      }
    } catch { /* ignore */ }
  }
  await setActiveProvider(id);
}

function onProviderClickOutside(e: MouseEvent) {
  if (providerSelectorRef.value && !providerSelectorRef.value.contains(e.target as Node)) {
    providerDropdownOpen.value = false;
  }
}


// Select a session from a potentially different workspace
async function selectSessionFromWorkspace(wsKey: string, sessionId: string) {
  if (wsKey !== activeWorkspace.value) {
    // Switch to the workspace first
    const ws = workspaces.value.find(w => w.key === wsKey);
    if (ws) {
      try {
        await api.setWorkspace(ws.key, ws.name);
      } catch (_e) { return; }
      activeWorkspace.value = ws.key;
      emit("workspace-changed", ws.name);
      // Load sessions for the new active workspace if not already loaded
      if (!sessionsByWorkspace.value[wsKey]) {
        await loadSessions();
      }
    }
  }
  emit("session-changed", sessionId);
}

function openUpdate() {
  if (downloadUrl.value) open(downloadUrl.value);
}

async function switchWorkspace(ws: WorkspaceInfo) {
  const isCurrentActive = ws.key === activeWorkspace.value;

  if (isCurrentActive) {
    // Clicking the active workspace: toggle expand/collapse
    if (expandedWorkspaces.value.has(ws.key)) {
      expandedWorkspaces.value.delete(ws.key);
    } else {
      expandedWorkspaces.value.add(ws.key);
    }
    return;
  }

  // Clicking a non-active workspace: switch to it + expand
  // (old workspace stays expanded if it was expanded before)
  try {
    await api.setWorkspace(ws.key, ws.name);
  } catch (_e) { return; }
  activeWorkspace.value = ws.key;
  expandedWorkspaces.value.add(ws.key);
  emit("workspace-changed", ws.name);
  await loadSessions();
}

async function renameSession(id: string, name: string) {
  try {
    await api.renameSession(id, name);
    await loadSessions();
  } catch (_e) { /* ignore */ }
}

function onSessionContextMenu(e: MouseEvent, id: string) {
  e.preventDefault();
  show(
    e.clientX,
    e.clientY,
    sessionMenuItems(id, (name: string) => renameSession(id, name), loadSessions),
  );
}

async function newSession() {
  const wsKey = activeWorkspace.value;
  const name = `新会话 ${new Date().toLocaleTimeString()}`;
  try {
    const s = await api.createSession(name);
    const list = sessionsByWorkspace.value[wsKey] ?? [];
    list.unshift(s);
    sessionsByWorkspace.value[wsKey] = list;
    emit("session-changed", s.id);
  } catch (_e) {
    const s: Session = {
      id: Date.now().toString(),
      name,
      timestamp: Date.now(),
      last_message: "",
    };
    const list = sessionsByWorkspace.value[wsKey] ?? [];
    list.unshift(s);
    sessionsByWorkspace.value[wsKey] = list;
    emit("session-changed", s.id);
  }
}

onUnmounted(() => {
  document.removeEventListener("click", onProviderClickOutside);
});

onMounted(async () => {
  document.addEventListener("click", onProviderClickOutside);
  await loadWorkspaces();
  // Find active workspace: match by encoded key derived from get_project_info
  try {
    const info = await api.getProjectInfo();
    for (const ws of workspaces.value) {
      if (ws.name === info.root) {
        activeWorkspace.value = ws.key;
        expandedWorkspaces.value.add(ws.key);
        break;
      }
    }
  } catch (_) { /* ignore */ }
  await loadSessions();

  try {
    const { checkUpdate } = useUpdate();
    await checkUpdate(await getVersion());
  } catch (_) { /* non-critical */ }
});

/**
 * Replace a placeholder session (new_xxx) with the real session after migration.
 * Does an in-place swap without triggering a full list reload or loading indicator.
 */
async function migrateSession(oldId: string, newId: string) {
  const wsKey = activeWorkspace.value;
  const list = sessionsByWorkspace.value[wsKey] ?? [];
  const idx = list.findIndex(s => s.id === oldId);
  if (idx === -1) return;

  const placeholder = list[idx];

  // Persist the placeholder's custom name under the real session ID,
  // so it survives page reloads (otherwise listSessions returns "未命名"
  // from Claude Code's auto-generated metadata).
  try {
    await api.renameSession(newId, placeholder.name);
  } catch (_) { /* best effort */ }

  try {
    const all = await api.listSessions();
    const real = all.find(s => s.id === newId);
    if (real) {
      real.name = placeholder.name; // use our name, not Claude Code's
      list.splice(idx, 1, real);
      sessionsByWorkspace.value[wsKey] = [...list];
    } else {
      await loadSessions();
    }
  } catch (_) {
    await loadSessions();
  }
}

defineExpose({ newSession, loadSessions, migrateSession, selectSessionFromWorkspace });
</script>

<template>
  <div class="sidebar-left">
    <!-- Header -->
    <div class="sidebar-header">
      <span class="header-title">会话</span>
      <button class="new-btn" @click="newSession" title="新建会话 (Ctrl+N)">
        新 (Ctrl+N)
      </button>
    </div>

    <!-- Workspace + Session list -->
    <div class="session-list">
      <div v-if="loading" class="session-empty muted">加载中...</div>

      <template v-else v-for="ws in filteredWorkspaces" :key="ws.key">
        <!-- Workspace row -->
        <div
          class="workspace-item"
          :class="{ active: ws.key === activeWorkspace, expanded: expandedWorkspaces.has(ws.key) }"
          @click="switchWorkspace(ws)"
        >
          <svg class="ws-chevron" :class="{ expanded: expandedWorkspaces.has(ws.key) }" width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <svg class="ws-folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M3 7C3 5.89543 3.89543 5 5 5H9.58579C9.851 5 10.1054 5.10536 10.2929 5.29289L12 7H19C20.1046 7 21 7.89543 21 9V17C21 18.1046 20.1046 19 19 19H5C3.89543 19 3 18.1046 3 17V7Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span class="ws-name">{{ workspaceLabel(ws) }}</span>
          <span v-if="(sessionsByWorkspace[ws.key] ?? []).length > 0" class="ws-count">{{ (sessionsByWorkspace[ws.key] ?? []).length }}</span>
        </div>

        <!-- Sessions (for any expanded workspace) -->
        <template v-if="expandedWorkspaces.has(ws.key)">
          <div
            v-if="wsSessions(ws.key).length === 0"
            class="session-empty muted"
          >
            暂无会话
          </div>
          <ACard
            v-for="s in wsSessions(ws.key)"
            :key="s.id"
            :active="props.activeSessionId === s.id"
            :glow-color="sessionState[s.id] === 'running' ? 'var(--aide-success)' : undefined"
            class="session-card"
            @click="selectSessionFromWorkspace(ws.key, s.id)"
            @contextmenu.prevent="onSessionContextMenu($event, s.id)"
          >
            <div class="session-card-header">
              <AStatusDot :status="sessionState[s.id] || 'stopped'" />
              <span class="session-name">{{ s.name }}</span>
              <span class="session-time">{{ timeAgo(s.timestamp) }}</span>
            </div>
            <div class="session-preview">{{ s.last_message }}</div>
          </ACard>
        </template>
      </template>
    </div>

    <!-- Update banner -->
    <div v-if="updateAvailable" class="update-banner" @click="openUpdate">
      <div class="update-banner-body">
        <span class="update-dot">●</span>
        <span class="update-text">新版本 {{ latestVersion }}</span>
      </div>
      <button class="update-dismiss" title="忽略" @click.stop="dismissUpdate">✕</button>
    </div>

    <!-- Provider selector -->
    <div ref="providerSelectorRef" class="provider-selector">
      <div class="provider-current" @click="toggleProviderDropdown">
        <span class="provider-icon">{{ activeProvider.icon }}</span>
        <span class="provider-name">{{ activeProvider.name }}</span>
        <span class="provider-arrow">{{ providerDropdownOpen ? '▾' : '▸' }}</span>
      </div>
      <div v-if="providerDropdownOpen" class="provider-dropdown">
        <div
          v-for="p in providerDisplayList"
          :key="p.id"
          class="provider-option"
          :class="{ active: p.id === activeProviderId }"
          @click="onProviderSelect(p.id)"
        >
          <span class="provider-opt-icon">{{ p.icon }}</span>
          <span class="provider-opt-name">{{ p.name }}</span>
          <span v-if="p.id === activeProviderId" class="provider-opt-check">✓</span>
        </div>
        <div class="provider-divider"></div>
        <div class="provider-option" @click="providerDropdownOpen = false; emit('open-settings-providers')">
          <span class="provider-opt-icon">⚙</span>
          <span class="provider-opt-name">管理供应商…</span>
        </div>
      </div>
    </div>

    <!-- Footer: terminal + settings -->
    <div class="sidebar-footer">
      <button class="footer-btn" title="工作台终端 (Ctrl+`)" @click="emit('open-workbench')">
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="4 17 10 11 4 5"/>
          <line x1="12" y1="19" x2="20" y2="19"/>
        </svg>
        <span>终端</span>
        <span class="footer-btn-kbd">⌘`</span>
      </button>
      <button class="footer-btn" title="设置" @click="emit('open-settings')">
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
        <span>设置</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.sidebar-left {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--aide-surface-default);
}

.header-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--aide-text-muted);
}

.new-btn {
  background: var(--aide-accent-subtle);
  border: 1px solid color-mix(in srgb, var(--aide-accent) 20%, transparent);
  color: var(--aide-accent);
  padding: 4px 12px;
  border-radius: var(--aide-radius-sm);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}
.new-btn:hover {
  background: color-mix(in srgb, var(--aide-accent) 20%, transparent);
  border-color: color-mix(in srgb, var(--aide-accent) 35%, transparent);
}

.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 10px 10px;
}

/* ── Workspace item ── */

.workspace-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  margin: 6px 10px 4px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  color: var(--aide-text-muted);
  background: transparent;
  border-radius: var(--aide-radius-md);
  transition: all 0.15s ease;
  letter-spacing: 0.2px;
}

.workspace-item:hover {
  color: var(--aide-text-secondary);
  background: var(--aide-surface-default);
}

.workspace-item.active {
  color: var(--aide-text-primary);
}

.workspace-item.expanded {
  color: var(--aide-text-primary);
}

.ws-chevron {
  flex-shrink: 0;
  color: var(--aide-text-muted);
  transition: transform 0.2s ease, color 0.15s;
}

.ws-chevron.expanded {
  transform: rotate(90deg);
  color: var(--aide-accent);
}

.workspace-item:hover .ws-chevron {
  color: var(--aide-text-secondary);
}

.ws-folder-icon {
  flex-shrink: 0;
  color: var(--aide-text-muted);
  transition: color 0.15s;
}

.workspace-item.active .ws-folder-icon,
.workspace-item.expanded .ws-folder-icon {
  color: var(--aide-accent);
}

.ws-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.ws-count {
  font-size: 10px;
  font-weight: 600;
  color: var(--aide-text-muted);
  background: var(--aide-surface-default);
  padding: 0 6px;
  border-radius: 8px;
  min-width: 18px;
  text-align: center;
  line-height: 1.6;
  flex-shrink: 0;
}

/* ── Session card ── */

.session-card {
  margin-bottom: 6px;
  cursor: pointer;
}

.session-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.session-name {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--aide-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.session-time {
  font-size: 10px;
  color: var(--aide-text-muted);
  flex-shrink: 0;
}

.session-preview {
  font-size: 11px;
  color: var(--aide-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.4;
}

.session-empty.muted {
  color: var(--aide-text-muted);
  cursor: default;
  font-size: 12px;
  padding: 12px 16px;
}

/* ── Update banner ── */

.update-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  margin: 0 8px;
  border-radius: 6px;
  background: rgba(137, 180, 250, 0.1);
  border: 1px solid rgba(137, 180, 250, 0.22);
  cursor: pointer;
  transition: all 0.12s;
}

.update-banner:hover {
  background: rgba(137, 180, 250, 0.18);
  border-color: rgba(137, 180, 250, 0.35);
}

.update-banner-body {
  display: flex;
  align-items: center;
  gap: 6px;
}

.update-dot {
  font-size: 8px;
  color: var(--aide-accent);
}

.update-text {
  font-size: 11.5px;
  color: var(--aide-accent);
  font-weight: 500;
}

.update-dismiss {
  background: none;
  border: none;
  color: var(--aide-text-muted);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 5px;
  border-radius: 3px;
  font-family: inherit;
  transition: all 0.1s;
}

.update-dismiss:hover {
  background: rgba(137, 180, 250, 0.2);
  color: var(--aide-text-primary);
}

/* ── Provider selector ── */

.provider-selector {
  position: relative;
  padding: 4px 8px 0;
  border-top: 1px solid var(--aide-surface-default);
}

.provider-current {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  color: var(--aide-text-secondary);
  transition: all 0.12s;
}

.provider-current:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

.provider-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.provider-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-arrow {
  font-size: 14px;
  flex-shrink: 0;
  color: var(--aide-text-muted);
}

.provider-dropdown {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 8px;
  right: 8px;
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-surface-hover);
  border-radius: 8px;
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.35);
  z-index: 100;
  padding: 4px;
  animation: dropdown-up 0.12s ease;
}

@keyframes dropdown-up {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.provider-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 12px;
  color: var(--aide-text-secondary);
  transition: all 0.1s;
}

.provider-option:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

.provider-option.active {
  color: var(--aide-text-primary);
}

.provider-opt-icon {
  font-size: 14px;
  width: 18px;
  text-align: center;
  flex-shrink: 0;
}

.provider-opt-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-opt-check {
  color: var(--aide-success);
  font-size: 12px;
  flex-shrink: 0;
}

.provider-divider {
  height: 1px;
  background: var(--aide-surface-default);
  margin: 4px 6px;
}

/* ── Footer ── */

.sidebar-footer {
  border-top: 1px solid var(--aide-surface-default);
  padding: 4px 8px;
  display: flex;
  gap: 2px;
}

.footer-btn {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1;
  padding: 7px 10px;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--aide-text-secondary);
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
  transition: all 0.12s;
  position: relative;
}

.footer-btn:hover {
  color: var(--aide-text-primary);
  background: var(--aide-surface-default);
}

.footer-btn-kbd {
  margin-left: auto;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--aide-surface-default);
  color: var(--aide-text-muted);
  line-height: 1.5;
  font-family: inherit;
}
</style>
