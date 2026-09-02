<script setup lang="ts">
import { computed, ref } from "vue";
import type { ChangeFile } from "../types";
import { buildChangeTree } from "../utils/changeTree";
import ChangeTreeItem from "./ChangeTreeItem.vue";

/**
 * 轮次文件变更树：files 变化（pending 轮实时刷新）→ 重建树，
 * 折叠状态按目录 path 键控跨重建保留；新目录不在折叠集 → 默认展开。
 */
const props = defineProps<{
  files: ChangeFile[];
  openFile: (f: ChangeFile) => void;
  revertFile: (f: ChangeFile) => void;
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
      :revert-file="revertFile"
      :toggle-dir="toggleDir"
    />
  </div>
</template>

<style scoped>
.cft {
  padding: 2px 0 4px;
}
</style>
