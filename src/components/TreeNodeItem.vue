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

function fileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const icons: Record<string, string> = {
    vue: "🟢", ts: "🔵", js: "🟡", json: "⚙", md: "📝",
    html: "🟠", css: "🎨", rs: "🦀", toml: "⚙", gitignore: "🔧",
    xml: "📋", yaml: "⚙", yml: "⚙", sh: "💻", ps1: "💻",
    png: "🖼", jpg: "🖼", ico: "🖼",
  };
  return icons[ext] || "📄";
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
</script>

<template>
  <div>
    <div
      class="tree-node"
      :class="{ active: node.path === selectedPath }"
      :style="{ paddingLeft: (depth * 16 + 12) + 'px' }"
      @click="handleClick"
      @contextmenu.prevent.stop="onContextMenu"
    >
      <span v-if="node.is_dir" class="arrow" :class="{ expanded: expandedDirs.has(node.path) }">&#x25B8;</span>
      <span v-else class="arrow-placeholder"></span>
      <span class="icon">{{ node.is_dir ? (expandedDirs.has(node.path) ? '📂' : '📁') : fileIcon(node.name) }}</span>
      <span class="name" :title="node.path">{{ node.name }}</span>
    </div>
    <template v-if="node.is_dir && expandedDirs.has(node.path) && node.children">
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
    </template>
  </div>
</template>

<style scoped>
.tree-node {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.tree-node:hover {
  background: var(--surface);
}

.tree-node.active {
  background: var(--surface);
  color: var(--text-primary);
}

.arrow {
  font-size: 10px;
  width: 12px;
  transition: transform 0.15s;
  flex-shrink: 0;
}

.arrow.expanded {
  transform: rotate(90deg);
}

.arrow-placeholder {
  width: 12px;
  flex-shrink: 0;
}

.icon {
  font-size: 13px;
  flex-shrink: 0;
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
