<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import TreeNodeItem from "./TreeNodeItem.vue";
import { useContextMenu } from "../composables/useContextMenu";
import { useFileViewer } from "../composables/useFileViewer";
import { useSessionState } from "../composables/useSessionState";
import { fileTreeAreaMenuItems } from "../menus/contextMenus";
import { api } from "../api";
import { useFileClipboard, getParentPath } from "../composables/useFileClipboard";
import type { FileEntry } from "../types";

const props = defineProps<{ sessionId: string }>();

const projectInfo = ref({ root: "...", name: "...", branch: "" });
const treeData = ref<FileEntry[]>([]);
const loading = ref(true);
const errorMsg = ref("");
const expandedDirs = ref<Set<string>>(new Set());
const selectedPath = ref<string>("");
const showHidden = ref(false);

async function toggleDir(path: string) {
  if (expandedDirs.value.has(path)) {
    expandedDirs.value.delete(path);
    removeExpandedDescendants(path);
  } else {
    expandedDirs.value.add(path);
    await loadChildren(path);
    await autoExpandSingleChild(path);
    await loadExpandedDescendants(path);
  }
}

async function autoExpandSingleChild(dirPath: string) {
  const node = findNode(treeData.value, dirPath);
  if (!node?.children) return;
  if (node.children.length === 1 && node.children[0].is_dir) {
    const child = node.children[0];
    expandedDirs.value.add(child.path);
    await loadChildren(child.path);
    await autoExpandSingleChild(child.path);
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
const { clipboard, copy, cut, clear, executePaste } = useFileClipboard();

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
    await autoExpandSingleChild(root);
  } catch (e) {
    errorMsg.value = `加载文件树失败: ${e}`;
    treeData.value = [];
  }
  loading.value = false;
}

function toggleHidden() {
  showHidden.value = !showHidden.value;
  loadRoot();
}

onMounted(() => {
  loadRoot();
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

function getSelectedNodeIsDir(): boolean {
  if (!selectedPath.value) return false;
  const node = findNode(treeData.value, selectedPath.value);
  return node?.is_dir ?? false;
}

async function onTreeKeydown(e: KeyboardEvent) {
  if (e.ctrlKey && e.key === 'c') {
    if (!selectedPath.value) return;
    e.preventDefault();
    copy(selectedPath.value);
  } else if (e.ctrlKey && e.key === 'x') {
    if (!selectedPath.value || selectedPath.value === projectInfo.value.root) return;
    e.preventDefault();
    cut(selectedPath.value);
  } else if (e.ctrlKey && e.key === 'v') {
    if (!clipboard.value) return;
    e.preventDefault();
    const targetDir = selectedPath.value
      ? (getSelectedNodeIsDir() ? selectedPath.value : getParentPath(selectedPath.value))
      : projectInfo.value.root;
    const srcParent = getParentPath(clipboard.value.path);
    await executePaste(
      targetDir,
      () => loadChildren(srcParent),
      () => loadChildren(targetDir),
    );
  } else if (e.key === 'Escape') {
    if (!clipboard.value) return;
    e.preventDefault();
    clear();
  }
}

defineExpose({ loadRoot });
</script>

<template>
  <div class="file-tree">
    <div class="path-bar">
      <div class="path-left">
        <span v-if="projectInfo.branch" class="path-branch">{{ projectInfo.branch }}</span>
        <span v-else class="path-hint">{{ projectInfo.name }}</span>
      </div>
      <button class="hidden-toggle" :class="{ active: showHidden }" @click.stop="toggleHidden" v-tooltip="showHidden ? '隐藏隐藏文件' : '显示隐藏文件'">
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
    <div class="tree-content" tabindex="0" @contextmenu="onAreaContextMenu" @keydown="onTreeKeydown">
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
          :session-id="sessionId"
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
  background: var(--aide-bg-deep);
  border-bottom: 1px solid var(--aide-surface-default);
  flex-shrink: 0;
}

.path-left {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--aide-text-secondary);
  overflow: hidden;
  padding: 2px 6px;
}

.path-branch {
  font-size: 10px;
  color: var(--aide-text-muted);
  background: var(--aide-surface-default);
  border-radius: var(--aide-radius-sm);
  padding: 1px 5px;
  flex-shrink: 0;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.path-hint {
  font-size: 11px;
  color: var(--aide-text-muted);
}

.hidden-toggle {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--aide-text-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  transition: color 0.15s, background 0.15s;
}
.hidden-toggle:hover {
  color: var(--aide-text-secondary);
  background: var(--aide-surface-default);
}
.hidden-toggle.active {
  color: var(--aide-accent);
}

.tree-content {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.tree-status {
  padding: 16px;
  color: var(--aide-text-muted);
  font-size: 12px;
  text-align: center;
}

.tree-status.error {
  color: var(--aide-danger);
}
</style>

