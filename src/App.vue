<script setup lang="ts">
import SidebarLeft from "./components/SidebarLeft.vue";
import FileTree from "./components/FileTree.vue";
import ChangeLogPanel from "./components/ChangeLogPanel.vue";
import FileResolveOverlay from "./components/FileResolveOverlay.vue";
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
import { useOnboarding } from "./composables/useOnboarding";
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
import { useWorkspaceJdk } from "./composables/useWorkspaceJdk";
import { matchShortcut } from "./utils/shortcut";
import { applyTheme, themes } from "./themes";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { snapshotScrollTrail, probeRebuildChatScrollers } from "./utils/diagnostics/scrollTrail";
import { useFileViewer } from "./composables/useFileViewer";
import { useRecent } from "./composables/useRecent";
import { useWorkspaces } from "./composables/useWorkspaces";
import { useSessionWorkspaces } from "./composables/useSessionWorkspaces";
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
 *  FileViewer.vue 顶部注释）——轨道不真的变，那层就量不到变化。
 *  左侧栏未固定（QQ 式自动隐藏）时轨道归 0：侧栏脱离 grid 改走 overlay
 *  绝对定位（见 .panel-left.overlay），不占布局、覆盖内容。 */
const gridTemplateColumns = computed(() => {
  const left = !leftPinned.value
    ? "0px"
    : leftCollapsed.value
      ? "10px"
      : "var(--aide-left-w, 280px)";
  const right = rightCollapsed.value ? "10px" : "var(--aide-right-w, 300px)";
  return `${left} 1px minmax(400px, 1fr) 1px ${right}`;
});

// ── 左侧栏 QQ 式自动隐藏（钉子未固定时）──
// 默认完全隐藏；贴左边缘 6px 热区滑出（overlay 覆盖内容，不推布局）；
// 移开延迟收回。钉子固定后回到常驻 dock（上方 grid 轨道恢复）。
const leftPinned = computed(() => settings.leftSidebarPinned ?? true);
const leftOverlayOpen = ref(false);
let leftShowTimer: ReturnType<typeof setTimeout> | null = null;
let leftHideTimer: ReturnType<typeof setTimeout> | null = null;
const LEFT_SHOW_DELAY = 60;  // 贴边 intent 延迟，防路过误触
const LEFT_HIDE_DELAY = 250; // 移开延迟收回，防闪烁

function onLeftEdgeEnter() {
  if (leftHideTimer) { clearTimeout(leftHideTimer); leftHideTimer = null; }
  leftShowTimer = setTimeout(() => { leftOverlayOpen.value = true; }, LEFT_SHOW_DELAY);
}
function onLeftEdgeLeave() {
  if (leftShowTimer) { clearTimeout(leftShowTimer); leftShowTimer = null; }
}
function onLeftPanelEnter() {
  if (leftHideTimer) { clearTimeout(leftHideTimer); leftHideTimer = null; }
}
function onLeftPanelLeave() {
  if (leftPinned.value) return;
  leftHideTimer = setTimeout(() => { leftOverlayOpen.value = false; }, LEFT_HIDE_DELAY);
}
function toggleLeftPinned() {
  updateSettings({ leftSidebarPinned: !leftPinned.value });
  if (leftPinned.value) {
    // 切回 dock：清掉 overlay 态
    leftOverlayOpen.value = false;
    if (leftHideTimer) { clearTimeout(leftHideTimer); leftHideTimer = null; }
  }
}

/** TitleBar「展开/收起左侧栏」按钮：固定 dock 模式折叠轨道；未固定 overlay
 *  模式切换滑出/收回（等价于贴边热区的点击版）。 */
function onToggleLeft() {
  if (leftPinned.value) {
    leftCollapsed.value = !leftCollapsed.value;
  } else {
    if (leftShowTimer) { clearTimeout(leftShowTimer); leftShowTimer = null; }
    if (leftHideTimer) { clearTimeout(leftHideTimer); leftHideTimer = null; }
    leftOverlayOpen.value = !leftOverlayOpen.value;
  }
}

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
    // 归属读注册表（首发时 seed 的创建时绑定），不用「当前」工作区——
    // session_init 在途期间用户可能已切走
    const ws = useSessionWorkspaces().workspaceOf(realId);
    void useRecent().recordCurrentSession(
      session.id,
      session.name,
      ws ? { key: ws.wsKey, name: ws.wsPath } : undefined,
    );
  });
});
const settingsVisible = ref(false);
const settingsInitialTab = ref<string | undefined>(undefined);
const { push: pushNotification, registerActionHandler } = useNotifications();
const { activeKey: activeWorkspaceKey } = useWorkspaces();
const workspacePath = ref("");
const projectName = ref("");
const { settings, update: updateSettings, dismissJdkPrompt: persistJdkDismissal } = useSettings();
// 首次引导：onMounted 里 open()，未 onboarded 时弹全屏向导（OnboardingWizard 在 Task 3 挂载）
const onboarding = useOnboarding();

// 「打开方式」事件监听句柄，onUnmounted 时释放
let unlistenOpenFile: UnlistenFn | null = null;
const workbenchHeight = ref(settings.workbenchHeight || Math.floor(window.innerHeight * 0.45));
const wb = useWorkbenchTerminal();
const { run: runProject } = useRunProject();
const { runStates, start: startRunProcess, stop: stopRunProcess, restart: restartRunProcess } = useRunProcess();
const { configs: runConfigs, activeConfig: activeRunConfig, load: loadRunConfigs, setActive: setActiveRunConfig } = useRunConfigs();
// 工作区级 JDK 单例：工作区切换时 loadFor 刷新（run 注入 / 提示判定 / 只读展示同源）
const { jdkHome: workspaceJdk, loadFor: loadWorkspaceJdk } = useWorkspaceJdk();
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
const { notice, choice } = useModal();
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
  { id: "files", icon: tabIconFiles },
  { id: "changes", icon: tabIconChanges, badge: changeCount.value || undefined },
  { id: "git", icon: tabIconGit, badge: unstagedFiles.value.length || undefined },
]);

function onSessionChanged(id: string) {
  // 打开语义（预览覆盖/全局唯一聚焦）由布局层统一裁决
  paneLayout.openSession(id);
}

function onNewSession(name: string) {
  // 零会话欢迎态：欢迎页本身就是新建会话页，再开空白 tab 只是冗余
  if (!paneLayout.hasAnyTab.value) return;
  // 打开空白可输入面板（预览 tab）；不落盘、不进侧栏。真正创建推迟到
  // 用户发出第一条消息、SDK 用 session_init 确认真实 id 之后（onSessionCreated）。
  // 工作区归属在创建时绑定（布局全局一份，切工作区不动 tab，不快照就会落到
  // 发送时的「当前」工作区）。
  const wsKey = activeWorkspaceKey.value;
  const wsPath = workspacePath.value;
  paneLayout.openBlankTab(name, wsKey && wsPath ? { wsKey, wsPath } : undefined);
}

async function onSidebarWsChanged(path: string) {
  workspacePath.value = path;
  projectName.value = path.split(/[\\/]/).filter(Boolean).pop() || path;
  // 混合 tab 布局：切换活动工作区不动聊天区的 tab（布局是全局一份）
  await fileTreeRef.value?.loadRoot();
  if (rightTab.value === "git") gitPanelRef.value?.reload();
  // Load run configurations for this workspace (auto-detects on first open).
  await loadRunConfigs(path, path);
  // 顺序敏感：list_run_configs 在 Rust 侧做存量 JAVA_HOME→工作区 JDK 迁移，
  // 迁移完成后 loadWorkspaceJdk 才能读到迁移值；提示判定在两者就绪后再跑。
  await loadWorkspaceJdk(path);
  // 加载完再判断是否需要预防式 JDK 提示（await 保证 runConfigs 已就绪）。
  void maybePromptJdk(path);
}

// Sync workbench terminal's active workspace when switching workspaces
watch(activeWorkspaceKey, (k) => {
  if (k) wb.setActiveWorkspace(k);
});

// ── 文件树定位：FileWindow 按钮 → 切到文件标签 → 展开并高亮 ──
const { revealInTreePath } = useFileViewer();
watch(revealInTreePath, (path) => {
  if (!path) return;
  rightTab.value = "files";
  nextTick(() => {
    fileTreeRef.value?.revealFile(path);
    revealInTreePath.value = null; // 消费后重置
  });
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

async function onRunProject(id?: string) {
  // 从下拉行 ▶（带 id）直接跑该配置；主按钮 ▶（无 id）跑当前选中的。多模块可
  // 并行——启动一个不会停掉另一个。无 active 且无 id 时回退到旧 workbench send。
  const cfg = id ? runConfigs.value.find(c => c.id === id) : activeRunConfig.value;
  if (cfg) {
    await startRunProcess(cfg);
  } else if (!id) {
    runProject();
  }
}

async function onStopProject(id?: string) {
  // 停止指定配置（下拉行的 ⏹ 带 id）；主按钮的 ⏹ 不带 id → 停当前选中的。
  // 只停这一个，不影响其他并行模块。
  const targetId = id ?? activeRunConfig.value?.id;
  if (targetId) await stopRunProcess(targetId);
}

async function onRestartProject() {
  const cfg = activeRunConfig.value;
  if (!cfg) return;
  await restartRunProcess(cfg);
}

function onSelectRunConfig(id: string) {
  setActiveRunConfig(id);
}

// ── 预防式 JDK 提示（缺 JDK 才弹）──
// 工作区加载后，若存在 Java 命令的运行配置且本工作区尚未选 JDK（且未 dismiss 过），
// 弹一次 choice 引导用户去配置。JDK 是工作区级——一个工作区一个 JDK，所有模块
// 共享（Maven/Gradle 反应堆只有一个启动 JDK，per-module 是错误粒度，2026-08-08
// 拍板）；confirm 程序化展开标题栏 LSP 面板（工作区选择器 + 注册表扫描都在那里；
// 运行配置对话框已改只读展示，不再承载配置动作）。「稍后」落盘 dismiss 到
// config.json（AppSettings.jdkPromptDismissed，按 wsKey 键控）——重启 / 清
// WebView2 缓存都不丢。判定「Java 命令」看命令字含 mvn/gradle/gradlew/java，
// 零 IO、足够准（javascript/javadoc 等 \b 边界不命中）。

function isJavaCommand(cmd: string): boolean {
  return /\b(mvn|gradlew?|java)\b/i.test(cmd);
}

/** 工作区加载后调用：满足条件则弹一次「去配置 JDK」。 */
async function maybePromptJdk(wsKey: string): Promise<void> {
  if (!wsKey) return;
  // 切换工作区竞态：加载期间用户又切走 → 不弹（避免给错工作区弹窗）
  if (workspacePath.value !== wsKey) return;
  // 引导式语义：仅当该工作区「有 Java 配置且尚未选工作区 JDK」时才提示——
  // 一次性引导（让用户知道有按工作区选 JDK 这回事），而非逐模块盯梢；
  // 选过一次所有模块共享，真版本不符时会有明确 Java 报错，无需反复弹窗。
  const javaConfigs = runConfigs.value.filter((c) => isJavaCommand(c.command));
  if (javaConfigs.length === 0 || workspaceJdk.value) return;
  if ((settings.jdkPromptDismissed ?? []).includes(wsKey)) return;

  const registryEmpty = (settings.jdkRegistry ?? []).length === 0;
  const message = registryEmpty
    ? "检测到 Java 项目，尚未选择工作区 JDK，启动时可能因版本不匹配报错。需先扫描本机 JDK。"
    : "检测到 Java 项目，尚未选择工作区 JDK，启动时可能因版本不匹配报错。";
  const result = await choice("检测到 Java 项目", message, {
    confirmLabel: "去配置 JDK",
    altLabel: "稍后",
  });
  // choice 返回 "confirm" | "alt" | "cancel"。confirm → 展开标题栏 LSP 面板
  // （JDK 区块）；其余 → 落盘 dismiss。弹窗期间用户可能又切走工作区，
  // 展开前再校验一次当前工作区一致。
  if (result === "confirm" && workspacePath.value === wsKey) {
    titleBarRef.value?.openLspPanel();
  } else {
    void persistJdkDismissal(wsKey);
  }
}

/** 启动时检测：用户系统有 ~/.claude/ 且尚未迁移 → 弹一次性迁移引导。
 *  让 Aide 不再依赖系统 Claude CLI，同时把现有配置/历史会话拷到自管理目录。
 *  参照 maybePromptJdk 的「检测条件 → choice 三选」模式。 */
async function maybePromptMigration(): Promise<void> {
  let status;
  try {
    status = await api.checkClaudeMigration();
  } catch {
    return;
  }
  if (!status.legacyExists || status.done || status.dismissed || !status.hasMigratable) return;
  const result = await choice(
    "检测到现有 Claude 配置",
    "发现你已有 ~/.claude/ 配置（MCP 服务器、skills、agents、会话记录等）。"
      + "是否迁移到 Aide 自管理目录，让 Aide 不再依赖系统 Claude CLI？"
      + "原 ~/.claude/ 保留不动，可继续与 CLI 并用。",
    { confirmLabel: "迁移", altLabel: "不再提示" },
  );
  if (result === "cancel") return;            // 关闭 = 以后再问（下次启动再弹）
  if (result === "alt") {
    await api.dismissClaudeMigration();
    return;
  }
  // confirm → 执行迁移（重 IO，Rust 侧 spawn_blocking）
  try {
    const s = await api.migrateClaudeData();
    await notice(
      "迁移完成",
      `已从 ~/.claude/ 迁移到 Aide 自管理目录：拷贝 ${s.copiedCount} 项，跳过 ${s.skippedCount} 项（已存在的保留不动）。原 ~/.claude/ 未改动。`,
      "知道了",
    );
  } catch (e) {
    await notice("迁移失败", `迁移过程中出错：${e}`, "知道了");
  }
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

  // Esc: collapse workbench if visible (but don't steal from other overlays:
  // settings, palette, or the titlebar run-config dropdown).
  const fromRunDropdown = e.target instanceof Element && !!e.target.closest(".config-drop-panel");
  if (
    e.key === "Escape" &&
    wb.visible.value &&
    !settingsVisible.value &&
    !paletteOpen.value &&
    !fromRunDropdown
  ) {
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

  // Ctrl+Shift+D：滚动诊断环落盘——间歇性「滚轮定格」的活体取证（见
  // utils/diagnostics/scrollTrail.ts）。定格时按下，wheel 目标 / scrollTop
  // 写入者时间线写入 diagnostics/scroll-trail-<ts>.json，路径走通知中心反馈。
  if (e.ctrlKey && e.shiftKey && (e.code === "KeyD" || e.key === "D")) {
    e.preventDefault();
    e.stopPropagation();
    void dumpScrollTrail();
  }

  // Ctrl+Shift+R：滚动修复探针——定格现场重建滚动节点，复活即坐实滚轮路径
  // 缓存病（见 scrollTrail.ts 注释）；探针副作用是回到顶部。
  if (e.ctrlKey && e.shiftKey && (e.code === "KeyR" || e.key === "R")) {
    e.preventDefault();
    e.stopPropagation();
    const n = probeRebuildChatScrollers();
    pushNotification({
      severity: "info",
      source: "diagnostics",
      title: "滚动探针已执行",
      body: `重建了 ${n} 个对话滚动容器（回到顶部）。现在试试滚轮，然后 Ctrl+Shift+D 落盘`,
      timestamp: Date.now(),
      dedupKey: "scroll-probe",
    });
    return;
  }

  // Ctrl+Alt+I：打开 WebView2 devtools（release 活体解剖入口；避开 F12/Ctrl+Shift+I
  // 这类可能被浏览器加速器键拦截的组合）
  if (e.ctrlKey && e.altKey && (e.code === "KeyI" || e.key === "I")) {
    e.preventDefault();
    e.stopPropagation();
    void invoke("open_devtools").catch(() => {});
  }
}

/** 滚动诊断环快照 → Rust 落盘；诊断永不影响业务，失败仅通知。 */
async function dumpScrollTrail() {
  try {
    const path = await invoke<string>("diag_scroll_trail", {
      payload: JSON.stringify(snapshotScrollTrail()),
    });
    pushNotification({
      severity: "info",
      source: "diagnostics",
      title: "滚动诊断已落盘",
      body: path,
      timestamp: Date.now(),
      dedupKey: "scroll-trail-dump",
    });
  } catch (err) {
    pushNotification({
      severity: "warning",
      source: "diagnostics",
      title: "滚动诊断落盘失败",
      body: String(err),
      timestamp: Date.now(),
      dedupKey: "scroll-trail-dump",
    });
  }
}

function handleKeyup(e: KeyboardEvent) {
  // Ctrl 松开 = MRU 回溯提交（无回溯在途时是 no-op）
  if (e.key === "Control") paneLayout.endMruSwitch();
}

onMounted(async () => {
  // 首屏主题：优先 localStorage 缓存的主题 id（上次切换时 SettingsPanel 写入），
  // 避免浅色主题用户每次启动先闪一帧暗色兜底；无缓存才用默认主题 glass。
  let cachedTheme = "glass";
  try {
    const c = localStorage.getItem("aide.theme");
    if (c && themes[c]) cachedTheme = c;
  } catch { /* localStorage 不可用时保持兜底 */ }
  applyTheme(themes[cachedTheme]);

  window.addEventListener("keydown", handleKeydown, { capture: true });
  window.addEventListener("keyup", handleKeyup, { capture: true });

  // Load persisted settings
  const { load: loadSettings } = useSettings();
  await loadSettings();

  // Apply persisted theme (以磁盘设置为准，校正 localStorage 缓存可能过期的情况)
  const themeId = settings.theme || "glass";
  const themeTokens = themes[themeId] || themes["warm-dark"];
  applyTheme(themeTokens);
  try { localStorage.setItem("aide.theme", themes[themeId] ? themeId : "warm-dark"); } catch { /* ignore */ }

  // Load provider configuration
  await loadProviders();
  // 首次引导门控：loadProviders 之后（登录步的 apiKeyConfigured 已就绪）、refresh 之前。
  // 全新用户 !onboarded → 弹向导；老用户 open() 内部守卫直接 return。
  onboarding.open();
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
      await loadRunConfigs(info.root, info.root);
      // 同 onSidebarWsChanged：迁移（list_run_configs 内）→ 读工作区 JDK → 提示
      await loadWorkspaceJdk(info.root);
      void maybePromptJdk(info.root);
      void maybePromptMigration();
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
        group: r.icon === "session" ? "会话" : r.icon === "file" ? "文件" : (r.icon === "link" || r.icon === "search") ? "代码定义" : "其他",
      }));
    });
  });

  // 把「最近访问」注入面板：空查询时展示最近会话 + 最近文件
  nextTick(() => {
    paletteRef.value?.setRecentFn(async (): Promise<PaletteResult[]> => {
      const { sessions, files } = useRecent();
      const { names } = useSessionNames();
      const out: PaletteResult[] = [];
      for (const s of sessions.value) {
        out.push({
          id: "rs-" + s.session_id,
          // 显示名以共享注册表为准（手动改名/自动标题当次运行内即时生效）；
          // 未注册（重启后未加载该工作区）回落 recent 快照——后端 list_recent
          // 已用权威元数据自愈覆盖，两条路径同源。
          label: names[s.session_id] || s.name,
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
            if (p.versionId && installed.some((i) => i.market === p.marketName && i.name === p.name && i.versionId !== p.versionId)) {
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
      :run-states="runStates"
      :left-collapsed="leftCollapsed"
      :right-collapsed="rightCollapsed"
      :workspace-root="workspacePath"
      @open-palette="paletteOpen = true"
      @select-session="(s) => sidebarRef?.selectSessionFromWorkspace(s.wsKey, s.id)"
      @run-project="onRunProject"
      @stop-project="onStopProject"
      @restart-project="onRestartProject"
      @select-run-config="onSelectRunConfig"
      @edit-run-configs="runConfigsDialogVisible = true"
      @toggle-left="onToggleLeft"
      @toggle-right="rightCollapsed = !rightCollapsed"
      @open-folder="onOpenFolder"
      @open-workbench="wb.toggle()"
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

      <!-- 贴边热区：未固定时鼠标贴左边缘滑出侧栏（QQ 式自动隐藏）。
           侧栏已展开时停用——热区 z 高于侧栏，否则向左划出侧栏会先撞上
           热区重新触发展开，永远收不回去。 -->
      <div
        v-if="!leftPinned"
        class="left-edge-hotzone"
        :class="{ inactive: leftOverlayOpen }"
        @mouseenter="onLeftEdgeEnter"
        @mouseleave="onLeftEdgeLeave"
      />
      <div v-if="!leftPinned && !leftOverlayOpen" class="left-edge-hint" />

      <!-- Left panel -->
      <div
        class="panel-left"
        :class="{
          collapsed: leftPinned && leftCollapsed,
          overlay: !leftPinned,
          'overlay-open': !leftPinned && leftOverlayOpen,
        }"
        @mouseenter="onLeftPanelEnter"
        @mouseleave="onLeftPanelLeave"
      >
        <SidebarLeft
          v-show="!leftPinned || !leftCollapsed"
          ref="sidebarRef"
          :active-session-id="activeSessionId"
          :pinned="leftPinned"
          @session-changed="onSessionChanged"
          @new-session="onNewSession"
          @workspace-changed="onSidebarWsChanged"
          @open-settings="openSettings"
          @provider-switch="onProviderSwitch"
          @open-settings-providers="openSettingsProviders"
          @remove-workspace="onRemoveWorkspace"
          @toggle-pin="toggleLeftPinned"
        />
      </div>

      <!-- Left resize handle（仅固定 dock 模式可拖） -->
      <div
        v-show="leftPinned && !leftCollapsed"
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

      <!-- 文件解析浮层：useFileResolver 的搜索 loading / 多命中选择（模块级单例状态，
           聊天文件链接与会话变更面板共用，必须全局挂载一份才可见） -->
      <FileResolveOverlay :workspace-path="workspacePath" />

      <ContextMenu />
      <ModalDialog />
      <OpenFolderDialog v-model:visible="openFolderVisible" v-model:error="openFolderError" @confirm="onOpenFolderConfirm" />
      <RemoveWorkspaceDialog
        v-model:visible="removeWsVisible"
        :workspace="removeWsTarget"
        @confirm="onRemoveWorkspaceConfirm"
      />
      <SettingsPanel v-if="settingsVisible" :initial-tab="settingsInitialTab" @close="settingsVisible = false" />
      <RunConfigsDialog
        v-if="runConfigsDialogVisible"
        @close="runConfigsDialogVisible = false"
      />
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

/* ── 左侧栏 overlay（QQ 式自动隐藏，钉子未固定）──
   脱离 grid（轨道已归 0），绝对定位浮在内容上；背景仍是 --aide-bg-deep
   （玻璃主题为半透明）+ SidebarLeft 根的 backdrop-filter: var(--aide-surface-blur)
   ——毛玻璃主题下悬浮侧栏自动带毛玻璃，无需特判。 */
.panel-left.overlay {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: var(--aide-left-w, 280px);
  transform: translateX(-100%);
  transition: transform 0.22s var(--aide-ease), box-shadow 0.22s var(--aide-ease);
  /* 高于 FileViewer 悬浮窗口层（40）与 WorkbenchTerminal dock（80），低于通知/弹窗层 */
  z-index: 90;
}

.panel-left.overlay.overlay-open {
  transform: translateX(0);
  box-shadow: var(--aide-shadow-lg);
}

/* 贴边热区：平时唯一接收 hover 的触发条（12px），z 高于 overlay 侧栏 */
.left-edge-hotzone {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 12px;
  z-index: 95;
}

.left-edge-hotzone.inactive {
  pointer-events: none;
}

/* 边缘提示细线：未展开时暗示"这里能拉出来"（原型同款） */
.left-edge-hint {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 64px;
  border-radius: 0 3px 3px 0;
  background: var(--aide-text-muted);
  opacity: 0.25;
  z-index: 89;
  pointer-events: none;
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
