<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import TreeNodeItem from "./TreeNodeItem.vue";
import { useContextMenu } from "../composables/useContextMenu";
import { fileTreeAreaMenuItems } from "../menus/contextMenus";

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children: FileEntry[] | null;
}

const projectInfo = ref({ root: "...", name: "...", branch: "" });
const treeData = ref<FileEntry[]>([]);
const loading = ref(true);
const errorMsg = ref("");
const expandedDirs = ref<Set<string>>(new Set());
const selectedPath = ref<string>("");
const workspaces = ref<string[]>([]);
const showWsDropdown = ref(false);

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
    const entries = await invoke<FileEntry[]>("list_directory", { path: dirPath });
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

async function openFile(path: string) {
  selectFile(path);
  try {
    await invoke("file_open", { path });
  } catch (e) {
    errorMsg.value = `无法打开: ${e}`;
  }
}

async function loadRoot() {
  loading.value = true;
  errorMsg.value = "";
  try {
    const info = await invoke<{ root: string; name: string; branch: string }>("get_project_info");
    projectInfo.value = info;
    const root = info.root;
    const entries = await invoke<FileEntry[]>("list_directory", { path: root });
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
    workspaces.value = await invoke<string[]>("list_workspaces");
  } catch (_e) {
    workspaces.value = [];
  }
}

async function selectWorkspace(path: string) {
  showWsDropdown.value = false;
  if (path === projectInfo.value.root) return;
  try {
    await invoke("set_workspace", { path });
  } catch (_e) { /* ignore */ }
  emit("workspace-changed", path);
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
          :key="ws"
          class="ws-item"
          :class="{ active: ws === projectInfo.root }"
          @click="selectWorkspace(ws)"
        >
          <span class="ws-item-icon">&#x1F4C1;</span>
          <span class="ws-item-text">{{ ws }}</span>
        </div>
        <div v-if="workspaces.length === 0" class="ws-item muted">
          未找到其他工作区
        </div>
      </div>
    </div>

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
</style>
