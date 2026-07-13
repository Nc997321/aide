<script setup lang="ts">
import { ref, onMounted, provide } from "vue";
import { api } from "../api";
import type { FileEntry } from "../types";
import DirTreeNode, { type TreeNode, DIR_TREE_CONTROLLER } from "./DirTreeNode.vue";

const path = defineModel<string>({ default: "" });

const roots = ref<FileEntry[]>([]);
const tree = ref<TreeNode[]>([]);
const selectedPath = ref<string>("");

const MAX_CHILDREN = 500;

// 向递归子组件下发选中态 + 选中/折叠动作
provide(DIR_TREE_CONTROLLER, {
  selectedPath,
  selectNode,
  toggleNode,
});

onMounted(async () => {
  try {
    roots.value = await api.listFsRoots();
  } catch (_e) {
    roots.value = [];
  }
  // 默认展开第一个根
  if (roots.value.length) {
    await expandRoot(roots.value[0].path);
  }
});

async function expandRoot(rootPath: string) {
  tree.value = [await makeNode(rootPath.split(/[\\/]/).pop() || rootPath, rootPath, true)];
  await loadChildren(tree.value[0]);
}

async function makeNode(name: string, dirPath: string, expanded = false): Promise<TreeNode> {
  return { name, path: dirPath, expanded, loaded: false, loading: false, children: [] };
}

async function loadChildren(node: TreeNode) {
  if (node.loaded || node.loading) return;
  node.loading = true;
  try {
    const entries = await api.listDirectory(node.path, false);
    const dirs = entries.filter(e => e.is_dir);
    if (dirs.length > MAX_CHILDREN) {
      node.children = [];
      node.hasError = true; // 触发「目录项过多」提示
    } else {
      node.children = await Promise.all(
        dirs.map(d => makeNode(d.name, d.path, false)),
      );
    }
    node.loaded = true;
  } catch (_e) {
    node.hasError = true;
    node.loaded = true;
  }
  node.loading = false;
}

async function toggleNode(node: TreeNode) {
  node.expanded = !node.expanded;
  if (node.expanded && !node.loaded) await loadChildren(node);
}

function selectNode(node: TreeNode) {
  selectedPath.value = node.path;
  path.value = node.path;
}

async function goUp() {
  if (!path.value) return;
  const parts = path.value.replace(/[\\/]+$/, "").split(/[\\/]/);
  parts.pop();
  const sep = path.value.includes("\\") ? "\\" : "/";
  const parent = parts.join(sep);
  if (parent) {
    selectedPath.value = parent;
    path.value = parent;
    await expandRoot(parent);
  }
}

async function jumpToRoot(rootPath: string) {
  selectedPath.value = rootPath;
  path.value = rootPath;
  await expandRoot(rootPath);
}
</script>

<template>
  <div class="dir-picker">
    <!-- 地址栏 -->
    <div class="addr-bar">
      <button class="up-btn" v-tooltip="'上一级'" @click="goUp">↑</button>
      <input
        class="addr-input"
        v-model="path"
        placeholder="输入或选择目录路径"
        spellcheck="false"
      />
    </div>

    <!-- 快速入口 -->
    <div class="quick-roots">
      <button
        v-for="r in roots"
        :key="r.path"
        class="root-chip"
        :class="{ active: path === r.path }"
        @click="jumpToRoot(r.path)"
      >
        {{ r.name }}
      </button>
    </div>

    <!-- 目录树（递归渲染） -->
    <div class="tree-scroll">
      <DirTreeNode
        v-for="node in tree"
        :key="node.path"
        :node="node"
        :depth="0"
      />
    </div>
  </div>
</template>

<style scoped>
.dir-picker {
  display: flex; flex-direction: column; gap: 8px;
  /* 填满弹框分配的高度并允许收缩，让 tree-scroll 内部滚动而非撑爆弹框 */
  flex: 1 1 auto; min-height: 0;
}
.addr-bar { display: flex; gap: 6px; }
.addr-input {
  flex: 1; box-sizing: border-box;
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-surface-hover);
  border-radius: var(--aide-radius-md);
  padding: 6px 10px; font-size: 12px; color: var(--aide-text-primary);
  font-family: inherit; outline: none;
}
.up-btn {
  width: 28px; border: 1px solid var(--aide-surface-hover);
  background: var(--aide-surface-default); border-radius: var(--aide-radius-md);
  color: var(--aide-text-secondary); cursor: pointer;
}
.up-btn:hover { background: var(--aide-surface-hover); }
.quick-roots { display: flex; flex-wrap: wrap; gap: 6px; }
.root-chip {
  font-size: 11px; padding: 3px 10px; border-radius: 10px;
  border: 1px solid var(--aide-surface-hover); background: var(--aide-surface-default);
  color: var(--aide-text-secondary); cursor: pointer; font-family: inherit;
}
.root-chip:hover { background: var(--aide-surface-hover); }
.root-chip.active { border-color: var(--aide-accent); color: var(--aide-accent); }
.tree-scroll {
  /* min-height:0 是 flex 子项能滚动而非撑高的关键 */
  flex: 1 1 auto; min-height: 0; overflow-y: auto;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md); padding: 6px; background: var(--aide-bg-base);
}
</style>