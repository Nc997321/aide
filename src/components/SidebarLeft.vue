<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { timeAgo } from "../utils/time";
import { useContextMenu } from "../composables/useContextMenu";
import { useSessionState } from "../composables/useSessionState";
import { useUpdate } from "../composables/useUpdate";
import { useRecent } from "../composables/useRecent";
import { useSessionNames } from "../composables/useSessionNames";
import { useSessionWorkspaces } from "../composables/useSessionWorkspaces";
import { sessionMenuItems, sessionSectionMenuItems, workspaceMenuItems } from "../menus/contextMenus";
import { useWorkspaces } from "../composables/useWorkspaces";
import { useSettings } from "../composables/useSettings";
import { useWorkspaceTrust } from "../composables/useWorkspaceTrust";
import { useCodeGraphProgress } from "../composables/useCodeGraphProgress";
import { api, openExternal } from "../api";
import AToast from "../ui/AToast.vue";
import AppLogo from "./AppLogo.vue";
import AutomationSidebarSection from "./automation/AutomationSidebarSection.vue";
import MarketplaceSidebarEntry from "./marketplace/MarketplaceSidebarEntry.vue";
import SidebarSectionHead from "./SidebarSectionHead.vue";
import { useToast } from "../composables/useToast";
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
  "open-memory-observatory": [];
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
/** 品牌区版本号（onMounted 里 getVersion 拉取，与更新检查共用一次调用）。 */
const appVersion = ref("");
/** 「会话」分区折叠态（与自动化分区平级，VS Code 资源管理器语义）。
 *  注意与下方 sessionsCollapsed(wsKey)（「另外 N 个」分页折叠）是两回事。 */
const sessionsSectionCollapsed = ref(false);
/** 全工作区会话总数（会话分区头的计数徽标）。 */
const totalSessionCount = computed(() =>
  Object.values(sessionsByWorkspace.value).reduce((n, list) => n + list.length, 0),
);

// ── 工作区信任提示（Variant A 居中模态）── trustPrompt 非 null 时显示。
// 不信任工作区首次激活时弹一次（maybePromptTrust），「暂不」后本会话不再弹；
// 工作区行 ⋯ 菜单的「信任此工作区」项可重开（openTrustPrompt = 回收路径）。
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
  return list.filter((s) => s.name.toLowerCase().includes(q));
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

// 从（可能非活动的）工作区打开会话：只打开，不切换活动工作区。
// 会话自带归属（useSessionWorkspaces 注册表：发消息 cwd / tab 后缀 / 归属校验
// 都走它），后端按全局唯一 session id 定位 JSONL，均不依赖活动工作区；
// 文件树 / git / run 面板仍跟随活动工作区不动。
// 切工作区的入口只剩三处：侧栏工作区头部点击（switchWorkspace）、文件树切换器
// （switchToWorkspaceByKey）、打开目录（openWorkspaceFolder）。
// 仅预览，不记录最近会话——只有真正"启动"（Agent SDK send_message）的会话才入列，
// 记录在 App.onNewSession 完成。
function selectSessionFromWorkspace(_wsKey: string, sessionId: string) {
  emit("session-changed", sessionId);
}

function openUpdate() {
  if (downloadUrl.value) openExternal(downloadUrl.value);
}

function switchWorkspace(ws: WorkspaceInfo) {
  // 工作区头部点击 = 纯展开/收起开关，与激活态无关（VS Code 语义）：
  // 展开/查看列表不改变活动工作区——与点会话只打开同一逻辑，工作区上下文
  // 只由文件树 path-bar 切换器（switchToWorkspaceByKey）与打开目录改变。
  // 展开非活动工作区时补加载其会话列表（未加载过才拉，避免每次展开都请求）。
  if (expandedWorkspaces.value.has(ws.key)) {
    expandedWorkspaces.value.delete(ws.key);
    return;
  }
  expandedWorkspaces.value.add(ws.key);
  if (!sessionsByWorkspace.value[ws.key]) {
    void loadWsSessions(ws.key);
  }
}

/** 真正把某个工作区设为活动：setWorkspace + 更新本地状态 + 广播 workspace-changed。
 *  唯一入口是文件树 path-bar 切换器（switchToWorkspaceByKey）。 */
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
  } catch (e) {
    // 乐观更新失败 → UI 与磁盘脱节：报错 + 重新拉取该工作区真实列表恢复
    console.error("[SidebarLeft] rename failed:", e);
    showToast("重命名失败，列表已恢复", "danger");
    await loadWsSessions(wsKey);
  }
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
 * 离场收拢起点校准：CSS 无法预知真实卡片高度。在 leave 钩子（先于 leave-active
 * 类生效）把真实高度写进 CSS 变量，让 max-height 从精确值收拢到 0——若从固定
 * 上界（如 100px）起播，前段数值大于真实高度时视觉空跑、收拢被压进末段，
 * 收尾会有顿挫感。
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
    sessionMenuItems(id, {
      onRenamed: (name: string) => renameSession(wsKey, id, name),
      onOptimisticRemove: () => removeSessionLocally(wsKey, id),
      onDeleteFailed: () => onSessionDeleteFailed(wsKey),
    }),
  );
}

/** 「会话」导航行 ⋯：新建入口（v3 右槽位交互，与右键体系同一个 useContextMenu）。 */
function onSessionSectionMenu(e: MouseEvent) {
  show(e.clientX, e.clientY, sessionSectionMenuItems(newSession));
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
      // 不受信任工作区：行内不再放「不受信任」文字徽标，信任入口收进此菜单
      !ws.missing && untrustedPaths.value.has(ws.name) ? () => openTrustPrompt(ws) : undefined,
    ),
  );
}

function newSession() {
  const name = `新会话 ${new Date().toLocaleTimeString()}`;
  emit("new-session", name);
}

onMounted(async () => {
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
    appVersion.value = await api.appVersion();
    const { checkUpdate } = useUpdate();
    await checkUpdate(appVersion.value);
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
    <!-- 品牌区（WorkBuddy 式：logo + 名称 + 版本号，固定不随列表滚动） -->
    <div class="brand">
      <AppLogo :size="34" />
      <div>
        <div class="brand-name">Aide</div>
        <div class="brand-ver">{{ appVersion ? `v${appVersion}` : "" }}</div>
      </div>
    </div>

    <!-- Workspace + Session list（「会话」降级为分区树的根分区之一，与自动化平级；
         session-style-* 挂会话列表样式皮肤（card/row，设置「主题样式」tab 切换）） -->
    <div class="session-list" :class="`session-style-${settings.sessionListStyle ?? 'card'}`">
      <SidebarSectionHead
        label="会话"
        :count="totalSessionCount || undefined"
        :expanded="!sessionsSectionCollapsed"
        @toggle="sessionsSectionCollapsed = !sessionsSectionCollapsed"
        @menu="onSessionSectionMenu"
      >
        <template #icon>
          <svg viewBox="0 0 24 24" fill="none"><path d="M21 15C21 15.53 20.79 16.04 20.41 16.41C20.04 16.79 19.53 17 19 17H7L3 21V5C3 4.47 3.21 3.96 3.59 3.59C3.96 3.21 4.47 3 5 3H19C19.53 3 20.04 3.21 20.41 3.59C20.79 3.96 21 4.47 21 5V15Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </template>
      </SidebarSectionHead>

      <template v-if="!sessionsSectionCollapsed">
      <!-- 子树容器：沿分区头 chevron 中轴右移 + 1px 引导线（v3.1 层级修正方案A），
           让「会话 > 工作区 > 会话行」的父子关系在视觉上成立 -->
      <div class="sec-subtree">
      <div v-if="workspacesLoading" class="session-empty muted">加载中...</div>

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
          @contextmenu="onWorkspaceContextMenu($event, ws)"
        >
          <svg v-if="!ws.missing" class="ws-chevron" :class="{ expanded: expandedWorkspaces.has(ws.key) }" width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <svg v-if="ws.missing" class="ws-warn-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <!-- 不受信任工作区：碎盾图标替代层叠图标（恒警示色），信任入口收进行尾 ⋯ 菜单 -->
          <svg v-if="!ws.missing && untrustedPaths.has(ws.name)" class="ws-icon ws-shield-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
            v-tooltip="'工作区不受信任，⋯ 菜单可信任'">
            <path d="M12 3L19 5.8V11c0 4.2-2.8 7.1-7 8.5C7.8 18.1 5 15.2 5 11V5.8L12 3Z"/>
            <path d="M12 6.8L10.5 9.6L13.2 11.5L11.2 14.6"/>
          </svg>
          <svg v-else-if="!ws.missing" class="ws-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3L21.5 7.8L12 12.6L2.5 7.8L12 3Z"/>
            <path d="M2.5 12.3L12 17.1L21.5 12.3"/>
            <path d="M2.5 16.8L12 21.6L21.5 16.8"/>
          </svg>
          <span class="ws-name" v-tooltip="ws.missing ? '' : workspaceLabel(ws)">{{ workspaceLabel(ws) }}</span>
          <!-- 右槽位：计数 ⇄ ⋯（hover 互换）；⋯ 与右键同一份 workspaceMenuItems -->
          <span class="ws-slot" @click.stop>
            <span v-if="!ws.missing && (sessionsByWorkspace[ws.key] ?? []).length > 0" class="ws-count">{{ (sessionsByWorkspace[ws.key] ?? []).length }}</span>
            <button class="row-dots" v-tooltip="'更多操作'" @click="onWorkspaceContextMenu($event, ws)">
              <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
            </button>
          </span>
        </div>

        <!-- Sessions (for any expanded workspace) -->
        <template v-if="expandedWorkspaces.has(ws.key)">
          <!-- 会话加载按工作区隔离：骨架只占本工作区展开区，其余工作区原地不动 -->
          <div v-if="sessionsLoading.has(ws.key)" class="session-skel-list">
            <div v-for="i in 2" :key="i" class="session-skel-card">
              <div class="session-skel-line session-skel-title"></div>
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
              <!-- 会话条目：状态点已移除，状态（颜色/脉动逻辑）整体搬到左缘流光——
                   绿=running / 蓝=waiting（回复完成待输入）/ 黄=attention（权限等待）/
                   红=warning / 橙=stalled，dead 无流光；右槽位 时间⇄⋯ 与右键同一份菜单 -->
              <div
                v-for="s in visibleSessions(ws.key)"
                :key="s.id"
                class="session-row"
                :class="[{ on: props.activeSessionId === s.id }, `tone-${dotTone(s.id)}`]"
                @click="selectSessionFromWorkspace(ws.key, s.id)"
                @contextmenu.prevent="onSessionContextMenu($event, ws.key, s.id)"
              >
                <div class="session-row-r1">
                  <span class="session-name">{{ sessionNames.names[s.id] || s.name }}</span>
                  <span class="session-slot" @click.stop>
                    <span class="session-time">{{ timeAgo(s.timestamp) }}</span>
                    <button class="row-dots" v-tooltip="'更多操作'" @click="onSessionContextMenu($event, ws.key, s.id)">
                      <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
                    </button>
                  </span>
                </div>
              </div>
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
      </template>

      <!-- 自动化分区：分区树的第二个根分区（会话工作区树之下，同区滚动），
           选中任务由 App.vue 把主区切成 AutomationMain（PaneLayout v-show 保活） -->
      <AutomationSidebarSection />

      <!-- 插件市场入口：与自动化平级的导航行，单击切换主区 MarketplaceTab
           （插件市场已从设置页迁出为一级主区视图） -->
      <MarketplaceSidebarEntry />
    </div>

    <!-- Update banner -->
    <div v-if="updateAvailable" class="update-banner" @click="openUpdate">
      <div class="update-banner-body">
        <span class="update-dot">●</span>
        <span class="update-text">新版本 {{ latestVersion }}</span>
      </div>
      <button class="update-dismiss" v-tooltip="'忽略'" @click.stop="dismissUpdate">✕</button>
    </div>

    <!-- Status bar: actions（供应商切换已搬到标题栏 ProviderSwitcher；pin 随分区树改造从 header 挪到此处） -->
    <div class="status-bar">
      <div class="status-bar-actions">
        <button
          class="status-bar-btn pin"
          :class="{ pinned: props.pinned }"
          v-tooltip="props.pinned ? '取消固定（恢复自动隐藏）' : '固定侧栏'"
          @click="emit('toggle-pin')"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 17v5"/>
            <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/>
          </svg>
        </button>
        <button class="status-bar-btn" v-tooltip="'记忆观测台'" @click="emit('open-memory-observatory')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <ellipse cx="12" cy="5" rx="9" ry="3"/>
            <path d="M3 5v6c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/>
            <path d="M3 11v6c0 1.66 4.03 3 9 3s9-1.34 9-3v-6"/>
          </svg>
        </button>
        <button class="status-bar-btn" v-tooltip="'设置'" @click="emit('open-settings')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
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

.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0 8px;
}

/* ── 品牌区（WorkBuddy 式，固定不滚动）── */
.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 16px 16px 12px;
  flex-shrink: 0;
}
.brand :deep(.app-logo) {
  border-radius: 10px;
}
.brand-name {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.2px;
  color: var(--aide-text-primary);
}
.brand-ver {
  font-size: 10.5px;
  color: var(--aide-text-muted);
  margin-top: 2px;
}

/* ── 分区子树（v3.1 层级修正方案A：缩进 + 引导线）──
   分区头 chevron 中轴 ≈ margin 10 + padding 12 + chevron 半宽 6.5 = 28.5px，
   引导线落在 28px 与 chevron 同轴；子级行随之右移，父子层级一眼可读。 */
.sec-subtree {
  margin-left: 28px;
  border-left: 1px solid var(--aide-border-subtle);
}

/* ── Workspace item ── */

.workspace-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 12px;
  margin: 4px 8px 0 7px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: var(--aide-text-secondary);
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

.ws-icon {
  flex-shrink: 0;
  color: var(--aide-text-muted);
  transition: color 0.15s;
}

.workspace-item.active .ws-icon,
.workspace-item.expanded .ws-icon {
  color: var(--aide-accent);
}

.ws-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  /* flex 项下限兜底：缺了它名字长时不收缩，会把行尾 ⋯ 槽位顶出行外（.session-name 同款） */
  min-width: 0;
}

/* ── 行右槽位（工作区/会话行共用）：元信息 ⇄ ⋯，hover 整行互换。
   元信息流内撑开槽位（「17分钟前」这类长文本不溢出行边界）；
   ⋯ absolute 覆盖同一区域，hover 互换时槽位宽度不变、布局不抖。 ── */
.ws-slot,
.session-slot {
  position: relative;
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.ws-count {
  min-width: 26px;
  box-sizing: border-box;
  text-align: center;
  padding: 2px 7px;
  font-size: 10px;
  font-weight: 600;
  color: var(--aide-text-muted);
  background: var(--aide-surface-default);
  border-radius: 8px;
  transition: opacity 0.12s;
}

/* 无计数的工作区行（未展开/0 会话/失效）：槽位没有流内内容会塌成 0×0，
   absolute 的 ⋯ 只剩半颗悬在行外、hover 底色与 tooltip 锚点全无；
   给 26px 地板（= 计数徽标 min-width），⋯ 列跨行对齐、命中区域恒定。 */
.ws-slot {
  min-width: 26px;
}

.row-dots {
  position: absolute;
  /* 垂直方向不能依赖槽位高度：无计数时槽位 0 高，inset:0 会把按钮压成
     0 高、网格轨道从槽位顶边起排，图标整体偏下半颗身位；
     横向铺满槽位 + 固定高度 + 中线变换，槽位有无内容都锁定行中线 */
  left: 0;
  right: 0;
  top: 50%;
  height: 22px;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--aide-text-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s;
}
.row-dots svg {
  width: 15px;
  height: 15px;
}
.workspace-item:hover .ws-count,
.session-row:hover .session-time {
  opacity: 0;
}
.workspace-item:hover .row-dots,
.session-row:hover .row-dots {
  opacity: 1;
}
.row-dots:hover {
  background: var(--aide-surface-active);
  color: var(--aide-text-primary);
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

/* ── Session card 公共布局（两档皮肤共享：间距/圆角骨架/流光/动画）──
   皮肤差异（底色/描边/阴影/选中表达）拆到 .session-style-card / .session-style-row
   两档，由设置「主题样式 → 会话列表样式」切换；布局共享保证切换时列表不跳动。 */

.session-row {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  margin: 3px 8px 0 7px;
  cursor: pointer;
  border: 1px solid transparent;
  overflow: hidden; /* running 流光贴左缘，收进圆角内 */
  transition: all var(--aide-ease-t);
}

/* 皮肤·卡片（默认）：raised 底 + 描边 + 内阴影/投影 + 悬停光影加深 +
   选中 135° accent 渐变。悬停只走光影不做位移（位移会让底缘脱离光标形成振荡）。 */
.session-style-card .session-row {
  background: var(--aide-bg-raised);
  border-color: var(--aide-border-subtle);
  border-radius: var(--aide-radius-lg);
  box-shadow: var(--aide-highlight-inset), var(--aide-shadow-sm);
}
.session-style-card .session-row:hover {
  border-color: var(--aide-border-strong);
  box-shadow: var(--aide-highlight-inset), var(--aide-shadow-md);
}
.session-style-card .session-row.on {
  border-color: color-mix(in srgb, var(--aide-accent) 35%, transparent);
  background:
    linear-gradient(135deg, var(--aide-accent-subtle) 0%, transparent 60%),
    var(--aide-bg-raised);
}

/* 皮肤·行式：surface 淡底 + hover 加深 + 选中 accent-subtle 底 + 名称转 accent。
   选中不再用左侧 accent 竖条——引导线（.sec-subtree border-left）已是同位置的
   层级线语言，再叠一条竖条会形成「双线」拥挤；左缘只保留 running 绿色流光。 */
.session-style-row .session-row {
  background: var(--aide-surface-default);
  border-radius: var(--aide-radius-md);
}
.session-style-row .session-row:hover {
  background: var(--aide-surface-hover);
}
.session-style-row .session-row.on {
  background: var(--aide-accent-subtle);
}
.session-style-row .session-row.on .session-name {
  color: var(--aide-accent);
}

/* ── 状态流光：会话条目左缘 2px 竖条，原状态点（AStatusDot）的颜色/动效一比一搬来——
   绿 running / 蓝 waiting（回复完成待输入，常亮）/ 黄 attention（权限等待，脉动）/
   红 warning（可恢复错误，脉动）/ 橙 stalled（疑似卡住，脉动）；stopped（dead）无流光。
   优先级坍缩沿用 dotTone（dead > warning > stalled > attention/running/waiting）。 ── */
.session-row.tone-running::after,
.session-row.tone-waiting::after,
.session-row.tone-attention::after,
.session-row.tone-warning::after,
.session-row.tone-stalled::after {
  content: "";
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 2px;
  border-radius: 1px;
}
.session-row.tone-running::after {
  background: linear-gradient(180deg, transparent, var(--aide-success), transparent);
  animation: session-glow-pulse 2s ease-in-out infinite;
}
.session-row.tone-waiting::after {
  background: linear-gradient(180deg, transparent, var(--aide-info), transparent);
}
.session-row.tone-attention::after {
  background: linear-gradient(180deg, transparent, var(--aide-warning), transparent);
  animation: session-glow-pulse 2s ease-in-out infinite;
}
.session-row.tone-warning::after {
  background: linear-gradient(180deg, transparent, var(--aide-danger), transparent);
  animation: session-glow-pulse 2s ease-in-out infinite;
}
.session-row.tone-stalled::after {
  background: linear-gradient(180deg, transparent, var(--aide-stalled), transparent);
  animation: session-glow-pulse 2s ease-in-out infinite;
}
@keyframes session-glow-pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}

/* ── 会话行进出场 / 补位动画（TransitionGroup session-anim）──
   删除 = 乐观本地移除：行淡出+左滑+高度收拢，兄弟行平滑上移补位，
   不再整表 loadSessions（旧写法 loading 闪「加载中...」且 scrollTop 被钳回顶部）。
   新建会话插入顶部走同一条渲染路径，白得入场淡入。
   两条硬性细节：
   1) 所有属性同一时长同一缓动、同一帧到终点——时长错开会出现"先隐身的行还在收高度、
      兄弟慢爬后急停"的收尾顿挫；
   2) 选择器叠成 .session-row.session-anim-* 压过行根上的 transition。 */
.session-row.session-anim-enter-active,
.session-row.session-anim-leave-active {
  transition:
    opacity 0.24s cubic-bezier(0.4, 0, 0.2, 1),
    transform 0.24s cubic-bezier(0.4, 0, 0.2, 1),
    max-height 0.24s cubic-bezier(0.4, 0, 0.2, 1),
    margin 0.24s cubic-bezier(0.4, 0, 0.2, 1),
    padding 0.24s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}

.session-row.session-anim-enter-from {
  opacity: 0;
  transform: translateY(-6px);
}

.session-row.session-anim-leave-active {
  /* 收拢期间保持 in-flow（脱离文档流会让兄弟补位丢失布局依据）。
     起点高度由 @leave 钩子写入 --session-leave-h（真实行高）——max-height 必须
     有有限起点（none→0 不可过渡），但不能拍固定上界：上界高于真实行高时前段
     空跑、收拢被压进末段，收尾有顿挫感。 */
  position: relative;
  max-height: var(--session-leave-h, 100px);
}

.session-row.session-anim-leave-to {
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

.session-row-r1 {
  display: flex;
  align-items: center;
  gap: 8px;
}

.session-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--aide-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

/* 会话行右槽位元信息 = 时间（无底色 flat 形态；流内撑开槽位，hover 时让给 ⋯） */
.session-time {
  padding: 2px;
  font-size: 10.5px;
  color: var(--aide-text-muted);
  white-space: nowrap;
  transition: opacity 0.12s;
}

.session-more {
  margin: 2px 8px 0 7px;
  padding: 7px 12px 7px 20px;
  font-size: 11.5px;
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
  padding: 10px 12px 10px 20px;
  margin: 1px 8px 0 7px;
}

/* ── 会话加载骨架（per-workspace）──
   加载态按工作区隔离后，「加载中」从全局文本变成本工作区展开区内的假会话条目：
   外壳跟随会话列表样式皮肤（卡片档描边大圆角 / 行式档淡底中圆角），切换真条目时
   只有文字线消失、轮廓不动；线条脉冲语言与 MarketplaceTab 的 skel-line 一致
   （surface-hover 底 + 呼吸透明度）。 */
.session-skel-card {
  margin: 3px 8px 0 7px;
  padding: 12px 14px;
  border: 1px solid transparent;
}
.session-style-card .session-skel-card {
  background: var(--aide-bg-raised);
  border-color: var(--aide-border-subtle);
  border-radius: var(--aide-radius-lg);
}
.session-style-row .session-skel-card {
  background: var(--aide-surface-default);
  border-radius: var(--aide-radius-md);
}

.session-skel-line {
  height: 12px;
  border-radius: 4px;
  background: var(--aide-surface-hover);
  animation: session-skel-pulse 1.5s ease-in-out infinite;
}

.session-skel-title {
  width: 55%;
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

/* ── Status bar (actions) ── */

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

.status-bar-actions {
  display: flex;
  align-items: center;
  gap: 1px;
  flex-shrink: 0;
  margin-left: auto; /* 供应商切换搬走后，设置齿轮保持右对齐 */
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

/* 钉子按钮（分区树改造后挪到状态栏）：未固定斜 45°（"没钉上"），
   固定竖直 + accent 高亮（QQ 侧栏语义，沿用旧 header 的视觉约定） */
.status-bar-btn.pin svg {
  width: 13px;
  height: 13px;
  transform: rotate(45deg);
  transition: transform var(--aide-ease-t);
}
.status-bar-btn.pin.pinned {
  color: var(--aide-accent);
  background: var(--aide-accent-subtle);
}
.status-bar-btn.pin.pinned svg {
  transform: none;
}

/* ── 工作区信任状态图标 ── */
/* 碎盾（不受信任）恒为警示色：与 .workspace-item.active/.expanded .ws-icon
   的 accent 规则同优先级（0,3,0），本条位置靠后胜出 */
.workspace-item .ws-icon.ws-shield-icon {
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
  background: var(--aide-accent-gradient);
  color: var(--aide-text-on-accent);
  box-shadow: var(--aide-accent-glow);
  border-color: color-mix(in srgb, var(--aide-accent) 40%, transparent);
}
.btn.primary:hover {
  filter: brightness(1.06);
}
</style>
