<script setup lang="ts">
import { computed, ref } from "vue";
import type { ChangeFile } from "../types";
import { buildChangeTree } from "../utils/changeTree";
import ChangeTreeItem from "./ChangeTreeItem.vue";

/**
 * 变更文件树：files 变化（pending 轮实时刷新）→ 重建树，
 * 折叠状态按目录 path 键控跨重建保留；新目录不在折叠集 → 默认展开。
 *
 * 本组件只出树结构；文件行的三个动作（diff 窗口 / 打开文件 / 撤回）由调用方传入，
 * 不靠插槽透传：递归组件自引用的插槽 prop 会让类型推断成环，拖垮整个项目的检查。
 */
const props = defineProps<{
  files: ChangeFile[];
  openFile: (f: ChangeFile) => void;
  openDiff: (f: ChangeFile) => void;
  revertFile: (f: ChangeFile) => void;
  /** 打开 / 定位用的会话工作区根 */
  workspaceRoot?: string;
}>();

const tree = computed(() => buildChangeTree(props.files));

const collapsedDirs = ref<Set<string>>(new Set());

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
      :open-diff="openDiff"
      :revert-file="revertFile"
      :toggle-dir="toggleDir"
      :workspace-root="workspaceRoot"
    />
  </div>
</template>

<style scoped>
.cft {
  padding: 2px 0 4px;
}
</style>
