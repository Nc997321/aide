<script setup lang="ts">
/**
 * GitCommitRow —— 提交行（纯展示 leaf）
 *
 * 渲染单条提交的折叠头（圆点 + message + author·date），点击 emit toggle。
 * 展开详情通过默认插槽注入（由宿主控制展开态与详情内容），保持 leaf 无状态。
 * 样式沿用 GitPanel 的 .commit-item/.commit-header 语汇（scoped 副本，不跨组件继承）。
 */
import type { CommitEntry } from "../../types";

defineProps<{
  commit: CommitEntry;
  unpushed?: boolean;
  expanded?: boolean;
}>();

defineEmits<{ toggle: [] }>();
</script>

<template>
  <div class="commit-item" :class="{ expanded }">
    <div class="commit-header" @click="$emit('toggle')">
      <span class="commit-dot" :class="{ unpushed }">●</span>
      <div class="commit-info">
        <span class="commit-message">{{ commit.message }}</span>
        <span class="commit-meta">{{ commit.author }} · {{ commit.date }}</span>
      </div>
    </div>
    <slot />
  </div>
</template>

<style scoped>
.commit-item { border-bottom: 1px solid var(--aide-surface-default); }
.commit-item:last-child { border-bottom: none; }
.commit-header {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 6px 10px; cursor: pointer; transition: background 0.15s ease;
}
.commit-header:hover { background: var(--aide-surface-default); }
.commit-dot { font-size: 12px; color: var(--aide-accent); margin-top: 1px; flex-shrink: 0; }
.commit-dot.unpushed { color: var(--aide-warning); }
.commit-info { flex: 1; min-width: 0; }
.commit-message {
  display: block; font-size: 12px; color: var(--aide-text-primary); font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.commit-meta { display: block; font-size: 10px; color: var(--aide-text-muted); margin-top: 1px; }
</style>