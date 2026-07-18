<script setup lang="ts">
import { ref } from "vue";
import PaneGroup from "./PaneGroup.vue";
import { usePaneLayout } from "../../composables/usePaneLayout";
import type { PaneNode, SplitNode } from "../../composables/paneLayout/tree";

/**
 * 布局树的递归渲染器：group 节点 → PaneGroup；split 节点 → flex 容器 +
 * 子节点（递归自身）+ 可拖分隔条。尺寸用 flex-grow 承载比例值，拖拽只改
 * 相邻两个孩子的占比（VS Code 语义），经 usePaneLayout.setSizes 写回。
 */
const props = defineProps<{ node: PaneNode }>();

const pl = usePaneLayout();
const containerEl = ref<HTMLDivElement | null>(null);
const draggingIdx = ref<number | null>(null);

/** 单个孩子的最小占比——防止把某组拖到不可用的窄条 */
const MIN_RATIO = 0.12;

function onHandleMousedown(e: MouseEvent, idx: number) {
  if (props.node.type !== "split" || !containerEl.value) return;
  const split = props.node as SplitNode;
  const rect = containerEl.value.getBoundingClientRect();
  const horizontal = split.direction === "horizontal";
  const total = horizontal ? rect.width : rect.height;
  if (total <= 0) return;
  const start = horizontal ? e.clientX : e.clientY;
  const startSizes = split.sizes.slice();
  draggingIdx.value = idx;

  const onMove = (ev: MouseEvent) => {
    const cur = horizontal ? ev.clientX : ev.clientY;
    let delta = (cur - start) / total;
    delta = Math.max(-(startSizes[idx] - MIN_RATIO), Math.min(startSizes[idx + 1] - MIN_RATIO, delta));
    const sizes = startSizes.slice();
    sizes[idx] += delta;
    sizes[idx + 1] -= delta;
    pl.setSizes(split.id, sizes);
  };
  const onUp = () => {
    draggingIdx.value = null;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}
</script>

<template>
  <PaneGroup v-if="props.node.type === 'group'" :group="props.node" />
  <div
    v-else
    ref="containerEl"
    class="pane-split"
    :class="props.node.direction === 'horizontal' ? 'pane-split--h' : 'pane-split--v'"
  >
    <template v-for="(child, i) in props.node.children" :key="child.id">
      <div class="pane-split__child" :style="{ flexGrow: props.node.sizes[i] }">
        <PaneSplit :node="child" />
      </div>
      <div
        v-if="i < props.node.children.length - 1"
        class="pane-split__handle"
        :class="{ 'pane-split__handle--active': draggingIdx === i }"
        @mousedown.prevent="onHandleMousedown($event, i)"
      />
    </template>
  </div>
</template>

<style scoped>
.pane-split {
  display: flex;
  height: 100%;
  width: 100%;
  min-width: 0;
  min-height: 0;
}

.pane-split--h {
  flex-direction: row;
}

.pane-split--v {
  flex-direction: column;
}

.pane-split__child {
  flex-basis: 0;
  flex-shrink: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

/* 分隔条：默认 1px 细线，hover/拖拽时 3px accent 发光线 */
.pane-split__handle {
  flex: none;
  position: relative;
}

.pane-split--h > .pane-split__handle {
  width: 5px;
  cursor: col-resize;
}

.pane-split--v > .pane-split__handle {
  height: 5px;
  cursor: row-resize;
}

.pane-split__handle::after {
  content: "";
  position: absolute;
  background: var(--aide-border-subtle);
  transition: all var(--aide-ease-t);
}

/* 水平布局（子元素横向排列）：分隔条是竖线 */
.pane-split--h > .pane-split__handle::after {
  left: 2px;
  top: 0;
  bottom: 0;
  width: 1px;
}

/* 垂直布局（子元素纵向堆叠）：分隔条是横线 */
.pane-split--v > .pane-split__handle::after {
  left: 0;
  right: 0;
  top: 2px;
  height: 1px;
}

.pane-split--h > .pane-split__handle:hover::after,
.pane-split--h > .pane-split__handle--active::after {
  width: 3px;
  left: 1px;
  background: var(--aide-accent);
  box-shadow: 0 0 8px color-mix(in srgb, var(--aide-accent) 50%, transparent);
}

.pane-split--v > .pane-split__handle:hover::after,
.pane-split--v > .pane-split__handle--active::after {
  height: 3px;
  top: 1px;
  background: var(--aide-accent);
  box-shadow: 0 0 8px color-mix(in srgb, var(--aide-accent) 50%, transparent);
}
</style>
