<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { api } from "../api";
import type { WorkspaceInfo } from "../types";

/**
 * 工作区归属选择器（hero「新会话位于 X」的可点版本）。
 *
 * 只发射选中结果，不改任何全局状态——**选归属 ≠ 切工作区**：活动工作区
 * 仍只由文件树 path-bar 切换器 / 打开目录改变。选中后由调用方决定写哪
 * （空白 tab 的 pendingWs / 零 tab 布局层的 defaultWs）。
 *
 * 交互范本：FileTree 的 ws-switcher（下拉列表 + 当前勾选 + missing 禁用）。
 */
const props = defineProps<{
  /** 当前归属的工作区根路径（勾选高亮依据）；空串时按钮显示「未选择」 */
  path: string;
}>();
const emit = defineEmits<{
  select: [ws: WorkspaceInfo];
}>();

const open = ref(false);
const loading = ref(false);
const list = ref<WorkspaceInfo[]>([]);
const rootRef = ref<HTMLElement | null>(null);

const label = computed(() => {
  if (!props.path) return "未选择工作区";
  return props.path.split(/[\\/]/).filter(Boolean).pop() || props.path;
});

function toggle() {
  if (open.value) {
    open.value = false;
    return;
  }
  open.value = true;
  loading.value = true;
  list.value = [];
  api
    .listWorkspaces()
    .then((ws) => { list.value = ws; })
    .catch(() => { list.value = []; })
    .finally(() => { loading.value = false; });
}

function pick(ws: WorkspaceInfo) {
  open.value = false;
  if (ws.missing) return;
  emit("select", ws);
}

function onClickOutside(e: MouseEvent) {
  if (rootRef.value && !rootRef.value.contains(e.target as Node)) open.value = false;
}
onMounted(() => document.addEventListener("click", onClickOutside));
onUnmounted(() => document.removeEventListener("click", onClickOutside));
</script>

<template>
  <div ref="rootRef" class="workspace-picker">
    <button class="wp-trigger" v-tooltip="props.path || '未选择工作区'" @click.stop="toggle">
      <svg class="wp-folder" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span class="wp-name">{{ label }}</span>
      <svg class="wp-chevron" :class="{ open }" width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2.5 3.5L5 6L7.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <div v-if="open" class="wp-dropdown">
      <div v-if="loading" class="wp-status">加载中…</div>
      <template v-else>
        <button
          v-for="ws in list"
          :key="ws.key"
          class="wp-option"
          :class="{ active: ws.name === props.path, missing: ws.missing }"
          :disabled="ws.missing"
          v-tooltip="ws.missing ? '路径已失效' : ws.name"
          @click="pick(ws)"
        >
          <span class="wp-option-name">{{ ws.name.split(/[\\/]/).filter(Boolean).pop() || ws.name }}</span>
          <span v-if="ws.name === props.path" class="wp-option-check">✓</span>
        </button>
        <div v-if="list.length === 0" class="wp-status">无其它工作区</div>
      </template>
    </div>
  </div>
</template>

<style>
.workspace-picker {
  position: relative;
  display: inline-flex;
}

.wp-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  margin: -1px -2px;
  border: none;
  border-radius: var(--aide-radius-sm);
  background: transparent;
  color: var(--aide-text-primary);
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
  transition: all var(--aide-ease-t);
}

.wp-trigger:hover {
  color: var(--aide-accent);
  background: var(--aide-surface-hover);
}

.wp-trigger:active {
  background: var(--aide-accent-subtle);
}

.wp-folder {
  color: var(--aide-accent);
  flex-shrink: 0;
}

.wp-name {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wp-chevron {
  color: var(--aide-text-muted);
  flex-shrink: 0;
  transition: transform var(--aide-ease-t);
}

.wp-chevron.open {
  transform: rotate(180deg);
}

.wp-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 9000;
  min-width: 200px;
  max-width: 320px;
  max-height: 260px;
  overflow-y: auto;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg);
  box-shadow: var(--aide-shadow-lg);
  padding: 5px;
}

.wp-option {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: var(--aide-radius-sm);
  background: transparent;
  color: var(--aide-text-secondary);
  font-family: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  transition: all var(--aide-ease-t);
}

.wp-option:hover:not(:disabled) {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}

.wp-option.active {
  color: var(--aide-text-primary);
}

.wp-option.active .wp-option-check {
  color: var(--aide-accent);
}

.wp-option.missing {
  opacity: 0.5;
  cursor: not-allowed;
}

.wp-option-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wp-option-check {
  flex-shrink: 0;
  font-size: 12px;
}

.wp-status {
  padding: 8px 10px;
  font-size: 12.5px;
  color: var(--aide-text-muted);
  text-align: center;
}
</style>
