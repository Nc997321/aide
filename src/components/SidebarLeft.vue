<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useContextMenu } from "../composables/useContextMenu";
import { useSessionState } from "../composables/useSessionState";
import { useUpdate } from "../composables/useUpdate";
import { sessionMenuItems } from "../menus/contextMenus";
import { api } from "../api";
import { open } from "@tauri-apps/plugin-shell";
import { getVersion } from "@tauri-apps/api/app";
import type { Session, WorkspaceInfo } from "../types";

const props = defineProps<{
  activeSessionId: string;
}>();

const emit = defineEmits<{
  "session-changed": [id: string];
  "workspace-changed": [path: string];
  "open-settings": [];
  "open-workbench": [];
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

onMounted(async () => {
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

    <!-- Search box -->
    <div class="search-box">
      <input
        v-model="searchQuery"
        class="search-input"
        placeholder="搜索工作区或会话..."
      />
    </div>

    <!-- Workspace + Session list -->
    <div class="session-list">
      <div v-if="loading" class="session-item muted">加载中...</div>

      <template v-else v-for="ws in filteredWorkspaces" :key="ws.key">
        <!-- Workspace row -->
        <div
          class="workspace-item"
          :class="{ active: ws.key === activeWorkspace }"
          @click="switchWorkspace(ws)"
        >
          <span class="ws-arrow" :class="{ expanded: expandedWorkspaces.has(ws.key) }">&#x25B8;</span>
          <span class="ws-name">{{ workspaceLabel(ws) }}</span>
        </div>

        <!-- Sessions (for any expanded workspace) -->
        <template v-if="expandedWorkspaces.has(ws.key)">
          <div
            v-if="wsSessions(ws.key).length === 0"
            class="session-item muted"
          >
            暂无会话
          </div>
          <div
            v-for="s in wsSessions(ws.key)"
            :key="s.id"
            class="session-item"
            :class="{
              active: props.activeSessionId === s.id,
              running: sessionState[s.id] === 'running',
              waiting: sessionState[s.id] === 'waiting',
              attention: sessionState[s.id] === 'attention',
            }"
            @click="selectSessionFromWorkspace(ws.key, s.id)"
            @contextmenu.prevent="onSessionContextMenu($event, s.id)"
          >
            <div class="session-name">{{ s.name }}</div>
            <div class="session-time">{{ timeAgo(s.timestamp) }}</div>
          </div>
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
  border-bottom: 1px solid var(--surface);
}

.header-title {
  font-weight: 600;
  font-size: 13px;
}

.new-btn {
  background: none;
  border: 1px solid var(--surface);
  color: var(--text-secondary);
  padding: 3px 10px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}

.new-btn:hover {
  background: var(--surface);
  color: var(--text-primary);
}

.search-box {
  padding: 8px 12px;
  border-bottom: 1px solid var(--surface);
}

.search-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--surface);
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-primary);
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s;
}
.search-input::placeholder {
  color: var(--text-muted);
}
.search-input:focus {
  border-color: var(--accent);
}

.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

/* ── Workspace item ── */

.workspace-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  cursor: pointer;
  font-size: 12.5px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--surface);
  transition: all 0.1s;
}

.ws-arrow {
  font-size: 14px;
  width: 16px;
  flex-shrink: 0;
  transition: transform 0.15s;
}
.ws-arrow.expanded {
  transform: rotate(90deg);
}
.workspace-item:first-child {
  border-top: 1px solid var(--surface);
}
.workspace-item:hover {
  color: var(--text-primary);
  background: var(--surface);
}
.workspace-item.active {
  color: var(--text-primary);
}

.ws-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Session item ── */

.session-item {
  padding: 7px 16px 7px 36px;
  cursor: pointer;
  border-left: 2px solid transparent;
  border-right: 2px solid transparent;
  transition: all 0.1s;
}

.session-item:hover {
  background: var(--surface);
}

.session-item.active {
  background: var(--surface);
  border-left-color: var(--accent);
}

/* Running: green shimmer sweeping right→left */
.session-item.running {
  position: relative;
  overflow: hidden;
}
.session-item.running::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(166, 227, 161, 0.06) 40%,
    rgba(166, 227, 161, 0.12) 50%,
    rgba(166, 227, 161, 0.06) 60%,
    transparent 100%
  );
  background-size: 200% 100%;
  animation: sweep-right 2.5s ease-in-out infinite;
  pointer-events: none;
}
@keyframes sweep-right {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* Waiting: subtle green right accent */
.session-item.waiting {
  border-right-color: var(--accent-green);
}

/* Attention: amber shimmer */
.session-item.attention {
  position: relative;
  overflow: hidden;
}
.session-item.attention::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(249, 226, 175, 0.06) 40%,
    rgba(249, 226, 175, 0.12) 50%,
    rgba(249, 226, 175, 0.06) 60%,
    transparent 100%
  );
  background-size: 200% 100%;
  animation: sweep-right 1.5s ease-in-out infinite;
  pointer-events: none;
}

.session-item.muted {
  color: var(--text-muted);
  cursor: default;
  font-size: 12px;
  padding-top: 12px;
  padding-bottom: 12px;
}

.session-name {
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-time {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
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
  color: var(--accent);
}

.update-text {
  font-size: 11.5px;
  color: var(--accent);
  font-weight: 500;
}

.update-dismiss {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 5px;
  border-radius: 3px;
  font-family: inherit;
  transition: all 0.1s;
}

.update-dismiss:hover {
  background: rgba(137, 180, 250, 0.2);
  color: var(--text-primary);
}

/* ── Footer ── */

.sidebar-footer {
  border-top: 1px solid var(--surface);
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
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
  transition: all 0.12s;
  position: relative;
}

.footer-btn:hover {
  color: var(--text-primary);
  background: var(--surface);
}

.footer-btn-kbd {
  margin-left: auto;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--surface);
  color: var(--text-muted);
  line-height: 1.5;
  font-family: inherit;
}
</style>
