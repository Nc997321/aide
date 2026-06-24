<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useConversationChanges } from "../composables/useConversationChanges";
import { useFileViewer } from "../composables/useFileViewer";
import { api } from "../api";

const props = defineProps<{ sessionId: string }>();

const { rounds, revertRound, revertSingleFile } = useConversationChanges(() => props.sessionId);
const fileViewer = useFileViewer();

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
        <div v-for="round in displayedRounds" :key="round.index" class="changelog-round">
          <div class="changelog-round-header">
            <span class="changelog-round-label">轮 {{ round.index }}</span>
            <span class="changelog-round-time">{{ round.time }}</span>
            <button
              v-if="round.files.length > 0"
              class="changelog-round-revert"
              title="撤回本轮"
              @click="revertRound(round)"
            >↶</button>
          </div>
          <div v-if="round.files.length === 0" class="changelog-nochange">无变更</div>
          <div
            v-for="f in round.files"
            :key="f.path"
            class="changelog-file"
            @click="openFile(resolvePath(f.path))"
          >
            <span class="changelog-file-status" :class="f.status === 'A' ? 'status-A' : 'status-M'">{{ f.status || 'M' }}</span>
            <span class="changelog-file-path" :title="f.path">{{ f.path }}</span>
            <span v-if="f.additions > 0 || f.deletions > 0" class="changelog-file-stats">
              <span v-if="f.additions > 0" class="stat-add">+{{ f.additions }}</span>
              <span v-if="f.additions > 0 && f.deletions > 0" class="stat-sep"> </span>
              <span v-if="f.deletions > 0" class="stat-del">-{{ f.deletions }}</span>
            </span>
            <button
              class="changelog-file-revert"
              title="撤回此文件"
              @click.stop="revertSingleFile(round, f.path)"
            >↶</button>
          </div>
        </div>
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
  font-weight: 600;
  color: var(--aide-accent);
}

.changelog-round-time {
  flex: 1;
  color: var(--aide-text-muted);
}

.changelog-round-revert {
  background: none;
  border: none;
  color: var(--aide-text-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 1px 4px;
  border-radius: 2px;
  transition: color 0.1s, background 0.1s;
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
  gap: 6px;
  padding: 3px 12px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.1s;
}
.changelog-file:hover {
  background: var(--aide-surface-default);
}

.changelog-nochange {
  padding: 4px 12px;
  font-size: 11px;
  color: var(--aide-text-muted);
  font-style: italic;
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
}

.changelog-file-stats {
  flex-shrink: 0;
  font-size: 11px;
  font-family: "Cascadia Code", "Fira Code", "Consolas", monospace;
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
  transition: opacity 0.1s, color 0.1s, background 0.1s;
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
