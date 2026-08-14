<script setup lang="ts">
/**
 * GitCompare —— 分支对比视图
 *
 * 当前分支 vs 任意分支的发散视图：
 *   - 头部：当前分支 pill（只读 base）+ ThemedSelect 选另一分支（真实分支列表）
 *   - 签名件「发散条」：accent(领先) | warning(落后)，中线=共同祖先，宽度按比例，加载展开
 *   - 两组提交（领先 / 落后），可展开看该提交的文件变更（本地展开态 + loadCommitDetail，
 *     不复用共享 toggleCommit/commitDetail，避免跨 tab 泄漏）
 *   - 文件差异组（两分支尖端直比），点击 → git_diff_pair_refs + fileViewer 打开行级 diff
 *
 * 数据来自 useGit.compare（git_compare_branches）。全 var(--aide-*)。
 */
import { ref, computed, onMounted, nextTick, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import ThemedSelect from "../ThemedSelect.vue";
import GitCommitRow from "./GitCommitRow.vue";
import GitFileRow from "./GitFileRow.vue";
import { useGit } from "../../composables/useGit";
import { useFileViewer } from "../../composables/useFileViewer";
import { useToast } from "../../composables/useToast";
import type { CompareFile, CommitDetail, DiffEntry, DiffPair } from "../../types";

const { currentBranch, branches, compare, compareLoading, compareError, loadCompare, clearCompare, loadCommitDetail } =
  useGit();
const fileViewer = useFileViewer();
const { showToast } = useToast();

const baseBranch = computed(() => currentBranch.value || "HEAD");

// 可对比分支：排除当前分支与游离 HEAD 占位
const headOptions = computed(() =>
  branches.value
    .filter((b) => b.name !== baseBranch.value && !b.is_current)
    .map((b) => ({ value: b.name, label: b.name })),
);
const headBranch = ref("");

// 默认选第一个可选分支；当前选择失效时回退
watch(
  headOptions,
  (opts) => {
    if (opts.length === 0) return;
    if (!headBranch.value || !opts.some((o) => o.value === headBranch.value)) {
      headBranch.value = opts[0].value;
    }
  },
  { immediate: true },
);

// 提交展开（本地态，与改动 tab 的共享 expandedCommit/commitDetail 隔离）
const expandedHash = ref<string | null>(null);
const detail = ref<CommitDetail | null>(null);
const detailLoading = ref(false);
// 三组折叠态（默认展开）
const aheadExpanded = ref(true);
const behindExpanded = ref(true);
const filesExpanded = ref(true);

async function runCompare() {
  if (!headBranch.value) {
    clearCompare();
    return;
  }
  expandedHash.value = null;
  detail.value = null;
  await loadCompare(headBranch.value, currentBranch.value || undefined);
}

watch([headBranch, currentBranch], () => { void runCompare(); });
onMounted(() => { void runCompare(); });

async function toggleCompareCommit(hash: string) {
  if (expandedHash.value === hash) {
    expandedHash.value = null;
    detail.value = null;
    return;
  }
  expandedHash.value = hash;
  detail.value = null;
  detailLoading.value = true;
  try {
    detail.value = await loadCommitDetail(hash);
  } catch (_) {
    detail.value = null;
  } finally {
    detailLoading.value = false;
  }
}

async function onCompareFileClick(f: CompareFile) {
  // 文件差异组：base vs head 的行级 diff
  try {
    const pair = await invoke<DiffPair>("git_diff_pair_refs", {
      path: f.path,
      base: currentBranch.value || undefined,
      head: headBranch.value,
      oldPath: f.oldPath ?? undefined,
    });
    fileViewer.open(f.path, { diffPair: pair });
  } catch (e) {
    showToast(`加载 diff 失败：${typeof e === "string" ? e : (e as Error).message || e}`, "danger");
  }
}

async function onCommitFileClick(f: DiffEntry, hash: string) {
  // 提交详情文件：该提交的行级 diff（h^ vs h）
  try {
    const pair = await invoke<DiffPair>("git_diff_pair", { path: f.path, commitHash: hash });
    fileViewer.open(f.path, { diffPair: pair });
  } catch (e) {
    showToast(`加载 diff 失败：${typeof e === "string" ? e : (e as Error).message || e}`, "danger");
  }
}

// ── 派生 ──
const aheadCommits = computed(() => compare.value?.aheadCommits ?? []);
const behindCommits = computed(() => compare.value?.behindCommits ?? []);
const aheadCount = computed(() => compare.value?.ahead ?? 0);
const behindCount = computed(() => compare.value?.behind ?? 0);
const files = computed(() => compare.value?.files ?? []);
const filesTotal = computed(() => compare.value?.filesTotal ?? 0);
const isIdentical = computed(() => aheadCount.value === 0 && behindCount.value === 0);
const total = computed(() => aheadCount.value + behindCount.value);
const aheadPct = computed(() => (total.value === 0 ? 0 : (aheadCount.value / total.value) * 100));
const behindPct = computed(() => 100 - aheadPct.value);

// 发散条展开动画
const animated = ref(false);
function triggerAnim() {
  animated.value = false;
  void nextTick(() => requestAnimationFrame(() => (animated.value = true)));
}
onMounted(triggerAnim);
watch(headBranch, triggerAnim);
</script>

<template>
  <div class="git-compare">
    <div class="compare-header">
      <span class="compare-base" v-tooltip="'当前分支（基准）'">
        <span class="compare-base-icon">⎇</span>{{ baseBranch }}
      </span>
      <span class="compare-vs">对比</span>
      <ThemedSelect v-model="headBranch" :options="headOptions" class="compare-head-select" />
    </div>

    <!-- 签名件：发散条 -->
    <div v-if="!isIdentical" class="divergence">
      <div class="divergence-labels">
        <span class="div-label div-ahead">◄◄ 领先 {{ aheadCount }}</span>
        <span class="div-label div-behind">落后 {{ behindCount }} ►►</span>
      </div>
      <div class="divergence-bar">
        <div class="div-seg div-seg-ahead" :style="{ width: (animated ? aheadPct : 0) + '%' }"></div>
        <div class="div-spine" v-tooltip="'共同祖先'"></div>
        <div class="div-seg div-seg-behind" :style="{ width: (animated ? behindPct : 0) + '%' }"></div>
      </div>
      <div class="divergence-legend">中线 = 共同祖先 · 共 {{ total }} 个分歧提交</div>
    </div>
    <div v-else-if="!compareLoading && !compareError" class="divergence divergence-same">
      <div class="divergence-bar-same"></div>
      <div class="divergence-legend">两个分支指向相同的提交</div>
    </div>

    <div v-if="compareError" class="compare-error">{{ compareError }}</div>
    <div v-else-if="compareLoading && !compare" class="section-empty">加载中…</div>

    <template v-else-if="compare">
      <!-- 领先提交组（base 独有） -->
      <div v-if="aheadCommits.length > 0" class="git-section">
        <button class="section-header" @click="aheadExpanded = !aheadExpanded">
          <svg class="section-arrow" :class="{ open: aheadExpanded }" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="section-title">领先于 {{ headBranch }} 的提交</span>
          <span class="section-badge ahead-badge">{{ aheadCount }}</span>
        </button>
        <div v-show="aheadExpanded" class="section-body">
          <GitCommitRow
            v-for="c in aheadCommits"
            :key="c.hash"
            :commit="c"
            :expanded="expandedHash === c.hash"
            @toggle="toggleCompareCommit(c.hash)"
          >
            <div v-if="expandedHash === c.hash" class="commit-detail">
              <div v-if="detailLoading" class="detail-loading">加载中…</div>
              <GitFileRow
                v-for="f in detail?.files ?? []"
                :key="f.path"
                :file="f"
                @click="onCommitFileClick(f, c.hash)"
              />
            </div>
          </GitCommitRow>
          <div v-if="aheadCount > aheadCommits.length" class="truncate-hint">仅显示前 {{ aheadCommits.length }} 条，共 {{ aheadCount }} 条</div>
        </div>
      </div>

      <!-- 落后提交组（head 独有） -->
      <div v-if="behindCommits.length > 0" class="git-section">
        <button class="section-header" @click="behindExpanded = !behindExpanded">
          <svg class="section-arrow" :class="{ open: behindExpanded }" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="section-title">{{ headBranch }} 领先的提交</span>
          <span class="section-badge behind-badge">{{ behindCount }}</span>
        </button>
        <div v-show="behindExpanded" class="section-body">
          <GitCommitRow
            v-for="c in behindCommits"
            :key="c.hash"
            :commit="c"
            :expanded="expandedHash === c.hash"
            @toggle="toggleCompareCommit(c.hash)"
          >
            <div v-if="expandedHash === c.hash" class="commit-detail">
              <div v-if="detailLoading" class="detail-loading">加载中…</div>
              <GitFileRow
                v-for="f in detail?.files ?? []"
                :key="f.path"
                :file="f"
                @click="onCommitFileClick(f, c.hash)"
              />
            </div>
          </GitCommitRow>
          <div v-if="behindCount > behindCommits.length" class="truncate-hint">仅显示前 {{ behindCommits.length }} 条，共 {{ behindCount }} 条</div>
        </div>
      </div>

      <!-- 文件差异组 -->
      <div v-if="files.length > 0" class="git-section">
        <button class="section-header" @click="filesExpanded = !filesExpanded">
          <svg class="section-arrow" :class="{ open: filesExpanded }" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="section-title">文件差异</span>
          <span class="section-badge files-badge">{{ filesTotal }}</span>
        </button>
        <div v-show="filesExpanded" class="section-body">
          <GitFileRow v-for="f in files" :key="f.path + f.status" :file="f" @click="onCompareFileClick(f)" />
        </div>
      </div>

      <div v-if="isIdentical && files.length === 0" class="section-empty">无文件差异</div>
    </template>
  </div>
</template>

<style scoped>
.git-compare {
  flex: 1; min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column;
}

.compare-header {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--aide-surface-default);
  flex-shrink: 0;
}
.compare-base {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 10px; border-radius: 99px;
  background: var(--aide-accent-subtle);
  border: 1px solid color-mix(in srgb, var(--aide-accent) 25%, transparent);
  color: var(--aide-accent); font-size: 11px; font-weight: 600;
  font-family: var(--aide-font-mono);
}
.compare-base-icon { font-size: 12px; }
.compare-vs {
  font-size: 10px; color: var(--aide-text-muted);
  text-transform: uppercase; letter-spacing: 0.4px;
}
.compare-head-select { flex: 1; min-width: 0; }
.compare-head-select :deep(.themed-select) { width: 100%; }

/* ── 发散条（签名件）── */
.divergence {
  padding: 10px 12px 12px;
  border-bottom: 1px solid var(--aide-surface-default);
  flex-shrink: 0;
}
.divergence-labels {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 6px; font-size: 11px; font-weight: 600;
}
.div-ahead { color: var(--aide-accent); }
.div-behind { color: var(--aide-warning); }
.divergence-bar {
  display: flex; align-items: stretch;
  height: 6px; border-radius: 99px; overflow: hidden;
  background: var(--aide-surface-default);
}
.div-seg { height: 100%; transition: width 240ms var(--aide-ease-t); }
.div-seg-ahead {
  background: var(--aide-accent);
  box-shadow: 0 0 8px color-mix(in srgb, var(--aide-accent) 45%, transparent);
}
.div-seg-behind {
  background: var(--aide-warning);
  box-shadow: 0 0 8px color-mix(in srgb, var(--aide-warning) 45%, transparent);
}
.div-spine {
  width: 2px; flex-shrink: 0;
  background: var(--aide-bg-deep);
  box-shadow: 0 0 0 1px var(--aide-surface-hover);
  border-radius: 1px;
  position: relative; z-index: 1;
}
.divergence-legend {
  margin-top: 6px; font-size: 10px; color: var(--aide-text-muted);
  text-align: center;
}
.divergence-same .divergence-bar-same {
  height: 6px; border-radius: 99px;
  background: var(--aide-surface-default);
}

.compare-error {
  padding: 10px 12px; font-size: 11px; color: var(--aide-danger);
  border-bottom: 1px solid var(--aide-surface-default);
  flex-shrink: 0;
}

/* ── 分组（复用 GitPanel section 语汇）── */
.git-section { border-bottom: 1px solid var(--aide-surface-default); flex-shrink: 0; }
.section-header {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 6px 10px; border: none; background: var(--aide-bg-deep);
  color: var(--aide-text-secondary); cursor: pointer; font-size: 11px;
  font-family: inherit; text-transform: uppercase; letter-spacing: 0.4px;
  transition: background 0.12s;
}
.section-header:hover { background: var(--aide-surface-default); color: var(--aide-text-primary); }
.section-arrow {
  transition: transform 0.15s; width: 16px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  color: var(--aide-text-muted);
}
.section-arrow.open { transform: rotate(90deg); }
.section-title { color: var(--aide-text-primary); text-transform: none; letter-spacing: 0; font-weight: 500; }
.section-badge {
  margin-left: auto; font-size: 10px; padding: 1px 6px; border-radius: 8px;
  font-family: var(--aide-font-mono);
}
.ahead-badge { background: color-mix(in srgb, var(--aide-accent) 18%, transparent); color: var(--aide-accent); }
.behind-badge { background: color-mix(in srgb, var(--aide-warning) 18%, transparent); color: var(--aide-warning); }
.files-badge { background: var(--aide-surface-default); color: var(--aide-text-muted); }

.section-body { display: flex; flex-direction: column; }
.commit-detail { padding: 4px 10px 8px 28px; }
.detail-loading {
  font-size: 10px; color: var(--aide-text-muted);
  padding: 2px 0 4px; font-style: italic;
}
.truncate-hint {
  padding: 5px 10px; font-size: 10px; color: var(--aide-text-muted);
  text-align: center; font-style: italic;
}

.section-empty { padding: 20px 16px; font-size: 11px; color: var(--aide-text-muted); text-align: center; }

.git-compare::-webkit-scrollbar { width: 4px; }
.git-compare::-webkit-scrollbar-track { background: transparent; }
.git-compare::-webkit-scrollbar-thumb { background: var(--aide-surface-hover); border-radius: 2px; }

@media (prefers-reduced-motion: reduce) {
  .div-seg { transition: none; }
}
</style>