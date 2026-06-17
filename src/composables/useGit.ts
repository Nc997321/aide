import { ref, computed } from "vue";
import type { CommitEntry, CommitDetail, BranchInfo, GitStatusEntry } from "../types";
import { gitApi } from "../api/git";

// ── Module-level reactive state ──

const commits = ref<CommitEntry[]>([]);
const branches = ref<BranchInfo[]>([]);
const currentBranch = ref("");
const statusEntries = ref<GitStatusEntry[]>([]);
const loading = ref(false);
const expandedCommit = ref<string | null>(null);
const commitDetail = ref<CommitDetail | null>(null);
const detailLoading = ref(false);

// Currently viewed diff
const viewingDiff = ref<{ path: string; content: string; loading: boolean } | null>(null);

// ── Computed ──

const unstagedFiles = computed(() =>
    statusEntries.value.filter((e) => !e.staged)
);

const stagedFiles = computed(() =>
    statusEntries.value.filter((e) => e.staged)
);

const hasChanges = computed(() => statusEntries.value.length > 0);

// ── Actions ──

async function loadBranches() {
    try {
        branches.value = await gitApi.branches();
        const cur = branches.value.find((b) => b.is_current);
        currentBranch.value = cur?.name ?? "";
    } catch (_) { /* best effort */ }
}

async function loadCommits() {
    loading.value = true;
    try {
        commits.value = await gitApi.log(50, currentBranch.value || undefined);
    } catch (_) {
        commits.value = [];
    } finally {
        loading.value = false;
    }
}

async function loadStatus() {
    try {
        const s = await gitApi.status();
        statusEntries.value = s.entries;
    } catch (_) {
        statusEntries.value = [];
    }
}

async function loadAll() {
    await Promise.all([loadBranches(), loadCommits(), loadStatus()]);
}

async function refreshAfterAction() {
    await Promise.all([loadCommits(), loadStatus()]);
}

async function toggleCommit(hash: string) {
    if (expandedCommit.value === hash) {
        expandedCommit.value = null;
        commitDetail.value = null;
        return;
    }
    expandedCommit.value = hash;
    detailLoading.value = true;
    try {
        commitDetail.value = await gitApi.show(hash);
    } catch (_) {
        commitDetail.value = null;
    } finally {
        detailLoading.value = false;
    }
}

async function viewDiff(path: string, staged?: boolean, commitHash?: string) {
    viewingDiff.value = { path, content: "", loading: true };
    try {
        const content = await gitApi.diffContent(path, staged, commitHash);
        viewingDiff.value = { path, content, loading: false };
    } catch (e) {
        viewingDiff.value = {
            path,
            content: `Failed to load diff: ${e}`,
            loading: false,
        };
    }
}

function closeDiff() {
    viewingDiff.value = null;
}

async function switchBranch(branch: string) {
    await gitApi.checkout(branch);
    await loadAll();
}

async function doStageFile(path: string) {
    await gitApi.stageFile(path);
    await loadStatus();
}

async function doUnstageFile(path: string) {
    await gitApi.unstageFile(path);
    await loadStatus();
}

async function doStageAll() {
    await gitApi.stageAll();
    await loadStatus();
}

async function doCommit(message: string): Promise<string> {
    const hash = await gitApi.commit(message);
    await refreshAfterAction();
    return hash;
}

async function doRevertFile(path: string) {
    await gitApi.revertFile(path);
    await loadStatus();
}

// ── Export ──

export function useGit() {
    return {
        // State
        commits,
        branches,
        currentBranch,
        statusEntries,
        unstagedFiles,
        stagedFiles,
        hasChanges,
        loading,
        expandedCommit,
        commitDetail,
        detailLoading,
        viewingDiff,
        // Actions
        loadAll,
        loadCommits,
        loadStatus,
        loadBranches,
        refreshAfterAction,
        toggleCommit,
        viewDiff,
        closeDiff,
        switchBranch,
        doStageFile,
        doUnstageFile,
        doStageAll,
        doCommit,
        doRevertFile,
    };
}
