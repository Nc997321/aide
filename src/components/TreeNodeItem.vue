<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useContextMenu } from "../composables/useContextMenu";
import { fileMenuItems, directoryMenuItems } from "../menus/contextMenus";
import { useFileClipboard } from "../composables/useFileClipboard";
import { useModal } from "../composables/useModal";
import { getFileIcon } from "../utils/fileIcons";

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children: FileEntry[] | null;
}

defineOptions({ name: "TreeNodeItem" });

const props = defineProps<{
  node: FileEntry;
  depth: number;
  expandedDirs: Set<string>;
  selectedPath: string;
  projectRoot: string;
  onRefreshDir: (path: string) => void;
  sessionId?: string;
}>();

const emit = defineEmits<{
  toggle: [path: string];
  open: [path: string];
}>();

const { show } = useContextMenu();

const cb = useFileClipboard();
const modal = useModal();
const { clipboard, cut, clear, executePaste } = cb;

const isDragOver = ref(false);
const insertPos = ref<'top' | 'bottom' | null>(null);

function handleClick() {
  if (props.node.is_dir) {
    emit("toggle", props.node.path);
  } else {
    emit("open", props.node.path);
  }
}

function getParentPath(path: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  const i = path.lastIndexOf(sep);
  return i > 0 ? path.slice(0, i) : path;
}

function onContextMenu(e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  const parentPath = getParentPath(props.node.path);
  const refresh = props.onRefreshDir;
  const items = props.node.is_dir
    ? directoryMenuItems(
        props.node.path,
        props.projectRoot,
        () => emit("toggle", props.node.path),
        () => refresh(props.node.path),
        () => refresh(parentPath),
        refresh,
      )
    : fileMenuItems(props.node.path, props.projectRoot, () =>
        refresh(parentPath), props.sessionId,
      );
  show(e.clientX, e.clientY, items);
}

function onDragStart(e: DragEvent) {
  e.dataTransfer!.setData('text/plain', props.node.path);
  e.dataTransfer!.effectAllowed = 'move';
  cut(props.node.path);
}

function onDragOver(e: DragEvent) {
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'move';
  if (props.node.is_dir) {
    isDragOver.value = true;
    insertPos.value = null;
  } else {
    isDragOver.value = false;
    insertPos.value = (e.offsetY < 13) ? 'top' : 'bottom';
  }
}

function onDragLeave(e: DragEvent) {
  if (e.relatedTarget && (e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) return;
  isDragOver.value = false;
  insertPos.value = null;
}

function onDragEnd(e: DragEvent) {
  // 拖拽取消（Esc 或拖到树外），清空剪贴板
  if (e.dataTransfer?.dropEffect === 'none') clear();
}

async function onDrop(e: DragEvent) {
  e.preventDefault();
  e.stopPropagation();
  isDragOver.value = false;
  insertPos.value = null;

  // dataTransfer.getData() can return empty string in Tauri + WebView2 on Windows.
  // Read the source path directly from the clipboard set in onDragStart instead.
  const entry = clipboard.value;
  if (!entry) return;
  const srcPath = entry.path;

  const targetDir = props.node.is_dir ? props.node.path : getParentPath(props.node.path);
  const srcParent = getParentPath(srcPath);
  const sep = targetDir.includes("\\") ? "\\" : "/";

  // 拖到自身所在目录，忽略
  if (targetDir === srcParent || srcPath === targetDir) {
    clear();
    return;
  }

  // 禁止把目录拖到自身子目录
  if (targetDir.startsWith(srcPath + sep)) {
    await modal.confirm("操作无效", "不能将文件夹移动到其自身的子目录中", "确定", false);
    clear();
    return;
  }

  const srcName = srcPath.split(/[/\\]/).pop() || srcPath;
  const targetName = targetDir.split(/[/\\]/).pop() || targetDir;
  const ok = await modal.confirm(
    "移动文件",
    `确定要将「${srcName}」移动到「${targetName}」吗？`,
    "移动",
    false,
  );
  if (!ok) {
    clear();
    return;
  }

  const refresh = props.onRefreshDir;
  try {
    await executePaste(
      targetDir,
      () => refresh(srcParent),
      () => refresh(targetDir),
    );
  } catch (err) {
    await modal.confirm("移动失败", String(err), "确定", false);
    clear();
  }
}

const isExpanded = () => props.expandedDirs.has(props.node.path);

const hovered = ref(false);
const nameEl = ref<HTMLSpanElement | null>(null);
const isOverflow = ref(false);

onMounted(() => {
  const el = nameEl.value;
  if (!el) return;
  const check = () => {
    if (hovered.value) return;
    isOverflow.value = el.scrollWidth > el.clientWidth + 1;
  };
  check();
  const ro = new ResizeObserver(check);
  ro.observe(el);
  onUnmounted(() => ro.disconnect());
});

const nodePadding = computed(() =>
  hovered.value && isOverflow.value
    ? props.depth * 6 + 8
    : props.depth * 18 + 8
);
</script>

<template>
  <div>
    <div
      class="tree-node"
      :class="{
        active: node.path === selectedPath,
        'drag-over-folder': isDragOver,
        'drag-insert-top': insertPos === 'top',
        'drag-insert-bottom': insertPos === 'bottom',
        'cut-state': clipboard?.op === 'cut' && clipboard?.path === node.path,
      }"
      :style="{ paddingLeft: nodePadding + 'px' }"
      draggable="true"
      @click="handleClick"
      @contextmenu.prevent.stop="onContextMenu"
      @mouseenter="hovered = true"
      @mouseleave="hovered = false"
      @dragstart="onDragStart"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @dragend="onDragEnd"
      @drop="onDrop"
    >
      <!-- Indent guides -->
      <span
        v-for="i in depth"
        :key="i"
        class="indent-guide"
        :style="{ left: (i * 18 - 2) + 'px' }"
      />

      <!-- Active indicator bar -->
      <span v-if="node.path === selectedPath" class="active-bar" />

      <!-- Chevron for directories -->
      <svg
        v-if="node.is_dir"
        class="node-chevron"
        :class="{ expanded: isExpanded() }"
        width="12" height="12" viewBox="0 0 12 12" fill="none"
        @click.stop="emit('toggle', node.path)"
      >
        <path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span v-else class="chevron-placeholder" />

      <!-- Icon -->
      <svg
        v-if="node.is_dir"
        class="node-icon node-icon--folder"
        :class="{ open: isExpanded() }"
        width="15" height="15" viewBox="0 0 24 24" fill="none"
      >
        <path
          v-if="isExpanded()"
          d="M5 19h14c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2h-6.6L10 5H5C3.9 5 3 5.9 3 7v10c0 1.1.9 2 2 2zM3 17l3-8h16l-3 8H3z"
          stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"
        />
        <path
          v-else
          d="M3 7c0-1.1.9-2 2-2h4.6L12 7h7c1.1 0 2 .9 2 2v8c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V7z"
          stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"
        />
      </svg>
      <svg
        v-else
        class="node-icon node-icon--file"
        :style="{ color: getFileIcon(node.name).color }"
        width="15" height="15" viewBox="0 0 24 24" fill="none"
      >
        <path :d="getFileIcon(node.name).path" fill="currentColor" opacity="0.85"/>
      </svg>

      <!-- Name -->
      <span ref="nameEl" class="node-name">{{ node.name }}</span>
    </div>

    <!-- Children with subtle background layer -->
    <div
      v-if="node.is_dir && isExpanded() && node.children"
      class="node-children"
    >
      <TreeNodeItem
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        :expanded-dirs="expandedDirs"
        :selected-path="selectedPath"
        :project-root="projectRoot"
        :on-refresh-dir="onRefreshDir"
        :session-id="sessionId"
        @toggle="(p: string) => emit('toggle', p)"
        @open="(p: string) => emit('open', p)"
      />
    </div>
  </div>
</template>

<style scoped>
.tree-node {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px 3px 8px;
  cursor: pointer;
  font-size: 13px;
  color: var(--aide-text-secondary);
  white-space: nowrap;
  position: relative;
  border-radius: 4px;
  margin: 0 4px;
  transition: padding-left 0.2s cubic-bezier(0.4, 0, 0.2, 1), background 0.15s ease, color 0.15s ease;
  height: 26px;
}

.tree-node:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

.tree-node.active {
  background: var(--aide-accent-subtle);
  color: var(--aide-text-primary);
  box-shadow: inset 2px 0 0 var(--aide-accent);
}

/* ── Active indicator bar ── */

.active-bar {
  position: absolute;
  left: 0;
  top: 4px;
  bottom: 4px;
  width: 2px;
  background: var(--aide-accent);
  border-radius: 1px;
}

/* ── Indent guides ── */

.indent-guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--aide-border);
  pointer-events: none;
}

.tree-node:hover .indent-guide {
  background: var(--aide-surface-hover);
}

/* ── Chevron ── */

.node-chevron {
  flex-shrink: 0;
  color: var(--aide-text-muted);
  transition: transform 0.15s ease, color 0.15s ease;
  cursor: pointer;
  border-radius: 3px;
  padding: 1px;
}

.node-chevron:hover {
  color: var(--aide-text-primary);
  background: var(--aide-surface-hover);
}

.node-chevron.expanded {
  transform: rotate(90deg);
  color: var(--aide-accent);
}

.chevron-placeholder {
  width: 12px;
  flex-shrink: 0;
}

/* ── Icons ── */

.node-icon {
  flex-shrink: 0;
  transition: color 0.15s ease;
}

.node-icon--folder {
  color: var(--aide-text-muted);
}

.node-icon--folder.open {
  color: var(--aide-accent);
}

.tree-node:hover .node-icon--folder {
  color: var(--aide-text-secondary);
}

.tree-node:hover .node-icon--folder.open {
  color: var(--aide-accent);
}

/* ── Name ── */

.node-name {
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.tree-node.active .node-name {
  font-weight: 500;
}

/* ── Children wrapper (subtle depth layering) ── */

.node-children {
  position: relative;
}

/* ── 拖拽视觉 ── */

.tree-node.drag-over-folder {
  background: var(--aide-accent-subtle);
  outline: 1px solid var(--aide-accent);
  outline-offset: -1px;
}

.tree-node.drag-insert-top::before {
  content: '';
  position: absolute;
  top: 0;
  left: 8px;
  right: 8px;
  height: 2px;
  background: var(--aide-accent);
  border-radius: 1px;
  pointer-events: none;
}

.tree-node.drag-insert-bottom::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 8px;
  right: 8px;
  height: 2px;
  background: var(--aide-accent);
  border-radius: 1px;
  pointer-events: none;
}

/* 被剪切的节点半透明 */
.tree-node.cut-state {
  opacity: 0.45;
}
</style>
