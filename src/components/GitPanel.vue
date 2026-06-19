<script setup lang="ts">
import { ref, onMounted, watch } from "vue";
import { useGit } from "../composables/useGit";

const {
  commits,
  branches,
  currentBranch,
  unstagedFiles,
  stagedFiles,
  loading,
  expandedCommit,
  commitDetail,
  detailLoading,
  viewingDiff,
  loadAll,
  toggleCommit,
  viewDiff,
  closeDiff,
  switchBranch,
  doStageFile,
  doUnstageFile,
  doStageAll,
  doCommit,
  doRevertFile,
} = useGit();

const branchDropdownOpen = ref(false);
const changesExpanded = ref(true);
const commitsExpanded = ref(true);
const commitMessage = ref("");
const committing = ref(false);
const commitError = ref("");

function diffLines(content: string): { type: string; text: string }[] {
  return content.split("\n").map((line) => {
    if (line.startsWith("+") && !line.startsWith("+++")) return { type: "add", text: line };
    if (line.startsWith("-") && !line.startsWith("---")) return { type: "del", text: line };
    if (line.startsWith("@@")) return { type: "hunk", text: line };
    if (line.startsWith("diff ") || line.startsWith("index ") ||
        line.startsWith("--- ") || line.startsWith("+++ ") ||
        line.startsWith("new file") || line.startsWith("deleted file"))
      return { type: "meta", text: line };
    return { type: "ctx", text: line };
  });
}

onMounted(() => { loadAll(); });

// 工作区无变更时自动折叠 Changes，有变更时自动展开
watch(
  () => stagedFiles.length + unstagedFiles.length,
  (total) => { changesExpanded.value = total > 0; }
);

function onBranchSelect(name: string) {
  branchDropdownOpen.value = false;
  switchBranch(name);
}

function onToggleBranchDropdown() {
  branchDropdownOpen.value = !branchDropdownOpen.value;
}

function onFileClick(path: string, staged?: boolean, commitHash?: string) {
  viewDiff(path, staged, commitHash);
}

async function onCommit() {
  if (!commitMessage.value.trim()) return;
  committing.value = true;
  commitError.value = "";
  try {
    await doCommit(commitMessage.value.trim());
    commitMessage.value = "";
  } catch (e) {
    commitError.value = typeof e === "string" ? e : (e as Error).message || "提交失败";
  } finally {
    committing.value = false;
  }
}

defineExpose({ reload: loadAll });
</script>

<template>
  <div class="git-panel">
    <!-- Branch bar -->
    <div class="branch-bar">
      <div class="branch-dropdown-wrapper">
        <button class="branch-btn" @click="onToggleBranchDropdown">
          <span class="branch-icon">⎇</span>
          <span class="branch-name">{{ currentBranch || "unknown" }}</span>
          <span class="branch-arrow">▾</span>
        </button>
        <div v-if="branchDropdownOpen" class="branch-dropdown" @mouseleave="branchDropdownOpen = false">
          <button v-for="b in branches" :key="b.name" class="branch-dropdown-item" :class="{ current: b.is_current }" @click="onBranchSelect(b.name)">
            <span class="branch-item-name">{{ b.name }}</span>
            <span v-if="b.is_current" class="branch-item-check">✓</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Staged -->
    <div v-if="stagedFiles.length > 0" class="git-section">
      <button class="section-header section-header-staged" @click="changesExpanded = !changesExpanded">
        <span class="section-arrow" :class="{ open: changesExpanded }">▸</span>
        <span class="section-title">Staged</span>
        <span class="section-badge staged-badge">{{ stagedFiles.length }}</span>
      </button>
      <div v-show="changesExpanded" class="section-body">
        <div v-for="entry in stagedFiles" :key="entry.path" class="git-file-row staged-row" @click="onFileClick(entry.path, true)">
          <span class="git-file-status staged-status" :class="'status-' + entry.status">{{ entry.status }}</span>
          <span class="git-file-path staged-path" :title="entry.path">{{ entry.path }}</span>
          <button class="git-file-unstage" title="Unstage" @click.stop="doUnstageFile(entry.path)">−</button>
        </div>
      </div>
    </div>

    <!-- Commit bar -->
    <div v-if="stagedFiles.length > 0" class="commit-bar">
      <input v-model="commitMessage" class="commit-input" placeholder="Commit message..." @keydown.enter="onCommit" />
      <button class="commit-btn" :disabled="!commitMessage.trim() || committing" @click="onCommit">
        {{ committing ? "Committing..." : "Commit" }}
      </button>
    </div>
    <div v-if="commitError" class="commit-error">{{ commitError }}</div>

    <!-- Unstaged -->
    <div class="git-section">
      <button class="section-header section-header-unstaged" @click="changesExpanded = !changesExpanded">
        <span class="section-arrow" :class="{ open: changesExpanded }">▸</span>
        <span class="section-title">Changes</span>
        <span v-if="unstagedFiles.length > 0" class="section-badge unstaged-badge">{{ unstagedFiles.length }}</span>
        <span v-if="unstagedFiles.length > 0" class="section-header-action" title="暂存全部" @click.stop="doStageAll()">Stage All</span>
      </button>
      <div v-show="changesExpanded" class="section-body">
        <div v-if="unstagedFiles.length === 0 && stagedFiles.length === 0" class="section-empty">Working tree clean</div>
        <div v-else-if="unstagedFiles.length === 0" class="section-empty">All changes staged</div>
        <div v-for="entry in unstagedFiles" :key="entry.path" class="git-file-row unstaged-row" @click="onFileClick(entry.path, false)">
          <button class="git-file-stage" title="Stage" @click.stop="doStageFile(entry.path)">+</button>
          <span class="git-file-status unstaged-status" :class="'status-' + (entry.status === '?' ? 'A' : entry.status)">{{ entry.status === '?' ? '?' : entry.status }}</span>
          <span class="git-file-path unstaged-path" :title="entry.path">{{ entry.path }}</span>
          <button class="git-file-revert" title="Revert" @click.stop="doRevertFile(entry.path)">↶</button>
        </div>
      </div>
    </div>

    <!-- Commits -->
    <div class="git-section commits-section">
      <button class="section-header section-header-commits" @click="commitsExpanded = !commitsExpanded">
        <span class="section-arrow" :class="{ open: commitsExpanded }">▸</span>
        <span class="section-title">Commits</span>
        <span v-if="commits.length > 0" class="section-badge commits-badge">{{ commits.length }}</span>
      </button>
      <div v-show="commitsExpanded" class="section-body">
        <div v-if="loading" class="section-empty">Loading...</div>
        <div v-else-if="commits.length === 0" class="section-empty">No commits yet</div>
        <template v-else>
          <div v-for="commit in commits" :key="commit.hash" class="commit-item" :class="{ expanded: expandedCommit === commit.hash }">
            <div class="commit-header" @click="toggleCommit(commit.hash)">
              <span class="commit-dot">●</span>
              <div class="commit-info">
                <span class="commit-message">{{ commit.message }}</span>
                <span class="commit-meta">{{ commit.author }} · {{ commit.date }}</span>
              </div>
            </div>
            <div v-if="expandedCommit === commit.hash" class="commit-detail">
              <div v-if="detailLoading" class="detail-loading">Loading...</div>
              <template v-else-if="commitDetail">
                <div v-if="commitDetail.body" class="commit-body">{{ commitDetail.body }}</div>
                <div v-for="f in commitDetail.files" :key="f.path" class="git-file-row" @click="onFileClick(f.path, undefined, commitDetail.hash)">
                  <span class="git-file-status" :class="'status-' + (f.status === 'R' ? 'M' : f.status)">{{ f.status }}</span>
                  <span class="git-file-path" :title="f.path">{{ f.path }}</span>
                  <span class="git-file-stats">
                    <span v-if="f.additions > 0" class="stat-add">+{{ f.additions }}</span>
                    <span v-if="f.additions > 0 && f.deletions > 0" class="stat-sep"> </span>
                    <span v-if="f.deletions > 0" class="stat-del">-{{ f.deletions }}</span>
                  </span>
                </div>
              </template>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- Diff viewer -->
    <div v-if="viewingDiff" class="diff-viewer">
      <div class="diff-header">
        <span class="diff-title">{{ viewingDiff.path }}</span>
        <button class="diff-close" @click="closeDiff">✕</button>
      </div>
      <div class="diff-body">
        <div v-if="viewingDiff.loading" class="diff-loading">Loading diff...</div>
        <pre v-else class="diff-content"><code><template v-for="(line, i) in diffLines(viewingDiff.content)" :key="i"><span :class="'diff-' + line.type">{{ line.text }}</span>
</template></code></pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.git-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-secondary);
  overflow: hidden;
}

.branch-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid var(--surface);
  flex-shrink: 0;
}

.branch-dropdown-wrapper { position: relative; }

.branch-btn {
  display: flex; align-items: center; gap: 5px;
  background: var(--bg-tertiary); border: 1px solid var(--surface-hover);
  border-radius: 5px; padding: 4px 10px; cursor: pointer;
  font-size: 12px; color: var(--text-primary); font-family: inherit; transition: background 0.12s;
}
.branch-btn:hover { background: var(--surface); }
.branch-icon { font-size: 14px; color: var(--accent); }
.branch-name { font-weight: 500; }
.branch-arrow { font-size: 14px; color: var(--text-muted); }

.branch-dropdown {
  position: absolute; top: 100%; left: 0; margin-top: 3px;
  min-width: 200px; max-height: 240px; overflow-y: auto;
  background: var(--bg-tertiary); border: 1px solid var(--surface-hover);
  border-radius: 6px; box-shadow: 0 6px 20px rgba(0,0,0,0.4); z-index: 50; padding: 4px;
}

.branch-dropdown-item {
  display: flex; align-items: center; justify-content: space-between;
  width: 100%; padding: 5px 8px; border: none; background: transparent;
  color: var(--text-secondary); cursor: pointer; font-size: 12px;
  font-family: inherit; border-radius: 4px; transition: background 0.1s; text-align: left;
}
.branch-dropdown-item:hover { background: var(--surface); color: var(--text-primary); }
.branch-dropdown-item.current { color: var(--accent); }
.branch-item-check { font-size: 10px; }

.git-section { border-bottom: 1px solid var(--surface); flex-shrink: 0; }
.commits-section { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.commits-section .section-body { flex: 1; overflow-y: auto; }

.section-header {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 6px 10px; border: none; background: var(--bg-tertiary);
  color: var(--text-secondary); cursor: pointer; font-size: 11px;
  font-family: inherit; text-transform: uppercase; letter-spacing: 0.4px;
  transition: background 0.12s; flex-shrink: 0;
}
.section-header:hover { background: var(--surface); color: var(--text-primary); }

.section-header-action {
  margin-left: auto; font-size: 10px; font-weight: 500; color: var(--text-muted);
  text-transform: none; letter-spacing: 0; padding: 2px 6px; border-radius: 3px; transition: all 0.12s;
}
.section-header-action:hover { color: #a6e3a1; background: rgba(166,227,161,0.12); }

.section-arrow { font-size: 14px; transition: transform 0.15s; width: 16px; text-align: center; }
.section-arrow.open { transform: rotate(90deg); }

.section-header-staged .section-title { color: #a6e3a1; }
.section-header-unstaged .section-title { color: #f9e2af; }
.section-header-commits .section-title { color: var(--accent); }

.staged-badge { background: rgba(166,227,161,0.18); color: #a6e3a1; }
.unstaged-badge { background: rgba(249,226,175,0.15); color: #f9e2af; }
.commits-badge { background: rgba(137,180,250,0.15); color: var(--accent); }
.section-badge { background: var(--surface); color: var(--text-muted); font-size: 10px; padding: 1px 6px; border-radius: 8px; }

.staged-row:hover { background: rgba(166,227,161,0.06); }
.staged-path { color: var(--text-primary); }
.unstaged-row:hover { background: var(--surface); }
.unstaged-path { color: var(--text-secondary); }

.staged-status.status-M { background: rgba(249,226,175,0.22); color: #f9e2af; }
.staged-status.status-A { background: rgba(166,227,161,0.22); color: #a6e3a1; }
.staged-status.status-D { background: rgba(243,139,168,0.22); color: #f38ba8; }
.unstaged-status.status-M { background: rgba(249,226,175,0.08); color: #c4a46c; }
.unstaged-status.status-A { background: rgba(166,227,161,0.08); color: #6b9a67; }
.unstaged-status.status-D { background: rgba(243,139,168,0.08); color: #b8697a; }

.section-empty { padding: 20px 16px; font-size: 11px; color: var(--text-muted); text-align: center; }

.commit-bar { display: flex; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--surface); }
.commit-input { flex: 1; background: var(--bg-primary); border: 1px solid var(--surface-hover); border-radius: 4px; padding: 5px 8px; font-size: 12px; color: var(--text-primary); outline: none; font-family: inherit; }
.commit-input:focus { border-color: var(--accent); }
.commit-btn { background: #a6e3a1; border: none; color: #1e1e2e; padding: 5px 12px; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: 600; font-family: inherit; }
.commit-btn:hover:not(:disabled) { filter: brightness(1.15); }
.commit-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.commit-error { padding: 6px 10px; font-size: 11px; color: var(--accent-red); background: rgba(243,139,168,0.08); }

.git-file-row { display: flex; align-items: center; gap: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; transition: background 0.1s; }
.git-file-row:hover { background: var(--surface); }

.git-file-status { flex-shrink: 0; width: 16px; height: 16px; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; border-radius: 3px; }
.status-M { background: rgba(249,226,175,0.15); color: #f9e2af; }
.status-A { background: rgba(166,227,161,0.15); color: #a6e3a1; }
.status-D { background: rgba(243,139,168,0.15); color: #f38ba8; }

.git-file-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
.git-file-stats { flex-shrink: 0; font-size: 11px; font-family: "Cascadia Code","Fira Code",Consolas,monospace; }
.stat-add { color: var(--accent-green); } .stat-del { color: var(--accent-red); } .stat-sep { color: var(--text-muted); }

.git-file-stage { flex-shrink: 0; background: none; border: none; color: var(--accent-green); cursor: pointer; font-size: 14px; font-weight: 700; padding: 1px 5px; border-radius: 3px; font-family: inherit; }
.git-file-stage:hover { background: rgba(166,227,161,0.15); }
.git-file-unstage { flex-shrink: 0; background: none; border: none; color: var(--accent-red); cursor: pointer; font-size: 14px; font-weight: 700; padding: 1px 5px; border-radius: 3px; font-family: inherit; opacity: 0; }
.git-file-row:hover .git-file-unstage { opacity: 1; }
.git-file-unstage:hover { background: rgba(243,139,168,0.15); }
.git-file-revert { flex-shrink: 0; background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 12px; padding: 1px 4px; border-radius: 2px; opacity: 0; transition: opacity 0.1s, color 0.1s, background 0.1s; font-family: inherit; }
.git-file-row:hover .git-file-revert { opacity: 1; }
.git-file-revert:hover { color: var(--accent-red); background: rgba(243,139,168,0.12); }

.commit-item { border-bottom: 1px solid var(--surface); }
.commit-item:last-child { border-bottom: none; }
.commit-header { display: flex; align-items: flex-start; gap: 8px; padding: 6px 10px; cursor: pointer; transition: background 0.1s; }
.commit-header:hover { background: var(--surface); }
.commit-dot { font-size: 12px; color: var(--accent); margin-top: 1px; flex-shrink: 0; }
.commit-info { flex: 1; min-width: 0; }
.commit-message { display: block; font-size: 12px; color: var(--text-primary); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.commit-meta { display: block; font-size: 10px; color: var(--text-muted); margin-top: 1px; }
.commit-detail { padding: 4px 10px 8px 28px; }
.detail-loading { font-size: 11px; color: var(--text-muted); padding: 4px 0; }
.commit-body { font-size: 11px; color: var(--text-secondary); white-space: pre-wrap; margin-bottom: 6px; padding: 4px 0; border-bottom: 1px solid var(--surface); }

.diff-viewer { border-top: 1px solid var(--surface-hover); flex-shrink: 0; max-height: 45%; display: flex; flex-direction: column; }
.diff-header { display: flex; align-items: center; justify-content: space-between; padding: 5px 10px; background: var(--bg-tertiary); border-bottom: 1px solid var(--surface); flex-shrink: 0; }
.diff-title { font-size: 11px; color: var(--text-secondary); font-family: "Cascadia Code","Fira Code",Consolas,monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diff-close { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 12px; padding: 2px 6px; border-radius: 3px; font-family: inherit; }
.diff-close:hover { background: var(--surface); color: var(--text-primary); }
.diff-body { flex: 1; overflow: auto; background: var(--bg-primary); }
.diff-loading { padding: 16px; font-size: 11px; color: var(--text-muted); text-align: center; }
.diff-content { margin: 0; padding: 8px 0; font-size: 11px; font-family: "Cascadia Code","Fira Code",Consolas,monospace; line-height: 1.45; tab-size: 4; white-space: pre; }
.diff-content code { display: block; }
.diff-add { background: rgba(166,227,161,0.08); color: #a6e3a1; }
.diff-del { background: rgba(243,139,168,0.08); color: #f38ba8; }
.diff-hunk { color: var(--accent); }
.diff-meta { color: #f9e2af; }
.diff-ctx { color: var(--text-muted); }

.section-body::-webkit-scrollbar, .diff-body::-webkit-scrollbar,
.commit-detail::-webkit-scrollbar, .branch-dropdown::-webkit-scrollbar { width: 4px; }
.section-body::-webkit-scrollbar-track, .diff-body::-webkit-scrollbar-track,
.commit-detail::-webkit-scrollbar-track, .branch-dropdown::-webkit-scrollbar-track { background: transparent; }
.section-body::-webkit-scrollbar-thumb, .diff-body::-webkit-scrollbar-thumb,
.commit-detail::-webkit-scrollbar-thumb, .branch-dropdown::-webkit-scrollbar-thumb { background: var(--surface-hover); border-radius: 2px; }
</style>
