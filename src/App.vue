<script setup lang="ts">
import SidebarLeft from "./components/SidebarLeft.vue";
import FileTree from "./components/FileTree.vue";
import ChangeLogPanel from "./components/ChangeLogPanel.vue";
import ContextMenu from "./components/ContextMenu.vue";
import ModalDialog from "./components/ModalDialog.vue";
import { defineAsyncComponent } from "vue";
const FileViewer = defineAsyncComponent(() => import("./components/FileViewer.vue"));
const SettingsPanel = defineAsyncComponent(() => import("./components/SettingsPanel.vue"));
const RunConfigsDialog = defineAsyncComponent(() => import("./components/RunConfigsDialog.vue"));
import PaneLayout from "./components/PaneLayout.vue";
import { useChatSession, isPendingSession } from "./composables/useChatSession";
import { usePaneLayout } from "./composables/usePaneLayout";
import { usePaneLayoutPersistence } from "./composables/paneLayout/persistence";
import { useSessionNames } from "./composables/useSessionNames";
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
import { marketplaceApi } from "./api/marketplace";
import { useNotifications } from "./composables/useNotifications";
import { ref, onMounted, onUnmounted, nextTick, watch, computed } from "vue";
import { useSettings } from "./composables/useSettings";
import { useWindowFocus } from "./composables/useWindowFocus";
import { useModal } from "./composables/useModal";
import { useNotification, pendingSessions, clearPending } from "./composables/useNotification";
import { useGit } from "./composables/useGit";
import { useSearchProviders } from "./composables/useSearchProviders";
import { useProviders } from "./composables/useProviders";
import { useGitWatcher } from "./composables/useGitWatcher";
import { useRunProject } from "./composables/useRunProject";
import { useRunProcess } from "./composables/useRunProcess";
import { useRunConfigs } from "./composables/useRunConfigs";
import { matchShortcut } from "./utils/shortcut";
import { applyTheme, themes } from "./themes";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useFileViewer } from "./composables/useFileViewer";
import { useRecent } from "./composables/useRecent";
import { useWorkspaces } from "./composables/useWorkspaces";
import { timeAgo } from "./utils/time";
import type { PaletteResult } from "./ui/ACommandPalette.vue";
import OpenFolderDialog from "./components/OpenFolderDialog.vue";
import RemoveWorkspaceDialog from "./components/RemoveWorkspaceDialog.vue";
import type { WorkspaceInfo } from "./types";

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
      name: info?.name || (isPendingSession(id) ? "新会话" : id.slice(0, 8)),
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

/** grid 轨道宽度的单一数据源：折叠态直接决定轨道本身，而不是只改子元素
 *  自身的 CSS 宽度——子元素默认按轨道 stretch，不需要再单独设 !important
 *  宽度。收起需要联动 .panel-center 的真实包围盒变化，FileViewer 的悬浮
 *  窗口层靠 ResizeObserver 量 .panel-center 才能正确重新平铺（见
 *  FileViewer.vue 顶部注释）——轨道不真的变，那层就量不到变化。 */
const gridTemplateColumns = computed(() => {
  const left = leftCollapsed.value ? "10px" : "var(--aide-left-w, 280px)";
  const right = rightCollapsed.value ? "10px" : "var(--aide-right-w, 300px)";
  return `${left} 1px minmax(400px, 1fr) 1px ${right}`;
});

const sidebarRef = ref<InstanceType<typeof SidebarLeft> | null>(null);
const fileTreeRef = ref<InstanceType<typeof FileTree> | null>(null);
const gitPanelRef = ref<InstanceType<typeof GitPanel> | null>(null);
const titleBarRef = ref<InstanceType<typeof TitleBar> | null>(null);
const paletteOpen = ref(false);
const paletteRef = ref<InstanceType<typeof ACommandPalette> | null>(null);
// 「当前会话」= 聚焦分屏组激活 tab 的会话——布局层的计算属性，所有下游
// （右面板 / 权限弹窗 / 标题栏 / 侧栏高亮）沿用旧的单一 activeSessionId 语义。
const paneLayout = usePaneLayout();
const paneLayoutPersistence = usePaneLayoutPersistence();
const activeSessionId = paneLayout.activeSessionId;
// App 级 useChatSession 只用来拿全局单例的 onSessionCreated 回调（module 级
// Set，跟传入的 session id 无关）——权限弹窗已经下沉进每个 PaneGroup 自己的
// ChatPanel（消息区和输入框之间，见 ChatPanel.vue/PermissionDialog.vue），
// 不再需要在这里为它单独绑定"聚焦会话"。
const { onSessionCreated } = useChatSession(computed(() => null));

// 会话首次创建：临时 key 拿到 SDK 确认的真实 id，这时才第一次落盘——
// 写元数据、加侧栏、记最近访问。之前什么都没写过，不存在"迁移"这一步。
// tab 绑定同步换成真实 id；空白面板预起的名字存放在 tab 上（takePendingName）。
onSessionCreated((tempId, realId) => {
  paneLayout.rebindSession(tempId, realId);
  const name = paneLayout.takePendingName(realId) || realId.substring(0, 8);
  useSessionNames().setName(realId, name);
  void api.createSession(realId, name).then((session) => {
    sidebarRef.value?.addSession({ id: session.id, name: session.name, timestamp: session.timestamp, last_message: "" });
    void useRecent().recordCurrentSession(session.id, session.name);
  });
});
const settingsVisible = ref(false);
const settingsInitialTab = ref<string | undefined>(undefined);
const { push: pushNotification, registerActionHandler } = useNotifications();
const { activeKey: activeWorkspaceKey } = useWorkspaces();
const workspacePath = ref("");
const projectName = ref("");
const { settings, update: updateSettings } = useSettings();

// 「打开方式」事件监听句柄，onUnmounted 时释放
let unlistenOpenFile: UnlistenFn | null = null;
const workbenchHeight = ref(settings.workbenchHeight || Math.floor(window.innerHeight * 0.45));
const wb = useWorkbenchTerminal();
const { run: runProject } = useRunProject();
const { runStatus, start: startRunProcess, stop: stopRunProcess, restart: restartRunProcess } = useRunProcess();
const { configs: runConfigs, activeConfig: activeRunConfig, load: loadRunConfigs, setActive: setActiveRunConfig } = useRunConfigs();
const runConfigsDialogVisible = ref(false);

// ── Workspace dialogs ──
const openFolderVisible = ref(false);
const openFolderError = ref("");
const removeWsVisible = ref(false);
const removeWsTarget = ref<WorkspaceInfo | null>(null);

async function onOpenFolder() {
  openFolderError.value = "";
  openFolderVisible.value = true;
}

async function onOpenFolderConfirm(path: string) {
  try {
    await sidebarRef.value?.openWorkspaceFolder(path);
    openFolderVisible.value = false;
    openFolderError.value = "";
  } catch (e: any) {
    openFolderError.value = typeof e === "string" ? e : (e?.message ?? "打开目录失败");
    // 保持弹窗打开，错误条由 dialog 内 v-model:error 显示
  }
}

function onRemoveWorkspace(ws: WorkspaceInfo) {
  removeWsTarget.value = ws;
  removeWsVisible.value = true;
}

async function onRemoveWorkspaceConfirm(mode: "hide" | "delete") {
  const ws = removeWsTarget.value;
  if (!ws) return;
  try {
    const ok = await sidebarRef.value?.removeWorkspaceByKey(ws.key, mode);
    if (!ok && mode === "delete") {
      await notice("无法移除", "该工作区有正在运行的会话，请先停止再移除。", "知道了");
    } else if (mode === "delete") {
      wb.killWorkspaceTerminals(ws.key);
    }
  } catch (e: any) {
    const msg = typeof e === "string" ? e : (e?.message ?? "移除工作区失败");
    await notice("移除工作区失败", msg, "知道了");
  }
  removeWsVisible.value = false;
  removeWsTarget.value = null;
}

// Persist workbench height changes to settings
function onWorkbenchHeightChange(v: number) {
  workbenchHeight.value = v;
  updateSettings({ workbenchHeight: v });
}

// ── Notification banner for completed sessions ──
const { isFocused } = useWindowFocus();
const { notice } = useModal();
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
  // 打开语义（预览覆盖/全局唯一聚焦）由布局层统一裁决
  paneLayout.openSession(id);
}

function onNewSession(name: string) {
  // 打开空白可输入面板（预览 tab）；不落盘、不进侧栏。真正创建推迟到
  // 用户发出第一条消息、SDK 用 session_init 确认真实 id 之后（onSessionCreated）。
  paneLayout.openBlankTab(name);
}

async function onSidebarWsChanged(path: string) {
  workspacePath.value = path;
  projectName.value = path.split(/[\\/]/).filter(Boolean).pop() || path;
  // 混合 tab 布局：切换活动工作区不动聊天区的 tab（布局是全局一份）
  await fileTreeRef.value?.loadRoot();
  if (rightTab.value === "git") gitPanelRef.value?.reload();
  // Load run configurations for this workspace (auto-detects on first open).
  loadRunConfigs(path, path);
}

// Sync workbench terminal's active workspace when switching workspaces
watch(activeWorkspaceKey, (k) => {
  if (k) wb.setActiveWorkspace(k);
});

/** 把绝对路径转成相对当前工作区的展示路径；不在工作区内则原样返回。 */
function relPath(p: string): string {
  const root = workspacePath.value;
  if (root && p.toLowerCase().startsWith(root.toLowerCase())) {
    return p.slice(root.length).replace(/^[\\/]+/, "");
  }
  return p;
}

const { setActiveProvider, load: loadProviders, refreshSystemDefaultModels } = useProviders();

async function onProviderSwitch(providerId: string) {
  await setActiveProvider(providerId);
}

function openSettingsProviders() {
  settingsInitialTab.value = "providers";
  settingsVisible.value = true;
}

function openSettings() {
  settingsInitialTab.value = undefined;
  settingsVisible.value = true;
}

function openSettingsMarket() {
  settingsInitialTab.value = "marketplace";
  settingsVisible.value = true;
}

async function onRunProject() {
  const cfg = activeRunConfig.value;
  if (cfg) {
    await startRunProcess(cfg);
  } else {
    // Fallback: no config detected, use legacy workbench send
    runProject();
  }
}

async function onStopProject() {
  await stopRunProcess();
}

async function onRestartProject() {
  const cfg = activeRunConfig.value;
  if (!cfg) return;
  await restartRunProcess(cfg);
}

function onSelectRunConfig(id: string) {
  setActiveRunConfig(id);
}

function handleKeydown(e: KeyboardEvent) {
  // ── App-level shortcuts (fire regardless of focus, including inside xterm.js) ──

  // Ctrl+`: toggle workbench terminal — checked FIRST, before any potentially-
  // throwing settings lookups. Use e.code (physical key, layout-independent)
  // rather than e.key (which Ctrl may alter on some platforms).
  if (e.ctrlKey && (e.code === "Backquote" || e.key === "`")) {
    e.preventDefault();
    e.stopPropagation();
    wb.toggle();
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

  // ── 聊天区分屏/tab 快捷键（可在设置里改键） ──
  const kb = settings.keybindings;
  if (matchShortcut(e, kb?.paneSplitRight || "Ctrl+\\")) {
    e.preventDefault();
    e.stopPropagation();
    paneLayout.splitFocusedGroup("horizontal");
    return;
  }
  if (matchShortcut(e, kb?.paneSplitDown || "Ctrl+Shift+\\")) {
    e.preventDefault();
    e.stopPropagation();
    paneLayout.splitFocusedGroup("vertical");
    return;
  }
  if (matchShortcut(e, kb?.paneCloseTab || "Ctrl+W")) {
    e.preventDefault();
    e.stopPropagation();
    paneLayout.closeActiveTab();
    return;
  }
  // Ctrl+Tab / Ctrl+Shift+Tab：OS Alt+Tab 语义的 MRU 会话切换（跨分屏组全局）。
  // 按住 Ctrl 连按 Tab 沿最近使用列表回溯，松开 Ctrl 提交（见 handleKeyup）。
  if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === "Tab") {
    e.preventDefault();
    e.stopPropagation();
    paneLayout.mruSwitch(e.shiftKey ? -1 : 1);
    return;
  }

  // Ctrl+N: new session
  if (e.ctrlKey && (e.code === "KeyN" || e.key === "n")) {
    e.preventDefault();
    e.stopPropagation();
    sidebarRef.value?.newSession();
  }
}

function handleKeyup(e: KeyboardEvent) {
  // Ctrl 松开 = MRU 回溯提交（无回溯在途时是 no-op）
  if (e.key === "Control") paneLayout.endMruSwitch();
}

onMounted(async () => {
  // Apply default theme before any rendering
  applyTheme(themes["warm-dark"]);

  window.addEventListener("keydown", handleKeydown, { capture: true });
  window.addEventListener("keyup", handleKeyup, { capture: true });

  // Load persisted settings
  const { load: loadSettings } = useSettings();
  await loadSettings();

  // Apply persisted theme (overrides the default warm-dark if user chose differently)
  const themeId = settings.theme || "warm-dark";
  const themeTokens = themes[themeId] || themes["warm-dark"];
  applyTheme(themeTokens);

  // Load provider configuration
  await loadProviders();
  // 启动时拉最新模型覆盖"系统默认"5 字段——fire-and-forget 不 await，UI 先渲染，
  // 拉完响应式刷新 systemDefaultMappings（ProviderSettings 系统默认下 5 字段只读）。
  // 无认证/网络失败时 Rust 侧保留旧值，前端不阻塞。
  void refreshSystemDefaultModels();
  // Start tracking window focus for notifications
  const { init: initWindowFocus } = useWindowFocus();
  initWindowFocus();

  // Initialize notification watcher
  useNotification();

  // Start git fingerprint watcher (auto-refresh on external changes)
  useGitWatcher();

  // 布局持久化：先装 watch（debounce 落盘），工作区确定后恢复全局快照
  paneLayoutPersistence.install();

  // Seed workbench cwd from the current project root.
  try {
    const info = await api.getProjectInfo();
    if (info?.root) {
      workspacePath.value = info.root;
      projectName.value = info.name;
      loadRunConfigs(info.root, info.root);
      void paneLayoutPersistence.restoreAtStartup();
    }
  } catch (_) { /* best effort */ }

  // Sync workbench terminal's active workspace with the current project root
  if (activeWorkspaceKey.value) wb.setActiveWorkspace(activeWorkspaceKey.value);

  // Initialize search providers for the title bar search box
  const { initProviders: initSearchProviders, search: searchProviders } = useSearchProviders();
  initSearchProviders(
    async () => {
      try { return await api.listSessions(); } catch { return []; }
    },
    (sessionId) => { paneLayout.openSession(sessionId); },
    () => workspacePath.value,
  );

  // Wire the search function into the palette
  nextTick(() => {
    paletteRef.value?.setSearchFn(async (q: string, limit: number) => {
      const rawResults = await searchProviders(q, limit);
      return rawResults.map((r) => ({
        ...r,
        group: r.icon === "session" ? "会话" : r.icon === "file" ? "文件" : (r.icon === "link" || r.icon === "search") ? "符号" : "其他",
      }));
    });
  });

  // 把「最近访问」注入面板：空查询时展示最近会话 + 最近文件
  nextTick(() => {
    paletteRef.value?.setRecentFn(async (): Promise<PaletteResult[]> => {
      const { sessions, files } = useRecent();
      const out: PaletteResult[] = [];
      for (const s of sessions.value) {
        out.push({
          id: "rs-" + s.session_id,
          label: s.name,
          description: `${s.ws_name} · ${timeAgo(s.ts)}`,
          icon: "session",
          group: "最近会话",
          action: () => {
            sidebarRef.value?.selectSessionFromWorkspace(s.ws_key, s.session_id);
          },
        });
      }
      for (const f of files.value) {
        out.push({
          id: "rf-" + f.path,
          label: f.name,
          description: `${relPath(f.path)} · ${timeAgo(f.ts)}`,
          icon: "file",
          group: "最近文件",
          action: () => {
            useFileViewer().open(f.path);
          },
        });
      }
      return out;
    });
  });

  // ── 「打开方式」预览接线 ──
  // 热启动：single-instance 回调 emit "open-file-preview"
  // 冷启动：consume_pending_open_file 取回 setup 暂存的待预览路径兜底
  const { open: openFileViewer } = useFileViewer();
  try {
    const pending = await api.consumePendingOpenFile();
    if (pending) openFileViewer(pending);
  } catch (_) { /* best effort */ }
  try {
    unlistenOpenFile = await listen<string>("open-file-preview", (e) => {
      if (e.payload) openFileViewer(e.payload);
    });
  } catch (_) { /* best effort */ }

  // 注册「查看」动作：市场更新通知点击 → 打开设置 → 市场标签页
  registerActionHandler("marketplace", () => openSettingsMarket());

  // 启动后台静默检查插件市场更新（方案 B：只通知，不自动应用）
  // 通知走应用内通知中心（右上角铃铛），不走系统通知。
  void (async () => {
    try {
      const sources = await marketplaceApi.listMarketplaceSources();
      const enabled = sources.filter((x) => x.enabled);
      if (enabled.length === 0) return;
      let failed = 0;
      for (const s of enabled) {
        try { await marketplaceApi.refreshMarketplace(s.id); }
        catch { failed++; }
      }
      // 全部启用源都失败 → 通知拉取失败（warning 落盘，重启仍可见）
      if (failed === enabled.length) {
        pushNotification({
          severity: "warning",
          source: "marketplace",
          title: "市场更新拉取失败",
          body: "无法连接市场源，请检查网络或代理。",
          timestamp: Date.now(),
          dedupKey: "marketplace:fetch-failed",
        });
        return;
      }
      // 比对已装插件版本，统计有更新的数量
      const installed = await marketplaceApi.listInstalledPlugins();
      let updates = 0;
      for (const s of enabled) {
        try {
          const list = await marketplaceApi.fetchMarketplace(s.id);
          for (const p of list) {
            if (p.version && installed.some((i) => i.market === p.marketName && i.name === p.name && i.version !== p.version)) {
              updates++;
            }
          }
        } catch { /* 单源失败已在上方统计 */ }
      }
      // 有更新 → 通知（info 仅内存；「查看」动作经 registerActionHandler 打开市场标签页）
      if (updates > 0) {
        pushNotification({
          severity: "info",
          source: "marketplace",
          title: `${updates} 个插件有更新`,
          body: "点击「查看」打开市场更新。",
          timestamp: Date.now(),
          dedupKey: "marketplace:updates",
          action: { label: "查看" },
        });
      }
    } catch { /* 静默：启动检查不应影响主流程 */ }
  })();
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeydown, { capture: true });
  window.removeEventListener("keyup", handleKeyup, { capture: true });
  wb.dispose();
  unlistenOpenFile?.();
});
</script>

<template>
  <div class="app-shell">
    <TitleBar
      ref="titleBarRef"
      :project-name="projectName"
      :git-branch="currentBranch"
      :active-sessions="activeSessionList"
      :run-configs="runConfigs"
      :active-run-config="activeRunConfig"
      :run-status="runStatus"
      :left-collapsed="leftCollapsed"
      :right-collapsed="rightCollapsed"
      @open-palette="paletteOpen = true"
      @select-session="(s) => sidebarRef?.selectSessionFromWorkspace(s.wsKey, s.id)"
      @run-project="onRunProject"
      @stop-project="onStopProject"
      @restart-project="onRestartProject"
      @select-run-config="onSelectRunConfig"
      @edit-run-configs="runConfigsDialogVisible = true"
      @toggle-left="leftCollapsed = !leftCollapsed"
      @toggle-right="rightCollapsed = !rightCollapsed"
      @open-folder="onOpenFolder"
    />

    <div
      class="app-layout"
      :class="{ 'is-dragging': leftResize.isDragging.value || rightResize.isDragging.value }"
      :style="{ gridTemplateColumns }"
    >
      <NotificationBanner
        :sessions="pendingSessionInfos"
        :visible="bannerVisible"
        @navigate="onBannerNavigate"
        @dismiss="onBannerDismiss"
      />

      <!-- Left panel -->
      <div class="panel-left" :class="{ collapsed: leftCollapsed }">
        <SidebarLeft
          v-show="!leftCollapsed"
          ref="sidebarRef"
          :active-session-id="activeSessionId"
          @session-changed="onSessionChanged"
          @new-session="onNewSession"
          @workspace-changed="onSidebarWsChanged"
          @open-settings="openSettings"
          @open-workbench="wb.toggle()"
          @provider-switch="onProviderSwitch"
          @open-settings-providers="openSettingsProviders"
          @remove-workspace="onRemoveWorkspace"
        />
      </div>

      <!-- Left resize handle -->
      <div
        v-show="!leftCollapsed"
        class="resize-handle resize-handle-left"
        :class="{ active: leftResize.isDragging.value }"
        @mousedown="leftResize.onMousedown"
      />

      <!-- Center panel: 多 tab + 任意分屏（每组自治接线见 panelayout/PaneGroup.vue） -->
      <div class="panel-center">
        <PaneLayout :workspace-path="workspacePath" class="h-full" />
      </div>

      <!-- Right resize handle -->
      <div
        v-show="!rightCollapsed"
        class="resize-handle resize-handle-right"
        :class="{ active: rightResize.isDragging.value }"
        @mousedown="rightResize.onMousedown"
      />

      <!-- Right panel -->
      <div class="panel-right" :class="{ collapsed: rightCollapsed }">
        <div v-show="!rightCollapsed" class="panel-right-inner">
          <ATabBar :tabs="rightTabs" v-model="rightTab" />

          <div class="tab-content">
            <FileTree
              v-show="rightTab === 'files'"
              ref="fileTreeRef"
              :session-id="activeSessionId"
              @switch-workspace="(wsKey) => sidebarRef?.switchToWorkspaceByKey(wsKey)"
            />
            <ChangeLogPanel v-show="rightTab === 'changes'" :session-id="activeSessionId" />
            <GitPanel v-show="rightTab === 'git'" ref="gitPanelRef" />
          </div>
        </div>
      </div>

      <!-- 文件窗口层：左缘起、止于文件树侧栏（可盖会话侧栏），边界随侧栏拖动实测 -->
      <FileViewer />

      <ContextMenu />
      <ModalDialog />
      <OpenFolderDialog v-model:visible="openFolderVisible" v-model:error="openFolderError" @confirm="onOpenFolderConfirm" />
      <RemoveWorkspaceDialog
        v-model:visible="removeWsVisible"
        :workspace="removeWsTarget"
        @confirm="onRemoveWorkspaceConfirm"
      />
      <SettingsPanel v-if="settingsVisible" :initial-tab="settingsInitialTab" @close="settingsVisible = false" />
      <RunConfigsDialog v-if="runConfigsDialogVisible" @close="runConfigsDialogVisible = false" />
      <WorkbenchTerminal :workspace-key="activeWorkspaceKey ?? ''" :cwd="workspacePath" :height="workbenchHeight" @update:height="onWorkbenchHeightChange" />
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
  position: relative; /* 文件窗口层（FileViewer）的定位锚点 */
  display: grid;
  /* 轨道宽度（含折叠态）由 gridTemplateColumns 计算属性通过 :style 绑定，
     单一数据源见 <script> 里的注释——这里不再写死，避免两处 grid 定义打架。 */
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

/* 五个轨道靠 grid-column 显式钉住，不依赖 DOM 书写顺序的自动布局——
   两侧的 resize-handle 收起时 v-show 会从文档流里摘掉（display:none 的元素
   不参与 grid 自动放置），少了一个参与放置的元素，后面所有兄弟就会顺位
   往前占位：panel-center 顶替进第 2 条（分隔线）轨道、panel-right 顶替进
   第 4 条，各自被压成 1px，聊天区整个视觉消失。显式钉死列号后，任何一侧
   隐藏都不会牵动其余四个的位置。 */
.panel-left {
  grid-column: 1;
  height: 100%;
  background-color: var(--aide-bg-deep);
  border-right: 1px solid var(--aide-border);
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
  min-width: 0;
}

.panel-center {
  grid-column: 3;
  height: 100%;
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background-color: var(--aide-bg-base);
}

.panel-right {
  grid-column: 5;
  height: 100%;
  background-color: var(--aide-bg-deep);
  border-left: 1px solid var(--aide-border);
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
  min-width: 0;
}

.resize-handle {
  width: 1px;
  background: var(--aide-border);
  cursor: col-resize;
  position: relative;
  transition: background 0.15s ease;
}

.resize-handle-left {
  grid-column: 2;
}

.resize-handle-right {
  grid-column: 4;
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

/* ── Right panel inner ── */

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
</style>
