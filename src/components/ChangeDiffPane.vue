<script setup lang="ts">
import { computed, ref, watch } from "vue";
import DiffViewer from "./fileviewer/DiffViewer.vue";
import { api } from "../api";
import { makePair, locateEditStartLine } from "../utils/changeCard";
import { resolveFileLinkPath } from "../utils/fileLink";
import { useSettings } from "../composables/useSettings";
import type { ChangeSegment, DiffPair } from "../types";

/**
 * 变更面板的 diff 薄壳：一个文件 → 一段或多段 diff。
 *
 * ## 两态（C3：以**轮**为单位，不是以文件为单位）
 *
 * - **片段视图**：本轮的工具调用片段还活在内存里 → 精确「本轮改了什么」；
 * - **累计视图**：历史轮 / 重启后 / 片段超预算 → 调 `git_diff_pair` 拿
 *   「HEAD → 当前」的差异，并在卡片上标注，不假装它是本轮的。
 *
 * 两种态喂给**同一个** DiffViewer（片段多传一个 `firstLineNumber`），
 * 不维护第二套渲染。
 *
 * 一轮内同一文件被 Edit 多次 → **依次渲染多个片段**，不做合并
 * （合并需要把 N 段重算成一段，行号语义会失真）。
 */
const props = defineProps<{
  /** 相对工作区根的路径：撤回、git 取 pair、展示全用它 */
  path: string;
  /** 变更状态（M/A/D）：决定片段 pair 的两侧标签与「打开 ↗」是否可用 */
  status: string;
  /** 本轮片段；空数组 = 无片段 → 累计视图 */
  segments: ChangeSegment[];
  /** 会话所属工作区根：拼绝对路径读文件（行号定位）、给 git 当 cwd */
  workspaceRoot?: string;
  /** 并排（轮内平铺）/ 单排（顶部统一树） */
  mode: "split" | "unified";
  /** 累计视图的标注文案：轮内是「本轮片段不可用」，顶部统一树是「全会话累计」，
   *  同一个组件两种语境，文案由调用方给（不在这里猜出处）。 */
  cumulativeNote?: string;
}>();

const { settings } = useSettings();

const segmented = computed(() => props.segments.length > 0);

const pairStatus = (): DiffPair["status"] => (props.status === "A" ? "added" : "modified");

const segmentPairs = computed<DiffPair[]>(() =>
  segmented.value
    ? props.segments.map((s) => makePair(s.oldText, s.newText, pairStatus()))
    : [],
);

/** 片段行号偏移：定位每段在当前文件中的真实起始行，让 DiffViewer 显示真实行号。
 *  算不出（Write 新文件 / 片段已被后续改动覆盖 / 读失败）→ undefined → 从 1。 */
const firstLines = ref<Array<number | undefined>>([]);

watch(
  segmentPairs,
  async (pairs) => {
    if (!segmented.value) return;
    const abs = resolveFileLinkPath(props.path, props.workspaceRoot);
    firstLines.value = await Promise.all(
      pairs.map((p, i) => locateEditStartLine(abs, props.segments[i].newText, p.status)),
    );
  },
  { immediate: true },
);

// ── 累计视图：懒加载（点开才取），失败显式提示，不静默留白 ──
const gitPair = ref<DiffPair | null>(null);
const loading = ref(false);
const loadError = ref<string | null>(null);

watch(
  () => [props.path, props.workspaceRoot] as const,
  async () => {
    if (segmented.value) return;
    loading.value = true;
    loadError.value = null;
    gitPair.value = null;
    try {
      gitPair.value = await api.gitDiffPair(props.path, { cwd: props.workspaceRoot });
    } catch (e) {
      loadError.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

/** DiffViewer 需要定高容器（内部 100% 布局）：按行数估算，超高封顶内滚。
 *  与 ToolCallBlock 变更卡同一套估算，视觉上两处 diff 高度一致。 */
function heightOf(pair: DiffPair): number {
  const lines = Math.max(pair.oldText.split("\n").length, pair.newText.split("\n").length, 1);
  const TOOLBAR = 38;
  const perLine = Math.round(settings.fontSize * 1.6);
  return Math.min(480, Math.max(120, TOOLBAR + lines * perLine + 16));
}
</script>

<template>
  <div class="cdp">
    <!-- 片段视图：本轮精确 diff -->
    <template v-if="segmented">
      <div v-for="(pair, i) in segmentPairs" :key="i" class="cdp-seg">
        <div v-if="segmentPairs.length > 1" class="cdp-seg-head">片段 {{ i + 1 }} / {{ segmentPairs.length }}</div>
        <div class="cdp-view" :style="{ height: heightOf(pair) + 'px' }">
          <DiffViewer
            :pair="pair"
            :file-path="path"
            :initial-mode="mode"
            :show-badge="false"
            :first-line-number="firstLines[i]"
          />
        </div>
      </div>
    </template>

    <!-- 累计视图：HEAD → 当前 -->
    <template v-else>
      <div class="cdp-note">{{ props.cumulativeNote ?? "累计视图：显示该文件相对 HEAD 的全部差异" }}</div>
      <div v-if="loading" class="cdp-state">加载中…</div>
      <div v-else-if="loadError" class="cdp-state cdp-state--error">加载失败：{{ loadError }}</div>
      <div v-else-if="gitPair" class="cdp-view" :style="{ height: heightOf(gitPair) + 'px' }">
        <DiffViewer :pair="gitPair" :file-path="path" :initial-mode="mode" :show-badge="false" />
      </div>    </template>
  </div>
</template>

<style scoped>
.cdp {
  background: var(--aide-bg-deep);
  border-top: 1px solid var(--aide-border-subtle);
}

.cdp-seg-head {
  padding: 4px 12px 2px;
  font-size: 10px;
  color: var(--aide-text-muted);
}

/* DiffViewer 内部 100% 布局：容器必须定高 */
.cdp-view {
  overflow: hidden;
}

.cdp-note {
  padding: 4px 12px;
  font-size: 10px;
  color: var(--aide-text-muted);
  font-style: italic;
}

.cdp-state {
  padding: 8px 12px;
  font-size: 11px;
  color: var(--aide-text-muted);
}

.cdp-state--error {
  color: var(--aide-danger);
}
</style>
