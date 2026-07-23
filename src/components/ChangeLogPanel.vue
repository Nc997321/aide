<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useConversationChanges } from "../composables/useConversationChanges";
import type { ChangeRound } from "../composables/useConversationChanges";
import { useFileViewer } from "../composables/useFileViewer";
import { api } from "../api";

const props = defineProps<{ sessionId: string }>();

const { rounds, revertRound, revertSingleFile } = useConversationChanges(() => props.sessionId);
const fileViewer = useFileViewer();

// 连续无变更轮次 > 2 时，中间折叠成一行省略号，点击可展开
const NOCHANGE_COLLAPSE_THRESHOLD = 2;

type RenderItem =
  | { kind: "round"; round: ChangeRound }
  | { kind: "collapsed"; key: string; hiddenCount: number };

const expandedGroups = ref<Set<string>>(new Set());

function expandGroup(key: string) {
  expandedGroups.value.add(key);
  expandedGroups.value = new Set(expandedGroups.value);
}

const projectRoot = ref("");

onMounted(async () => {
  try {
    const info = await api.getProjectInfo();
    projectRoot.value = info.root;
  } catch (_) { /* ignore */ }
});

function resolvePath(rel: string): string {
  return projectRoot.value.replace(/\\/g, "/") + "/" + rel;
}

function openFile(path: string) {
  fileViewer.open(path);
}

const totalFiles = computed(() => {
  let n = 0;
  for (const r of rounds.value) n += r.files.length;
  return n;
});

const displayedRounds = computed(() => [...rounds.value].reverse());

const renderItems = computed<RenderItem[]>(() => {
  const list = displayedRounds.value;
  const items: RenderItem[] = [];
  let i = 0;
  while (i < list.length) {
    if (list[i].files.length > 0) {
      items.push({ kind: "round", round: list[i] });
      i++;
      continue;
    }
    let j = i;
    while (j < list.length && list[j].files.length === 0) j++;
    const group = list.slice(i, j);
    const groupKey = String(group[0].index);
    if (group.length > NOCHANGE_COLLAPSE_THRESHOLD && !expandedGroups.value.has(groupKey)) {
      const hidden = group.slice(1, -1);
      items.push({ kind: "round", round: group[0] });
      items.push({ kind: "collapsed", key: groupKey, hiddenCount: hidden.length });
      items.push({ kind: "round", round: group[group.length - 1] });
    } else {
      for (const r of group) items.push({ kind: "round", round: r });
    }
    i = j;
  }
  return items;
});
</script>

<template>
  <div class="changelog">
    <div class="changelog-header">
      <span class="changelog-dot">●</span>
      <span class="changelog-title">会话变更</span>
      <span v-if="totalFiles > 0" class="changelog-badge">{{ totalFiles }}</span>
    </div>

    <div class="changelog-body">
      <template v-if="rounds.length === 0">
        <div class="changelog-empty">暂无变更记录</div>
      </template>
      <template v-else>
        <template v-for="item in renderItems" :key="item.kind === 'round' ? `r-${item.round.index}` : `c-${item.key}`">
          <div
            v-if="item.kind === 'collapsed'"
            class="changelog-collapsed"
            v-tooltip="`展开 ${item.hiddenCount} 轮无变更记录`"
            @click="expandGroup(item.key)"
          >⋯ {{ item.hiddenCount }} 轮无变更 ⋯</div>
          <div v-else class="changelog-round">
            <div class="changelog-round-header">
              <span class="changelog-round-label">轮 {{ item.round.index }}</span>
              <span
                class="changelog-round-title"
                :class="{ 'changelog-round-title--empty': !item.round.prompt }"
                v-tooltip="item.round.prompt || undefined"
              >{{ item.round.prompt || '（无提问记录）' }}</span>
              <button
                v-if="item.round.files.length > 0"
                class="changelog-round-revert"
                v-tooltip="'撤回本轮'"
                @click="revertRound(item.round)"
              ><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6.69 3L3 13"/></svg></button>
            </div>
            <div class="changelog-round-time">{{ item.round.time }}</div>
            <div v-if="item.round.files.length === 0" class="changelog-nochange">无变更</div>
            <div
              v-for="f in item.round.files"
              :key="f.path"
              class="changelog-file"
              @click="openFile(resolvePath(f.path))"
            >
              <span class="changelog-file-status" :class="f.status === 'A' ? 'status-A' : 'status-M'">{{ f.status || 'M' }}</span>
              <span class="changelog-file-path" v-tooltip="f.path">{{ f.path }}</span>
              <span v-if="f.additions > 0 || f.deletions > 0" class="changelog-file-stats">
                <span v-if="f.additions > 0" class="stat-add">+{{ f.additions }}</span>
                <span v-if="f.additions > 0 && f.deletions > 0" class="stat-sep"> </span>
                <span v-if="f.deletions > 0" class="stat-del">-{{ f.deletions }}</span>
              </span>
              <button
                class="changelog-file-revert"
                v-tooltip="'撤回此文件'"
                @click.stop="revertSingleFile(item.round, f.path)"
              ><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6.69 3L3 13"/></svg></button>
            </div>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.changelog {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--aide-bg-deep);
  overflow: hidden;
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
}

/* ── Header ── */

.changelog-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--aide-text-secondary);
  flex-shrink: 0;
  border-bottom: 1px solid var(--aide-border);
}

.changelog-dot {
  font-size: 8px;
  color: var(--aide-accent);
}

.changelog-badge {
  background: var(--aide-surface-default);
  color: var(--aide-text-muted);
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  min-width: 16px;
  text-align: center;
  line-height: 1.4;
}

/* ── Body ── */

.changelog-body {
  flex: 1;
  overflow-y: auto;
}

.changelog-empty {
  padding: 24px 16px;
  font-size: 11px;
  color: var(--aide-text-muted);
  text-align: center;
}

/* ── Round groups ── */

.changelog-round {
  border-bottom: 1px solid var(--aide-border-subtle);
}

.changelog-round:last-child {
  border-bottom: none;
}

.changelog-round-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 12px;
  font-size: 10px;
  color: var(--aide-text-muted);
  background: var(--aide-bg-deep);
  border-bottom: 1px solid var(--aide-border-subtle);
}

.changelog-round-label {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--aide-accent);
}

.changelog-round-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--aide-text-secondary);
}

.changelog-round-title--empty {
  color: var(--aide-text-muted);
  font-style: italic;
}

.changelog-round-time {
  padding: 0 12px 4px;
  font-size: 10px;
  color: var(--aide-text-muted);
  background: var(--aide-bg-deep);
}

.changelog-round-revert {
  background: none;
  border: none;
  color: var(--aide-text-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 1px 4px;
  border-radius: 2px;
  transition: color 0.15s ease, background 0.15s ease;
  font-family: inherit;
}
.changelog-round-revert:hover {
  color: var(--aide-danger);
  background: color-mix(in srgb, var(--aide-danger) 12%, transparent);
}

/* ── File rows ── */

.changelog-file {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 10px;
  font-size: 12px;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  transition: background var(--aide-ease-t), color var(--aide-ease-t);
}
.changelog-file:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

.changelog-nochange {
  padding: 4px 12px;
  font-size: 11px;
  color: var(--aide-text-muted);
  font-style: italic;
}

.changelog-collapsed {
  padding: 4px 12px;
  font-size: 10px;
  color: var(--aide-text-muted);
  text-align: center;
  cursor: pointer;
  border-bottom: 1px solid var(--aide-border-subtle);
  transition: color 0.15s ease, background 0.15s ease;
}
.changelog-collapsed:hover {
  color: var(--aide-text-secondary);
  background: var(--aide-surface-default);
}

.changelog-file-status {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  border-radius: 3px;
}
.status-M {
  background: color-mix(in srgb, var(--aide-warning) 15%, transparent);
  color: var(--aide-warning);
}
.status-A {
  background: color-mix(in srgb, var(--aide-success) 15%, transparent);
  color: var(--aide-success);
}

.changelog-file-path {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--aide-text-secondary);
  font-size: 12px;
  font-family: var(--aide-font-mono);
  font-size: 11.5px;
}

.changelog-file-stats {
  flex-shrink: 0;
  font-size: 11px;
  font-family: var(--aide-font-mono);
}

.stat-add { color: var(--aide-success); }
.stat-del { color: var(--aide-danger); }

.changelog-file-revert {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--aide-text-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 1px 4px;
  border-radius: 2px;
  opacity: 0;
  transition: opacity 0.15s ease, color 0.15s ease, background 0.15s ease;
  font-family: inherit;
}
.changelog-file:hover .changelog-file-revert {
  opacity: 1;
}
.changelog-file-revert:hover {
  color: var(--aide-danger);
  background: color-mix(in srgb, var(--aide-danger) 12%, transparent);
}

/* ── Scrollbar ── */

.changelog-body::-webkit-scrollbar {
  width: 4px;
}
.changelog-body::-webkit-scrollbar-track {
  background: transparent;
}
.changelog-body::-webkit-scrollbar-thumb {
  background: var(--aide-surface-hover);
  border-radius: 2px;
}
</style>
