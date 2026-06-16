<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";
import TreeNodeItem from "./TreeNodeItem.vue";
import { useContextMenu } from "../composables/useContextMenu";
import { useFileViewer } from "../composables/useFileViewer";
import { useConversationChanges } from "../composables/useConversationChanges";
import { fileTreeAreaMenuItems } from "../menus/contextMenus";
import { api } from "../api";
import type { FileEntry, WorkspaceInfo } from "../types";

const props = defineProps<{ sessionId: string }>();

const projectInfo = ref({ root: "...", name: "...", branch: "" });
const treeData = ref<FileEntry[]>([]);
const loading = ref(true);
const errorMsg = ref("");
const expandedDirs = ref<Set<string>>(new Set());
const selectedPath = ref<string>("");
const workspaces = ref<WorkspaceInfo[]>([]);
const showWsDropdown = ref(false);

// ── Tab switching ──

type TabId = "files" | "changes";
const activeTab = ref<TabId>("files");

// ── Conversation change log ──

const { rounds, revertRound, revertSingleFile } = useConversationChanges(() => props.sessionId);

function resolveDiffPath(rel: string): string {
  return projectInfo.value.root.replace(/\\/g, "/") + "/" + rel;
}

function switchTab(tab: TabId) {
  activeTab.value = tab;
}

const emit = defineEmits<{
  "workspace-changed": [path: string];
}>();

async function toggleDir(path: string) {
  if (expandedDirs.value.has(path)) {
    expandedDirs.value.delete(path);
  } else {
    expandedDirs.value.add(path);
    await loadChildren(path);
  }
}

async function loadChildren(dirPath: string) {
  try {
    const entries = await api.listDirectory(dirPath);
    if (dirPath === projectInfo.value.root) {
      // Refresh root: replace treeData entirely
      treeData.value = entries;
    } else {
      setChildren(treeData.value, dirPath, entries);
    }
  } catch (e) {
    errorMsg.value = `加载失败: ${e}`;
  }
}

function setChildren(nodes: FileEntry[], targetPath: string, entries: FileEntry[]): boolean {
  for (const node of nodes) {
    if (node.path === targetPath) {
      node.children = entries;
      return true;
    }
    if (node.children && setChildren(node.children, targetPath, entries)) {
      return true;
    }
  }
  return false;
}

function selectFile(path: string) {
  selectedPath.value = path;
}

const fileViewer = useFileViewer();

function openFile(path: string) {
  selectFile(path);
  fileViewer.open(path);
}

async function loadRoot() {
  loading.value = true;
  errorMsg.value = "";
  try {
    const info = await api.getProjectInfo();
    projectInfo.value = info;
    const root = info.root;
    const entries = await api.listDirectory(root);
    treeData.value = entries;
    expandedDirs.value = new Set([root]);
  } catch (e) {
    errorMsg.value = `加载文件树失败: ${e}`;
    treeData.value = [];
  }
  loading.value = false;
}

async function loadWorkspaces() {
  try {
    workspaces.value = await api.listWorkspaces();
  } catch (_e) {
    workspaces.value = [];
  }
}

async function selectWorkspace(ws: WorkspaceInfo) {
  showWsDropdown.value = false;
  if (ws.name === projectInfo.value.root) return;
  try {
    await api.setWorkspace(ws.key, ws.name);
  } catch (_e) { return; }
  emit("workspace-changed", ws.name);
  await loadRoot();
}

function toggleWsDropdown(e: MouseEvent) {
  e.stopPropagation();
  showWsDropdown.value = !showWsDropdown.value;
  if (showWsDropdown.value) {
    loadWorkspaces();
  }
}

function closeWsDropdown() {
  showWsDropdown.value = false;
}

onMounted(() => {
  loadRoot();
  document.addEventListener("click", closeWsDropdown);
});

onUnmounted(() => {
  document.removeEventListener("click", closeWsDropdown);
});

const { show } = useContextMenu();

function onAreaContextMenu(e: MouseEvent) {
  e.preventDefault();
  show(e.clientX, e.clientY, fileTreeAreaMenuItems(projectInfo.value.root, loadRoot));
}

defineExpose({ loadRoot });
</script>

<template>
  <div class="file-tree">
    <div class="path-bar">
      <div class="path-left" @click="toggleWsDropdown">
        <span class="path-icon">&#x1F4C1;</span>
        <span class="path-text">{{ projectInfo.root }}<template v-if="projectInfo.branch"> &#xB7; {{ projectInfo.branch }}</template></span>
        <span class="ws-arrow" :class="{ open: showWsDropdown }">&#x25BE;</span>
      </div>
      <!-- Workspace dropdown -->
      <div v-if="showWsDropdown" class="ws-dropdown" @click.stop>
        <div
          v-for="ws in workspaces"
          :key="ws.key"
          class="ws-item"
          :class="{ active: ws.name === projectInfo.root }"
          @click="selectWorkspace(ws)"
        >
          <span class="ws-item-icon">&#x1F4C1;</span>
          <span class="ws-item-text">{{ ws.name }}</span>
        </div>
        <div v-if="workspaces.length === 0" class="ws-item muted">
          未找到其他工作区
        </div>
      </div>
    </div>

    <!-- Tab bar -->
    <div class="tab-bar">
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'files' }"
        @click="switchTab('files')"
      >文件</button>
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'changes' }"
        @click="switchTab('changes')"
      >
        会话变更
        <span v-if="rounds.length > 0" class="tab-badge">{{ rounds.length }}</span>
      </button>
    </div>

    <!-- Files tab -->
    <div class="tree-content" @contextmenu="onAreaContextMenu" v-show="activeTab === 'files'">
      <div v-if="loading" class="tree-status">加载中...</div>
      <div v-else-if="errorMsg" class="tree-status error">{{ errorMsg }}</div>
      <template v-else>
        <TreeNodeItem
          v-for="node in treeData"
          :key="node.path"
          :node="node"
          :depth="0"
          :expanded-dirs="expandedDirs"
          :selected-path="selectedPath"
          :project-root="projectInfo.root"
          :on-refresh-dir="(p: string) => loadChildren(p)"
          @toggle="toggleDir"
          @open="openFile"
        />
        <div v-if="treeData.length === 0" class="tree-status">目录为空</div>
      </template>
    </div>

    <!-- Changes tab: per-round conversation change log -->
    <div class="tree-content" v-show="activeTab === 'changes'">
      <template v-if="rounds.length === 0">
        <div class="tree-status">暂无变更 — 在终端里跟 Claude 对话，修改的文件会出现在这里</div>
      </template>
      <template v-else>
        <div v-for="(round, ri) in [...rounds].reverse()" :key="ri" class="round-group">
          <div class="round-header">
            <span class="round-badge">轮 {{ round.index }}</span>
            <span class="round-time">{{ round.time }}</span>
            <span class="round-revert" title="撤回本轮所有修改" @click="revertRound(round)">↶ 撤回本轮</span>
          </div>
          <div
            v-for="f in round.files"
            :key="f.path"
            class="diff-item"
            :class="{ selected: selectedPath === f.path }"
            @click="openFile(resolveDiffPath(f.path))"
          >
            <span class="diff-status diff-M">M</span>
            <span class="diff-path">{{ f.path }}</span>
            <span class="diff-stat">+{{ f.additions }}/-{{ f.deletions }}</span>
            <span class="diff-revert" title="撤回此文件" @click.stop="revertSingleFile(round, f.path)">↶</span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.file-tree {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.path-bar {
  position: relative;
  display: flex;
  align-items: center;
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--surface);
  flex-shrink: 0;
}

.path-left {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
  overflow: hidden;
  padding: 2px 6px;
  border-radius: 4px;
  transition: background 0.1s;
}
.path-left:hover {
  background: var(--surface);
}

.path-icon { font-size: 13px; flex-shrink: 0; }

.path-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

.ws-arrow {
  font-size: 10px;
  flex-shrink: 0;
  transition: transform 0.15s;
  margin-left: 2px;
}
.ws-arrow.open {
  transform: rotate(180deg);
}

.ws-dropdown {
  position: absolute;
  top: 100%;
  left: 8px;
  right: 8px;
  background: var(--surface);
  border: 1px solid var(--surface-hover);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  z-index: 50;
  max-height: 240px;
  overflow-y: auto;
  padding: 4px 0;
}

.ws-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.1s;
}
.ws-item:hover {
  background: var(--surface-hover);
  color: var(--text-primary);
}
.ws-item.active {
  color: var(--accent);
}
.ws-item.muted {
  color: var(--text-muted);
  cursor: default;
}
.ws-item.muted:hover {
  background: none;
  color: var(--text-muted);
}

.ws-item-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-content {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.tree-status {
  padding: 16px;
  color: var(--text-muted);
  font-size: 12px;
  text-align: center;
}

.tree-status.error {
  color: var(--accent-red);
}

/* ── Tab bar ── */

.tab-bar {
  display: flex;
  border-bottom: 1px solid var(--surface);
  flex-shrink: 0;
}

.tab-btn {
  flex: 1;
  padding: 7px 0;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.tab-btn:hover {
  color: var(--text-primary);
}
.tab-btn.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

.tab-badge {
  background: var(--surface);
  color: var(--text-muted);
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  min-width: 18px;
  text-align: center;
}
.tab-btn.active .tab-badge {
  background: var(--accent);
  color: var(--bg-primary);
}

/* ── Diff items ── */

.diff-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 16px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.1s;
  border-left: 2px solid transparent;
}
.diff-item:hover {
  background: var(--surface);
}
.diff-item.selected {
  background: var(--surface);
  border-left-color: var(--accent);
}

.diff-status {
  flex-shrink: 0;
  width: 22px;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  text-align: center;
  text-transform: uppercase;
}
.diff-M { background: rgba(249, 226, 175, 0.15); color: #f9e2af; }
.diff-A { background: rgba(166, 227, 161, 0.15); color: #a6e3a1; }
.diff-D { background: rgba(243, 139, 168, 0.15); color: #f38ba8; }
.diff-R { background: rgba(137, 180, 250, 0.15); color: #89b4fa; }
.diff-un { background: rgba(108, 112, 134, 0.15); color: #6c7086; }

.diff-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
  flex: 1;
}

.diff-stat {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-muted);
}

.diff-revert {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--text-muted);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
  opacity: 0;
  transition: opacity 0.1s, color 0.1s, background 0.1s;
}
.diff-item:hover .diff-revert {
  opacity: 1;
}
.diff-revert:hover {
  color: #f38ba8;
  background: rgba(243, 139, 168, 0.12);
}

/* ── Round groups ── */

.round-group {
  border-bottom: 1px solid var(--surface);
}

.round-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--surface);
}

.round-badge {
  font-weight: 600;
  color: var(--accent);
}

.round-time {
  flex: 1;
}

.round-revert {
  cursor: pointer;
  color: var(--text-muted);
  transition: color 0.1s;
}
.round-revert:hover {
  color: #f38ba8;
}
</style>
