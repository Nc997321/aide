<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed, nextTick } from "vue";
import TreeNodeItem from "./TreeNodeItem.vue";
import { useContextMenu } from "../composables/useContextMenu";
import { useFileViewer } from "../composables/useFileViewer";
import { useSessionState } from "../composables/useSessionState";
import { useCodeGraphProgress } from "../composables/useCodeGraphProgress";
import { fileTreeAreaMenuItems } from "../menus/contextMenus";
import { api } from "../api";
import { useFileClipboard, getParentPath } from "../composables/useFileClipboard";
import type { FileEntry, WorkspaceInfo } from "../types";

const props = defineProps<{ sessionId: string }>();
const emit = defineEmits<{ "switch-workspace": [wsKey: string] }>();

const projectInfo = ref({ root: "...", name: "...", branch: "" });
const treeData = ref<FileEntry[]>([]);
const loading = ref(true);
const errorMsg = ref("");
const expandedDirs = ref<Set<string>>(new Set());
const selectedPath = ref<string>("");
const showHidden = ref(false);

// ── CodeGraph 构建进度（方案 A：底部条）──
const CGP_SEGMENTS = 18; // 分段方块格数（signature：符号逐个点亮）
const cg = useCodeGraphProgress();
const cgPct = computed(() => {
  const { done, total } = cg.progress.value;
  if (!total) return 0;
  return Math.min(100, Math.round((done / total) * 100));
});
const cgFilled = computed(() => {
  const { done, total } = cg.progress.value;
  if (!total) return 0;
  return Math.min(CGP_SEGMENTS, Math.round((done / total) * CGP_SEGMENTS));
});
const cgStatus = computed(() => {
  const s = cg.progress.value.current;
  return s || "代码索引";
});

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
    if (!root) {
      // 无显式工作区（首次使用 / 工作区被删 / 路径失效）：显示空态，绝不
      // 加载任何目录——历史上这里会回退到家目录，把整个用户目录渲染出来
      // 并触发 CodeGraph 全量索引（405 万符号 / 3GB 的事故）。
      treeData.value = [];
      expandedDirs.value = new Set();
      loading.value = false;
      return;
    }
    // 项目加载锚点：触发 CodeGraph 索引构建（若未建/切项目）。
    // ensureIndex 内部 lastIndexedRoot 守卫 + close 上一个，同一 root 不重复。
    cg.ensureIndex(root);
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
  show(
    e.clientX,
    e.clientY,
    fileTreeAreaMenuItems(projectInfo.value.root, loadRoot, {
      rescan: (root: string) => cg.rescan(root),
      rebuild: (root: string) => cg.rebuild(root),
    }),
  );
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
  // 原地刷新：不重置 expandedDirs、不触发 loading 闪烁，只逐目录重载子节点，
  // 保持视觉展开状态。旧的 loadRoot() 推倒重建会把 expandedDirs 清成 [root]，
  // 再用 loadExpandedDescendants(root) 恢复——但 root 不在 treeData 中
  // （treeData 存的是 root 的直属子节点），findNode 返回 null 直接退出，
  // 导致已展开目录的 children 不被重载，出现"按钮展开、内容收起"的错位。
  try {
    projectInfo.value = await api.getProjectInfo();
  } catch {
    // 项目信息刷新失败不阻断树刷新
  }
  // 无显式工作区时不刷新（root 为空，loadChildren("") 只会报错）。
  if (!projectInfo.value.root) return;
  // 重载 root 直属子节点（loadChildren(root) 整体替换 treeData）
  await loadChildren(projectInfo.value.root);
  // 自顶向下补加载已展开目录的子节点
  await reloadExpandedDescendants(treeData.value);
}

async function reloadExpandedDescendants(nodes: FileEntry[]) {
  for (const node of nodes) {
    if (!node.is_dir || !expandedDirs.value.has(node.path)) continue;
    await loadChildren(node.path);
    if (node.children) await reloadExpandedDescendants(node.children);
  }
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

// ── 工作区（项目）切换器 ───────────────────────────────────────────────────
// path-bar 上的项目名即切换入口：点开列出所有工作区，选中后把 wsKey 抛给
// App.vue，由侧栏（单一数据源）执行真正切换并广播 workspace-changed，避免
// 文件树自己 setWorkspace 造成侧栏 activeWorkspace 与实际工作区脱节。
const wsDropdownOpen = ref(false);
const wsLoading = ref(false);
const workspaceList = ref<WorkspaceInfo[]>([]);
const wsSwitcherRef = ref<HTMLElement>();

async function toggleWsDropdown() {
  if (wsDropdownOpen.value) {
    wsDropdownOpen.value = false;
    return;
  }
  wsDropdownOpen.value = true;
  wsLoading.value = true;
  try {
    workspaceList.value = await api.listWorkspaces();
  } catch {
    workspaceList.value = [];
  }
  wsLoading.value = false;
}

function wsLabel(ws: WorkspaceInfo): string {
  return ws.name.split(/[\\/]/).filter(Boolean).pop() || ws.name;
}

function onSelectWorkspace(ws: WorkspaceInfo) {
  wsDropdownOpen.value = false;
  if (ws.missing || ws.name === projectInfo.value.root) return;
  emit("switch-workspace", ws.key);
}

function onWsClickOutside(e: MouseEvent) {
  if (wsSwitcherRef.value && !wsSwitcherRef.value.contains(e.target as Node)) {
    wsDropdownOpen.value = false;
  }
}
onMounted(() => document.addEventListener("click", onWsClickOutside));
onUnmounted(() => document.removeEventListener("click", onWsClickOutside));

/**
 * 在文件树中定位并高亮指定文件：展开所有祖先目录 → 选中 → 滚动到可见。
 * 由 App.vue 在收到 revealInTreePath 信号时调用。
 */
async function revealFile(filePath: string) {
  if (!filePath || !projectInfo.value.root) return;

  const root = projectInfo.value.root;
  const sep = root.includes("\\") ? "\\" : "/";

  // 打开入口的路径风格不一：文件树点击给的是原生分隔符，会话变更面板 / 聊天
  // 文件链接给的是统一正斜杠。先归一到树的约定，否则下面的 startsWith 前缀
  // 检查和 selectFile 全等比较会静默落空（定位无任何反应）。
  const normalized = filePath.replace(/[\\/]/g, sep);

  // 确保 filePath 在项目根目录下（Windows 路径大小写不敏感，放宽前缀比较）
  const prefixOk =
    sep === "\\"
      ? normalized.toLowerCase().startsWith(root.toLowerCase())
      : normalized.startsWith(root);
  if (!prefixOk) return;

  // 计算从根到目标文件的所有祖先目录（不含根、不含文件自身）
  const relative = normalized.slice(root.length).replace(/^[\\/]/, "");
  const parts = relative.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return;

  // 用 root + 段重建目标路径，保证与树节点路径（原生分隔符 + root 原始大小写）
  // 逐字节一致——树节点的选中高亮靠 path 全等匹配
  const target = root + sep + parts.join(sep);
  const ancestors: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const ancestor = root + sep + parts.slice(0, i + 1).join(sep);
    ancestors.push(ancestor);
  }

  // 自顶向下逐层确保展开并加载子节点
  for (const dir of ancestors) {
    if (!expandedDirs.value.has(dir)) {
      expandedDirs.value.add(dir);
      await loadChildren(dir);
    } else {
      // 已展开但子节点可能还没加载（手动 toggle 后未展开过深层）
      const node = findNode(treeData.value, dir);
      if (node && !node.children) {
        await loadChildren(dir);
      }
    }
  }

  // 选中目标文件
  selectFile(target);

  // 等待 Vue 更新 DOM 后滚动到目标节点
  await nextTick();
  const treeEl = document.querySelector(".tree-content") as HTMLElement | null;
  if (!treeEl) return;
  const activeEl = treeEl.querySelector(".tree-node.active") as HTMLElement | null;
  if (activeEl) {
    activeEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

defineExpose({ loadRoot, revealFile });
</script>

<template>
  <div class="file-tree">
    <div class="path-bar">
      <div ref="wsSwitcherRef" class="ws-switcher">
        <button class="ws-trigger" v-tooltip="projectInfo.root" @click.stop="toggleWsDropdown">
          <svg class="ws-folder" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <span class="ws-project-name">{{ projectInfo.name || "未打开工作区" }}</span>
          <span v-if="projectInfo.branch" class="path-branch">{{ projectInfo.branch }}</span>
          <svg class="ws-chevron" :class="{ open: wsDropdownOpen }" width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2.5 3.5L5 6L7.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div v-if="wsDropdownOpen" class="ws-dropdown">
          <div v-if="wsLoading" class="ws-dropdown-status">加载中…</div>
          <template v-else>
            <button
              v-for="ws in workspaceList"
              :key="ws.key"
              class="ws-option"
              :class="{ active: ws.name === projectInfo.root, missing: ws.missing }"
              :disabled="ws.missing"
              v-tooltip="ws.missing ? '路径已失效' : ws.name"
              @click="onSelectWorkspace(ws)"
            >
              <span class="ws-option-name">{{ wsLabel(ws) }}</span>
              <span v-if="ws.name === projectInfo.root" class="ws-option-check">✓</span>
            </button>
            <div v-if="workspaceList.length === 0" class="ws-dropdown-status">无其它项目</div>
          </template>
        </div>
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
    <div class="tree-content" tabindex="0" @contextmenu="onAreaContextMenu" @keydown="onTreeKeydown" @dragover.prevent @drop.prevent>
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
        <div v-if="treeData.length === 0" class="tree-status">
          {{ projectInfo.root ? "目录为空" : "未打开工作区 — 从左侧栏选择一个项目" }}
        </div>
      </template>
    </div>

    <!-- CodeGraph 构建进度（方案 A：底部条）。CSS 变量自动跟主题。 -->
    <Transition name="cgp-fade">
      <div v-if="cg.building.value" class="cgp-bar">
        <i
          v-if="cg.progress.value.index_ready"
          class="cgp-ready"
          v-tooltip="'精确跳转已就绪 · 语义搜索后台补全中'"
        >✓</i>
        <i v-else class="cgp-dot"></i>
        <span class="cgp-status" v-tooltip="cg.progress.value.current">{{ cgStatus }}</span>
        <div class="cgp-segments">
          <span
            v-for="i in CGP_SEGMENTS"
            :key="i"
            class="cgp-seg"
            :class="{ on: i <= cgFilled }"
          />
        </div>
        <span class="cgp-pct">{{ cgPct }}%</span>
      </div>
    </Transition>

  </div>
</template>

<style scoped>
.file-tree {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
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

.ws-switcher {
  position: relative;
  min-width: 0;
  flex: 1;
}

.ws-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  background: none;
  border: none;
  padding: 2px 6px;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  color: var(--aide-text-secondary);
  transition: background 0.15s, color 0.15s;
}
.ws-trigger:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

.ws-folder {
  flex-shrink: 0;
  color: var(--aide-text-muted);
}

.ws-project-name {
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-chevron {
  flex-shrink: 0;
  color: var(--aide-text-muted);
  transition: transform 0.15s;
}
.ws-chevron.open {
  transform: rotate(180deg);
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

.ws-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 200px;
  max-width: 320px;
  max-height: 320px;
  overflow-y: auto;
  z-index: 200;
  padding: 4px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  box-shadow: var(--aide-shadow-lg);
}

.ws-dropdown-status {
  padding: 8px 10px;
  font-size: 11px;
  color: var(--aide-text-muted);
  text-align: center;
}

.ws-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: none;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  color: var(--aide-text-secondary);
  font-size: 12px;
  text-align: left;
  transition: background 0.12s, color 0.12s;
}
.ws-option:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
.ws-option.active {
  color: var(--aide-accent);
}
.ws-option.missing {
  opacity: 0.45;
  cursor: not-allowed;
  text-decoration: line-through;
}

.ws-option-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-option-check {
  flex-shrink: 0;
  color: var(--aide-accent);
  font-size: 11px;
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

/* ── CodeGraph 构建进度条（方案 A：底部条）──
   全部用主题 CSS 变量，Warm Dark / Catppuccin 自动切换。
   分段方块是 signature：一格一格点亮，呼应符号逐个被索引。
   活跃色用主题 accent（Warm Dark = 工匠黄铜），不是 success 绿——
   与 Warm Dark 的主题色一致。 */
.cgp-bar {
  flex-shrink: 0;
  border-top: 1px solid var(--aide-border);
  background: var(--aide-bg-raised);
  padding: 9px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.cgp-status {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--aide-text-secondary);
  font-family: var(--aide-font-mono);
}
.cgp-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--aide-accent);
  flex-shrink: 0;
  animation: cgp-breathe 1.6s ease-in-out infinite;
}
.cgp-ready {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  color: var(--aide-accent);
  cursor: help;
}
@keyframes cgp-breathe {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.4; }
}
.cgp-segments {
  flex-shrink: 0;
  width: 120px;
  display: flex;
  gap: 2px;
  height: 8px;
  align-items: center;
}
.cgp-seg {
  flex: 1;
  height: 8px;
  border-radius: 2px;
  background: var(--aide-surface-default);
  transition: background 0.25s ease;
}
.cgp-seg.on {
  background: var(--aide-accent);
}
.cgp-pct {
  font-family: var(--aide-font-mono);
  font-size: 12px;
  color: var(--aide-accent);
  font-weight: 500;
  min-width: 38px;
  text-align: right;
  flex-shrink: 0;
}

/* 进入/离开淡出 */
.cgp-fade-enter-active,
.cgp-fade-leave-active {
  transition: opacity 0.35s ease;
}
.cgp-fade-enter-from,
.cgp-fade-leave-to {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .cgp-dot { animation: none; }
  .cgp-seg { transition: none; }
  .cgp-fade-enter-active, .cgp-fade-leave-active { transition: none; }
}
</style>

