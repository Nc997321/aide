<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";
import TreeNodeItem from "./TreeNodeItem.vue";
import { useContextMenu } from "../composables/useContextMenu";
import { useFileViewer } from "../composables/useFileViewer";
import { useSessionState } from "../composables/useSessionState";
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
const showHidden = ref(false);

const emit = defineEmits<{
  "workspace-changed": [path: string];
}>();

async function toggleDir(path: string) {
  if (expandedDirs.value.has(path)) {
    expandedDirs.value.delete(path);
    removeExpandedDescendants(path);
  } else {
    expandedDirs.value.add(path);
    await loadChildren(path);
    await loadExpandedDescendants(path);
  }
}

function removeExpandedDescendants(dirPath: string) {
  const node = findNode(treeData.value, dirPath);
  if (!node || !node.children) return;
  for (const child of node.children) {
    if (child.is_dir && expandedDirs.value.has(child.path)) {
      expandedDirs.value.delete(child.path);
      removeExpandedDescendants(child.path);
    }
  }
}

async function loadExpandedDescendants(dirPath: string) {
  const node = findNode(treeData.value, dirPath);
  if (!node || !node.children) return;
  const expandedSubdirs = node.children.filter(
    (c) => c.is_dir && expandedDirs.value.has(c.path),
  );
  for (const subdir of expandedSubdirs) {
    await loadChildren(subdir.path);
    await loadExpandedDescendants(subdir.path);
  }
}

function findNode(nodes: FileEntry[], path: string): FileEntry | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

async function loadChildren(dirPath: string) {
  try {
    const entries = await api.listDirectory(dirPath, showHidden.value);
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
    const entries = await api.listDirectory(root, showHidden.value);
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

function toggleHidden() {
  showHidden.value = !showHidden.value;
  loadRoot();
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

// Refresh file tree when the active session finishes a response round
const { state: sessionState } = useSessionState();
let prevSessionStatus = "";

watch(
  () => (props.sessionId ? sessionState[props.sessionId] : undefined),
  (newStatus) => {
    if (!newStatus || newStatus === prevSessionStatus) return;
    const prev = prevSessionStatus;
    prevSessionStatus = newStatus;

    if (newStatus === "waiting" || newStatus === "stopped") {
      if (prev === "running" || prev === "attention") {
        refreshAllExpanded();
      }
    }
  },
);

async function refreshAllExpanded() {
  // Small delay to let useConversationChanges.captureChanges finish git ops
  await new Promise((r) => setTimeout(r, 300));
  const saved = new Set(expandedDirs.value);
  await loadRoot();
  // loadRoot resets expandedDirs to just root; restore and reload recursively
  expandedDirs.value = saved;
  await loadExpandedDescendants(projectInfo.value.root);
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
      <button class="hidden-toggle" :class="{ active: showHidden }" @click.stop="toggleHidden" :title="showHidden ? '隐藏隐藏文件' : '显示隐藏文件'">
        <svg v-if="!showHidden" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
          <line x1="1" y1="1" x2="23" y2="23"/>
        </svg>
        <svg v-else xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </button>
    </div>

    <!-- File tree -->
    <div class="tree-content" @contextmenu="onAreaContextMenu">
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

  </div>
</template>

<style scoped>
.file-tree {
  flex: 1;
  min-height: 0;
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
  font-size: 14px;
  flex-shrink: 0;
  transition: transform 0.15s;
  margin-left: 2px;
}
.ws-arrow.open {
  transform: rotate(180deg);
}

.hidden-toggle {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  transition: color 0.15s, background 0.15s;
}
.hidden-toggle:hover {
  color: var(--text-secondary);
  background: var(--surface);
}
.hidden-toggle.active {
  color: var(--accent);
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
</style>

