<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed, nextTick } from "vue";
import TreeNodeItem from "./TreeNodeItem.vue";
import { useContextMenu } from "../composables/useContextMenu";
import { useFileViewer } from "../composables/useFileViewer";
import { useSessionState } from "../composables/useSessionState";
import { useModal } from "../composables/useModal";
import { fileTreeAreaMenuItems } from "../menus/contextMenus";
import { api, listen } from "../api";
import { useOnboarding } from "../composables/useOnboarding";
import { useFileClipboard, getParentPath } from "../composables/useFileClipboard";
import { planWatchRefresh } from "../utils/fileTreeWatch";
import { mergeFileEntries } from "../utils/fileTree";
import WorkspacePicker from "../ui/WorkspacePicker.vue";
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
const onboarding = useOnboarding();

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
    // 文件树的「显示隐藏文件」沿用旧语义：隐藏项与 node_modules/target/dist 同开关。
    const entries = await api.listDirectory(dirPath, showHidden.value, showHidden.value);
    if (dirPath === projectInfo.value.root) {
      // Refresh root: 按路径合并不整体替换——整体替换会让已展开子目录跌进
      // children=null 的过渡态，子列表卸载等补加载回来，整树闪烁波
      treeData.value = mergeFileEntries(treeData.value, entries);
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
      node.children = mergeFileEntries(node.children, entries);
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
const { clipboard, copyWithOs, cutWithOs, clear, executePaste, resolvePasteEntry } = useFileClipboard();
const modal = useModal();

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
      // （2026-08 事故：整个用户目录被渲染、索引 405 万符号 / 3GB）。
      void api.fileTreeWatch("").catch(() => {});
      treeData.value = [];
      expandedDirs.value = new Set();
      loading.value = false;
      return;
    }
    const entries = await api.listDirectory(root, showHidden.value, showHidden.value);
    treeData.value = entries;
    expandedDirs.value = new Set([root]);
    await autoExpandSingleChild(root);
    // 监听跟随当前工作区根（后端同 root 幂等短路，反复 loadRoot 无害）
    void api.fileTreeWatch(root).catch(() => {});
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

onMounted(async () => {
  // 工作区外部改动 → 自动刷新（组件 v-show 常驻挂载，监听贯穿应用生命周期；
  // unlisten 见下方 onUnmounted）
  unlistenFs = await listen<string[]>("file-tree-changed", (e) => onTreeChanged(e.payload));
  void loadRoot();
});

onUnmounted(() => {
  unlistenFs?.();
  unlistenFs = null;
  if (watchRefreshTimer) clearTimeout(watchRefreshTimer);
  watchRefreshTimer = null;
});

const { show } = useContextMenu();

function onAreaContextMenu(e: MouseEvent) {
  e.preventDefault();
  // 索引维护（更新/全量重建）已迁右侧栏「代码索引」tab，菜单只剩刷新/新建/粘贴。
  show(e.clientX, e.clientY, fileTreeAreaMenuItems(projectInfo.value.root, refreshAllExpanded));
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

async function refreshAllExpanded(immediate = false) {
  // Small delay to let useConversationChanges.captureChanges finish git ops
  if (!immediate) await new Promise((r) => setTimeout(r, 300));
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

/**
 * 文件操作（移动/粘贴/重命名/删除/新建）后的局部刷新。
 * 裸 loadChildren 会整体替换目标目录的 children——新条目里所有子目录的
 * children 都是 null，而 TreeNodeItem 的渲染条件是 isExpanded && node.children，
 * 于是已展开的子孙目录"箭头朝下、内容消失"；刷新根目录时整棵树全部收起。
 * 这里重载后自顶向下补加载仍处于展开状态的子孙目录，与 refreshAllExpanded 同理。
 */
async function refreshDir(dirPath: string) {
  await loadChildren(dirPath);
  const base =
    dirPath === projectInfo.value.root
      ? treeData.value
      : findNode(treeData.value, dirPath)?.children;
  if (base) await reloadExpandedDescendants(base);
}

/**
 * 多目录刷新统一入口：root 直接受影响走整体刷新，其余逐目录原地刷新。
 * executePaste / 系统剪贴板来源的多路径粘贴共用。
 */
function refreshDirs(dirs: string[]) {
  for (const d of dirs) {
    if (d === projectInfo.value.root) void refreshAllExpanded(true);
    else void refreshDir(d);
  }
}

// ── 工作区文件系统监听（filewatch.rs → "file-tree-changed" → 树刷新）────────
// 三层降噪：后端归集/冷却合并 → planWatchRefresh 相关性过滤 → 此处 250ms
// trailing 防抖合并连续批次，只发一次刷新。
let unlistenFs: (() => void) | null = null;
let watchRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let watchPlanFull = false;
const watchPendingDirs = new Set<string>();

function onTreeChanged(dirs: string[]) {
  if (!projectInfo.value.root) return;
  const plan = planWatchRefresh(dirs, projectInfo.value.root, [...expandedDirs.value]);
  if (plan.full) watchPlanFull = true;
  plan.dirs.forEach((d) => watchPendingDirs.add(d));
  if (watchRefreshTimer) clearTimeout(watchRefreshTimer);
  watchRefreshTimer = setTimeout(applyWatchRefresh, 250);
}

async function applyWatchRefresh() {
  watchRefreshTimer = null;
  const full = watchPlanFull;
  const dirs = [...watchPendingDirs];
  watchPlanFull = false;
  watchPendingDirs.clear();
  // 防抖窗口后工作区可能已切换（dir 集合过时），refreshDir 内部 findNode
  // 找不到节点时是无害 no-op，跨根目录 listDirectory 失败也只进 errorMsg。
  if (full) await refreshAllExpanded(true);
  else dirs.forEach((d) => refreshDirs([d]));
}

function getSelectedNodeIsDir(): boolean {
  if (!selectedPath.value) return false;
  const node = findNode(treeData.value, selectedPath.value);
  return node?.is_dir ?? false;
}

async function onTreeKeydown(e: KeyboardEvent) {
  if (e.ctrlKey && (e.key === 'c' || e.key === 'x')) {
    if (!selectedPath.value) return;
    const isCut = e.key === 'x';
    if (isCut && selectedPath.value === projectInfo.value.root) return;
    e.preventDefault();
    (isCut ? cutWithOs : copyWithOs)([selectedPath.value]);
  } else if (e.ctrlKey && e.key === 'v') {
    e.preventDefault();
    // 应用内剪贴板为空 → 兜底读系统剪贴板（Explorer 复制/剪切 → 树内粘贴）
    const source = await resolvePasteEntry();
    if (!source) return;
    const targetDir = selectedPath.value
      ? (getSelectedNodeIsDir() ? selectedPath.value : getParentPath(selectedPath.value))
      : projectInfo.value.root;
    if (!targetDir) return;
    await executePaste(targetDir, {
      onDestRefresh: refreshDirs,
      onSrcRefresh: refreshDirs,
    });
  } else if (e.key === 'Escape') {
    if (!clipboard.value) return;
    e.preventDefault();
    clear();
  } else if (e.key === 'Enter') {
    if (!selectedPath.value) return;
    e.preventDefault();
    const node = findNode(treeData.value, selectedPath.value);
    if (!node) return;
    if (node.is_dir) void toggleDir(node.path);
    else openFile(node.path);
  } else if (e.key === 'F2') {
    if (!selectedPath.value) return;
    e.preventDefault();
    void renameNode(selectedPath.value);
  } else if (e.key === 'Delete') {
    if (!selectedPath.value) return;
    e.preventDefault();
    void deleteNode(selectedPath.value);
  }
}

/** F2 重命名（root 拦截；选中项跟随新路径；剪切态与展开态不在改造范围内） */
async function renameNode(path: string) {
  if (!path || path === projectInfo.value.root) return;
  const node = findNode(treeData.value, path);
  if (!node) return;
  const newName = await modal.prompt("重命名", `「${node.name}」的新名称`, "重命名");
  if (!newName || newName === node.name) return;
  const newPath = path.slice(0, path.length - node.name.length) + newName;
  try {
    await api.moveFile(path, newPath);
    if (selectedPath.value === path) selectedPath.value = newPath;
    refreshDirs([getParentPath(path)]);
  } catch (err) {
    await modal.confirm("重命名失败", String(err), "确定", false);
  }
}

/** Delete 删除（root 拦截 + 确认弹窗，语义与右键菜单一致） */
async function deleteNode(path: string) {
  if (!path || path === projectInfo.value.root) return;
  const node = findNode(treeData.value, path);
  if (!node) return;
  const ok = await modal.confirm(
    node.is_dir ? "删除文件夹" : "删除文件",
    node.is_dir
      ? `确定要删除「${node.name}」及其所有内容吗？`
      : `确定要删除「${node.name}」吗？`,
    "删除",
    true,
  );
  if (!ok) return;
  try {
    await api.deleteFile(path);
    if (selectedPath.value === path) selectedPath.value = "";
    refreshDirs([getParentPath(path)]);
  } catch (err) {
    await modal.confirm("删除失败", String(err), "确定", false);
  }
}

// ── 工作区（项目）切换器 ───────────────────────────────────────────────────
// path-bar 上的项目名即切换入口：下拉列表/勾选/missing 禁用/开合交互由共享组件
// WorkspacePicker 承担，这里只保留「切换」语义的同 root 守卫——选中后把 wsKey
// 抛给 App.vue，由侧栏（单一数据源）执行真正切换并广播 workspace-changed，避免
// 文件树自己 setWorkspace 造成侧栏 activeWorkspace 与实际工作区脱节。
function onPickWorkspace(ws: WorkspaceInfo) {
  if (ws.name === projectInfo.value.root) return;
  emit("switch-workspace", ws.key);
}

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
      <div class="ws-switcher">
        <WorkspacePicker :path="projectInfo.root" @select="onPickWorkspace">
          <template #trigger="{ open, toggle }">
            <button class="ws-trigger" v-tooltip="projectInfo.root" @click.stop="toggle">
              <svg class="ws-folder" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              <span class="ws-project-name">{{ projectInfo.name || "未打开工作区" }}</span>
              <span v-if="projectInfo.branch" class="path-branch">{{ projectInfo.branch }}</span>
              <svg class="ws-chevron" :class="{ open }" width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2.5 3.5L5 6L7.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </template>
        </WorkspacePicker>
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
          :on-refresh-dir="(p: string) => refreshDir(p)"
          :session-id="sessionId"
          @select="selectFile"
          @toggle="toggleDir"
          @open="openFile"
        />
        <div v-if="treeData.length === 0" class="tree-status">
          <template v-if="projectInfo.root">目录为空</template>
          <template v-else>
            <div class="no-workspace-hint">还没有工作区</div>
            <button class="onboard-ws-btn" @click="onboarding.openAt('workspace')">选一个工作区</button>
          </template>
        </div>
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
  min-width: 0;
  flex: 1;
}

/* 共享 WorkspacePicker 占满 path-bar，触发按钮（slot）随之全宽、名称省略号生效 */
.ws-switcher .workspace-picker {
  width: 100%;
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

