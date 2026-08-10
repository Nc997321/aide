<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { timeAgo } from "../utils/time";
import { useContextMenu } from "../composables/useContextMenu";
import { useSessionState } from "../composables/useSessionState";
import { useUpdate } from "../composables/useUpdate";
import { useProviders } from "../composables/useProviders";
import { useRecent } from "../composables/useRecent";
import { useSessionNames } from "../composables/useSessionNames";
import { useSessionWorkspaces } from "../composables/useSessionWorkspaces";
import { sessionMenuItems, workspaceMenuItems } from "../menus/contextMenus";
import { useWorkspaces } from "../composables/useWorkspaces";
import { useSettings } from "../composables/useSettings";
import { useWorkspaceTrust } from "../composables/useWorkspaceTrust";
import { useCodeGraphProgress } from "../composables/useCodeGraphProgress";
import { api } from "../api";
import { open } from "@tauri-apps/plugin-shell";
import { getVersion } from "@tauri-apps/api/app";
import { ACard, AStatusDot } from "../ui";
import AToast from "../ui/AToast.vue";
import { useToast } from "../composables/useToast";
import IconOrChar from "./IconOrChar.vue";
import Icon from "./Icon.vue";
import type { Session, WorkspaceInfo } from "../types";

const props = defineProps<{
  activeSessionId: string;
  /** 钉子固定状态（App.vue 持久化到 settings.leftSidebarPinned）：
   *  false = 悬浮自动隐藏模式（侧栏此刻是 overlay），true = 常驻 dock。 */
  pinned?: boolean;
}>();

const emit = defineEmits<{
  "session-changed": [id: string];
  "new-session": [name: string];
  "workspace-changed": [path: string];
  "remove-workspace": [ws: WorkspaceInfo];
  "open-settings": [];
  "provider-switch": [providerId: string];
  "open-settings-providers": [];
  "toggle-pin": [];
}>();

const { workspaces, activeKey: wsActiveKey, refresh: refreshWorkspaces, openFolder, removeWorkspace: removeWs } = useWorkspaces();
const { untrustedPaths, isTrusted, refreshFor: refreshTrust, trust, shouldPrompt, markPrompted } = useWorkspaceTrust();
const { onWorkspaceTrusted } = useCodeGraphProgress();
const { settings } = useSettings();
const sessionsByWorkspace = ref<Record<string, Session[]>>({});
const activeWorkspace = ref("");
const expandedWorkspaces = ref(new Set<string>());
const searchQuery = ref("");
// 加载态按层级隔离：workspacesLoading 只覆盖启动时的工作区清单（全局占位仅此一处）；
// sessionsLoading 按工作区 key 各自标记——点哪个工作区只有哪个的展开区显示骨架，
// 不再全局「加载中...」连坐隐藏整表（旧写法点大会话量的工作区时全侧栏空白）。
const workspacesLoading = ref(true);
const sessionsLoading = ref(new Set<string>());

// ── 工作区信任提示（Variant A 居中模态）── trustPrompt 非 null 时显示。
// 不信任工作区首次激活时弹一次（maybePromptTrust），「暂不」后本会话不再弹；
// 工作区行的「不受信任」徽标点击可重开（openTrustPrompt = 回收路径）。
const trustPrompt = ref<{ path: string; name: string } | null>(null);

/** 检查信任态：不信任且本会话未弹过 → 弹模态。幂等（markPrompted 去重）。 */
async function maybePromptTrust(ws: WorkspaceInfo): Promise<void> {
  if (ws.missing || !ws.name) return;
  if (!shouldPrompt(ws.name)) return;
  markPrompted(ws.name); // 先标记，避免并发激活重复弹
  const trusted = await isTrusted(ws.name);
  if (!trusted) trustPrompt.value = { path: ws.name, name: workspaceLabel(ws) };
}

function openTrustPrompt(ws: WorkspaceInfo): void {
  if (ws.missing || !ws.name) return;
  trustPrompt.value = { path: ws.name, name: workspaceLabel(ws) };
}

function closeTrustPrompt(): void {
  trustPrompt.value = null;
}

/** 信任此工作区：持久化 + 自动写入安全命令白名单 + 触发索引构建 + 刷新徽标。 */
async function confirmTrust(): Promise<void> {
  const p = trustPrompt.value;
  if (!p) return;
  trustPrompt.value = null;
  const { ok, added } = await trust(p.path);
  if (ok) {
    onWorkspaceTrusted(p.path);
    void refreshTrust(workspaces.value.map((w) => w.name).filter(Boolean));
    if (added > 0) {
      showToast(`已信任工作区，已添加 ${added} 条安全命令白名单`, "success");
    }
  }
}

/** 暂不信任：本会话不再弹（徽标仍在，可点击重开）。 */
function declineTrust(): void {
  const p = trustPrompt.value;
  if (p) markPrompted(p.path);
  trustPrompt.value = null;
}

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
// N 跟随设置「最近访问保留条数」（settings.recentLimit，1..50），改设置即时生效。
const showAllSessions = ref(new Set<string>());

function sessionsCollapsed(wsKey: string): boolean {
  return !searchQuery.value.trim() && !showAllSessions.value.has(wsKey);
}

function visibleSessions(wsKey: string): Session[] {
  const list = wsSessions(wsKey);
  return sessionsCollapsed(wsKey) ? list.slice(0, settings.recentLimit) : list;
}

function hiddenSessionCount(wsKey: string): number {
  return sessionsCollapsed(wsKey)
    ? Math.max(0, wsSessions(wsKey).length - settings.recentLimit)
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
    await refreshWorkspaces();
  } finally {
    workspacesLoading.value = false;
  }
}

async function loadSessions() {
  // 先捕获再标记：await 期间用户可能又切了工作区，结果与骨架都跟着捕获的 key 走
  const wsKey = activeWorkspace.value;
  sessionsLoading.value.add(wsKey);

  try {
    const loaded = await api.listSessions();
    sessionsByWorkspace.value[wsKey] = loaded;
    sessionNames.setFromSessions(loaded);
    registerSessionWs(loaded, wsKey);
  } catch (_e) {
    sessionsByWorkspace.value[wsKey] = [];
  } finally {
    sessionsLoading.value.delete(wsKey);
  }

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
    registerSessionWs(loaded, wsKey);
  } catch (_e) {
    sessionsByWorkspace.value[wsKey] = [];
  }
}

const { show } = useContextMenu();
const { toastState, showToast } = useToast();
const sessionNames = useSessionNames();
const sessionWs = useSessionWorkspaces();
const { state: sessionState, dotTone } = useSessionState();

/** 把某工作区的一批会话记入归属注册表（tab 后缀标识 / sidecar cwd 依赖它）。 */
function registerSessionWs(list: Session[], wsKey: string) {
  const wsPath = workspaces.value.find((w) => w.key === wsKey)?.name ?? "";
  if (!wsPath) return;
  sessionWs.setMany(list, { wsKey, wsPath });
}
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
      wsActiveKey.value = ws.key;   // 同步共享 activeKey，供终端分组/run tab 归属等消费方感知切换
      emit("workspace-changed", ws.name);
      await setCurrentWs(ws.key, ws.name);
      void maybePromptTrust(ws);
      void refreshTrust(workspaces.value.map((w) => w.name).filter(Boolean));
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
  wsActiveKey.value = ws.key;   // 同步共享 activeKey，供终端分组/run tab 归属等消费方感知切换
  expandedWorkspaces.value.add(ws.key);
  emit("workspace-changed", ws.name);
  await setCurrentWs(ws.key, ws.name);
  await loadSessions();
  void maybePromptTrust(ws);
  void refreshTrust(workspaces.value.map((w) => w.name).filter(Boolean));
  return true;
}

/** 供文件树 path-bar 切换器调用：按 key 激活工作区（已是活动则忽略）。 */
async function switchToWorkspaceByKey(wsKey: string) {
  if (wsKey === activeWorkspace.value) return;
  const ws = workspaces.value.find((w) => w.key === wsKey);
  if (ws) await activateWorkspace(ws);
}

/** TitleBar「打开目录」确认后调用：登记目录为工作区 → 激活 → 广播 workspace-changed。
 *  由 App.vue 经 defineExpose 触发。 */
async function openWorkspaceFolder(path: string): Promise<boolean> {
  let info: WorkspaceInfo;
  try {
    info = await openFolder(path);
  } catch (e) {
    throw e;
  }
  activeWorkspace.value = info.key;
  expandedWorkspaces.value.add(info.key);
  emit("workspace-changed", info.name);
  await setCurrentWs(info.key, info.name);
  await loadSessions();
  void maybePromptTrust(info);
  void refreshTrust(workspaces.value.map((w) => w.name).filter(Boolean));
  return true;
}

/** 移除工作区（hide/delete）。delete 前检查该工作区是否有 running 会话。 */
async function removeWorkspaceByKey(key: string, mode: "hide" | "delete"): Promise<boolean> {
  if (mode === "delete") {
    // 阻止删除有正在运行会话的工作区
    const list = sessionsByWorkspace.value[key] ?? [];
    if (list.some(s => sessionState[s.id] === "running")) {
      return false;
    }
  }
  const wasActive = key === activeWorkspace.value;
  await removeWs(key, mode);
  // 从本地 UI 状态清理
  expandedWorkspaces.value.delete(key);
  delete sessionsByWorkspace.value[key];
  if (wasActive) {
    activeWorkspace.value = "";
    // 回落空态：清当前会话预览
    emit("session-changed", "");
  }
  return true;
}

async function renameSession(wsKey: string, id: string, name: string) {
  try {
    await api.renameSession(id, name);
    // Update in-memory list directly — avoids a full reload that would
    // clobber any optimistic state not yet persisted on disk.
    const list = sessionsByWorkspace.value[wsKey] ?? [];
    const idx = list.findIndex(s => s.id === id);
    if (idx !== -1) {
      list.splice(idx, 1, { ...list[idx], name });
      sessionsByWorkspace.value[wsKey] = [...list];
    } else {
      await loadWsSessions(wsKey);
    }
    sessionNames.setName(id, name);
  } catch (_e) { /* ignore */ }
}

/** 本地移除会话卡片（乐观删除）：不动滚动、不整表重载，离场动画由 TransitionGroup 播。 */
function removeSessionLocally(wsKey: string, id: string) {
  const list = sessionsByWorkspace.value[wsKey] ?? [];
  const idx = list.findIndex(s => s.id === id);
  if (idx === -1) return;
  list.splice(idx, 1);
  sessionsByWorkspace.value[wsKey] = [...list];
  // 删空活动工作区时维持 loadSessions 的原行为：自动开一个空白会话
  if (wsKey === activeWorkspace.value && list.length === 0) newSession();
}

/** 乐观删除失败回滚：重新拉取该工作区的真实列表 + toast 报错。 */
function onSessionDeleteFailed(wsKey: string) {
  loadWsSessions(wsKey);
  showToast("删除会话失败，列表已恢复", "danger");
}

/**
 * 离场收拢起点校准：卡高不固定（有无 preview 行差 ~20px），CSS 无法预知真实高度。
 * 在 leave 钩子（先于 leave-active 类生效）把真实高度写进 CSS 变量，
 * 让 max-height 从精确值收拢到 0——若从固定上界（如 100px）起播，
 * 前段数值大于真实高度时视觉空跑、收拢被压进末段，收尾会有顿挫感。
 */
function onSessionAnimLeave(el: Element) {
  (el as HTMLElement).style.setProperty("--session-leave-h", `${(el as HTMLElement).offsetHeight}px`);
}

function onSessionContextMenu(e: MouseEvent, wsKey: string, id: string) {
  e.preventDefault();
  // 混合 tab 布局：任何工作区的会话都可以直接开 tab/分屏（cwd 跟会话走）
  show(
    e.clientX,
    e.clientY,
    sessionMenuItems(
      id,
      (name: string) => renameSession(wsKey, id, name),
      () => removeSessionLocally(wsKey, id),
      () => onSessionDeleteFailed(wsKey),
    ),
  );
}

function onWorkspaceContextMenu(e: MouseEvent, ws: WorkspaceInfo) {
  e.preventDefault();
  e.stopPropagation();
  show(
    e.clientX,
    e.clientY,
    workspaceMenuItems(
      ws,
      () => activateWorkspace(ws),
      () => emit("remove-workspace", ws),
    ),
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
    let activeWs: WorkspaceInfo | null = null;
    for (const ws of workspaces.value) {
      if (ws.name === info.root) {
        activeWorkspace.value = ws.key;
        wsActiveKey.value = ws.key;   // 同步共享 activeKey：启动时若只设本地 ref，
        // 首个终端会被归到空 key（activeWorkspaceKey 仍为 null → :workspace-key="''"），
        // 之后首次侧栏切换才真正设 activeKey，把那个终端遗弃成孤儿——切回去就"没了"。
        expandedWorkspaces.value.add(ws.key);
        await setCurrentWs(ws.key, ws.name);
        activeWs = ws;
        break;
      }
    }
    if (activeWs) void maybePromptTrust(activeWs);
  } catch (_) { /* ignore */ }
  await loadSessions();
  void refreshTrust(workspaces.value.map((w) => w.name).filter(Boolean));

  try {
    const { checkUpdate } = useUpdate();
    await checkUpdate(await getVersion());
  } catch (_) { /* non-critical */ }
});

/**
 * Add a newly-created session to the top of its own workspace list.
 * Called by App.vue's onSessionCreated once the SDK has confirmed a real
 * session id (see CLAUDE.md「会话 ID 生命周期」) — sessions never appear here
 * before that, so there's no draft id to swap out later.
 * 归属读注册表（首发时 seed 的创建时绑定快照）：session_init 在途期间用户
 * 可能已切走工作区，不能用回调时刻的 activeWorkspace。
 */
function addSession(session: Session) {
  const wsKey = sessionWs.workspaceOf(session.id)?.wsKey ?? activeWorkspace.value;
  const list = sessionsByWorkspace.value[wsKey] ?? [];
  if (!list.some(s => s.id === session.id)) {
    list.unshift(session);
    sessionsByWorkspace.value[wsKey] = [...list];
  }
  sessionNames.setName(session.id, session.name);
  registerSessionWs([session], wsKey);
}

defineExpose({ newSession, loadSessions, addSession, selectSessionFromWorkspace, switchToWorkspaceByKey, sessionsByWorkspace, openWorkspaceFolder, removeWorkspaceByKey });
</script>

<template>
  <div class="sidebar-left">
    <!-- Header -->
    <div class="sidebar-header">
      <span class="header-title">会话</span>
      <button
        class="pin-btn"
        :class="{ pinned: props.pinned }"
        v-tooltip="props.pinned ? '取消固定（恢复自动隐藏）' : '固定侧栏'"
        @click="emit('toggle-pin')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 17v5"/>
          <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/>
        </svg>
      </button>
      <button class="new-btn" @click="newSession" v-tooltip="'新建会话 (Ctrl+N)'">
        新 (Ctrl+N)
      </button>
    </div>

    <!-- Workspace + Session list -->
    <div class="session-list">
      <div v-if="workspacesLoading" class="session-empty muted">加载中...</div>

      <template v-else v-for="ws in filteredWorkspaces" :key="ws.key">
        <!-- Workspace row -->
        <div
          class="workspace-item"
          :class="{
            active: ws.key === activeWorkspace,
            expanded: expandedWorkspaces.has(ws.key),
            missing: ws.missing,
            untrusted: !ws.missing && untrustedPaths.has(ws.name),
          }"
          v-tooltip="ws.missing ? `路径不存在，目录可能已被移动或删除：${ws.key}` : ''"
          @click="ws.missing ? undefined : switchWorkspace(ws)"
          @contextmenu="onWorkspaceContextMenu($event, ws)"
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
          <span
            v-if="!ws.missing && untrustedPaths.has(ws.name)"
            class="ws-trust-badge"
            v-tooltip="'工作区不受信任，点击信任'"
            @click.stop="openTrustPrompt(ws)"
          >不受信任</span>
        </div>

        <!-- Sessions (for any expanded workspace) -->
        <template v-if="expandedWorkspaces.has(ws.key)">
          <!-- 会话加载按工作区隔离：骨架只占本工作区展开区，其余工作区原地不动 -->
          <div v-if="sessionsLoading.has(ws.key)" class="session-skel-list">
            <div v-for="i in 2" :key="i" class="session-skel-card">
              <div class="session-skel-line session-skel-title"></div>
              <div class="session-skel-line session-skel-preview"></div>
            </div>
          </div>
          <div
            v-else-if="wsSessions(ws.key).length === 0"
            class="session-empty muted"
          >
            暂无会话
          </div>
          <template v-else>
            <TransitionGroup name="session-anim" tag="div" class="session-anim-group" @leave="onSessionAnimLeave">
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
                  <span class="session-name">{{ sessionNames.names[s.id] || s.name }}</span>
                  <span class="session-time">{{ timeAgo(s.timestamp) }}</span>
                </div>
                <div v-if="s.last_message" class="session-preview">{{ s.last_message }}</div>
              </ACard>
            </TransitionGroup>
            <div
              v-if="hiddenSessionCount(ws.key) > 0"
              class="session-more"
              @click="toggleShowAllSessions(ws.key)"
            >
              另外 {{ hiddenSessionCount(ws.key) }} 个
            </div>
            <div
              v-else-if="showAllSessions.has(ws.key) && wsSessions(ws.key).length > settings.recentLimit"
              class="session-more"
              @click="toggleShowAllSessions(ws.key)"
            >
              收起
            </div>
          </template>
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
        <span class="status-bar-provider-icon"><IconOrChar :text="activeProvider.icon" :size="13" /></span>
        <span class="status-bar-provider-name">{{ activeProvider.name }}</span>
        <svg class="status-bar-chevron" :class="{ open: providerDropdownOpen }" width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2.5 4L5 6.5L7.5 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>

      <div class="status-bar-actions">
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
          <span class="provider-opt-icon"><IconOrChar :text="p.icon" :size="14" /></span>
          <span class="provider-opt-name">{{ p.name }}</span>
          <span v-if="p.id === activeProviderId" class="provider-opt-check">✓</span>
        </div>
        <div class="provider-divider"></div>
        <div class="provider-option" @click="providerDropdownOpen = false; emit('open-settings-providers')">
          <span class="provider-opt-icon"><Icon name="general" :size="14" /></span>
          <span class="provider-opt-name">管理供应商…</span>
        </div>
      </div>
    </div>

    <AToast :state="toastState" />

    <Teleport to="body">
      <div v-if="trustPrompt" class="trust-overlay" @click.self="closeTrustPrompt">
        <div class="trust-modal" role="dialog" aria-modal="true" @click.stop>
          <div class="trust-shield">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          </div>
          <h3 class="trust-title">是否信任此工作区？</h3>
          <p class="trust-path">{{ trustPrompt.path }}</p>
          <p class="trust-desc">不受信任的工作区将以下功能受限：</p>
          <ul class="trust-list">
            <li><span class="dot"></span>代码索引（CodeGraph 向量检索）</li>
            <li><span class="dot"></span>项目 <code>CLAUDE.md</code> 指令</li>
            <li><span class="dot"></span>项目 <code>.claude/skills/</code> 与 <code>.mcp.json</code></li>
          </ul>
          <p class="trust-note">Claude 对话本身不受影响。</p>
          <div class="trust-actions">
            <button class="btn secondary" @click="declineTrust">暂不信任</button>
            <button class="btn primary" @click="confirmTrust">信任此工作区</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.sidebar-left {
  position: relative; /* AToast 锚定 */
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--aide-surface-default);
}

.header-title {
  flex: 1; /* 把钉子/新建按钮挤到右侧 */
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--aide-text-muted);
}

/* 钉子按钮：未固定斜 45°（"没钉上"），固定竖直 + accent 高亮（QQ 侧栏语义） */
.pin-btn {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  margin-right: 6px;
  border: none;
  border-radius: var(--aide-radius-sm);
  background: transparent;
  color: var(--aide-text-muted);
  cursor: pointer;
  transition: background var(--aide-ease-t), color var(--aide-ease-t);
}
.pin-btn:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
.pin-btn svg {
  width: 13px;
  height: 13px;
  transform: rotate(45deg);
  transition: transform var(--aide-ease-t);
}
.pin-btn.pinned {
  color: var(--aide-accent);
  background: var(--aide-accent-subtle);
}
.pin-btn.pinned svg {
  transform: none;
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
  box-shadow: var(--aide-highlight-inset);
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

/* ── 会话卡进出场 / 补位动画（TransitionGroup session-anim）──
   删除 = 乐观本地移除：卡片淡出+左滑+高度收拢，兄弟卡片平滑上移补位，
   不再整表 loadSessions（旧写法 loading 闪「加载中...」且 scrollTop 被钳回顶部）。
   新建会话插入顶部走同一条渲染路径，白得入场淡入。
   两条硬性细节：
   1) 所有属性同一时长同一缓动、同一帧到终点——时长错开会出现"先隐身的卡片还在收高度、
      兄弟慢爬后急停"的收尾顿挫；
   2) 选择器叠成 .session-card.session-anim-*（0-2-0）压过 ACard 根上的
      transition: all var(--aide-ease-t)（0-1-0），否则离场过渡被它接管。 */
.session-card.session-anim-enter-active,
.session-card.session-anim-leave-active {
  transition:
    opacity 0.24s cubic-bezier(0.4, 0, 0.2, 1),
    transform 0.24s cubic-bezier(0.4, 0, 0.2, 1),
    max-height 0.24s cubic-bezier(0.4, 0, 0.2, 1),
    margin 0.24s cubic-bezier(0.4, 0, 0.2, 1),
    padding 0.24s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}

.session-card.session-anim-enter-from {
  opacity: 0;
  transform: translateY(-6px);
}

.session-card.session-anim-leave-active {
  /* 收拢期间保持 in-flow（脱离文档流会让兄弟补位丢失布局依据）。
     起点高度由 @leave 钩子写入 --session-leave-h（真实卡高）——max-height 必须
     有有限起点（none→0 不可过渡），但不能拍固定上界：上界高于真实卡高时前段
     空跑、收拢被压进末段，收尾有顿挫感。 */
  position: relative;
  max-height: var(--session-leave-h, 100px);
}

.session-card.session-anim-leave-to {
  opacity: 0;
  transform: translateX(-12px);
  max-height: 0;
  margin-top: 0;
  margin-bottom: 0;
  padding-top: 0;
  padding-bottom: 0;
}

.session-anim-move {
  transition: transform 0.24s cubic-bezier(0.4, 0, 0.2, 1);
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

/* ── 会话加载骨架（per-workspace）──
   加载态按工作区隔离后，「加载中」从全局文本变成本工作区展开区内的假会话卡：
   外壳复刻 ACard（raised 底 + 细描边 + radius-lg + 16px 内边距），切换真卡时
   只有文字线消失、卡轮廓不动；线条脉冲语言与 MarketplaceTab 的 skel-line 一致
   （surface-hover 底 + 呼吸透明度）。 */
.session-skel-card {
  margin: 0 10px 6px 24px;
  padding: 16px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-lg);
}

.session-skel-line {
  height: 11px;
  border-radius: 4px;
  background: var(--aide-surface-hover);
  animation: session-skel-pulse 1.5s ease-in-out infinite;
}

.session-skel-title {
  width: 55%;
  margin-bottom: 8px;
}

.session-skel-preview {
  width: 80%;
  height: 10px;
}

@keyframes session-skel-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 0.7; }
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  flex-shrink: 0;
  color: var(--aide-accent);
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
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-md);
  box-shadow: var(--aide-shadow-md), var(--aide-highlight-inset);
  z-index: 100;
  padding: 4px;
  backdrop-filter: var(--aide-surface-blur);
  animation: dropdown-up var(--aide-ease-t);
}

@keyframes dropdown-up {
  from { opacity: 0; transform: translateY(4px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.provider-dropdown {
  animation: dropdown-up var(--aide-ease-t);
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  width: 18px;
  flex-shrink: 0;
  color: var(--aide-accent);
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

/* ── 工作区信任徽标 ── */
.ws-trust-badge {
  font-size: 9.5px;
  font-weight: 600;
  color: var(--aide-warning);
  background: color-mix(in srgb, var(--aide-warning) 15%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-warning) 32%, transparent);
  padding: 1.5px 6px;
  border-radius: var(--aide-radius-sm);
  letter-spacing: 0.3px;
  flex: 0 0 auto;
  cursor: pointer;
  transition: background var(--aide-ease-t);
}
.ws-trust-badge:hover {
  background: color-mix(in srgb, var(--aide-warning) 24%, transparent);
}
.workspace-item.untrusted:not(.active):not(.expanded) .ws-folder-icon {
  color: var(--aide-warning);
}

/* ── 信任提示模态（Variant A 居中）── 经 Teleport 渲染到 body，scoped 仍生效。 */
.trust-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(12, 10, 16, 0.72);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  animation: trust-fade var(--aide-ease-t);
}
@keyframes trust-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
.trust-modal {
  width: 440px;
  max-width: 100%;
  background:
    linear-gradient(180deg, rgba(255, 235, 210, 0.03), transparent 60px),
    var(--aide-bg-raised);
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg);
  box-shadow: var(--aide-shadow-lg);
  padding: 22px 22px 18px;
  animation: trust-pop var(--aide-ease-t);
}
@keyframes trust-pop {
  from { opacity: 0; transform: translateY(6px) scale(0.98); }
  to { opacity: 1; transform: none; }
}
.trust-shield {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: var(--aide-accent-subtle);
  border: 1px solid color-mix(in srgb, var(--aide-accent) 30%, transparent);
  display: grid;
  place-items: center;
  color: var(--aide-accent);
  margin-bottom: 14px;
}
.trust-title {
  margin: 0 0 4px;
  font-size: 16px;
  font-weight: 600;
}
.trust-path {
  font-size: 12px;
  color: var(--aide-text-muted);
  font-family: "Cascadia Code", "Consolas", monospace;
  margin: 0 0 12px;
  word-break: break-all;
}
.trust-desc {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--aide-text-secondary);
}
.trust-list {
  margin: 6px 0 12px;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.trust-list li {
  font-size: 12.5px;
  color: var(--aide-text-secondary);
  display: flex;
  align-items: center;
  gap: 7px;
}
.trust-list li .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--aide-warning);
  flex: 0 0 auto;
}
.trust-list code {
  font-family: "Cascadia Code", "Consolas", monospace;
  font-size: 11.5px;
}
.trust-note {
  margin: 0;
  font-size: 12.5px;
  color: var(--aide-text-muted);
}
.trust-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}
.btn {
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  border: 1px solid transparent;
  padding: 8px 16px;
  transition: all var(--aide-ease-t);
}
.btn.secondary {
  background: var(--aide-surface-default);
  color: var(--aide-text-secondary);
  border-color: var(--aide-border-strong);
}
.btn.secondary:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
.btn.primary {
  background: var(--aide-accent-gradient, linear-gradient(180deg, #e6bd8e, #cf9c66));
  color: var(--aide-text-on-accent);
  box-shadow: var(--aide-accent-glow, 0 6px 20px rgba(212, 165, 116, 0.28));
  border-color: color-mix(in srgb, var(--aide-accent) 40%, transparent);
}
.btn.primary:hover {
  filter: brightness(1.06);
}
</style>
