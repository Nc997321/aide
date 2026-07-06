<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { timeAgo } from "../utils/time";
import { useContextMenu } from "../composables/useContextMenu";
import { useSessionState } from "../composables/useSessionState";
import { useUpdate } from "../composables/useUpdate";
import { useProviders } from "../composables/useProviders";
import { useRecent } from "../composables/useRecent";
import { useSessionNames } from "../composables/useSessionNames";
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
  "new-session": [name: string];
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
  if (ws.missing) {
    // Strip drive prefix (e.g. "C--") and show the rest as a best-effort label
    return ws.key.replace(/^[A-Za-z]--/, "");
  }
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

// ── 会话折叠（VS Code 式）：每个工作区默认只露前 N 条，其余收进
// 「另外 N 个」展开行；搜索时展示全部命中，折叠只作用于默认视图。
const SESSION_PREVIEW_COUNT = 3;
const showAllSessions = ref(new Set<string>());

function sessionsCollapsed(wsKey: string): boolean {
  return !searchQuery.value.trim() && !showAllSessions.value.has(wsKey);
}

function visibleSessions(wsKey: string): Session[] {
  const list = wsSessions(wsKey);
  return sessionsCollapsed(wsKey) ? list.slice(0, SESSION_PREVIEW_COUNT) : list;
}

function hiddenSessionCount(wsKey: string): number {
  return sessionsCollapsed(wsKey)
    ? Math.max(0, wsSessions(wsKey).length - SESSION_PREVIEW_COUNT)
    : 0;
}

function toggleShowAllSessions(wsKey: string) {
  if (showAllSessions.value.has(wsKey)) {
    showAllSessions.value.delete(wsKey);
  } else {
    showAllSessions.value.add(wsKey);
  }
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

  try {
    const loaded = await api.listSessions();
    sessionsByWorkspace.value[wsKey] = loaded;
    sessionNames.setFromSessions(loaded);
  } catch (_e) {
    sessionsByWorkspace.value[wsKey] = [];
  }

  loading.value = false;

  const list = sessionsByWorkspace.value[wsKey] ?? [];
  if (list.length === 0) {
    newSession();
    return;
  }
  if (!props.activeSessionId) {
    emit("session-changed", list[0].id);
  }
}

// Load sessions for a specific (non-active) workspace
async function loadWsSessions(wsKey: string) {
  try {
    const loaded = await api.listSessionsForWorkspace(wsKey);
    sessionsByWorkspace.value[wsKey] = loaded;
    sessionNames.setFromSessions(loaded);
  } catch (_e) {
    sessionsByWorkspace.value[wsKey] = [];
  }
}

const { show } = useContextMenu();
const sessionNames = useSessionNames();
const { state: sessionState, dotTone } = useSessionState();
const { updateAvailable, latestVersion, downloadUrl, dismissUpdate } = useUpdate();
const { setCurrentWs } = useRecent();

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
  await setActiveProvider(id);
}

function onProviderClickOutside(e: MouseEvent) {
  if (providerSelectorRef.value && !providerSelectorRef.value.contains(e.target as Node)) {
    providerDropdownOpen.value = false;
  }
}


// Select a session from a potentially different workspace.
// 仅切换+预览，不记录最近会话——只有真正"启动"（Agent SDK send_message）的会话才入列，
// 记录在 App.onNewSession 完成。
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
      await setCurrentWs(ws.key, ws.name);
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
  // 工作区头部点击 = 纯展开/收起开关（VS Code 语义），与激活态无关：
  // 若收起也要求先激活，两个展开的工作区来回点时第一下会被"抢激活"
  // 消耗掉，收起就得点两下。激活切换只在展开非活动工作区时顺带发生，
  // 或通过点击其下的会话条目（selectSessionFromWorkspace）。
  if (expandedWorkspaces.value.has(ws.key)) {
    expandedWorkspaces.value.delete(ws.key);
    return;
  }

  expandedWorkspaces.value.add(ws.key);
  if (ws.key === activeWorkspace.value) return;

  const ok = await activateWorkspace(ws);
  if (!ok) expandedWorkspaces.value.delete(ws.key);
}

/** 真正把某个工作区设为活动：setWorkspace + 更新本地状态 + 广播 workspace-changed。
 *  switchWorkspace（侧栏点头）与 switchToWorkspaceByKey（文件树切换器）共用。 */
async function activateWorkspace(ws: WorkspaceInfo): Promise<boolean> {
  if (ws.missing) return false;
  try {
    await api.setWorkspace(ws.key, ws.name);
  } catch (_e) {
    return false;
  }
  activeWorkspace.value = ws.key;
  expandedWorkspaces.value.add(ws.key);
  emit("workspace-changed", ws.name);
  await setCurrentWs(ws.key, ws.name);
  await loadSessions();
  return true;
}

/** 供文件树 path-bar 切换器调用：按 key 激活工作区（已是活动则忽略）。 */
async function switchToWorkspaceByKey(wsKey: string) {
  if (wsKey === activeWorkspace.value) return;
  const ws = workspaces.value.find((w) => w.key === wsKey);
  if (ws) await activateWorkspace(ws);
}

async function renameSession(id: string, name: string) {
  try {
    await api.renameSession(id, name);
    // Update in-memory list directly — avoids a full reload that would
    // clobber any optimistic state not yet persisted on disk.
    const wsKey = activeWorkspace.value;
    const list = sessionsByWorkspace.value[wsKey] ?? [];
    const idx = list.findIndex(s => s.id === id);
    if (idx !== -1) {
      list.splice(idx, 1, { ...list[idx], name });
      sessionsByWorkspace.value[wsKey] = [...list];
    } else {
      await loadSessions();
    }
    sessionNames.setName(id, name);
  } catch (_e) { /* ignore */ }
}

function onSessionContextMenu(e: MouseEvent, wsKey: string, id: string) {
  e.preventDefault();
  show(
    e.clientX,
    e.clientY,
    sessionMenuItems(id, (name: string) => renameSession(id, name), loadSessions, {
      // tab/分屏打开只对当前活动工作区的会话开放；跨工作区先单击切换再操作
      openInPane: wsKey === activeWorkspace.value,
    }),
  );
}

function newSession() {
  const name = `新会话 ${new Date().toLocaleTimeString()}`;
  emit("new-session", name);
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
        await setCurrentWs(ws.key, ws.name);
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
 * Add a newly-created session to the top of the active workspace list.
 * Called by App.vue's onSessionCreated once the SDK has confirmed a real
 * session id (see CLAUDE.md「会话 ID 生命周期」) — sessions never appear here
 * before that, so there's no draft id to swap out later.
 */
function addSession(session: Session) {
  const wsKey = activeWorkspace.value;
  const list = sessionsByWorkspace.value[wsKey] ?? [];
  if (!list.some(s => s.id === session.id)) {
    list.unshift(session);
    sessionsByWorkspace.value[wsKey] = [...list];
  }
  sessionNames.setName(session.id, session.name);
}

defineExpose({ newSession, loadSessions, addSession, selectSessionFromWorkspace, switchToWorkspaceByKey, sessionsByWorkspace });
</script>

<template>
  <div class="sidebar-left">
    <!-- Header -->
    <div class="sidebar-header">
      <span class="header-title">会话</span>
      <button class="new-btn" @click="newSession" v-tooltip="'新建会话 (Ctrl+N)'">
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
          :class="{
            active: ws.key === activeWorkspace,
            expanded: expandedWorkspaces.has(ws.key),
            missing: ws.missing,
          }"
          v-tooltip="ws.missing ? `路径不存在，目录可能已被移动或删除：${ws.key}` : ''"
          @click="ws.missing ? undefined : switchWorkspace(ws)"
        >
          <svg v-if="!ws.missing" class="ws-chevron" :class="{ expanded: expandedWorkspaces.has(ws.key) }" width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <svg v-if="ws.missing" class="ws-warn-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <svg v-if="!ws.missing" class="ws-folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M3 7C3 5.89543 3.89543 5 5 5H9.58579C9.851 5 10.1054 5.10536 10.2929 5.29289L12 7H19C20.1046 7 21 7.89543 21 9V17C21 18.1046 20.1046 19 19 19H5C3.89543 19 3 18.1046 3 17V7Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span class="ws-name">{{ workspaceLabel(ws) }}</span>
          <span v-if="ws.missing" class="ws-missing-badge">失效</span>
          <span v-else-if="(sessionsByWorkspace[ws.key] ?? []).length > 0" class="ws-count">{{ (sessionsByWorkspace[ws.key] ?? []).length }}</span>
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
            v-for="s in visibleSessions(ws.key)"
            :key="s.id"
            :active="props.activeSessionId === s.id"
            :glow-color="sessionState[s.id] === 'running' ? 'var(--aide-success)' : undefined"
            class="session-card"
            @click="selectSessionFromWorkspace(ws.key, s.id)"
            @contextmenu.prevent="onSessionContextMenu($event, ws.key, s.id)"
          >
            <div class="session-card-header">
              <AStatusDot :tone="dotTone(s.id)" />
              <span class="session-name">{{ s.name }}</span>
              <span class="session-time">{{ timeAgo(s.timestamp) }}</span>
            </div>
            <div v-if="s.last_message" class="session-preview">{{ s.last_message }}</div>
          </ACard>
          <div
            v-if="hiddenSessionCount(ws.key) > 0"
            class="session-more"
            @click="toggleShowAllSessions(ws.key)"
          >
            另外 {{ hiddenSessionCount(ws.key) }} 个
          </div>
          <div
            v-else-if="showAllSessions.has(ws.key) && wsSessions(ws.key).length > SESSION_PREVIEW_COUNT"
            class="session-more"
            @click="toggleShowAllSessions(ws.key)"
          >
            收起
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
      <button class="update-dismiss" v-tooltip="'忽略'" @click.stop="dismissUpdate">✕</button>
    </div>

    <!-- Status bar: provider + actions -->
    <div ref="providerSelectorRef" class="status-bar">
      <div class="status-bar-provider" @click="toggleProviderDropdown">
        <span class="status-bar-provider-icon">{{ activeProvider.icon }}</span>
        <span class="status-bar-provider-name">{{ activeProvider.name }}</span>
        <svg class="status-bar-chevron" :class="{ open: providerDropdownOpen }" width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2.5 4L5 6.5L7.5 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>

      <div class="status-bar-actions">
        <button class="status-bar-btn" v-tooltip="'工作台终端 (Ctrl+`)'" @click="emit('open-workbench')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="4 17 10 11 4 5"/>
            <line x1="12" y1="19" x2="20" y2="19"/>
          </svg>
        </button>
        <button class="status-bar-btn" v-tooltip="'设置'" @click="emit('open-settings')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
      </div>

      <!-- Provider dropdown -->
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

.workspace-item.missing {
  cursor: not-allowed;
  opacity: 0.55;
}

.workspace-item.missing:hover {
  background: color-mix(in srgb, var(--aide-warning) 8%, transparent);
  color: var(--aide-warning);
}

.ws-warn-icon {
  flex-shrink: 0;
  color: var(--aide-warning);
}

.ws-missing-badge {
  font-size: 9px;
  font-weight: 600;
  color: var(--aide-warning);
  background: color-mix(in srgb, var(--aide-warning) 15%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-warning) 30%, transparent);
  padding: 0 5px;
  border-radius: 6px;
  line-height: 1.6;
  flex-shrink: 0;
  letter-spacing: 0.3px;
}

/* ── Session card ──
   工匠质感卡片（复用 ACard 凸起卡片语言：raised 底 + 描边 + 圆角 + 内边距 +
   悬停阴影 + 选中 accent 渐变 + 运行时左侧 glow 光条）。布局保持 VS Code 式对齐：
   左缩进挂在工作区名下、右留白使卡片整体比工作区行窄；卡片间留呼吸间距。 */

.session-card {
  margin: 0 10px 6px 24px;
  cursor: pointer;
}

.session-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.session-name {
  font-size: 13px;
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

.session-more {
  margin: 1px 6px 3px 24px;
  padding: 4px 10px 4px 25px;
  font-size: 11px;
  color: var(--aide-text-muted);
  cursor: pointer;
  border-radius: var(--aide-radius-sm);
  transition: all 0.12s;
}

.session-more:hover {
  color: var(--aide-accent);
  background: var(--aide-surface-default);
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
  background: color-mix(in srgb, var(--aide-info) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-info) 22%, transparent);
  cursor: pointer;
  transition: all 0.12s;
}

.update-banner:hover {
  background: color-mix(in srgb, var(--aide-info) 18%, transparent);
  border-color: color-mix(in srgb, var(--aide-info) 35%, transparent);
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
  font-size: 12px;
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
  background: color-mix(in srgb, var(--aide-info) 20%, transparent);
  color: var(--aide-text-primary);
}

/* ── Status bar (provider + actions) ── */

.status-bar {
  position: relative;
  display: flex;
  align-items: center;
  height: 36px;
  padding: 0 6px;
  border-top: 1px solid var(--aide-border);
  background:
    linear-gradient(180deg, var(--aide-border-subtle) 0%, transparent 100%),
    var(--aide-bg-deep);
  flex-shrink: 0;
  gap: 2px;
}

.status-bar-provider {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  font-size: 12px;
  color: var(--aide-text-secondary);
  transition: all 0.12s;
  overflow: hidden;
  flex: 1;
  min-width: 0;
}

.status-bar-provider:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

.status-bar-provider-icon {
  font-size: 13px;
  flex-shrink: 0;
}

.status-bar-provider-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.status-bar-chevron {
  flex-shrink: 0;
  color: var(--aide-text-muted);
  transition: transform 0.15s ease;
}

.status-bar-chevron.open {
  transform: rotate(180deg);
}

.status-bar-actions {
  display: flex;
  align-items: center;
  gap: 1px;
  flex-shrink: 0;
}

.status-bar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: none;
  border: none;
  border-radius: var(--aide-radius-sm);
  color: var(--aide-text-muted);
  cursor: pointer;
  transition: all 0.12s;
}

.status-bar-btn:hover {
  color: var(--aide-text-primary);
  background: var(--aide-surface-default);
}

/* ── Provider dropdown ── */

.provider-dropdown {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 6px;
  right: 6px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  box-shadow: var(--aide-shadow-md);
  z-index: 100;
  padding: 4px;
  animation: dropdown-up 0.12s ease-out;
}

@keyframes dropdown-up {
  from { opacity: 0; transform: translateY(4px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.provider-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--aide-radius-sm);
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
  background: var(--aide-border);
  margin: 4px 6px;
}
</style>
