<script setup lang="ts">
import { computed, ref } from "vue";
import type { ChangeFile } from "../types";
import { buildChangeTree } from "../utils/changeTree";
import ChangeTreeItem from "./ChangeTreeItem.vue";

/**
 * 轮次文件变更树：files 变化（pending 轮实时刷新）→ 重建树，
 * 折叠状态按目录 path 键控跨重建保留；新目录不在折叠集 → 默认展开。
 *
 * diff 怎么渲染由**本组件**决定（逐层透传参数给 ChangeDiffPane），不用插槽透传：
 * 递归组件自引用的插槽 prop 会让类型推断成环，拖垮整个项目的检查。
 */
const props = defineProps<{
  files: ChangeFile[];
  openFile: (f: ChangeFile) => void;
  revertFile: (f: ChangeFile) => void;
  /** 展开 diff 用的上下文：会话工作区根、并排/单排、累计视图文案 */
  workspaceRoot?: string;
  diffMode?: "split" | "unified";
  cumulativeNote?: string;
}>();

const tree = computed(() => buildChangeTree(props.files));

const collapsedDirs = ref<Set<string>>(new Set());

/** 展开 diff 的文件路径。**单开**：DiffViewer 是 CodeMirror 实例，多开会在窄面板
 *  里堆多个编辑器（内存 + 布局代价），两处列表都按单开做。 */
const expandedPath = ref<string | null>(null);

function toggleExpand(path: string) {
  expandedPath.value = expandedPath.value === path ? null : path;
}

function toggleDir(path: string) {
  if (collapsedDirs.value.has(path)) collapsedDirs.value.delete(path);
  else collapsedDirs.value.add(path);
  collapsedDirs.value = new Set(collapsedDirs.value);
}
</script>

<template>
  <div class="cft">
    <ChangeTreeItem
      v-for="node in tree"
      :key="node.kind === 'dir' ? `d:${node.path}` : `f:${node.file.path}`"
      :node="node"
      :depth="0"
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
  </div>
</template>

<style scoped>
.cft {
  padding: 2px 0 4px;
}
</style>
