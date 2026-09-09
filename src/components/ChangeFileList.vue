<script setup lang="ts">
import { ref } from "vue";
import { getFileIcon } from "../utils/fileIcons";
import ChangeDiffPane from "./ChangeDiffPane.vue";
import type { ChangeFile, TouchedFile } from "../types";

/**
 * 轮次文件**平铺**列表（一行一条，不再是每轮一棵树）。
 *
 * 点行 = 展开该文件的 diff（并排）；「打开 ↗」与「撤回」是行内的独立图标——
 * 三个动作互不抢占，不需要靠修饰键或双击区分。
 *
 * `rows` 用 `TouchedFile`（比 `ChangeFile` 多一份本轮片段）：历史轮没有片段，
 * 由调用方用空数组补齐，这里不做「有没有 touches」的分支判断。
 */
const props = defineProps<{
  rows: TouchedFile[];
  /** 会话所属工作区根：拼绝对路径（打开 / 片段行号定位）、给 git 当 cwd */
  workspaceRoot?: string;
  /** 并排（轮内）/ 单排（顶部统一树复用时） */
  mode?: "split" | "unified";
  openFile: (f: ChangeFile) => void;
  revertFile: (f: ChangeFile) => void;
}>();

/** 单开：同时只展开一个文件的 diff。
 *  DiffViewer 是 CodeMirror 实例，多开会在窄面板里堆出多个编辑器（内存 + 布局代价）。 */
const expanded = ref<string | null>(null);

function toggle(path: string) {
  expanded.value = expanded.value === path ? null : path;
}

/** 路径拆目录段（弱化）+ 基名（强调）：窄面板里主角是文件名。 */
function splitPath(p: string): { dir: string; name: string } {
  const norm = p.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? { dir: norm.slice(0, i + 1), name: norm.slice(i + 1) } : { dir: "", name: norm };
}
</script>

<template>
  <div class="cfl">
    <div v-for="row in rows" :key="row.path" class="cfl-item">
      <div
        class="cfl-row"
        :class="{ 'cfl-row--open': expanded === row.path }"
        v-tooltip="row.path"
        @click="toggle(row.path)"
      >
        <svg
          class="cfl-chevron" :class="{ expanded: expanded === row.path }"
          width="12" height="12" viewBox="0 0 12 12" fill="none"
        >
          <path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="cfl-status" :class="`status-${row.status || 'M'}`">{{ row.status || 'M' }}</span>
        <svg
          class="cfl-icon"
          :style="{ color: getFileIcon(row.path).color }"
          width="14" height="14" viewBox="0 0 24 24" fill="none"
        >
          <path :d="getFileIcon(row.path).path" fill="currentColor" opacity="0.85"/>
        </svg>
        <span class="cfl-name">
          <span v-if="splitPath(row.path).dir" class="cfl-dir">{{ splitPath(row.path).dir }}</span>{{ splitPath(row.path).name }}
        </span>
        <span v-if="row.additions > 0 || row.deletions > 0" class="cfl-stats">
          <span v-if="row.additions > 0" class="cfl-add">+{{ row.additions }}</span>
          <span v-if="row.deletions > 0" class="cfl-del">-{{ row.deletions }}</span>
        </span>
        <button
          v-if="row.status !== 'D'"
          class="cfl-act"
          v-tooltip="'在编辑器中打开'"
          @click.stop="props.openFile(row)"
        ><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg></button>
        <button
          class="cfl-act cfl-act--revert"
          v-tooltip="'撤回此文件'"
          @click.stop="props.revertFile(row)"
        ><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6.69 3L3 13"/></svg></button>
      </div>
      <ChangeDiffPane
        v-if="expanded === row.path"
        :path="row.path"
        :status="row.status"
        :segments="row.segments"
        :workspace-root="props.workspaceRoot"
        :mode="props.mode ?? 'split'"
      />
    </div>
  </div>
</template>

<style scoped>
.cfl {
  padding: 2px 0 4px;
}

.cfl-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px 3px 8px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s ease, color 0.15s ease;
}
.cfl-row:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}
.cfl-row--open {
  background: var(--aide-surface-default);
}

.cfl-chevron {
  flex-shrink: 0;
  color: var(--aide-text-muted);
  transition: transform 0.15s ease;
}
.cfl-chevron.expanded {
  transform: rotate(90deg);
  color: var(--aide-accent);
}

.cfl-status {
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

.cfl-icon {
  flex-shrink: 0;
}

.cfl-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--aide-text-secondary);
  font-family: var(--aide-font-mono);
  font-size: 11.5px;
}

.cfl-dir {
  color: var(--aide-text-muted);
}

.cfl-stats {
  flex-shrink: 0;
  font-size: 11px;
  font-family: var(--aide-font-mono);
}
.cfl-add { color: var(--aide-success); }
.cfl-del { color: var(--aide-danger); }

.cfl-act {
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
.cfl-row:hover .cfl-act {
  opacity: 1;
}
.cfl-act:hover {
  color: var(--aide-accent);
  background: color-mix(in srgb, var(--aide-accent) 12%, transparent);
}
.cfl-act--revert:hover {
  color: var(--aide-danger);
  background: color-mix(in srgb, var(--aide-danger) 12%, transparent);
}
</style>
