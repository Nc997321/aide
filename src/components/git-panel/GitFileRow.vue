<script setup lang="ts">
/**
 * GitFileRow —— 文件行（纯展示 leaf）
 *
 * 渲染单条文件变更（状态字母 + 路径 + 增删统计），点击 emit click。
 * 重命名（status R）归一为 M 的配色，但路径展示 oldPath → path。
 * 样式沿用 GitPanel 的 .git-file-row 语汇（scoped 副本）。
 */
interface FileLike {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  oldPath?: string;
}

const props = defineProps<{ file: FileLike }>();
defineEmits<{ click: [] }>();

function statusClass(s: string): string {
  if (s === "R") return "M";
  if (s === "?") return "U";
  return s;
}

function pathTooltip(): string {
  return props.file.status === "R" && props.file.oldPath
    ? `${props.file.oldPath} → ${props.file.path}`
    : props.file.path;
}
</script>

<template>
  <div class="git-file-row" @click="$emit('click')">
    <span class="git-file-status" :class="'status-' + statusClass(file.status)">{{ file.status }}</span>
    <span class="git-file-path" v-tooltip="pathTooltip()">
      <template v-if="file.status === 'R' && file.oldPath">{{ file.oldPath }} → {{ file.path }}</template>
      <template v-else>{{ file.path }}</template>
    </span>
    <span class="git-file-stats">
      <span v-if="file.additions > 0" class="stat-add">+{{ file.additions }}</span>
      <span v-if="file.additions > 0 && file.deletions > 0" class="stat-sep"> </span>
      <span v-if="file.deletions > 0" class="stat-del">-{{ file.deletions }}</span>
    </span>
  </div>
</template>

<style scoped>
.git-file-row {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 10px; font-size: 12px; cursor: pointer;
  transition: background 0.15s ease;
}
.git-file-row:hover { background: var(--aide-surface-default); }

.git-file-status {
  flex-shrink: 0; width: 16px; height: 16px;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 700; border-radius: 3px;
}
.status-M { background: color-mix(in srgb, var(--aide-warning) 15%, transparent); color: var(--aide-warning); }
.status-A { background: color-mix(in srgb, var(--aide-success) 15%, transparent); color: var(--aide-success); }
.status-D { background: color-mix(in srgb, var(--aide-danger) 15%, transparent); color: var(--aide-danger); }
.status-U { background: color-mix(in srgb, var(--aide-info) 15%, transparent); color: var(--aide-info); }

.git-file-path {
  flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--aide-text-secondary);
}
.git-file-stats { flex-shrink: 0; font-size: 11px; font-family: var(--aide-font-mono); }
.stat-add { color: var(--aide-success); }
.stat-del { color: var(--aide-danger); }
.stat-sep { color: var(--aide-text-muted); }
</style>