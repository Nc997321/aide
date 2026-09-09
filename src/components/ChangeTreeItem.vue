<script setup lang="ts">
import { getFileIcon } from "../utils/fileIcons";
import ChangeDiffPane from "./ChangeDiffPane.vue";
import type { ChangeTreeNode } from "../utils/changeTree";
import type { ChangeFile } from "../types";

defineOptions({ name: "ChangeTreeItem" });

/** 本组件只服务变更面板（不是通用树），diff 渲染直接依赖 ChangeDiffPane：
 *  递归组件自引用的插槽 prop 会让类型推断成环，宁可多三个 props。 */
const props = defineProps<{
  node: ChangeTreeNode;
  depth: number;
  collapsedDirs: Set<string>;
  openFile: (f: ChangeFile) => void;
  revertFile: (f: ChangeFile) => void;
  toggleDir: (path: string) => void;
  /** 当前展开 diff 的文件路径（单开）；null = 无 */
  expandedPath: string | null;
  toggleExpand: (path: string) => void;
  workspaceRoot?: string;
  diffMode?: "split" | "unified";
  cumulativeNote?: string;
}>();

const isCollapsed = () => props.collapsedDirs.has(props.node.kind === "dir" ? props.node.path : "");

const rowPadding = () => `${props.depth * 14 + 8}px`;
</script>

<template>
  <div>
    <template v-if="node.kind === 'dir'">
      <div class="cft-dir" :style="{ paddingLeft: rowPadding() }" @click="toggleDir(node.path)">
        <span v-for="i in depth" :key="i" class="cft-guide" :style="{ left: (i * 14 - 2) + 'px' }" />
        <svg
          class="cft-chevron" :class="{ expanded: !isCollapsed() }"
          width="12" height="12" viewBox="0 0 12 12" fill="none"
        >
          <path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <svg class="cft-folder" :class="{ open: !isCollapsed() }" width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path
            v-if="!isCollapsed()"
            d="M5 19h14c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2h-6.6L10 5H5C3.9 5 3 5.9 3 7v10c0 1.1.9 2 2 2zM3 17l3-8h16l-3 8H3z"
            stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"
          />
          <path
            v-else
            d="M3 7c0-1.1.9-2 2-2h4.6L12 7h7c1.1 0 2 .9 2 2v8c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V7z"
            stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"
          />
        </svg>
        <span class="cft-dir-name" v-tooltip="node.path">{{ node.name }}</span>
      </div>
      <template v-if="!isCollapsed()">
        <ChangeTreeItem
          v-for="child in node.children"
          :key="child.kind === 'dir' ? `d:${child.path}` : `f:${child.file.path}`"
          :node="child"
          :depth="depth + 1"
          :collapsed-dirs="collapsedDirs"
          :open-file="openFile"
          :revert-file="revertFile"
          :toggle-dir="toggleDir"
          :expanded-path="expandedPath"
          :toggle-expand="toggleExpand"
          :workspace-root="workspaceRoot"
          :diff-mode="diffMode"
          :cumulative-note="cumulativeNote"
        />
      </template>
    </template>

    <div v-else>
      <div
        class="cft-file"
        :class="{ 'cft-file--deleted': node.file.status === 'D', 'cft-file--open': expandedPath === node.file.path }"
        :style="{ paddingLeft: rowPadding() }"
        v-tooltip="node.file.path"
        @click="toggleExpand(node.file.path)"
      >
        <span class="cft-status" :class="`status-${node.file.status || 'M'}`">{{ node.file.status || 'M' }}</span>
        <svg
          class="cft-file-icon"
          :style="{ color: getFileIcon(node.file.path).color }"
          width="14" height="14" viewBox="0 0 24 24" fill="none"
        >
          <path :d="getFileIcon(node.file.path).path" fill="currentColor" opacity="0.85"/>
        </svg>
        <span class="cft-name">{{ node.name }}</span>
        <span v-if="node.file.additions > 0 || node.file.deletions > 0" class="cft-stats">
          <span v-if="node.file.additions > 0" class="cft-add">+{{ node.file.additions }}</span>
          <span v-if="node.file.deletions > 0" class="cft-del">-{{ node.file.deletions }}</span>
        </span>
        <button
          v-if="node.file.status !== 'D'"
          class="cft-act"
          v-tooltip="'在编辑器中打开'"
          @click.stop="openFile(node.file)"
        ><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg></button>
        <button
          class="cft-act cft-act--revert"
          v-tooltip="'撤回此文件'"
          @click.stop="revertFile(node.file)"
        ><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6.69 3L3 13"/></svg></button>
      </div>
      <ChangeDiffPane
        v-if="expandedPath === node.file.path"
        :path="node.file.path"
        :status="node.file.status"
        :segments="[]"
        :workspace-root="workspaceRoot"
        :mode="diffMode ?? 'unified'"
        :cumulative-note="cumulativeNote"
      />
    </div>
  </div>
</template>

<style scoped>
.cft-dir,
.cft-file {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px 3px 8px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s ease, color 0.15s ease;
}
.cft-dir:hover,
.cft-file:hover {
  background: var(--aide-surface-default);
}

.cft-guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--aide-border);
  pointer-events: none;
}
.cft-dir:hover .cft-guide,
.cft-file:hover .cft-guide {
  background: var(--aide-surface-hover);
}

.cft-chevron {
  flex-shrink: 0;
  color: var(--aide-text-muted);
  transition: transform 0.15s ease;
}
.cft-chevron.expanded {
  transform: rotate(90deg);
  color: var(--aide-accent);
}

.cft-folder {
  flex-shrink: 0;
  color: var(--aide-text-muted);
}
.cft-folder.open {
  color: var(--aide-accent);
}

.cft-dir-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--aide-text-secondary);
  font-size: 11.5px;
}
.cft-dir:hover .cft-dir-name {
  color: var(--aide-text-primary);
}

.cft-file:hover {
  color: var(--aide-text-primary);
}

/* 已删除条目：磁盘上无对应物（「打开 ↗」不渲染），但 diff 仍可展开——
   git 拿得到删除前的全文，这是唯一能看见它内容的地方。 */
.cft-file--deleted {
  opacity: 0.6;
}
.cft-file--deleted .cft-name {
  text-decoration: line-through;
}

.cft-file--open {
  background: var(--aide-surface-default);
}

.cft-status {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  border-radius: 3px;
}
.status-M {
  background: color-mix(in srgb, var(--aide-warning) 15%, transparent);
  color: var(--aide-warning);
}
.status-A {
  background: color-mix(in srgb, var(--aide-success) 15%, transparent);
  color: var(--aide-success);
}
.status-D {
  background: color-mix(in srgb, var(--aide-danger) 15%, transparent);
  color: var(--aide-danger);
}

.cft-file-icon {
  flex-shrink: 0;
}

.cft-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--aide-text-secondary);
  font-family: var(--aide-font-mono);
  font-size: 11.5px;
}

.cft-stats {
  flex-shrink: 0;
  font-size: 11px;
  font-family: var(--aide-font-mono);
}
.cft-add { color: var(--aide-success); }
.cft-del { color: var(--aide-danger); }

.cft-act {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--aide-text-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 1px 4px;
  border-radius: 2px;
  opacity: 0;
  transition: opacity 0.15s ease, color 0.15s ease, background 0.15s ease;
  font-family: inherit;
}
.cft-file:hover .cft-act {
  opacity: 1;
}
.cft-act:hover {
  color: var(--aide-accent);
  background: color-mix(in srgb, var(--aide-accent) 12%, transparent);
}
.cft-act--revert:hover {
  color: var(--aide-danger);
  background: color-mix(in srgb, var(--aide-danger) 12%, transparent);
}
</style>
