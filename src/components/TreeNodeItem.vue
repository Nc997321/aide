<script setup lang="ts">
import { useContextMenu } from "../composables/useContextMenu";
import { fileMenuItems, directoryMenuItems } from "../menus/contextMenus";

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
}>();

const emit = defineEmits<{
  toggle: [path: string];
  open: [path: string];
}>();

const { show } = useContextMenu();

interface FileIconDef {
  color: string;
  path: string;
}

const FILE_ICONS: Record<string, FileIconDef> = {
  vue:  { color: "var(--aide-success)",  path: "M2 3h6l4 7 4-7h6L12 21 2 3z" },
  ts:   { color: "var(--aide-info)",     path: "M3 5h18v14H3V5zm6 3v2h2v7h2V10h2V8H9zm8 0v9h2V8h-2z" },
  js:   { color: "var(--aide-warning)",  path: "M3 3h18v18H3V3zm9 14c0 1.1-.9 2-2 2s-2-.5-2-1.5h1.5c0 .3.2.5.5.5s.5-.2.5-.5V10h2v7zm4 2c-1.1 0-2-.5-2-1.5h1.5c0 .3.2.5.5.5s.5-.2.5-.5c0-.4-.3-.5-.8-.7l-.5-.2C14.3 15.6 14 15 14 14.3c0-1 .8-1.8 1.8-1.8 1 0 1.7.5 1.7 1.5h-1.4c0-.3-.1-.5-.4-.5-.2 0-.4.2-.4.4 0 .3.2.4.6.6l.6.2c.9.4 1.3 1 1.3 1.8 0 1-1 1.8-2.1 1.8z" },
  json: { color: "var(--aide-text-muted)", path: "M5 3h2v2H5v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5h2v2H5c-1.1 0-2-.9-2-2v-4a2 2 0 0 0-2-2v-2a2 2 0 0 0 2-2V5c0-1.1.9-2 2-2zm14 0c1.1 0 2 .9 2 2v4a2 2 0 0 0 2 2v2a2 2 0 0 0-2 2v4c0 1.1-.9 2-2 2h-2v-2h2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5h-2V3h2z" },
  md:   { color: "var(--aide-text-secondary)", path: "M2 4h20v16H2V4zm3 12V8l3 4 3-4v8h2V8h2v8h2V8h1.5" },
  html: { color: "var(--aide-danger)",   path: "M4 2l1.5 17L12 22l6.5-3L20 2H4zm13.1 5H8.4l.3 3h8.1l-.8 8-4 1.4-4-1.4-.4-4h2.8l.2 2.1 1.4.4 1.5-.4.2-2.1H7.6L7 5.5h10.3l-.2 1.5z" },
  css:  { color: "var(--aide-info)",     path: "M4 2l1.5 17L12 22l6.5-3L20 2H4zm12 12.5c0 1.9-1.6 3.5-4 3.5s-4-1.6-4-3.5h2.5c0 .8.7 1.3 1.5 1.3s1.5-.4 1.5-1.3c0-.8-.5-1.2-1.5-1.5-2-.5-3.5-1.2-3.5-3.2C9 7.5 10.5 6 12 6s3 1.5 3 3h-2.5c0-.5-.3-1-.5-1-.4 0-.5.3-.5.8 0 .8.5 1 1.5 1.4 2 .6 3 1.5 3 3.3z" },
  rs:   { color: "var(--aide-accent)",   path: "M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 3c1.1 0 2 .6 2 1.3 0 .5-.3 1-.8 1.2.7.3 1.3 1.1 1.3 2 0 1.2-1.1 2.2-2.5 2.2S9.5 10.7 9.5 9.5c0-.9.5-1.7 1.3-2C10.3 7.3 10 6.8 10 6.3 10 5.6 10.9 5 12 5zm-3 8h6v2l-3 4-3-4v-2z" },
  toml: { color: "var(--aide-text-muted)", path: "M3 3h18v18H3V3zm3 3v3h3V6H6zm4.5 0v3h3V6h-3zM15 6v3h3V6h-3zM6 10.5v3h12v-3H6zM6 15v3h12v-3H6z" },
  yaml: { color: "var(--aide-text-muted)", path: "M3 3h18v18H3V3zm3 3v3h3V6H6zm4.5 0v3h3V6h-3zM15 6v3h3V6h-3zM6 10.5v3h12v-3H6zM6 15v3h12v-3H6z" },
  yml:  { color: "var(--aide-text-muted)", path: "M3 3h18v18H3V3zm3 3v3h3V6H6zm4.5 0v3h3V6h-3zM15 6v3h3V6h-3zM6 10.5v3h12v-3H6zM6 15v3h12v-3H6z" },
  sh:   { color: "var(--aide-success)",  path: "M4 17l6-5-6-5v10zm8 0h8v-2h-8v2z" },
  ps1:  { color: "var(--aide-info)",     path: "M4 17l6-5-6-5v10zm8 0h8v-2h-8v2z" },
  png:  { color: "var(--aide-accent)",   path: "M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" },
  jpg:  { color: "var(--aide-accent)",   path: "M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" },
  svg:  { color: "var(--aide-accent)",   path: "M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" },
  ico:  { color: "var(--aide-accent)",   path: "M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" },
  lock: { color: "var(--aide-text-muted)", path: "M12 17a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm6-6V9A6 6 0 0 0 6 9v2a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2zM8 9a4 4 0 1 1 8 0v2H8V9z" },
  gitignore: { color: "var(--aide-text-muted)", path: "M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8-3.6 8-8 8zm3.5-12.5L12 11l-3.5-3.5L7 9l3.5 3.5L7 16l1.5 1.5L12 14l3.5 3.5L17 16l-3.5-3.5L17 9l-1.5-1.5z" },
};

const DEFAULT_ICON: FileIconDef = {
  color: "var(--aide-text-muted)",
  path: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 8V3.5L18.5 8H14zM6 20V4h6v6h6v10H6z",
};

function getFileIcon(name: string): FileIconDef {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (name === ".gitignore") return FILE_ICONS.gitignore;
  if (name.endsWith(".lock")) return FILE_ICONS.lock;
  return FILE_ICONS[ext] || DEFAULT_ICON;
}

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
      )
    : fileMenuItems(props.node.path, props.projectRoot, () =>
        refresh(parentPath),
      );
  show(e.clientX, e.clientY, items);
}

const isExpanded = () => props.expandedDirs.has(props.node.path);
</script>

<template>
  <div>
    <div
      class="tree-node"
      :class="{ active: node.path === selectedPath }"
      :style="{ paddingLeft: (depth * 18 + 8) + 'px' }"
      @click="handleClick"
      @contextmenu.prevent.stop="onContextMenu"
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
      <span class="node-name" :title="node.path">{{ node.name }}</span>
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
  gap: 5px;
  padding: 3px 10px 3px 8px;
  cursor: pointer;
  font-size: 12.5px;
  color: var(--aide-text-secondary);
  white-space: nowrap;
  position: relative;
  border-radius: 4px;
  margin: 0 4px;
  transition: background 0.1s ease, color 0.1s ease;
  height: 26px;
}

.tree-node:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

.tree-node.active {
  background: var(--aide-accent-subtle);
  color: var(--aide-text-primary);
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
</style>
