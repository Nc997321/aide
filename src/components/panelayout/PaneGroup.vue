<script setup lang="ts">
import { computed, inject, ref, type Ref } from "vue";
import ChatPanel from "../ChatPanel/ChatPanel.vue";
import PaneTabBar from "./PaneTabBar.vue";
import { usePaneLayout } from "../../composables/usePaneLayout";
import { useChatSession, type SendOptions } from "../../composables/useChatSession";
import type { PermissionRuleDraft } from "../../types/permissions";
import { useContextMenu } from "../../composables/useContextMenu";
import { useSessionWorkspaces } from "../../composables/useSessionWorkspaces";
import { useWorkspaces } from "../../composables/useWorkspaces";
import {
  dailyWorkspaceBind,
  ensureDailyWorkspace,
  isDailyKey,
} from "@aide/sdk/utils/dailyWorkspace";
import type { HeroMode } from "../ChatPanel/hero/modes";
import { paneTabMenuItems } from "../../menus/contextMenus";
import { WORKSPACE_PATH_KEY } from "./keys";
import type { GroupNode } from "../../composables/paneLayout/tree";
import type { WorkspaceInfo } from "../../types";

/**
 * 一个分屏组：tab 栏 + 常驻一个 ChatPanel。
 *
 * 自治绑定：本组自己调 useChatSession（绑定激活 tab 的 session id ref）——
 * store 是模块级按会话路由的，多实例零成本；切 tab 只换 sessionId prop，
 * 与旧版 App.vue 单面板切会话的行为完全一致。
 */
const props = defineProps<{ group: GroupNode }>();

const pl = usePaneLayout();
const { show: showContextMenu } = useContextMenu();

const focused = computed(() => pl.layout.focusedGroupId === props.group.id);
const activeTab = computed(
  () => props.group.tabs.find((t) => t.id === props.group.activeTabId) ?? null,
);
const sessionIdRef = computed(() => activeTab.value?.sessionId ?? null);

const {
  messages,
  isBusy,
  models,
  currentModel,
  modelSwitchResult,
  currentEffort,
  effortSwitchError,
  contextUsage,
  contextCompaction,
  rateLimit,
  tasks,
  permissionModes,
  currentPermissionMode,
  pendingJumps,
  pendingPermission,
  pendingPermissionCount,
  bgTasks,
  bgDockOpen,
  bgDockSelectedId,
  rollbackText,
  consumeRollbackText,
  sendMessage,
  sendBtw,
  interrupt,
  setModel,
  setEffort,
  setPermissionMode,
  respondPermission,
} = useChatSession(sessionIdRef);

const workspacePath = inject<Ref<string>>(WORKSPACE_PATH_KEY, ref(""));

// 混合 tab：面板内的路径展示/文件引用以会话自己的工作区为基准，
// 没有归属记录（空白新会话）才回落当前活动工作区。
const { workspaceOf } = useSessionWorkspaces();
const { activeKey: activeWsKey } = useWorkspaces();

/** 当前活动工作区的归属快照（空白 tab 创建/兜底发送用）；信息不全时不绑。 */
function wsSnapshot(): { wsKey: string; wsPath: string } | undefined {
  const wsPath = workspacePath.value;
  const wsKey = activeWsKey.value;
  return wsKey && wsPath ? { wsKey, wsPath } : undefined;
}

const effectiveWorkspacePath = computed(() => {
  const tab = activeTab.value;
  const sid = tab?.sessionId;
  if (sid) return workspaceOf(sid)?.wsPath || workspacePath.value;
  // 空白面板：显示创建时绑定的工作区（切工作区后仍如实展示它属于哪）；
  // 零 tab（hero）时显示 hero 归属选择器选定的归属，未选才回落活动工作区
  return tab?.pendingWs?.wsPath || pl.layout.defaultWs?.wsPath || workspacePath.value;
});

/**
 * 发送 = 会话启动：空白 tab 现场绑定临时 id（真实 id 由 App.vue 的
 * onSessionCreated 经 rebindSession 换上），预览 tab 随派发转正。
 * 零 tab（欢迎态）时先现场建一个空白 tab，之后走同一条路径。
 */
async function onSend(prompt: string, opts: SendOptions) {
  if (!activeTab.value) await onNewTab();
  const tab = activeTab.value;
  if (!tab) return;
  // 空白 tab 的归属在创建时已绑定（pendingWs）；切工作区后发送仍落创建时的
  // 工作区。无快照（欢迎态同 tick 建 tab / 拆组空白 tab）兜底当前工作区。
  const sid = await sendMessage(prompt, {
    ...opts,
    workspace: tab.sessionId ? undefined : (tab.pendingWs ?? wsSnapshot()),
  });
  if (!sid) return;
  if (tab.sessionId !== sid) pl.bindSession(tab.id, sid);
  pl.promoteTab(sid);
}

/** 权限响应转发：PermissionDialog 的 emit 载荷 → respondPermission 的具名对象
 *  （模板内联展开对象字面量会被 Vue 模板解析器当作语句块，故在此收口）。 */
function onRespondPermission(
  req: { id: string; approved: boolean; answers?: Record<string, string>; nextMode?: string; reason?: string },
  sessionRules?: PermissionRuleDraft[],
) {
  respondPermission(req.id, req.approved, {
    answers: req.answers,
    nextMode: req.nextMode,
    reason: req.reason,
    sessionRules,
  });
}

function onSendBtw(prompt: string) {
  sendBtw(prompt);
}

function onTabContext(tabId: string, x: number, y: number) {
  // 右键即激活该 tab：菜单里的「拆分」作用于被点的 tab（splitGroup 移动的是激活 tab）
  pl.setActiveTab(props.group.id, tabId);
  showContextMenu(x, y, paneTabMenuItems(props.group.id, tabId));
}

async function onNewTab() {
  pl.focusGroup(props.group.id);
  // 新建对话的默认落点听**模式意图**：日常 → 日常工作区（先确保归属已装载）；
  // 工程 → hero 上选定的归属（defaultWs），没选就快照当前活动工作区——布局全局
  // 一份、切工作区不动 tab，不快照的话首条消息会落到「当前」工作区而不是创建时的那个。
  if (pl.layout.heroMode === "daily") await ensureDailyWorkspace();
  const ws =
    pl.layout.heroMode === "daily"
      ? (dailyWorkspaceBind() ?? undefined)
      : (pl.layout.defaultWs ?? wsSnapshot());
  if (pl.layout.defaultWs) pl.setDefaultWs(null);
  pl.openBlankTab(`新会话 ${new Date().toLocaleTimeString()}`, ws);
}

/** hero 归属选择：空白预览 tab 直接改写其 pendingWs；零 tab 存布局 defaultWs
 *  （作用于紧随其后的第一个新会话）。只写归属不切工作区——活动工作区仍只由
 *  文件树 path-bar 切换器 / 打开目录改变。 */
function onPickWorkspace(ws: WorkspaceInfo) {
  if (ws.missing) return;
  const bind = { wsKey: ws.key, wsPath: ws.name };
  const tab = activeTab.value;
  if (tab && !tab.sessionId) {
    pl.setTabPendingWs(tab.id, bind);
  } else {
    pl.setDefaultWs(bind);
  }
}

/** 当前在用什么模式：有 tab 就看那个 tab 的归属，没有 tab 看布局上的意图。
 *  空白 tab 绑了日常就是日常；其余（含未绑）算工程 —— 未绑时首条消息会落到活动
 *  工作区（后端 cwd 链第三级），与「工程」的语义一致。 */
const currentMode = computed<HeroMode>(() => {
  const tab = activeTab.value;
  if (!tab) return pl.layout.heroMode;
  return isDailyKey(tab.pendingWs?.wsKey) ? "daily" : "project";
});

/**
 * 模式切换：写模式意图 + 归属，**不切活动工作区**（同 onPickWorkspace 的范式）。
 * 归属按模式取：日常 → 日常工作区（懒加载一次）；工程 → 当前活动工作区快照，
 * 快照为空就绑「无」——「工程 + 还没选工作区」是能表达的真实状态，hero 上就地
 * 用 WorkspacePicker 选。
 */
async function onPickMode(mode: HeroMode) {
  pl.setHeroMode(mode);
  if (mode === "daily") await ensureDailyWorkspace();
  const bind = mode === "daily" ? dailyWorkspaceBind() : wsSnapshot();
  const tab = activeTab.value;
  if (tab && !tab.sessionId) {
    pl.setTabPendingWs(tab.id, bind ?? undefined);
  } else {
    pl.setDefaultWs(bind ?? null);
  }
}
</script>

<template>
  <div class="pane-group" @mousedown.capture="pl.focusGroup(props.group.id)">
    <!-- 零 tab（欢迎态）时整行 tab 栏不渲染：只剩居中 hero 的 ChatPanel。
         Transition 包住 v-if：hero → 对话时 tab 栏从顶部滑入，反向滑出。 -->
    <Transition name="tabbar">
      <PaneTabBar
        v-if="props.group.tabs.length"
        :group="props.group"
        :focused="focused"
        @select="(id: string) => pl.setActiveTab(props.group.id, id)"
        @close="(id: string) => pl.closeTab(props.group.id, id)"
        @promote="(id: string) => pl.promoteTabById(props.group.id, id)"
        @context="onTabContext"
        @new-tab="onNewTab"
      />
    </Transition>
    <ChatPanel
      :focused="focused"
      :session-id="activeTab?.sessionId ?? null"
      :workspace-path="effectiveWorkspacePath"
      :messages="messages"
      :is-busy="isBusy"
      :models="models"
      :current-model="currentModel"
      :model-switch-result="modelSwitchResult"
      :current-effort="currentEffort"
      :effort-switch-error="effortSwitchError"
      :context-usage="contextUsage"
      :context-compaction="contextCompaction"
      :rate-limit="rateLimit"
      :tasks="tasks"
      :permission-modes="permissionModes"
      :current-permission-mode="currentPermissionMode"
      :pending-jumps="pendingJumps"
      :bg-tasks="bgTasks"
      :bg-dock-open="bgDockOpen"
      v-model:bg-dock-selected-id="bgDockSelectedId"
      :permission="pendingPermission"
      :permission-queue-count="pendingPermissionCount"
      :rollback-text="rollbackText"
      class="pane-group__chat"
      :hero-mode="currentMode"
      @send="onSend"
      @send-btw="onSendBtw"
      @select-workspace="onPickWorkspace"
      @select-mode="onPickMode"
      @interrupt="interrupt"
      @set-model="setModel"
      @set-effort="setEffort"
      @set-permission-mode="setPermissionMode"
      @respond-permission="onRespondPermission"
      @rollback-text-consumed="consumeRollbackText"
    />
  </div>
</template>

<style scoped>
.pane-group {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--aide-bg-base);
}

.pane-group__chat {
  flex: 1;
  min-height: 0;
}

/* 零 tab ↔ 有 tab：tab 栏沿顶边滑入/滑出（只动 transform/opacity） */
.tabbar-enter-active {
  transition: transform .2s var(--aide-ease), opacity .2s var(--aide-ease);
}
.tabbar-leave-active {
  transition: transform .18s ease, opacity .18s ease;
}
.tabbar-enter-from,
.tabbar-leave-to {
  transform: translateY(-100%);
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .tabbar-enter-active,
  .tabbar-leave-active {
    transition: none;
  }
}
</style>
