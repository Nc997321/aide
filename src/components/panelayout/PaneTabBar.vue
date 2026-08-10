<script setup lang="ts">
import { inject, ref, type Ref } from "vue";
import { useSessionState } from "../../composables/useSessionState";
import { useSessionNames } from "../../composables/useSessionNames";
import { useSessionWorkspaces, workspaceLabelFromPath } from "../../composables/useSessionWorkspaces";
import { WORKSPACE_PATH_KEY } from "./keys";
import { AStatusDot } from "../../ui";
import type { GroupNode, TabItem } from "../../composables/paneLayout/tree";

const props = defineProps<{
  group: GroupNode;
  /** 本组是否为聚焦组（决定激活 tab 的强调程度） */
  focused: boolean;
}>();

const emit = defineEmits<{
  select: [tabId: string];
  close: [tabId: string];
  /** 双击预览 tab 转正 */
  promote: [tabId: string];
  context: [tabId: string, x: number, y: number];
  "new-tab": [];
}>();

const { state: sessionState, dotTone } = useSessionState();
const { displayName } = useSessionNames();
const { workspaceOf } = useSessionWorkspaces();
const activeWorkspacePath = inject<Ref<string>>(WORKSPACE_PATH_KEY, ref(""));

/** 跨工作区标识：会话（含空白 tab 的创建时绑定）不属于当前活动工作区时
 *  返回其工作区短名，否则空串。Windows 路径大小写不敏感，比较统一转小写。 */
function wsSuffix(tab: TabItem): string {
  const ws = tab.sessionId ? workspaceOf(tab.sessionId) : (tab.pendingWs ?? null);
  if (!ws?.wsPath) return "";
  if (ws.wsPath.toLowerCase() === activeWorkspacePath.value.toLowerCase()) return "";
  return workspaceLabelFromPath(ws.wsPath);
}

function wsFullPath(tab: TabItem): string {
  if (tab.sessionId) return workspaceOf(tab.sessionId)?.wsPath || "";
  return tab.pendingWs?.wsPath || "";
}

/** 该 tab 的会话进程是否存活（决定 X 按钮的存活态视觉：tooltip 文案 + hover 危险色）。
 *  per-tab 判定——点哪个 tab 的 X 就停哪个，比原组级"激活 tab"按钮更精准。 */
function tabLive(tab: TabItem): boolean {
  return !!tab.sessionId && (sessionState[tab.sessionId] ?? "stopped") !== "stopped";
}

function label(tab: TabItem): string {
  if (tab.sessionId) return displayName(tab.sessionId);
  return tab.pendingName || "新会话";
}

function onContextMenu(e: MouseEvent, tab: TabItem) {
  e.preventDefault();
  emit("context", tab.id, e.clientX, e.clientY);
}

/** 中键点击关 tab（编辑器惯例） */
function onAuxClick(e: MouseEvent, tab: TabItem) {
  if (e.button === 1) {
    e.preventDefault();
    emit("close", tab.id);
  }
}
</script>

<template>
  <div class="pane-tab-bar" :class="{ 'pane-tab-bar--focused': focused }">
    <div class="pane-tabs">
      <div
        v-for="tab in props.group.tabs"
        :key="tab.id"
        class="pane-tab"
        :class="{
          'pane-tab--active': tab.id === props.group.activeTabId,
          'pane-tab--preview': tab.id === props.group.previewTabId,
        }"
        @click="emit('select', tab.id)"
        @dblclick="emit('promote', tab.id)"
        @auxclick="onAuxClick($event, tab)"
        @contextmenu="onContextMenu($event, tab)"
      >
        <AStatusDot v-if="tab.sessionId" :tone="dotTone(tab.sessionId)" />
        <span class="pane-tab__label" v-tooltip="label(tab)">{{ label(tab) }}</span>
        <span
          v-if="wsSuffix(tab)"
          class="pane-tab__ws"
          v-tooltip="wsFullPath(tab)"
        >· {{ wsSuffix(tab) }}</span>
        <button
          class="pane-tab__close"
          :class="{ 'pane-tab__close--live': tabLive(tab) }"
          v-tooltip="tabLive(tab) ? '停止会话并关闭' : '关闭'"
          @click.stop="emit('close', tab.id)"
        >
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M1 1L7 7M7 1L1 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        </button>
      </div>
    </div>
    <button class="pane-tab-new" v-tooltip="'新建会话 tab'" @click="emit('new-tab')">
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M5 1V9M1 5H9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
    </button>
  </div>
</template>

<style scoped>
.pane-tab-bar {
  display: flex;
  align-items: stretch;
  flex-shrink: 0;
  height: 32px;
  background: var(--aide-bg-deep);
  border-bottom: 1px solid var(--aide-border);
  user-select: none;
  min-width: 0;
}

.pane-tabs {
  display: flex;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none; /* tab 条内滚动不出滚动条 */
}

.pane-tabs::-webkit-scrollbar {
  display: none;
}

.pane-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px 0 10px;
  max-width: 180px;
  min-width: 0;
  cursor: pointer;
  color: var(--aide-text-muted);
  font-size: 12px;
  border-right: 1px solid var(--aide-border-subtle, var(--aide-border));
  border-top: 2px solid transparent;
  background: transparent;
  transition: background 0.12s ease, color 0.12s ease;
}

.pane-tab:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-secondary);
}

.pane-tab--active {
  background: var(--aide-bg-base);
  color: var(--aide-text-primary);
}

/* 聚焦组的激活 tab 才有 accent 顶线——一眼分辨「当前会话」在哪个组 */
.pane-tab-bar--focused .pane-tab--active {
  border-top-color: var(--aide-accent);
}

/* 预览 tab：斜体（VS Code 惯例） */
.pane-tab--preview .pane-tab__label {
  font-style: italic;
}

.pane-tab__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* 跨工作区后缀：淡色小字，不参与省略挤压（保住辨识度） */
.pane-tab__ws {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--aide-text-muted);
  opacity: 0.75;
  max-width: 72px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pane-tab__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  border: none;
  border-radius: var(--aide-radius-sm, 3px);
  background: transparent;
  color: var(--aide-text-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s ease, background 0.12s ease;
}

.pane-tab:hover .pane-tab__close,
.pane-tab--active .pane-tab__close {
  opacity: 1;
}

.pane-tab__close:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}

/* 会话存活时：X 图标不变，仅 hover 走危险色 + tooltip 切"停止会话并关闭"——
   颜色 + 文案双重提示"点我会停止"，颜色统一用主题语义 token（--aide-danger）。 */
.pane-tab__close--live:hover {
  color: var(--aide-danger);
}

.pane-tab-new {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--aide-text-muted);
  cursor: pointer;
  transition: color 0.12s ease, background 0.12s ease;
}

.pane-tab-new:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
</style>
