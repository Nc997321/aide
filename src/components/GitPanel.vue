<script setup lang="ts">
import { ref, onMounted, watch, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useGit } from "../composables/useGit";
import { useFileViewer } from "../composables/useFileViewer";
import { useModal } from "../composables/useModal";
import { parseGitError } from "../utils/errors";

const {
  commits,
  branches,
  currentBranch,
  unstagedFiles,
  stagedFiles,
  unpushedHashes,
  hasUnpushed,
  unpushedCount,
  projectRoot,
  loading,
  expandedCommit,
  commitDetail,
  detailLoading,
  loadAll,
  toggleCommit,
  switchBranch,
  createBranch,
  deleteBranch,
  doStageFile,
  doUnstageFile,
  doStageAll,
  doUnstageAll,
  doCommit,
  doRevertFile,
  doPush,
  doForcePush,
  doPull,
  pushing,
  pushError,
  pulling,
  pullError,
  clearPushError,
  clearPullError,
} = useGit();

const fileViewer = useFileViewer();
const { confirm: confirmDialog, prompt: promptDialog } = useModal();

const branchDropdownOpen = ref(false);
const switchError = ref("");
const pendingBranch = ref("");
const branchError = ref("");
const deleteError = ref("");
const pendingDeleteBranch = ref("");
const stashPopWarning = ref("");
const changesExpanded = ref(true);
const commitsExpanded = ref(true);
const commitMessage = ref("");
const committing = ref(false);
const commitError = ref("");

onMounted(() => { loadAll(); });

// 工作区无变更时自动折叠 Changes，有变更时自动展开
watch(
  () => stagedFiles.value.length + unstagedFiles.value.length,
  (total) => { changesExpanded.value = total > 0; }
);

function onBranchSelect(name: string) {
  branchDropdownOpen.value = false;
  switchError.value = "";
  pendingBranch.value = name;
  switchBranch(name).catch((e) => {
    switchError.value = typeof e === "string" ? e : (e as Error).message || "切换分支失败";
  });
}

const parsedSwitchError = computed(() => {
  return switchError.value ? parseGitError(switchError.value) : null;
});

function onToggleBranchDropdown() {
  branchDropdownOpen.value = !branchDropdownOpen.value;
}

const BRANCH_NAME_RE = /^[a-zA-Z0-9._\-/]+$/;
const BRANCH_INVALID_CHARS = /[~^:?*\[@{\s]/;

async function onCreateBranch() {
  branchDropdownOpen.value = false;
  branchError.value = "";
  const name = await promptDialog("新建分支", "例如: feature/my-branch", "创建");
  if (!name) return;
  if (!BRANCH_NAME_RE.test(name) || BRANCH_INVALID_CHARS.test(name) || name.startsWith(".") || name.endsWith("/") || name.endsWith(".")) {
    branchError.value = "INVALID_NAME: 分支名只能包含字母、数字、. _ - /，且不能以 . 开头或以 / . 结尾";
    return;
  }
  try {
    await createBranch(name);
  } catch (e) {
    branchError.value = typeof e === "string" ? e : (e as Error).message || "创建分支失败";
  }
}

const parsedBranchError = computed(() => {
  return branchError.value ? parseGitError(branchError.value) : null;
});

const parsedDeleteError = computed(() => {
  return deleteError.value ? parseGitError(deleteError.value) : null;
});

async function onDeleteBranch(name: string, event: MouseEvent) {
  event.stopPropagation();
  deleteError.value = "";
  const ok = await confirmDialog(
    "删除分支",
    `确定要删除分支 '${name}' 吗？未合并的改动将丢失。`,
    "删除",
    true,
  );
  if (!ok) return;
  try {
    await deleteBranch(name);
  } catch (e) {
    pendingDeleteBranch.value = name;
    deleteError.value = typeof e === "string" ? e : (e as Error).message || "删除分支失败";
  }
}

function onFileClick(path: string, staged?: boolean, commitHash?: string) {
  // 工作区变更 → staged 是 boolean；历史提交 → commitHash 是 string
  openDiffInViewer(path, staged, commitHash);
}

async function openDiffInViewer(relPath: string, staged?: boolean, commitHash?: string) {
  try {
    const params: Record<string, unknown> = { path: relPath };
    if (staged !== undefined) params.staged = staged;
    if (commitHash) params.commitHash = commitHash;
    const content = await invoke<string>("git_diff_content", params);
    fileViewer.open(relPath, { content, language: "diff" });
  } catch (e) {
    fileViewer.open(relPath, { content: `Failed to load diff: ${e}`, language: "diff" });
  }
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

const parsedPushError = computed(() => {
  return pushError.value ? parseGitError(pushError.value) : null;
});

const parsedPullError = computed(() => {
  return pullError.value ? parseGitError(pullError.value) : null;
});

async function onPush() {
  clearPushError();
  try {
    await doPush();
  } catch (_) {
    // error stored in pushError ref by doPush
  }
}

async function onPull() {
  clearPullError();
  try {
    await doPull();
  } catch (_) {
    // error stored in pullError ref by doPull
  }
}

async function onErrorAction(kind: string) {
  if (kind === "force-push") {
    clearPushError();
    try {
      await doForcePush();
    } catch (_) {}
  } else if (kind === "pull-first") {
    clearPushError();
    // User should pull from terminal
  } else if (kind === "retry") {
    if (pendingBranch.value) {
      // Retry branch switch
      switchError.value = "";
      try {
        await switchBranch(pendingBranch.value);
      } catch (e) {
        switchError.value = typeof e === "string" ? e : (e as Error).message || "切换分支失败";
      }
    } else if (pullError.value) {
      await onPull();
    } else if (branchError.value) {
      branchError.value = "";
      await onCreateBranch();
    } else {
      await onPush();
    }
  } else if (kind === "stash-and-switch" && pendingBranch.value) {
    switchError.value = "";
    stashPopWarning.value = "";
    try {
      await invoke("git_stash");
      await switchBranch(pendingBranch.value);
      try {
        await invoke("git_stash_pop");
      } catch (popErr) {
        const msg = typeof popErr === "string" ? popErr : (popErr as Error).message || "";
        stashPopWarning.value = msg.includes("CONFLICT") || msg.includes("conflict")
          ? "改动已保存到 stash,但恢复时出现冲突。请在终端用 `git stash pop` 手动处理。"
          : "改动已保存到 stash,但恢复失败。可在终端用 `git stash list` 查看,或 `git stash pop` 手动恢复。";
      }
    } catch (e) {
      switchError.value = typeof e === "string" ? e : (e as Error).message || "Stash 并切换失败";
    }
    pendingBranch.value = "";
  } else if (kind === "discard-and-switch" && pendingBranch.value) {
    const ok = await confirmDialog(
      "丢弃改动并切换",
      `当前分支的未提交改动将被永久丢弃,无法恢复。\n\n确定要切换到 '${pendingBranch.value}' 吗?`,
      "丢弃并切换",
      true,
    );
    if (!ok) return;
    switchError.value = "";
    try {
      await invoke("git_discard_all");
      await switchBranch(pendingBranch.value);
    } catch (e) {
      switchError.value = typeof e === "string" ? e : (e as Error).message || "丢弃并切换失败";
    }
    pendingBranch.value = "";
  } else if (kind === "stash-and-pull") {
    clearPullError();
    stashPopWarning.value = "";
    try {
      await invoke("git_stash");
      await doPull();
      try {
        await invoke("git_stash_pop");
      } catch (popErr) {
        const msg = typeof popErr === "string" ? popErr : (popErr as Error).message || "";
        stashPopWarning.value = msg.includes("CONFLICT") || msg.includes("conflict")
          ? "改动已保存到 stash,但恢复时出现冲突。请在终端用 `git stash pop` 手动处理。"
          : "改动已保存到 stash,但恢复失败。可在终端用 `git stash list` 查看,或 `git stash pop` 手动恢复。";
      }
    } catch (e) {
      pullError.value = typeof e === "string" ? e : (e as Error).message || "Stash 并拉取失败";
    }
  } else if (kind === "force-delete-branch" && pendingDeleteBranch.value) {
    deleteError.value = "";
    try {
      await deleteBranch(pendingDeleteBranch.value, true);
    } catch (e) {
      deleteError.value = typeof e === "string" ? e : (e as Error).message || "强制删除失败";
    }
    pendingDeleteBranch.value = "";
  }
}

function isUnpushed(hash: string): boolean {
  return unpushedHashes.value.has(hash);
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
          <button class="branch-dropdown-item branch-dropdown-create" @click="onCreateBranch">
            <span class="branch-item-name">+ 新建分支...</span>
          </button>
          <button v-for="b in branches" :key="b.name" class="branch-dropdown-item" :class="{ current: b.is_current }" @click="onBranchSelect(b.name)">
            <span class="branch-item-name">{{ b.name }}</span>
            <span v-if="b.is_current" class="branch-item-check">✓</span>
            <button v-else class="branch-delete-btn" title="删除分支" @click.stop="onDeleteBranch(b.name, $event)">🗑</button>
          </button>
        </div>
      </div>
    </div>
    <div v-if="parsedBranchError" class="switch-error">
      <span class="switch-error-text">{{ parsedBranchError.message }}</span>
      <button class="switch-error-close" @click="branchError = ''">✕</button>
    </div>
    <div v-if="parsedDeleteError" class="switch-error">
      <span class="switch-error-text">{{ parsedDeleteError.message }}</span>
      <span class="switch-error-actions">
        <button
          v-for="action in parsedDeleteError.actions"
          :key="action.kind"
          class="switch-error-action-btn"
          @click="onErrorAction(action.kind)"
        >
          {{ action.label }}
        </button>
      </span>
      <button class="switch-error-close" @click="deleteError = ''">✕</button>
    </div>
    <div v-if="parsedSwitchError" class="switch-error">
      <span class="switch-error-text">切换到 <b>{{ pendingBranch }}</b> 失败:{{ parsedSwitchError.message }}</span>
      <span class="switch-error-actions">
        <button
          v-for="action in parsedSwitchError.actions"
          :key="action.kind"
          class="switch-error-action-btn"
          @click="onErrorAction(action.kind)"
        >
          {{ action.label }}
        </button>
      </span>
      <button class="switch-error-close" @click="switchError = ''">✕</button>
    </div>
    <div v-if="stashPopWarning" class="stash-warning">
      <span class="stash-warning-text">{{ stashPopWarning }}</span>
      <button class="stash-warning-close" @click="stashPopWarning = ''">✕</button>
    </div>

    <!-- Staged -->
    <div v-if="stagedFiles.length > 0" class="git-section">
      <button class="section-header section-header-staged" @click="changesExpanded = !changesExpanded">
        <span class="section-arrow" :class="{ open: changesExpanded }">▸</span>
        <span class="section-title">Staged</span>
        <span class="section-badge staged-badge">{{ stagedFiles.length }}</span>
        <span class="section-header-action" title="取消暂存全部" @click.stop="doUnstageAll()">Unstage All</span>
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
        <span v-if="hasUnpushed" class="section-badge push-count-badge">{{ unpushedCount }}</span>
        <span v-if="commits.length > 0" class="section-badge commits-badge">{{ commits.length }}</span>
        <span
          class="section-header-action pull-action"
          :class="{ pulling }"
          @click.stop="onPull"
        >
          {{ pulling ? "Pulling..." : "Pull ↓" }}
        </span>
        <span
          v-if="hasUnpushed"
          class="section-header-action push-action"
          :class="{ pushing }"
          @click.stop="onPush"
        >
          {{ pushing ? "Pushing..." : "Push ↑" }}
        </span>
      </button>
      <div v-if="parsedPullError" class="pull-error">
        <span class="pull-error-text">{{ parsedPullError.message }}</span>
        <span class="pull-error-actions">
          <button
            v-for="action in parsedPullError.actions"
            :key="action.kind"
            class="pull-error-action-btn"
            @click="onErrorAction(action.kind)"
          >
            {{ action.label }}
          </button>
        </span>
        <button class="pull-error-close" @click="clearPullError">✕</button>
      </div>
      <div v-if="parsedPushError" class="push-error">
        <span class="push-error-text">{{ parsedPushError.message }}</span>
        <span class="push-error-actions">
          <button
            v-for="action in parsedPushError.actions"
            :key="action.kind"
            class="push-error-action-btn"
            @click="onErrorAction(action.kind)"
          >
            {{ action.label }}
          </button>
        </span>
        <button class="push-error-close" @click="clearPushError">✕</button>
      </div>
      <div v-show="commitsExpanded" class="section-body">
        <div v-if="loading" class="section-empty">Loading...</div>
        <div v-else-if="commits.length === 0" class="section-empty">No commits yet</div>
        <template v-else>
          <template v-for="(commit, index) in commits" :key="commit.hash">
            <div
              v-if="hasUnpushed && index > 0 && isUnpushed(commits[index - 1].hash) && !isUnpushed(commit.hash)"
              class="unpushed-divider"
            >
              <span class="unpushed-divider-label">已推送 ↓</span>
            </div>
            <div class="commit-item" :class="{ expanded: expandedCommit === commit.hash }">
              <div class="commit-header" @click="toggleCommit(commit.hash)">
                <span class="commit-dot" :class="{ unpushed: isUnpushed(commit.hash) }">●</span>
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
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.git-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--aide-bg-deep);
  overflow: hidden;
}

.branch-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid var(--aide-surface-default);
  flex-shrink: 0;
}

.branch-dropdown-wrapper { position: relative; }

.branch-btn {
  display: flex; align-items: center; gap: 5px;
  background: var(--aide-bg-deep); border: 1px solid var(--aide-surface-hover);
  border-radius: 5px; padding: 4px 10px; cursor: pointer;
  font-size: 12px; color: var(--aide-text-primary); font-family: inherit; transition: background 0.12s;
}
.branch-btn:hover { background: var(--aide-surface-default); }
.branch-icon { font-size: 14px; color: var(--aide-accent); }
.branch-name { font-weight: 500; }
.branch-arrow { font-size: 14px; color: var(--aide-text-muted); }

.branch-dropdown {
  position: absolute; top: 100%; left: 0; margin-top: 3px;
  min-width: 200px; max-height: 240px; overflow-y: auto;
  background: var(--aide-bg-deep); border: 1px solid var(--aide-surface-hover);
  border-radius: 6px; box-shadow: var(--aide-shadow-md); z-index: 50; padding: 4px;
}

.branch-dropdown-item {
  display: flex; align-items: center; justify-content: space-between;
  width: 100%; padding: 5px 8px; border: none; background: transparent;
  color: var(--aide-text-secondary); cursor: pointer; font-size: 12px;
  font-family: inherit; border-radius: 4px; transition: background 0.1s; text-align: left;
}
.branch-dropdown-item:hover { background: var(--aide-surface-default); color: var(--aide-text-primary); }
.branch-dropdown-item.current { color: var(--aide-accent); }
.branch-dropdown-create {
  color: var(--aide-accent); border-bottom: 1px dashed var(--aide-surface-hover);
  margin-bottom: 4px; padding-bottom: 6px; border-radius: 4px 4px 0 0;
}
.branch-dropdown-create:hover { background: color-mix(in srgb, var(--aide-info) 8%, transparent); color: var(--aide-accent); }
.branch-item-check { font-size: 10px; }

.branch-delete-btn {
  display: none; flex-shrink: 0; background: none; border: none; color: var(--aide-text-muted);
  cursor: pointer; font-size: 11px; padding: 1px 4px; border-radius: 3px; font-family: inherit;
  margin-left: auto;
}
.branch-dropdown-item:hover .branch-delete-btn { display: inline-block; }
.branch-delete-btn:hover { background: color-mix(in srgb, var(--aide-danger) 15%, transparent); color: var(--aide-danger); }

.switch-error {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 6px 10px; font-size: 11px; color: var(--aide-danger);
  background: color-mix(in srgb, var(--aide-danger) 8%, transparent); border-bottom: 1px solid var(--aide-surface-default);
}
.switch-error-text { flex: 1; white-space: pre-wrap; word-break: break-all; line-height: 1.4; }
.switch-error-actions { display: flex; gap: 6px; flex-shrink: 0; flex-wrap: wrap; }
.switch-error-action-btn {
  background: color-mix(in srgb, var(--aide-info) 12%, transparent); border: none; color: var(--aide-accent);
  padding: 3px 10px; border-radius: 4px; font-size: 11px; cursor: pointer;
  font-family: inherit; white-space: nowrap; transition: background 0.12s;
}
.switch-error-action-btn:hover { background: color-mix(in srgb, var(--aide-info) 25%, transparent); }
.switch-error-close {
  flex-shrink: 0; background: none; border: none; color: var(--aide-text-muted);
  cursor: pointer; font-size: 11px; padding: 1px 4px; border-radius: 3px; font-family: inherit;
}
.switch-error-close:hover { background: color-mix(in srgb, var(--aide-danger) 15%, transparent); color: var(--aide-danger); }

.stash-warning {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 6px 10px; font-size: 11px; color: var(--aide-warning);
  background: color-mix(in srgb, var(--aide-warning) 8%, transparent); border-bottom: 1px solid var(--aide-surface-default);
}
.stash-warning-text { flex: 1; line-height: 1.4; }
.stash-warning-close {
  flex-shrink: 0; background: none; border: none; color: var(--aide-text-muted);
  cursor: pointer; font-size: 11px; padding: 1px 4px; border-radius: 3px; font-family: inherit;
}
.stash-warning-close:hover { background: color-mix(in srgb, var(--aide-warning) 15%, transparent); color: var(--aide-warning); }

.git-section { border-bottom: 1px solid var(--aide-surface-default); flex-shrink: 0; }
.commits-section { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.commits-section .section-body { flex: 1; overflow-y: auto; }

.section-header {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 6px 10px; border: none; background: var(--aide-bg-deep);
  color: var(--aide-text-secondary); cursor: pointer; font-size: 11px;
  font-family: inherit; text-transform: uppercase; letter-spacing: 0.4px;
  transition: background 0.12s; flex-shrink: 0;
}
.section-header:hover { background: var(--aide-surface-default); color: var(--aide-text-primary); }

.section-header-action {
  margin-left: auto; font-size: 10px; font-weight: 500; color: var(--aide-text-muted);
  text-transform: none; letter-spacing: 0; padding: 2px 6px; border-radius: 3px; transition: all 0.12s;
}
.section-header-action:hover { color: var(--aide-success); background: color-mix(in srgb, var(--aide-success) 12%, transparent); }

.push-action:hover { color: var(--aide-warning); background: color-mix(in srgb, var(--aide-warning) 12%, transparent); }
.push-action.pushing { opacity: 0.5; pointer-events: none; }

.pull-action { }
.pull-action:hover { color: var(--aide-info); background: color-mix(in srgb, var(--aide-info) 12%, transparent); }
.pull-action.pulling { opacity: 0.5; pointer-events: none; }

.pull-error {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 6px 10px; font-size: 11px; color: var(--aide-info);
  background: color-mix(in srgb, var(--aide-info) 8%, transparent); border-bottom: 1px solid var(--aide-surface-default);
}
.pull-error-text { flex: 1; white-space: pre-wrap; word-break: break-all; line-height: 1.4; }
.pull-error-actions { display: flex; gap: 6px; flex-shrink: 0; }
.pull-error-action-btn {
  background: color-mix(in srgb, var(--aide-info) 12%, transparent); border: none; color: var(--aide-accent);
  padding: 3px 10px; border-radius: 4px; font-size: 11px; cursor: pointer;
  font-family: inherit; white-space: nowrap; transition: background 0.12s;
}
.pull-error-action-btn:hover { background: color-mix(in srgb, var(--aide-info) 25%, transparent); }
.pull-error-close {
  flex-shrink: 0; background: none; border: none; color: var(--aide-text-muted);
  cursor: pointer; font-size: 11px; padding: 1px 4px; border-radius: 3px; font-family: inherit;
}
.pull-error-close:hover { background: color-mix(in srgb, var(--aide-info) 15%, transparent); color: var(--aide-info); }

.push-error {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 6px 10px; font-size: 11px; color: var(--aide-danger);
  background: color-mix(in srgb, var(--aide-danger) 8%, transparent); border-bottom: 1px solid var(--aide-surface-default);
}
.push-error-text { flex: 1; white-space: pre-wrap; word-break: break-all; }
.push-error-close {
  flex-shrink: 0; background: none; border: none; color: var(--aide-text-muted);
  cursor: pointer; font-size: 11px; padding: 1px 4px; border-radius: 3px; font-family: inherit;
}
.push-error-close:hover { background: color-mix(in srgb, var(--aide-danger) 15%, transparent); color: var(--aide-danger); }
.push-error-actions { display: flex; gap: 6px; flex-shrink: 0; }
.push-error-action-btn {
  background: color-mix(in srgb, var(--aide-info) 12%, transparent); border: none; color: var(--aide-accent);
  padding: 3px 10px; border-radius: 4px; font-size: 11px; cursor: pointer;
  font-family: inherit; white-space: nowrap; transition: background 0.12s;
}
.push-error-action-btn:hover { background: color-mix(in srgb, var(--aide-info) 25%, transparent); }

.section-arrow { font-size: 14px; transition: transform 0.15s; width: 16px; text-align: center; }
.section-arrow.open { transform: rotate(90deg); }

.section-header-staged .section-title { color: var(--aide-success); }
.section-header-unstaged .section-title { color: var(--aide-warning); }
.section-header-commits .section-title { color: var(--aide-accent); }

.staged-badge { background: color-mix(in srgb, var(--aide-success) 18%, transparent); color: var(--aide-success); }
.unstaged-badge { background: color-mix(in srgb, var(--aide-warning) 15%, transparent); color: var(--aide-warning); }
.commits-badge { background: color-mix(in srgb, var(--aide-info) 15%, transparent); color: var(--aide-accent); }
.section-badge { background: var(--aide-surface-default); color: var(--aide-text-muted); font-size: 10px; padding: 1px 6px; border-radius: 8px; }
.push-count-badge { background: color-mix(in srgb, var(--aide-warning) 15%, transparent); color: var(--aide-warning); }

.staged-row:hover { background: color-mix(in srgb, var(--aide-success) 6%, transparent); }
.staged-path { color: var(--aide-text-primary); }
.unstaged-row:hover { background: var(--aide-surface-default); }
.unstaged-path { color: var(--aide-text-secondary); }

.staged-status.status-M { background: color-mix(in srgb, var(--aide-warning) 22%, transparent); color: var(--aide-warning); }
.staged-status.status-A { background: color-mix(in srgb, var(--aide-success) 22%, transparent); color: var(--aide-success); }
.staged-status.status-D { background: color-mix(in srgb, var(--aide-danger) 22%, transparent); color: var(--aide-danger); }
.unstaged-status.status-M { background: color-mix(in srgb, var(--aide-warning) 8%, transparent); color: color-mix(in srgb, var(--aide-warning) 40%, var(--aide-text-muted)); }
.unstaged-status.status-A { background: color-mix(in srgb, var(--aide-success) 8%, transparent); color: color-mix(in srgb, var(--aide-success) 40%, var(--aide-text-muted)); }
.unstaged-status.status-D { background: color-mix(in srgb, var(--aide-danger) 8%, transparent); color: color-mix(in srgb, var(--aide-danger) 40%, var(--aide-text-muted)); }

.section-empty { padding: 20px 16px; font-size: 11px; color: var(--aide-text-muted); text-align: center; }

.commit-bar { display: flex; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--aide-surface-default); }
.commit-input { flex: 1; background: var(--aide-bg-base); border: 1px solid var(--aide-surface-hover); border-radius: 4px; padding: 5px 8px; font-size: 12px; color: var(--aide-text-primary); outline: none; font-family: inherit; }
.commit-input:focus { border-color: var(--aide-accent); }
.commit-btn { background: var(--aide-success); border: none; color: var(--aide-text-on-accent); padding: 5px 12px; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: 600; font-family: inherit; }
.commit-btn:hover:not(:disabled) { filter: brightness(1.15); }
.commit-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.commit-error { padding: 6px 10px; font-size: 11px; color: var(--aide-danger); background: color-mix(in srgb, var(--aide-danger) 8%, transparent); }

.git-file-row { display: flex; align-items: center; gap: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; transition: background 0.1s; }
.git-file-row:hover { background: var(--aide-surface-default); }

.git-file-status { flex-shrink: 0; width: 16px; height: 16px; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; border-radius: 3px; }
.status-M { background: color-mix(in srgb, var(--aide-warning) 15%, transparent); color: var(--aide-warning); }
.status-A { background: color-mix(in srgb, var(--aide-success) 15%, transparent); color: var(--aide-success); }
.status-D { background: color-mix(in srgb, var(--aide-danger) 15%, transparent); color: var(--aide-danger); }

.git-file-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--aide-text-secondary); }
.git-file-stats { flex-shrink: 0; font-size: 11px; font-family: "Cascadia Code","Fira Code",Consolas,monospace; }
.stat-add { color: var(--aide-success); } .stat-del { color: var(--aide-danger); } .stat-sep { color: var(--aide-text-muted); }

.git-file-stage { flex-shrink: 0; background: none; border: none; color: var(--aide-success); cursor: pointer; font-size: 14px; font-weight: 700; padding: 1px 5px; border-radius: 3px; font-family: inherit; }
.git-file-stage:hover { background: color-mix(in srgb, var(--aide-success) 15%, transparent); }
.git-file-unstage { flex-shrink: 0; background: none; border: none; color: var(--aide-danger); cursor: pointer; font-size: 14px; font-weight: 700; padding: 1px 5px; border-radius: 3px; font-family: inherit; opacity: 0; }
.git-file-row:hover .git-file-unstage { opacity: 1; }
.git-file-unstage:hover { background: color-mix(in srgb, var(--aide-danger) 15%, transparent); }
.git-file-revert { flex-shrink: 0; background: none; border: none; color: var(--aide-text-muted); cursor: pointer; font-size: 12px; padding: 1px 4px; border-radius: 2px; opacity: 0; transition: opacity 0.1s, color 0.1s, background 0.1s; font-family: inherit; }
.git-file-row:hover .git-file-revert { opacity: 1; }
.git-file-revert:hover { color: var(--aide-danger); background: color-mix(in srgb, var(--aide-danger) 12%, transparent); }

.commit-item { border-bottom: 1px solid var(--aide-surface-default); }
.commit-item:last-child { border-bottom: none; }
.commit-header { display: flex; align-items: flex-start; gap: 8px; padding: 6px 10px; cursor: pointer; transition: background 0.1s; }
.commit-header:hover { background: var(--aide-surface-default); }
.commit-dot { font-size: 12px; color: var(--aide-accent); margin-top: 1px; flex-shrink: 0; }
.commit-dot.unpushed { color: var(--aide-warning); }

.unpushed-divider {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 10px; font-size: 10px; color: var(--aide-text-muted);
  text-transform: uppercase; letter-spacing: 0.3px;
}
.unpushed-divider::before,
.unpushed-divider::after {
  content: ""; flex: 1; height: 1px;
  background: var(--aide-surface-hover);
}
.commit-info { flex: 1; min-width: 0; }
.commit-message { display: block; font-size: 12px; color: var(--aide-text-primary); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.commit-meta { display: block; font-size: 10px; color: var(--aide-text-muted); margin-top: 1px; }
.commit-detail { padding: 4px 10px 8px 28px; }
.detail-loading { font-size: 11px; color: var(--aide-text-muted); padding: 4px 0; }
.commit-body { font-size: 11px; color: var(--aide-text-secondary); white-space: pre-wrap; margin-bottom: 6px; padding: 4px 0; border-bottom: 1px solid var(--aide-surface-default); }

.section-body::-webkit-scrollbar,
.commit-detail::-webkit-scrollbar, .branch-dropdown::-webkit-scrollbar { width: 4px; }
.section-body::-webkit-scrollbar-track,
.commit-detail::-webkit-scrollbar-track, .branch-dropdown::-webkit-scrollbar-track { background: transparent; }
.section-body::-webkit-scrollbar-thumb,
.commit-detail::-webkit-scrollbar-thumb, .branch-dropdown::-webkit-scrollbar-thumb { background: var(--aide-surface-hover); border-radius: 2px; }
</style>
