<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useConversationChanges } from "../composables/useConversationChanges";
import { useFileViewer } from "../composables/useFileViewer";
import { api } from "../api";

const props = defineProps<{ sessionId: string }>();
const emit = defineEmits<{ (e: "collapse-changed", collapsed: boolean): void }>();

const { rounds, revertRound, revertSingleFile } = useConversationChanges(() => props.sessionId);
const fileViewer = useFileViewer();

const collapsed = ref(false);
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

function toggleCollapsed() {
  collapsed.value = !collapsed.value;
  emit("collapse-changed", collapsed.value);
}

const totalFiles = computed(() => {
  let n = 0;
  for (const r of rounds.value) n += r.files.length;
  return n;
});

const displayedRounds = computed(() => [...rounds.value].reverse());
</script>

<template>
  <div class="changelog" :class="{ collapsed }">
    <!-- Header -->
    <div class="changelog-header" @click="toggleCollapsed">
      <div class="changelog-header-left">
        <span class="changelog-dot">●</span>
        <span class="changelog-title">会话变更</span>
        <span v-if="totalFiles > 0" class="changelog-badge">{{ totalFiles }}</span>
      </div>
      <span class="changelog-arrow" :class="{ open: !collapsed }">▾</span>
    </div>

    <!-- Body -->
    <div v-show="!collapsed" class="changelog-body">
      <template v-if="rounds.length === 0">
        <div class="changelog-empty">暂无变更</div>
      </template>
      <template v-else>
        <div v-for="round in displayedRounds" :key="round.index" class="changelog-round">
          <!-- Round header -->
          <div class="changelog-round-header">
            <span class="changelog-round-label">轮 {{ round.index }}</span>
            <span class="changelog-round-time">{{ round.time }}</span>
            <button class="changelog-round-revert" title="撤回本轮" @click="revertRound(round)">↶</button>
          </div>
          <!-- Files -->
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
  border-top: 1px solid var(--surface);
  background: var(--bg-secondary);
  overflow: hidden;
}

/* ── Header ── */

.changelog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 12px;
  min-height: 28px;
  cursor: pointer;
  user-select: none;
  background: var(--bg-tertiary);
  flex-shrink: 0;
}
.changelog-header:hover {
  background: var(--surface);
}

.changelog-header-left {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--text-secondary);
}

.changelog-dot {
  font-size: 8px;
  color: var(--accent);
}

.changelog-badge {
  background: var(--surface);
  color: var(--text-muted);
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  min-width: 16px;
  text-align: center;
  line-height: 1.4;
}

.changelog-arrow {
  font-size: 14px;
  color: var(--text-muted);
  transition: transform 0.15s;
}
.changelog-arrow.open {
  transform: rotate(180deg);
}

/* ── Body ── */

.changelog-body {
  flex: 1;
  overflow-y: auto;
}

.changelog-empty {
  padding: 24px 16px;
  font-size: 11px;
  color: var(--text-muted);
  text-align: center;
}

/* ── Round groups ── */

.changelog-round {
  border-bottom: 1px solid var(--surface);
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
  color: var(--text-muted);
  background: var(--bg-secondary);
  border-bottom: 1px solid rgba(49, 50, 68, 0.6);
}

.changelog-round-label {
  font-weight: 600;
  color: var(--accent);
}

.changelog-round-time {
  flex: 1;
  color: var(--text-muted);
}

.changelog-round-revert {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 1px 4px;
  border-radius: 2px;
  transition: color 0.1s, background 0.1s;
  font-family: inherit;
}
.changelog-round-revert:hover {
  color: var(--accent-red);
  background: rgba(243, 139, 168, 0.12);
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
  background: var(--surface);
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
  background: rgba(249, 226, 175, 0.15);
  color: #f9e2af;
}
.status-A {
  background: rgba(166, 227, 161, 0.15);
  color: #a6e3a1;
}

.changelog-file-path {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
  font-size: 12px;
}

.changelog-file-stats {
  flex-shrink: 0;
  font-size: 11px;
  font-family: "Cascadia Code", "Fira Code", "Consolas", monospace;
}

.stat-add { color: var(--accent-green); }
.stat-del { color: var(--accent-red); }

.changelog-file-revert {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--text-muted);
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
  color: var(--accent-red);
  background: rgba(243, 139, 168, 0.12);
}

/* ── Scrollbar ── */

.changelog-body::-webkit-scrollbar {
  width: 4px;
}
.changelog-body::-webkit-scrollbar-track {
  background: transparent;
}
.changelog-body::-webkit-scrollbar-thumb {
  background: var(--surface-hover);
  border-radius: 2px;
}
</style>
