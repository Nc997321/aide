import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { CommitEntry, CommitDetail, BranchInfo, GitStatusEntry } from "../types";

// ── Module-level reactive state ──

const commits = ref<CommitEntry[]>([]);
const branches = ref<BranchInfo[]>([]);
const currentBranch = ref("");
const statusEntries = ref<GitStatusEntry[]>([]);
const loading = ref(false);
const expandedCommit = ref<string | null>(null);
const commitDetail = ref<CommitDetail | null>(null);
const detailLoading = ref(false);
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
        branches.value = await invoke<BranchInfo[]>("git_branches");
        const cur = branches.value.find((b) => b.is_current);
        currentBranch.value = cur?.name ?? "";
    } catch (e) {
        console.error("[useGit] loadBranches failed:", e);
    }
}

async function loadCommits() {
    loading.value = true;
    try {
        commits.value = await invoke<CommitEntry[]>("git_log", { limit: 50, branch: currentBranch.value || null });
    } catch (e) {
        console.error("[useGit] loadCommits failed:", e);
        commits.value = [];
    } finally {
        loading.value = false;
    }
}

async function loadStatus() {
    try {
        const s = await invoke<{ entries: GitStatusEntry[] }>("git_status");
        statusEntries.value = s.entries;
    } catch (e) {
        console.error("[useGit] loadStatus failed:", e);
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
        commitDetail.value = await invoke<CommitDetail>("git_show", { hash });
    } catch (_) {
        commitDetail.value = null;
    } finally {
        detailLoading.value = false;
    }
}

async function viewDiff(path: string, staged?: boolean, commitHash?: string) {
    viewingDiff.value = { path, content: "", loading: true };
    try {
        const content = await invoke<string>("git_diff_content", { path, staged, commitHash });
        viewingDiff.value = { path, content, loading: false };
    } catch (e) {
        viewingDiff.value = { path, content: `Failed to load diff: ${e}`, loading: false };
    }
}

function closeDiff() {
    viewingDiff.value = null;
}

async function switchBranch(branch: string) {
    try { await invoke("git_checkout", { branch }); } catch (e) { console.error("[useGit] switchBranch:", e); }
    await loadAll();
}

async function doStageFile(path: string) {
    try { await invoke("git_stage_file", { path }); } catch (e) { console.error("[useGit] stageFile:", e); }
    await loadStatus();
}

async function doUnstageFile(path: string) {
    try { await invoke("git_unstage_file", { path }); } catch (e) { console.error("[useGit] unstageFile:", e); }
    await loadStatus();
}

async function doStageAll() {
    try { await invoke("git_stage_all"); } catch (e) { console.error("[useGit] stageAll:", e); }
    await loadStatus();
}

async function doCommit(message: string): Promise<string> {
    const hash = await invoke<string>("git_commit", { message });
    await refreshAfterAction();
    return hash;
}

async function doRevertFile(path: string) {
    try { await invoke("git_revert_file", { path }); } catch (e) { console.error("[useGit] revertFile:", e); }
    await loadStatus();
}

// ── Export ──

export function useGit() {
    return {
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
