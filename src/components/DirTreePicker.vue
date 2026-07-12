<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { api } from "../api";
import type { FileEntry } from "../types";

const path = defineModel<string>({ default: "" });

interface TreeNode {
  name: string;
  path: string;
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  children: TreeNode[];
  hasError?: boolean;
}

const roots = ref<FileEntry[]>([]);
const tree = ref<TreeNode[]>([]);
const selectedPath = ref<string>("");

const MAX_CHILDREN = 500;

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

function goUp() {
  if (!path.value) return;
  const parts = path.value.replace(/[\\/]+$/, "").split(/[\\/]/);
  parts.pop();
  const parent = parts.join("\\");
  if (parent) {
    selectedPath.value = parent;
    path.value = parent;
    // 重新以 parent 为根展开
    expandRoot(parent);
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

    <!-- 目录树 -->
    <div class="tree-scroll">
      <template v-for="node in tree" :key="node.path">
        <div
          class="tree-node"
          :class="{ selected: selectedPath === node.path }"
          :style="{ paddingLeft: '8px' }"
          @click="selectNode(node)"
          @dblclick="toggleNode(node)"
        >
          <svg
            class="chev"
            :class="{ expanded: node.expanded }"
            width="10" height="10" viewBox="0 0 12 12" fill="none"
            @click.stop="toggleNode(node)"
          >
            <path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <svg class="folder-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M3 7C3 5.89543 3.89543 5 5 5H9.58579C9.851 5 10.1054 5.10536 10.2929 5.29289L12 7H19C20.1046 7 21 7.89543 21 9V17C21 18.1046 20.1046 19 19 19H5C3.89543 19 3 18.1046 3 17V7Z"/>
          </svg>
          <span class="node-name">{{ node.name }}</span>
        </div>
        <template v-if="node.expanded">
          <div v-if="node.loading" class="tree-hint">加载中…</div>
          <div v-else-if="node.hasError" class="tree-hint warn">目录项过多或无权限，请在地址栏输入路径</div>
          <div v-else-if="node.children.length === 0" class="tree-hint">（空）</div>
          <!-- 子节点（一层；嵌套展开由递归子组件或后续提取，此处先支持两层以验证流程） -->
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.dir-picker { display: flex; flex-direction: column; gap: 8px; min-height: 240px; }
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
  flex: 1; overflow-y: auto; border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md); padding: 6px; background: var(--aide-bg-base);
}
.tree-node {
  display: flex; align-items: center; gap: 4px; padding: 3px 6px;
  border-radius: 4px; cursor: pointer; font-size: 12px;
  color: var(--aide-text-secondary);
}
.tree-node:hover { background: var(--aide-surface-hover); }
.tree-node.selected { background: color-mix(in srgb, var(--aide-accent) 18%, transparent); color: var(--aide-text-primary); }
.chev { transition: transform 0.1s; opacity: 0.6; }
.chev.expanded { transform: rotate(90deg); }
.folder-ic { opacity: 0.7; flex-shrink: 0; }
.node-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-hint { padding: 2px 18px; font-size: 11px; color: var(--aide-text-muted); }
.tree-hint.warn { color: var(--aide-warning); }
</style>
