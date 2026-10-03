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
const MemoryObservatory = defineAsyncComponent(() => import("./components/MemoryObservatory/MemoryObservatory.vue"));
const KnowledgeBase = defineAsyncComponent(() => import("./components/KnowledgeBase/KnowledgeBase.vue"));
const OnboardingWizard = defineAsyncComponent(() => import("./components/onboarding/OnboardingWizard.vue"));
const RunConfigsDialog = defineAsyncComponent(() => import("./components/RunConfigsDialog.vue"));
const BrowserPanel = defineAsyncComponent(() => import("./components/Browser/BrowserPanel.vue"));
import PaneLayout from "./components/PaneLayout.vue";
import AutomationMain from "./components/automation/AutomationMain.vue";
import MarketplaceTab from "./components/marketplace/MarketplaceTab.vue";
import { useAutomation } from "./composables/useAutomation";
import { useMarketplace } from "./composables/useMarketplace";
import { useMemoryObservatory } from "./composables/useMemoryObservatory";
import { useKnowledgeBase } from "./composables/useKnowledgeBase";
import { useRightPanel, rightPanelWidthSource, type RightTabId } from "./composables/useRightPanel";
import { useBrowserViews } from "./composables/browser/useBrowserViews";
import { useChatSession, setAuthRequiredHandler } from "./composables/useChatSession";
import { usePaneLayout } from "./composables/usePaneLayout";
import { usePaneLayoutPersistence } from "./composables/paneLayout/persistence";
import { useSessionNames } from "./composables/useSessionNames";
import GitPanel from "./components/GitPanel.vue";
import SearchPanel from "./components/SearchPanel.vue";
import CallHierarchyPanel from "./components/callhierarchy-panel/CallHierarchyPanel.vue";
import { useCallHierarchy } from "./composables/useCallHierarchy";
import PermissionsPanel from "./components/permissions/PermissionsPanel.vue";
import WorkbenchTerminal from "./components/WorkbenchTerminal.vue";
import TitleBar from "./components/titlebar/TitleBar.vue";
import HostConnectionBanner from "./components/HostConnectionBanner.vue";
import HostLauncherDialog from "./components/HostLauncherDialog.vue";
import ACommandPalette from "./ui/ACommandPalette.vue";
import { ARailBar } from "./ui";
import type { Tab } from "./ui";
import { useResizable, staticWidthSource } from "./composables/useResizable";
import { useConversationChanges } from "./composables/useConversationChanges";
import { TURN_CHANGES_KEY, type TurnChangesFeed } from "./components/ChatPanel/turnChanges";
import { useWorkbenchTerminal } from "./composables/useWorkbenchTerminal";
import { api } from "./api";
import { isDailyKey, dailyWorkspaceBind, ensureDailyWorkspace } from "@aide/sdk/utils/dailyWorkspace";
import { HOST_OPEN_FOLDER_EVENT, hostApi } from "@aide/sdk";
import { marketplaceApi } from "./api/marketplace";
import { useNotifications } from "./composables/useNotifications";
import { ref, onMounted, onUnmounted, nextTick, watch, computed, provide } from "vue";
import { useSettings } from "./composables/useSettings";
import { useOnboarding } from "./composables/useOnboarding";
import { useWindowFocus } from "./composables/useWindowFocus";
import { useModal } from "./composables/useModal";
import { useNotification } from "./composables/useNotification";
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
import { listen } from "./api";
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
// 右侧栏状态的主人是 useRightPanel（模块单例）：折叠态、当前 tab、最大化、两档宽度都在那里，
// 三态裁决也搬到了它的 `select`。这两个别名只为少改模板与既有函数——它们就是 store 里的 ref 本身。
// 注意调用层级面板在 rootQuery 变化时会强制展开（见下方 watch）。
const rightPanel = useRightPanel();
// 浏览器视图的常驻订阅在这里安装**一次**（面板是懒挂载的，agent 可能在它之前就开 tab / 请求 focus）。
// 逻辑全在 useBrowserViews 里，App 只负责"活着"这件事。
useBrowserViews();
const rightCollapsed = rightPanel.collapsed;
const rightTab = rightPanel.tab;
const { unstagedFiles, hasChanges, loadStatus, currentBranch } = useGit();

// 调用层级面板状态（模块单例；gutter ⇄ 触发点在编辑器深处）。根变化 = 换根查询 →
// 自动切到面板 tab 并展开右栏（点击 ⇄ 即看面板，无需手动切）。
const callHierarchy = useCallHierarchy();
watch(
  () => callHierarchy.rootQuery.value,
  (q) => {
    if (q) {
      rightTab.value = "callhierarchy";
      rightCollapsed.value = false;
    }
  },
);

const leftResize = useResizable({
  cssVar: "--aide-left-w",
  direction: "left",
  source: staticWidthSource({ initial: 280, min: 220, max: 450 }),
});

/** 右栏宽档的边界要看窗口：量 .app-layout 与**非 overlay 态**的左侧栏真实宽度
 *  （overlay 态侧栏脱离 grid 不吃轨道，不能算进去）。 */
function measureLayout() {
  const layout = document.querySelector<HTMLElement>(".app-layout");
  const left = document.querySelector<HTMLElement>(".panel-left:not(.overlay)");
  return {
    appW: layout?.getBoundingClientRect().width ?? 0,
    leftW: left?.getBoundingClientRect().width ?? 0,
  };
}

// 宽度真相住在 useRightPanel（两档：工具窄档 / 浏览器宽档），这里只把它绑到 CSS 变量。
const rightResize = useResizable({
  cssVar: "--aide-right-w",
  direction: "right",
  source: rightPanelWidthSource(measureLayout),
});

/** grid 轨道宽度的单一数据源：折叠态直接决定轨道本身，而不是只改子元素
 *  自身的 CSS 宽度——子元素默认按轨道 stretch，不需要再单独设 !important
 *  宽度。收起需要联动 .panel-center 的真实包围盒变化，FileViewer 的悬浮
 *  窗口层靠 ResizeObserver 量 .panel-center 才能正确重新平铺（见
 *  FileViewer.vue 顶部注释）——轨道不真的变，那层就量不到变化。
 *  左侧栏未固定（QQ 式自动隐藏）时轨道归 0：侧栏脱离 grid 改走 overlay
 *  绝对定位（见 .panel-left.overlay），不占布局、覆盖内容。 */
/** 最大化 = 右栏吃满主区：中心轨道归 0、右栏拿 1fr。聊天区已被 v-show 换下（保活不卸载），
 *  所以这里不动任何 DOM 结构——原生视图的「洞」只是换了个更大的 rect。 */
const browserMaximized = rightPanel.maximized;

const gridTemplateColumns = computed(() => {
  const left = !leftPinned.value
    ? "0px"
    : leftCollapsed.value
      ? "10px"
      : "var(--aide-left-w, 280px)";
  if (browserMaximized.value) return `${left} 1px 0px 1px 1fr`;
  const right = rightCollapsed.value ? "var(--aide-rail-w, 40px)" : "var(--aide-right-w, 300px)";
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
const searchPanelRef = ref<InstanceType<typeof SearchPanel> | null>(null);
const gitPanelRef = ref<InstanceType<typeof GitPanel> | null>(null);
const titleBarRef = ref<InstanceType<typeof TitleBar> | null>(null);
const paletteOpen = ref(false);
const paletteRef = ref<InstanceType<typeof ACommandPalette> | null>(null);
// 内嵌浏览器：主区已不认它——它是右栏的一个 tab（rail 图标 / Ctrl+8 / Ctrl+Shift+B），
// 开合状态同住在 useRightPanel（`browserEverActive` 管懒挂载）。桌面壳专属，原生子 webview。
// 「当前会话」= 聚焦分屏组激活 tab 的会话——布局层的计算属性，所有下游
// （右面板 / 权限弹窗 / 标题栏 / 侧栏高亮）沿用旧的单一 activeSessionId 语义。
const paneLayout = usePaneLayout();
const automation = useAutomation();
const marketplace = useMarketplace();
// 观测台面板开关（模块级状态，主区视图范式；数据闭包在 MemoryObservatory 组件内部）
const observatory = useMemoryObservatory();
const knowledgeBase = useKnowledgeBase();
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
  // 无条件取走 tab 预起的名字（一次性，取空也不留垃圾在布局持久化里），
  // 它只是「还没有标题时」的占位。
  const pendingName = paneLayout.takePendingName(realId);
  // 名字优先级：sidecar 截取首条消息生成的标题 > 空白面板预起的名字 > id 前 8 位。
  // 标题在 session_init 之前就到了（session_title），暂存在临时 id 下，
  // finalizeSession 定名时已迁到 realId——这里直接取用，一次落盘即最终名
  // （此前是先用默认名落盘、再 auto_rename，标题必被覆盖成孤儿）。
  const name =
    useSessionNames().takePendingTitle(realId) || pendingName || realId.substring(0, 8);
  useSessionNames().setName(realId, name);
  void api.createSession(realId, name).then((session) => {
    sidebarRef.value?.addSession({ id: session.id, name: session.name, timestamp: session.timestamp });
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
let unlistenOpenFile: (() => void) | null = null;
let unlistenOpenSessionFromNotification: (() => void) | null = null;
let unlistenHostOpenFolder: (() => void) | null = null;
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
const hostLauncherVisible = ref(false);
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

// ── 会话完成只走桌面通知（useNotification）；内部浮层已移除 ──
// 点击定位由 Windows toast 的进程内 Activated 回调驱动：notify_send 聚焦窗口
// 并 emit "open-session-from-notification"，监听器在 onMounted 注册。
const { notice, choice } = useModal();

// ── Conversation changes（P2-4 合一：唯一实例，badge + 变更面板共用，
//    ChangeLogPanel 不再自建 useConversationChanges，走 props 透传）──
const { rounds, revertRound, revertSingleFile, revertFileGlobally } = useConversationChanges(() => activeSessionId.value);

// 回合变更结算卡的数据源：与右栏变更面板**同一份 rounds**（唯一实例），只多带一个
// sid——卡片据此判断这份数据是不是自己那个会话的（分屏里另一组显示的是别的会话）。
// 走 provide 而不是逐层透传：PaneLayout → PaneSplit（递归）→ PaneGroup → ChatPanel
// 要为这一个叶子加四个文件的转发（先例见 panelayout/keys.ts 的 WORKSPACE_PATH_KEY）。
provide(TURN_CHANGES_KEY, computed<TurnChangesFeed>(() => ({
  sid: activeSessionId.value,
  rounds: rounds.value,
  revertSingleFile,
})));

const changeCount = computed(() => {
  let n = 0;
  for (const r of rounds.value) n += r.files.length;
  return n;
});

const tabIconFiles = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7c0-1.1.9-2 2-2h4.6L12 7h7c1.1 0 2 .9 2 2v8c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V7z"/></svg>';
const tabIconChanges = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
const tabIconGit = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';
const tabIconSearch = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const tabIconCallhierarchy = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2v6h-6"/><path d="M7 22v-6h6"/><path d="M17 8c0 5-3 8-10 8"/><path d="M7 16c0-5 3-8 10-8"/></svg>';
const tabIconPermissions = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>';
// 地球（圆 + 赤道 + 两弧）：与侧栏那几个入口同一字形语言。
const tabIconBrowser = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a9 9 0 0 1 0 18"/><path d="M12 3a9 9 0 0 0 0 18"/></svg>';

const rightTabs = computed<Tab[]>(() => [
  { id: "files", icon: tabIconFiles, label: "文件 (Ctrl+1)" },
  { id: "changes", icon: tabIconChanges, badge: changeCount.value || undefined, label: "变更 (Ctrl+2)" },
  { id: "git", icon: tabIconGit, badge: unstagedFiles.value.length || undefined, label: "Git (Ctrl+3)" },
  { id: "search", icon: tabIconSearch, label: "搜索 (Ctrl+4)" },
  { id: "callhierarchy", icon: tabIconCallhierarchy, label: "调用层级 (Ctrl+7)" },
  { id: "browser", icon: tabIconBrowser, label: "浏览器 (Ctrl+8)" },
  { id: "permissions", icon: tabIconPermissions, label: "权限 (Ctrl+5)", bottom: true },
]);

/** 右侧竖直工具栏选择（IDEA 式）：展开 / 折叠 / 切换的三态裁决住在 `useRightPanel.select`。
 *  标题栏 toggle-right 走 rightCollapsed 直翻。 */
function onRailSelect(id: string) {
  rightPanel.select(id as RightTabId);
}

/** Ctrl+1~8 → 右侧栏 tab（IDEA Alt+数字语义，走 onRailSelect 的现成裁决：按当前
 *  激活项 = 折叠右栏）。key 用 e.code 物理键位而非 e.key：AZERTY 等布局数字在
 *  Shift 层，e.key 产出的是 "&" 不是 "1"。 */
const RAIL_DIGIT_TABS: Record<string, RightTabId> = {
  Digit1: "files",
  Digit2: "changes",
  Digit3: "git",
  Digit4: "search",
  Digit5: "permissions",
  Digit7: "callhierarchy",
  Digit8: "browser",
};

/** 快捷键打开搜索面板：展开右侧 + 切到 search tab + 预选模式并聚焦输入框。
 *  面板已打开时重复按快捷键 = 聚焦输入框（IDEA 行为）。 */
function openSearchPanel(mode: "search" | "replace") {
  if (rightCollapsed.value) {
    rightTab.value = "search";
    rightCollapsed.value = false;
  } else if (rightTab.value !== "search") {
    rightTab.value = "search";
  }
  // v-show 的 DOM 更新（摘除 display:none）要等下一轮 flush，同步 focus 会打在
  // 仍隐藏的输入框上（HTML 规范下对 display:none 元素 focus 是 no-op）——nextTick
  // 后再聚焦，折叠/跨 tab 打开两条路径才生效。
  nextTick(() => searchPanelRef.value?.focusInput(mode));
}

function onSearchFilesChanged() {
  fileTreeRef.value?.loadRoot();
}

// 自动化 ⇄ 插件市场 ⇄ 记忆观测台 ⇄ 知识库四者互斥：主区 v-if 链有优先级
// （自动化 > 市场 > 观测台 > 知识库），不互斥的话先开的那个会一直挡住后开的，点侧栏入口
// 毫无反应（自动化漏了互斥就是这个症状）。放在 App 层做，覆盖全部入口（侧栏任务节点、
// 底部入口行、市场的 ⋯ 菜单「打开市场」、标题栏/通知的 openPanel）。
//
// 内嵌浏览器**不在这条链上**：它是右栏 tab，不占主区（2026-09-20 前它与聊天互斥，
// 导致"看着聊天时视图必然隐藏 → agent 截图永远等不到帧"）。唯一还互斥的是**最大化**
// ——右栏吃满主区，等同占用了主区，见下方两条 watch。
function closeOtherPanels(except: string) {
  if (except !== "marketplace") marketplace.closePanel();
  if (except !== "observatory") observatory.closePanel();
  if (except !== "automation") automation.closePanel();
  if (except !== "kb") knowledgeBase.closePanel();
}
watch(marketplace.panelOpen, (open) => { if (open) closeOtherPanels("marketplace"); });
watch(observatory.panelOpen, (open) => { if (open) closeOtherPanels("observatory"); });
watch(knowledgeBase.panelOpen, (open) => { if (open) closeOtherPanels("kb"); });
watch(() => automation.state.view, (v) => { if (v !== null) closeOtherPanels("automation"); });

// 切进日常对话就收起右栏（用户 2026-09-20 定：日常 = 面板收起来）。
// **只在归属 key 真的换到日常时才收**：不在两个日常会话之间反复收（那会和用户手动
// 打开右栏打架），也不在切回工程时自动展开（避免开合抖动）。
// 这是布局动作，不是归属变更 —— 活动工作区一动不动（「不跟随焦点」的既定决策）。
watch(
  () => paneLayout.activeTabWsKey.value,
  (wsKey) => { if (isDailyKey(wsKey)) rightPanel.collapse(); },
);

// 最大化 = 右栏吃满主区，与其它主区面板互斥：开最大化先关掉它们；它们被打开则退最大化。
// **只在有面板真的开着时才退**——否则 closeOtherPanels 关掉它们的瞬间会反过来把刚开的
// 最大化取消掉（顺序：设 true → 关它们 → 它们的 watch 触发 → 无条件 setMaximized(false) → 白开）。
watch(browserMaximized, (on) => {
  if (on) closeOtherPanels("browser");
});
watch(
  [marketplace.panelOpen, observatory.panelOpen, knowledgeBase.panelOpen, () => automation.state.view],
  ([mk, ob, kb, auto]) => {
    if (mk || ob || kb || auto !== null) rightPanel.setMaximized(false);
  },
);

function onSessionChanged(id: string) {
  // 选中会话时关掉自动化/插件市场/记忆观测台/知识库，主区切回聊天
  // （知识库虽与会话/工作区无关，但它占主区、v-if 链优先级高于聊天，不关的话点会话毫无反应）。
  // 浏览器也不关：它是右栏 tab——2026-09-20 前这里会 closePanel()，正是"切会话就把浏览器
  // 踢掉、视图随之隐藏、agent 截图永远等不到帧"那条死路的入口。
  automation.closePanel();
  marketplace.closePanel();
  observatory.closePanel();
  knowledgeBase.closePanel();
  // 打开语义（预览覆盖/全局唯一聚焦）由布局层统一裁决
  paneLayout.openSession(id);
}

function onNewSession(name: string, ws?: { wsKey: string; wsPath: string }) {
  // 零会话欢迎态：欢迎页本身就是新建会话页，再开空白 tab 只是冗余。
  // 但侧栏显式指定了工作区时要把它种进欢迎页（工程模式 + defaultWs），否则点了没反应。
  if (!paneLayout.hasAnyTab.value) {
    if (ws) {
      paneLayout.setChatMode("project");
      paneLayout.setDefaultWs(ws);
    }
    return;
  }
  // 打开空白可输入面板（预览 tab）；不落盘、不进侧栏。真正创建推迟到
  // 用户发出第一条消息、SDK 用 session_init 确认真实 id 之后（onSessionCreated）。
  // 工作区归属在创建时绑定（布局全局一份，切工作区不动 tab，不快照就会落到
  // 发送时的「当前」工作区）。
  // 侧栏工作区 ⋯ 菜单显式指定了工作区就用它（不动活动工作区），否则取活动工作区。
  const wsKey = ws?.wsKey ?? activeWorkspaceKey.value;
  const wsPath = ws?.wsPath ?? workspacePath.value;
  paneLayout.openBlankTab(name, wsKey && wsPath ? { wsKey, wsPath } : undefined);
}

async function onSidebarWsChanged(path: string) {
  workspacePath.value = path;
  projectName.value = path.split(/[\\/]/).filter(Boolean).pop() || path;
  // 混合 tab 布局：切换活动工作区不动聊天区的 tab（布局是全局一份）
  await fileTreeRef.value?.loadRoot();
  // git 面板数据是工作区级的（分支/提交/状态/标签/对比），右栏 git 徽标也读
  // useGit 状态——无条件刷新，不依赖 git tab 是否激活；否则面板隐藏期间切走
  // 再切回会看到上一个工作区的陈旧数据（分支 unknown / 提交全空 / 对比报错）
  gitPanelRef.value?.reload();
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

// Host 启动页的「最近项目」：本窗口的 Host 每打开一个项目就记一笔（桌面自己记、Host 由窗口定）。
// 日常工作区是每台 Host 自带的草稿目录而不是「项目」，不记。
const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, "").replace(/\\/g, "/") === b.replace(/[\\/]+$/, "").replace(/\\/g, "/");
watch(workspacePath, async (p) => {
  if (!p) return;
  try {
    await ensureDailyWorkspace();
    const daily = dailyWorkspaceBind()?.wsPath;
    if (daily && samePath(daily, p)) return;
    await hostApi.recordRecent(p);
  } catch {
    /* 只是个便利清单：记不上不打扰用户 */
  }
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

const { load: loadProviders, refreshSystemDefaultModels } = useProviders();

function openSettingsProviders() {
  settingsInitialTab.value = "providers";
  settingsVisible.value = true;
}

function openSettings() {
  settingsInitialTab.value = undefined;
  settingsVisible.value = true;
}

// 插件市场已迁出设置页为一级主区视图：通知「查看」动作 → 打开主区市场面板
function openMarketplacePanel() {
  marketplace.openPanel();
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
    // 消费标记：本 handler 在 capture 相最先跑，preventDefault 是给下游（如
    // PermissionDialog 的 window 键盘确认）的让路信号——一次 Esc 只产生一个效果。
    e.preventDefault();
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
  // Ctrl+1~5：右侧栏 tab 切换（映射与键位选择见 RAIL_DIGIT_TABS 注释）
  if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
    const railTab = RAIL_DIGIT_TABS[e.code];
    if (railTab) {
      e.preventDefault();
      e.stopPropagation();
      onRailSelect(railTab);
      return;
    }
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

  // Ctrl+Shift+B：内嵌浏览器（右栏 tab；已激活则折叠，与 rail 点击同语义）
  if (e.ctrlKey && e.shiftKey && (e.code === "KeyB" || e.key === "B")) {
    e.preventDefault();
    e.stopPropagation();
    rightPanel.select("browser");
    return;
  }

  // Ctrl+Shift+F：全局搜索（只查找）；Ctrl+Shift+R：全局搜索+替换（IDEA 语义）
  if (e.ctrlKey && e.shiftKey && (e.code === "KeyF" || e.key === "F")) {
    e.preventDefault();
    e.stopPropagation();
    openSearchPanel("search");
    return;
  }
  if (e.ctrlKey && e.shiftKey && (e.code === "KeyR" || e.key === "R")) {
    e.preventDefault();
    e.stopPropagation();
    openSearchPanel("replace");
    return;
  }

  // Ctrl+Alt+I：打开 WebView2 devtools。仅 dev build / 诊断包（--features devtools）可用；
  // 正常 release 的 open_devtools command 不注册，调用静默 reject。避开 F12/Ctrl+Shift+I
  // 这类可能被浏览器加速器键拦截的组合
  if (e.ctrlKey && e.altKey && (e.code === "KeyI" || e.key === "I")) {
    e.preventDefault();
    e.stopPropagation();
    void api.openDevtools().catch(() => {});
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
  // 上下文兜底：无凭证发消息时，sendMessage 拦截 + 调本 handler → 打开 onboarding 登录步。
  setAuthRequiredHandler(() => onboarding.openAt("login"));

  // 自动化：拉任务表 + 注册运行终态监听（不阻塞首屏）
  void automation.init();
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

  // ── 桌面通知点击定位（release 干净路径）──
  // Windows 点击 toast 按 AUMID 无参拉起二次实例 → 单实例回调取走暂存的
  // 会话 id 并 emit 此事件。只打开会话、不切换活动工作区（QQ/微信式）。
  try {
    unlistenOpenSessionFromNotification = await listen<string>(
      "open-session-from-notification",
      (e) => {
        if (e.payload) sidebarRef.value?.selectSessionFromWorkspace("", e.payload);
      },
    );
  } catch (_) { /* best effort */ }

  // Host 窗口（一个窗口 = 一个 Host）带着要打开的目录启动：`?openFolder=<Host 原生路径>`；
  // 窗口已开着时同一请求经 host-open-folder 事件送达。与「打开目录」对话框确认同一条路。
  try {
    unlistenHostOpenFolder = await listen<string>(HOST_OPEN_FOLDER_EVENT, (e) => {
      if (e.payload) void onOpenFolderConfirm(e.payload);
    });
  } catch (_) { /* best effort */ }
  {
    const folder = new URLSearchParams(window.location.search).get("openFolder");
    if (folder) void onOpenFolderConfirm(folder);
  }

  // 注册「查看」动作：市场更新通知点击 → 打开主区插件市场面板
  registerActionHandler("marketplace", () => openMarketplacePanel());

  // 侧栏「插件」入口的已安装计数（best effort，不阻塞首屏）
  void marketplace.refreshInstalled();

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
        } catch {
          // 与上方 refresh 循环同构：单源失败同样计入 failed（供「全部源失败」判定）
          failed++;
        }
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
  unlistenOpenSessionFromNotification?.();
  unlistenHostOpenFolder?.();
});
</script>

<template>
  <div class="app-shell">
    <TitleBar
      ref="titleBarRef"
      :project-name="projectName"
      :git-branch="currentBranch"
      :run-configs="runConfigs"
      :active-run-config="activeRunConfig"
      :run-states="runStates"
      :left-collapsed="leftCollapsed"
      :right-collapsed="rightCollapsed"
      :workspace-root="workspacePath"
      @open-palette="paletteOpen = true"
      @run-project="onRunProject"
      @stop-project="onStopProject"
      @restart-project="onRestartProject"
      @select-run-config="onSelectRunConfig"
      @edit-run-configs="runConfigsDialogVisible = true"
      @toggle-left="onToggleLeft"
      @toggle-right="rightCollapsed = !rightCollapsed"
      @open-folder="onOpenFolder"
      @open-hosts="hostLauncherVisible = true"
      @open-workbench="wb.toggle()"
      @open-settings-providers="openSettingsProviders"
    />

    <!-- Host 窗口：连接意外断开时如实说明并给「重新连接」；本机窗口不渲染 -->
    <HostConnectionBanner />
    <HostLauncherDialog v-model:visible="hostLauncherVisible" />

    <div
      class="app-layout"
      :class="{ 'is-dragging': leftResize.isDragging.value || rightResize.isDragging.value }"
      :style="{ gridTemplateColumns }"
    >
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

      <!-- Center panel: 多 tab + 任意分屏（每组自治接线见 panelayout/PaneGroup.vue）。
           自动化/插件市场面板激活时盖在上面；PaneLayout 用 v-show 保活（流式会话不掉线） -->
      <div class="panel-center">
        <AutomationMain v-if="automation.state.view !== null" class="h-full" />
        <MarketplaceTab
          v-else-if="marketplace.panelOpen.value"
          class="h-full"
          @go-settings="openSettings"
        />
        <MemoryObservatory
          v-else-if="observatory.panelOpen.value && activeWorkspaceKey"
          class="h-full"
          :workspace-key="activeWorkspaceKey"
          :workspace-name="projectName"
          :current-session-id="activeSessionId"
          @close="observatory.closePanel()"
        />
        <!-- 知识库不接 workspaceKey：它连的是独立进程 knowledge-server，
             与当前打开的工作区、会话、配对状态都无关——没配对也能用。 -->
        <KnowledgeBase v-else-if="knowledgeBase.panelOpen.value" class="h-full" @close="knowledgeBase.closePanel()" />
        <!-- 内嵌浏览器已不在主区：它是右栏的一个 tab（见 .panel-right-inner）。
             这里只剩"最大化 = 右栏吃满主区"时把聊天换下。 -->
        <PaneLayout
          v-show="automation.state.view === null && !marketplace.panelOpen.value && !observatory.panelOpen.value && !knowledgeBase.panelOpen.value && !browserMaximized"
          :workspace-path="workspacePath"
          class="h-full"
        />
      </div>

      <!-- Right resize handle -->
      <div
        v-show="!rightCollapsed"
        class="resize-handle resize-handle-right"
        :class="{ active: rightResize.isDragging.value }"
        @mousedown="rightResize.onMousedown"
      />

      <!-- Right panel：content + 常驻竖直工具栏（IDEA 式） -->
      <div class="panel-right" :class="{ collapsed: rightCollapsed }">
        <div v-show="!rightCollapsed" class="panel-right-inner">
          <div class="tab-content">
            <FileTree
              v-show="rightTab === 'files'"
              ref="fileTreeRef"
              :session-id="activeSessionId"
              @switch-workspace="(wsKey) => sidebarRef?.switchToWorkspaceByKey(wsKey)"
            />
            <ChangeLogPanel
              v-show="rightTab === 'changes'"
              :session-id="activeSessionId"
              :rounds="rounds"
              :revert-round="revertRound"
              :revert-single-file="revertSingleFile"
              :revert-file-globally="revertFileGlobally"
            />
            <GitPanel v-show="rightTab === 'git'" ref="gitPanelRef" />
            <SearchPanel
              v-show="rightTab === 'search'"
              :workspace-path="workspacePath"
              ref="searchPanelRef"
              @files-changed="onSearchFilesChanged"
            />
            <CallHierarchyPanel v-show="rightTab === 'callhierarchy'" />
            <PermissionsPanel
              v-show="rightTab === 'permissions'"
              :workspace-path="workspacePath"
            />
            <!-- 内嵌浏览器：与其它工具 tab 并列的单例槽位（视图属于本窗口，Host 窗口各有各的）。首次激活才挂（异步 chunk 不在启动时拉），
                 挂上后常驻——关面板/切 tab 只 setDisplayed(false)，页面、滚动位置与前进后退历史都留着。 -->
            <BrowserPanel
              v-if="rightPanel.browserEverActive.value"
              v-show="rightTab === 'browser'"
            />
          </div>
        </div>
        <ARailBar :tabs="rightTabs" :model-value="rightTab" :collapsed="rightCollapsed" @select="onRailSelect" />
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
      <OnboardingWizard v-if="onboarding.visible.value" @workspace-selected="onSidebarWsChanged" />
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
  flex-direction: row; /* content + 常驻竖直工具栏 */
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
  min-width: 0;
  min-height: 0;
}

.tab-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
</style>
