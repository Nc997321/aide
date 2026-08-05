<script lang="ts">
import type { InjectionKey, Ref } from "vue";

/** 目录树节点（DirTreePicker 构造并持有，DirTreeNode 递归渲染）。 */
export interface TreeNode {
  name: string;
  path: string;
  /** 是否目录（决定图标/chevron/可选语义；mixed 模式下区分文件节点）。 */
  is_dir: boolean;
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  children: TreeNode[];
  hasError?: boolean;
}

export type TreeMode = "directory" | "file" | "mixed";

/** DirTreePicker 向递归子节点下发的控制器：选中态 + 选中/折叠/多选动作。 */
export interface DirTreeController {
  /** 单选当前选中路径（多选模式下为空串，仅用于单选高亮）。 */
  selectedPath: Ref<string>;
  /** 多选选中路径集合（单选模式下含 0/1 个元素）。 */
  selectedPaths: Ref<Set<string>>;
  mode: TreeMode;
  multiple: boolean;
  selectNode: (node: TreeNode) => void;
  toggleNode: (node: TreeNode) => void;
  toggleSelect: (node: TreeNode) => void;
}

export const DIR_TREE_CONTROLLER: InjectionKey<DirTreeController> = Symbol("dir-tree-controller");
</script>

<script setup lang="ts">
import { inject, computed } from "vue";

const props = defineProps<{ node: TreeNode; depth: number }>();

const ctrl = inject(DIR_TREE_CONTROLLER);
if (!ctrl) {
  throw new Error("DirTreeNode must be used inside <DirTreePicker> (missing DIR_TREE_CONTROLLER injection)");
}

const isSelected = computed(() =>
  ctrl!.multiple
    ? ctrl!.selectedPaths.value.has(props.node.path)
    : ctrl!.selectedPath.value === props.node.path
);
</script>

<template>
  <div>
    <div
      class="tree-node"
      :class="{ selected: isSelected }"
      :style="{ paddingLeft: 8 + props.depth * 14 + 'px' }"
      @click="ctrl!.selectNode(props.node)"
      @dblclick="ctrl!.toggleNode(props.node)"
    >
      <input
        v-if="ctrl!.multiple"
        type="checkbox"
        class="tree-check"
        :checked="ctrl!.selectedPaths.value.has(props.node.path)"
        @click.stop="ctrl!.toggleSelect(props.node)"
      />
      <svg
        v-if="props.node.is_dir"
        class="chev"
        :class="{ expanded: props.node.expanded }"
        width="10" height="10" viewBox="0 0 12 12" fill="none"
        @click.stop="ctrl!.toggleNode(props.node)"
      >
        <path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span v-else class="chev-spacer" />
      <svg v-if="props.node.is_dir" class="folder-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M3 7C3 5.89543 3.89543 5 5 5H9.58579C9.851 5 10.1054 5.10536 10.2929 5.29289L12 7H19C20.1046 7 21 7.89543 21 9V17C21 18.1046 20.1046 19 19 19H5C3.89543 19 3 18.1046 3 17V7Z"/>
      </svg>
      <svg v-else class="file-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M14 3v5h5"/><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/>
      </svg>
      <span class="node-name">{{ props.node.name }}</span>
    </div>
    <template v-if="props.node.expanded">
      <div v-if="props.node.loading" class="tree-hint">加载中…</div>
      <div v-else-if="props.node.hasError" class="tree-hint warn">目录项过多或无权限，请在地址栏输入路径</div>
      <div v-else-if="props.node.children.length === 0" class="tree-hint">（空）</div>
      <!-- 递归子节点：DirTreeNode 在 <script setup> 下按文件名自引用 -->
      <DirTreeNode
        v-for="child in props.node.children"
        :key="child.path"
        :node="child"
        :depth="props.depth + 1"
      />
    </template>
  </div>
</template>

<style scoped>
.tree-node {
  display: flex; align-items: center; gap: 4px; padding: 3px 6px;
  border-radius: 4px; cursor: pointer; font-size: 12px;
  color: var(--aide-text-secondary);
  /* 阻止双击展开时浏览器默认选词（选中目录名文本） */
  user-select: none;
}
.tree-node:hover { background: var(--aide-surface-hover); }
.tree-node.selected {
  background: color-mix(in srgb, var(--aide-accent) 18%, transparent);
  color: var(--aide-text-primary);
}
.tree-check { width: 13px; height: 13px; accent-color: var(--aide-accent); margin: 0; flex-shrink: 0; cursor: pointer; }
.chev { transition: transform 0.1s; opacity: 0.6; flex-shrink: 0; }
.chev.expanded { transform: rotate(90deg); }
.chev-spacer { display: inline-block; width: 10px; flex-shrink: 0; }
.folder-ic { opacity: 0.7; flex-shrink: 0; }
.file-ic { opacity: 0.6; flex-shrink: 0; }
.node-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-hint { padding: 2px 18px; font-size: 11px; color: var(--aide-text-muted); }
.tree-hint.warn { color: var(--aide-warning); }
</style>