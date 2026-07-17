<script setup lang="ts">
import { computed, inject, ref, type Ref } from "vue";
import ChatPanel from "../ChatPanel.vue";
import PaneTabBar from "./PaneTabBar.vue";
import { usePaneLayout } from "../../composables/usePaneLayout";
import { useChatSession, type SendOptions } from "../../composables/useChatSession";
import { useContextMenu } from "../../composables/useContextMenu";
import { useSessionWorkspaces } from "../../composables/useSessionWorkspaces";
import { paneTabMenuItems } from "../../menus/contextMenus";
import { WORKSPACE_PATH_KEY } from "./keys";
import type { GroupNode } from "../../composables/paneLayout/tree";

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
  contextUsage,
  rateLimit,
  tasks,
  permissionModes,
  currentPermissionMode,
  queuedPrompts,
  pendingPermission,
  pendingPermissionCount,
  sendMessage,
  sendBtw,
  interrupt,
  stopSession,
  setModel,
  setPermissionMode,
  removeQueued,
  respondPermission,
} = useChatSession(sessionIdRef);

const workspacePath = inject<Ref<string>>(WORKSPACE_PATH_KEY, ref(""));

// 混合 tab：面板内的路径展示/文件引用以会话自己的工作区为基准，
// 没有归属记录（空白新会话）才回落当前活动工作区。
const { workspaceOf } = useSessionWorkspaces();
const effectiveWorkspacePath = computed(() => {
  const sid = activeTab.value?.sessionId;
  return (sid && workspaceOf(sid)?.wsPath) || workspacePath.value;
});

/**
 * 发送 = 会话启动：空白 tab 现场绑定临时 id（真实 id 由 App.vue 的
 * onSessionCreated 经 rebindSession 换上），预览 tab 随派发转正。
 */
async function onSend(prompt: string, opts: SendOptions) {
  const tab = activeTab.value;
  if (!tab) return;
  const sid = await sendMessage(prompt, opts);
  if (!sid) return;
  if (tab.sessionId !== sid) pl.bindSession(tab.id, sid);
  pl.promoteTab(sid);
}

function onSendBtw(prompt: string, opts: { lightweight: boolean }) {
  sendBtw(prompt, opts);
}

function onTabContext(tabId: string, x: number, y: number) {
  // 右键即激活该 tab：菜单里的「拆分」作用于被点的 tab（splitGroup 移动的是激活 tab）
  pl.setActiveTab(props.group.id, tabId);
  showContextMenu(x, y, paneTabMenuItems(props.group.id, tabId));
}

function onNewTab() {
  pl.focusGroup(props.group.id);
  pl.openBlankTab(`新会话 ${new Date().toLocaleTimeString()}`);
}
</script>

<template>
  <div class="pane-group" @mousedown.capture="pl.focusGroup(props.group.id)">
    <PaneTabBar
      :group="props.group"
      :focused="focused"
      @select="(id: string) => pl.setActiveTab(props.group.id, id)"
      @close="(id: string) => pl.closeTab(props.group.id, id)"
      @promote="(id: string) => pl.promoteTabById(props.group.id, id)"
      @context="onTabContext"
      @new-tab="onNewTab"
      @stop="stopSession"
    />
    <ChatPanel
      :focused="focused"
      :session-id="activeTab?.sessionId ?? null"
      :workspace-path="effectiveWorkspacePath"
      :messages="messages"
      :is-busy="isBusy"
      :models="models"
      :current-model="currentModel"
      :model-switch-result="modelSwitchResult"
      :context-usage="contextUsage"
      :rate-limit="rateLimit"
      :tasks="tasks"
      :permission-modes="permissionModes"
      :current-permission-mode="currentPermissionMode"
      :queued-prompts="queuedPrompts"
      :permission="pendingPermission"
      :permission-queue-count="pendingPermissionCount"
      class="pane-group__chat"
      @send="onSend"
      @send-btw="onSendBtw"
      @interrupt="interrupt"
      @set-model="setModel"
      @set-permission-mode="setPermissionMode"
      @remove-queued="removeQueued"
      @respond-permission="(id: string, approved: boolean, always?: boolean, answers?: Record<string, string>) => respondPermission(id, approved, always, answers)"
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
</style>
