<script setup lang="ts">
import { ref, watch, onMounted, provide, computed } from "vue";
import { api } from "../api";
import type { FileEntry } from "../types";
import DirTreeNode, { type TreeNode, type TreeMode, type DirTreeController, DIR_TREE_CONTROLLER } from "./DirTreeNode.vue";

// ── props（默认值保证 OpenFolderDialog 零改动兼容）──
// mode="directory" + multiple=false + root=undefined == 原行为：只显目录、单选、有盘符入口、地址栏可编辑可往上跳出。
const props = withDefaults(defineProps<{
  /** directory=只显目录；file=只显文件；mixed=都显（目录可展开、文件可选，server 二进制选择用）。 */
  mode?: TreeMode;
  /** 多选（排除目录用）。 */
  multiple?: boolean;
  /** 锁定根：非空时跳过盘符、隐藏 quick-roots、goUp 不跳出根、地址栏只读（限工作空间内）。 */
  root?: string;
}>(), {
  mode: "directory",
  multiple: false,
});

/** 单选时是 string，多选时是 string[]。内部统一用 selectedPaths(Set) 管理。 */
const path = defineModel<string | string[]>({ default: "" });

const roots = ref<FileEntry[]>([]);
const tree = ref<TreeNode[]>([]);
const selectedPath = ref<string>("");
const selectedPaths = ref<Set<string>>(new Set());

const MAX_CHILDREN = 500;

// model → selectedPath / selectedPaths 同步
watch(path, (v) => {
  if (props.multiple) {
    selectedPaths.value = new Set(Array.isArray(v) ? v : []);
    selectedPath.value = "";
  } else {
    const s = typeof v === "string" ? v : "";
    selectedPath.value = s;
    selectedPaths.value = new Set(s ? [s] : []);
  }
}, { immediate: true });

// 向递归子组件下发选中态 + 动作
provide(DIR_TREE_CONTROLLER, {
  selectedPath,
  selectedPaths,
  mode: props.mode,
  multiple: props.multiple,
  selectNode,
  toggleNode,
  toggleSelect,
} satisfies DirTreeController);

onMounted(async () => {
  if (props.root) {
    // root 锁定：不列盘符，直接以 root 为根展开
    roots.value = [];
    await expandRoot(props.root);
  } else {
    try {
      roots.value = await api.listFsRoots();
    } catch (_e) {
      roots.value = [];
    }
    // 默认展开第一个根
    if (roots.value.length) {
      await expandRoot(roots.value[0].path);
    }
  }
});

async function expandRoot(rootPath: string) {
  tree.value = [await makeNode(rootPath.split(/[\\/]/).pop() || rootPath, rootPath, true, true)];
  await loadChildren(tree.value[0]);
}

async function makeNode(name: string, dirPath: string, isDir: boolean, expanded = false): Promise<TreeNode> {
  return { name, path: dirPath, is_dir: isDir, expanded, loaded: false, loading: false, children: [] };
}

async function loadChildren(node: TreeNode) {
  if (node.loaded || node.loading) return;
  node.loading = true;
  try {
    const entries = await api.listDirectory(node.path, false);
    let filtered = entries;
    if (props.mode === "directory") {
      filtered = entries.filter(e => e.is_dir);
    } else if (props.mode === "file") {
      filtered = entries.filter(e => !e.is_dir);
    }
    // mixed：都保留（目录可展开、文件可选）
    if (filtered.length > MAX_CHILDREN) {
      node.children = [];
      node.hasError = true; // 触发「目录项过多」提示
    } else {
      node.children = await Promise.all(
        filtered.map(d => makeNode(d.name, d.path, d.is_dir, false)),
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

// 选中语义（按 mode + is_dir）：
// - directory：目录→选中设值（OpenFolderDialog 兼容）；文件→不响应（不显示）
// - file/mixed：目录→展开（不选中）；文件→选中（单选设值 / 多选 toggle）
function selectNode(node: TreeNode) {
  if (node.is_dir) {
    if (props.mode === "directory") {
      setSelected(node.path);
    } else {
      toggleNode(node);
    }
  } else {
    if (props.mode === "directory") return;
    if (props.multiple) toggleSelect(node);
    else setSelected(node.path);
  }
}

function setSelected(p: string) {
  selectedPath.value = p;
  selectedPaths.value = new Set([p]);
  path.value = p;
}

function toggleSelect(node: TreeNode) {
  const next = new Set(selectedPaths.value);
  if (next.has(node.path)) next.delete(node.path);
  else next.add(node.path);
  selectedPaths.value = next;
  path.value = [...next];
}

async function goUp() {
  if (props.multiple) return; // 多选不走地址栏导航
  const cur = typeof path.value === "string" ? path.value : "";
  if (!cur) return;
  const parts = cur.replace(/[\\/]+$/, "").split(/[\\/]/);
  parts.pop();
  const sep = cur.includes("\\") ? "\\" : "/";
  const parent = parts.join(sep);
  if (!parent) return;
  // root 锁定：不跳出 root
  if (props.root) {
    const norm = (s: string) => s.replace(/[\\/]+$/g, "").toLowerCase();
    const np = norm(parent), nr = norm(props.root);
    if (np !== nr && !np.startsWith(nr + "\\") && !np.startsWith(nr + "/")) return;
  }
  selectedPath.value = parent;
  path.value = parent;
  await expandRoot(parent);
}

async function jumpToRoot(rootPath: string) {
  if (props.multiple) return;
  selectedPath.value = rootPath;
  path.value = rootPath;
  await expandRoot(rootPath);
}

const showQuickRoots = computed(() => !props.root && roots.value.length > 0);
const addrReadonly = computed(() => !!props.root || props.multiple);
const addrValue = computed(() => (props.multiple || Array.isArray(path.value)) ? "" : (path.value as string));
const addrPlaceholder = computed(() => props.multiple ? "在下方树中勾选目录" : "输入或选择目录路径");

function onAddrInput(e: Event) {
  if (props.multiple) return;
  path.value = (e.target as HTMLInputElement).value;
}
</script>

<template>
  <div class="dir-picker">
    <!-- 地址栏 -->
    <div class="addr-bar">
      <button class="up-btn" v-tooltip="'上一级'" :disabled="multiple" @click="goUp">↑</button>
      <input
        class="addr-input"
        :value="addrValue"
        :placeholder="addrPlaceholder"
        :readonly="addrReadonly"
        spellcheck="false"
        @input="onAddrInput"
      />
    </div>

    <!-- 快速入口（root 锁定时隐藏） -->
    <div v-if="showQuickRoots" class="quick-roots">
      <button
        v-for="r in roots"
        :key="r.path"
        class="root-chip"
        :class="{ active: !multiple && path === r.path }"
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
.up-btn:hover:not(:disabled) { background: var(--aide-surface-hover); }
.up-btn:disabled { opacity: 0.4; cursor: not-allowed; }
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