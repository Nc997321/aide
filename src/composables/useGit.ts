import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { CommitEntry, CommitDetail, BranchInfo, GitStatusEntry, StashEntry, AheadBehind, FetchPullOutcome, TagEntry, CompareResult } from "../types";

// ── Module-level reactive state ──

const commits = ref<CommitEntry[]>([]);
const branches = ref<BranchInfo[]>([]);
const currentBranch = ref("");
const detachedAt = ref(""); // 非空 = detached HEAD（短 hash 或 tag）
const statusEntries = ref<GitStatusEntry[]>([]);
const unpushedHashes = ref<Set<string>>(new Set());
const projectRoot = ref("");
const loading = ref(false);
const hasMoreCommits = ref(false);
const loadingMore = ref(false);
const expandedCommit = ref<string | null>(null);
const commitDetail = ref<CommitDetail | null>(null);
const detailLoading = ref(false);
const pushing = ref(false);
const pushError = ref("");
const pulling = ref(false);
const pullError = ref("");
const fetching = ref(false);
const fetchError = ref("");
const stashes = ref<StashEntry[]>([]);
const aheadBehind = ref<AheadBehind>({ ahead: 0, behind: 0, hasUpstream: false });

// ── 标签 / 分支对比（独立加载，不进 loadAll；tags 不在 git_fingerprint 内，需显式触发）──
const tags = ref<TagEntry[]>([]);
const tagsLoading = ref(false);
const compare = ref<CompareResult | null>(null);
const compareLoading = ref(false);
const compareError = ref("");

const LOG_PAGE_SIZE = 50;

// ── 加载纪元：工作区切换后旧加载结果可能晚到（git 命令 ~1s/条，两轮 loadAll
// 交错时旧结果会覆盖新结果），用纪元号丢弃过期写入——「最新一次加载胜出」。
// 每个 load* 函数在调用时捕获当前纪元（或由 loadAll 显式传入新纪元），结果
// 落地前校验：纪元已推进 = 期间又发起了新一轮加载，丢弃本次结果。──
let loadEpoch = 0;

/** 结果是否已过期（期间又发起了新一轮加载）。 */
function isStale(epoch: number): boolean {
  return epoch !== loadEpoch;
}

// ── Computed ──

const unstagedFiles = computed(() =>
    statusEntries.value.filter((e) => !e.staged)
);

const stagedFiles = computed(() =>
    statusEntries.value.filter((e) => e.staged)
);

const hasChanges = computed(() => statusEntries.value.length > 0);
const hasUnpushed = computed(() => unpushedHashes.value.size > 0);
const unpushedCount = computed(() => unpushedHashes.value.size);
const conflictFiles = computed(() =>
    statusEntries.value.filter((e) => e.status === "C")
);
const hasConflicts = computed(() => conflictFiles.value.length > 0);

// ── 文件树 git 装饰数据层 ──
// git status 给相对路径（正斜杠），文件树节点是绝对路径（Windows 反斜杠），
// 统一归一化为「相对根 + 正斜杠 + Windows 小写」的 key 再查表。

const isWindowsRoot = computed(() => /^[A-Za-z]:[\\/]/.test(projectRoot.value));

function normalizeSlashes(p: string): string {
    return p.replace(/\\/g, "/");
}

function normalizeKey(p: string): string {
    const s = normalizeSlashes(p);
    return isWindowsRoot.value ? s.toLowerCase() : s;
}

/** 绝对路径 → 相对根的归一化 key；不在项目根下（或根未知）返回 null。 */
function toRelKey(absPath: string): string | null {
    const root = projectRoot.value;
    if (!root) return null;
    const normRoot = normalizeKey(root).replace(/\/+$/, "");
    const normPath = normalizeKey(absPath);
    if (!normPath.startsWith(normRoot + "/")) return null;
    return normPath.slice(normRoot.length + 1);
}

/** 相对路径（git 命令输出）→ 绝对路径。fileViewer 窗口 identity、文件树定位
 *  （revealFile 的前缀检查）、真实文件读取全都建立在绝对路径约定上；根未知时
 *  原样返回（面板未加载完就不会有可点的文件条目，理论不会发生）。 */
function toAbsPath(relPath: string): string {
    const root = projectRoot.value;
    if (!root) return relPath;
    const sep = root.includes("\\") ? "\\" : "/";
    return root.replace(/[\\/]+$/, "") + sep + relPath.replace(/[\\/]/g, sep);
}

/** 文件查找表：相对路径 key → status entry（O(1)）。 */
const statusByPath = computed(() => {
    const m = new Map<string, GitStatusEntry>();
    for (const e of statusEntries.value) {
        m.set(normalizeKey(e.path), e);
    }
    return m;
});

// 目录聚合取优先级最高的子孙状态
const STATUS_PRIORITY: Record<string, number> = { C: 5, D: 4, M: 3, R: 3, A: 2, "?": 1 };

/** 目录聚合表：相对目录 key → 最高优先级状态字母（O(1) 查目录是否含变更）。 */
const dirtyDirs = computed(() => {
    const m = new Map<string, string>();
    for (const e of statusEntries.value) {
        const parts = normalizeKey(e.path).split("/");
        for (let i = 1; i < parts.length; i++) {
            const dir = parts.slice(0, i).join("/");
            const cur = m.get(dir);
            if (!cur || (STATUS_PRIORITY[e.status] ?? 0) > (STATUS_PRIORITY[cur] ?? 0)) {
                m.set(dir, e.status);
            }
        }
    }
    return m;
});

/** 文件树节点（绝对路径）→ 文件 git 状态；无变更返回 null。 */
function fileGitStatus(absPath: string): GitStatusEntry | null {
    const key = toRelKey(absPath);
    return key ? statusByPath.value.get(key) ?? null : null;
}

/** 文件树节点（绝对路径）→ 目录聚合状态字母；无变更返回 null。 */
function dirGitStatus(absPath: string): string | null {
    const key = toRelKey(absPath);
    return key ? dirtyDirs.value.get(key) ?? null : null;
}

// ── Actions ──

async function loadBranches(epoch?: number) {
    const eff = epoch ?? loadEpoch;
    try {
        const list = await invoke<BranchInfo[]>("git_branches");
        if (isStale(eff)) return;
        branches.value = list;
        const cur = list.find((b) => b.is_current);
        const name = cur?.name ?? "";
        // detached HEAD 时 git branch 输出 `* (HEAD detached at abc1234)`
        const m = name.match(/^\(HEAD detached (?:at|from) (.+)\)$/);
        if (m) {
            detachedAt.value = m[1];
            currentBranch.value = "";
        } else {
            detachedAt.value = "";
            currentBranch.value = name;
        }
    } catch (e) {
        if (isStale(eff)) return;
        console.error("[useGit] loadBranches failed:", e);
    }
}

async function loadCommits(epoch?: number) {
    const eff = epoch ?? loadEpoch;
    loading.value = true;
    try {
        const page = await invoke<CommitEntry[]>("git_log", {
            limit: LOG_PAGE_SIZE,
            branch: currentBranch.value || null,
            skip: 0,
        });
        if (isStale(eff)) return;
        commits.value = page;
        hasMoreCommits.value = page.length >= LOG_PAGE_SIZE;
    } catch (e) {
        if (isStale(eff)) return;
        console.error("[useGit] loadCommits failed:", e);
        commits.value = [];
        hasMoreCommits.value = false;
    } finally {
        // loading 由最新一轮 loadAll 的 loadCommits 兜底复位（loadAll 必含 loadCommits）
        if (!isStale(eff)) loading.value = false;
    }
}

async function loadMoreCommits() {
    if (loadingMore.value || !hasMoreCommits.value) return;
    loadingMore.value = true;
    const eff = loadEpoch;
    try {
        const page = await invoke<CommitEntry[]>("git_log", {
            limit: LOG_PAGE_SIZE,
            branch: currentBranch.value || null,
            skip: commits.value.length,
        });
        if (isStale(eff)) return;
        commits.value = [...commits.value, ...page];
        hasMoreCommits.value = page.length >= LOG_PAGE_SIZE;
    } catch (e) {
        if (isStale(eff)) return;
        console.error("[useGit] loadMoreCommits failed:", e);
    } finally {
        loadingMore.value = false;
    }
}

async function loadStatus(epoch?: number) {
    const eff = epoch ?? loadEpoch;
    try {
        const s = await invoke<{ entries: GitStatusEntry[] }>("git_status");
        if (isStale(eff)) return;
        statusEntries.value = s.entries;
    } catch (e) {
        if (isStale(eff)) return;
        console.error("[useGit] loadStatus failed:", e);
        statusEntries.value = [];
    }
}

async function loadUnpushed(epoch?: number) {
    const eff = epoch ?? loadEpoch;
    try {
        const hashes: string[] = await invoke("git_unpushed_commits");
        if (isStale(eff)) return;
        unpushedHashes.value = new Set(hashes);
    } catch (e) {
        if (isStale(eff)) return;
        console.error("[useGit] loadUnpushed failed:", e);
        unpushedHashes.value = new Set();
    }
}

async function loadProjectRoot(epoch?: number) {
    const eff = epoch ?? loadEpoch;
    try {
        const info = await invoke<{ root: string }>("get_project_info");
        if (isStale(eff)) return;
        projectRoot.value = info.root;
    } catch (e) {
        if (isStale(eff)) return;
        console.error("[useGit] loadProjectRoot failed:", e);
    }
}

async function loadStashes(epoch?: number) {
    const eff = epoch ?? loadEpoch;
    try {
        const list = await invoke<StashEntry[]>("git_stash_list");
        if (isStale(eff)) return;
        stashes.value = list;
    } catch (e) {
        if (isStale(eff)) return;
        console.error("[useGit] loadStashes failed:", e);
        stashes.value = [];
    }
}

async function loadAheadBehind(epoch?: number) {
    const eff = epoch ?? loadEpoch;
    try {
        const ab = await invoke<AheadBehind>("git_ahead_behind");
        if (isStale(eff)) return;
        aheadBehind.value = ab;
    } catch (e) {
        if (isStale(eff)) return;
        console.error("[useGit] loadAheadBehind failed:", e);
        aheadBehind.value = { ahead: 0, behind: 0, hasUpstream: false };
    }
}

/** 列出所有标签（按创建日期降序）；不进 loadAll，由标签 tab 显式触发 + 手动刷新。
 *  不推进纪元（与 loadAll 同轮共享——reload 并行调用两者时不能互相作废）。 */
async function loadTags(epoch?: number) {
    const eff = epoch ?? loadEpoch;
    tagsLoading.value = true;
    try {
        const list = await invoke<TagEntry[]>("git_tags");
        if (isStale(eff)) return;
        tags.value = list;
    } catch (e) {
        if (isStale(eff)) return;
        console.error("[useGit] loadTags failed:", e);
        tags.value = [];
    } finally {
        // 无条件复位：loadAll 不含 loadTags，过期丢弃后没有兜底复位方
        tagsLoading.value = false;
    }
}

/** 加载分支对比结果。base 缺省由后端取当前分支。失败时写 compareError，不抛出。 */
async function loadCompare(head: string, base?: string): Promise<void> {
    const eff = loadEpoch;
    compareLoading.value = true;
    compareError.value = "";
    try {
        const result = await invoke<CompareResult>("git_compare_branches", {
            head,
            base: base ?? null,
        });
        if (isStale(eff)) return;
        compare.value = result;
    } catch (e) {
        if (isStale(eff)) return;
        compareError.value = typeof e === "string" ? e : (e as Error).message || "对比加载失败";
        compare.value = null;
    } finally {
        // 无条件复位：loadAll 不含 loadCompare，过期丢弃后由 projectRoot watcher 重跑
        compareLoading.value = false;
    }
}

function clearCompare() {
    compare.value = null;
    compareError.value = "";
}

async function loadAll(epoch?: number) {
    const eff = epoch ?? ++loadEpoch;
    // 先定分支：commits 的 branch 参数、compare 的 base 都依赖 currentBranch，
    // 并行发起会用旧仓库的分支名查新仓库
    await loadBranches(eff);
    await Promise.all([
        loadProjectRoot(eff),
        loadCommits(eff),
        loadStatus(eff),
        loadUnpushed(eff),
        loadStashes(eff),
        loadAheadBehind(eff),
    ]);
}

async function refreshAfterAction() {
    await Promise.all([loadCommits(), loadStatus(), loadUnpushed(), loadStashes(), loadAheadBehind()]);
}

/** 纯获取单条提交详情（不触碰共享展开态）；供对比视图本地展开复用。 */
async function loadCommitDetail(hash: string): Promise<CommitDetail> {
    return invoke<CommitDetail>("git_show", { hash });
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
        commitDetail.value = await loadCommitDetail(hash);
    } catch (_) {
        commitDetail.value = null;
    } finally {
        detailLoading.value = false;
    }
}

async function switchBranch(branch: string) {
    await invoke("git_checkout", { branch });
    await loadAll();
}

async function createBranch(name: string) {
    await invoke("git_create_branch", { name });
    await loadAll();
}

async function deleteBranch(name: string, force = false) {
    await invoke("git_delete_branch", { name, force });
    await loadBranches();
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

async function doUnstageAll() {
    try { await invoke("git_unstage_all"); } catch (e) { console.error("[useGit] unstageAll:", e); }
    await loadStatus();
}

async function doCommit(message: string, amend = false): Promise<string> {
    const hash = await invoke<string>("git_commit", { message, amend });
    await refreshAfterAction();
    return hash;
}

async function doFetch(): Promise<FetchPullOutcome> {
    fetching.value = true;
    fetchError.value = "";
    try {
        const outcome = await invoke<FetchPullOutcome>("git_fetch");
        await Promise.all([loadAheadBehind(), loadUnpushed(), loadBranches()]);
        return outcome;
    } catch (e) {
        fetchError.value = typeof e === "string" ? e : (e as Error).message || "Fetch failed";
        throw e;
    } finally {
        fetching.value = false;
    }
}

function clearFetchError() {
    fetchError.value = "";
}

async function doStashPush(message?: string): Promise<void> {
    await invoke("git_stash", { message: message?.trim() || null });
    await Promise.all([loadStatus(), loadStashes()]);
}

async function doStashApply(index: number): Promise<void> {
    await invoke("git_stash_apply", { index });
    await loadStatus();
}

async function doStashPop(index: number): Promise<void> {
    await invoke("git_stash_pop", { index });
    await Promise.all([loadStatus(), loadStashes()]);
}

async function doStashDrop(index: number): Promise<void> {
    await invoke("git_stash_drop", { index });
    await loadStashes();
}

async function doRevertFile(path: string) {
    try { await invoke("git_revert_file", { path }); } catch (e) { console.error("[useGit] revertFile:", e); }
    await loadStatus();
}

async function doPush(force?: boolean): Promise<void> {
    pushing.value = true;
    pushError.value = "";
    try {
        await invoke("git_push", { force: force ?? false });
        await refreshAfterAction();
    } catch (e) {
        pushError.value = typeof e === "string" ? e : (e as Error).message || "Push failed";
        throw e;
    } finally {
        pushing.value = false;
    }
}

async function doForcePush(): Promise<void> {
    return doPush(true);
}

async function doPull(): Promise<FetchPullOutcome> {
    pulling.value = true;
    pullError.value = "";
    try {
        const outcome = await invoke<FetchPullOutcome>("git_pull");
        await refreshAfterAction();
        await loadBranches();
        return outcome;
    } catch (e) {
        pullError.value = typeof e === "string" ? e : (e as Error).message || "Pull failed";
        throw e;
    } finally {
        pulling.value = false;
    }
}

function clearPullError() {
    pullError.value = "";
}

function clearPushError() {
    pushError.value = "";
}

// ── Export ──

export function useGit() {
    return {
        commits,
        branches,
        currentBranch,
        detachedAt,
        statusEntries,
        unstagedFiles,
        stagedFiles,
        hasChanges,
        conflictFiles,
        hasConflicts,
        unpushedHashes,
        hasUnpushed,
        unpushedCount,
        projectRoot,
        loading,
        hasMoreCommits,
        loadingMore,
        expandedCommit,
        commitDetail,
        detailLoading,
        // 文件树 git 装饰
        statusByPath,
        dirtyDirs,
        fileGitStatus,
        dirGitStatus,
        toAbsPath,
        loadAll,
        loadCommits,
        loadMoreCommits,
        loadStatus,
        loadBranches,
        loadUnpushed,
        loadStashes,
        loadAheadBehind,
        refreshAfterAction,
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
        doFetch,
        doStashPush,
        doStashApply,
        doStashPop,
        doStashDrop,
        pushing,
        pushError,
        pulling,
        pullError,
        fetching,
        fetchError,
        stashes,
        aheadBehind,
        // 标签 / 分支对比
        tags,
        tagsLoading,
        compare,
        compareLoading,
        compareError,
        loadTags,
        loadCompare,
        clearCompare,
        loadCommitDetail,
        clearPushError,
        clearPullError,
        clearFetchError,
    };
}
