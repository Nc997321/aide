<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { mergeChangeFiles, asTouchedFile } from "../utils/changeFiles";
import type { ChangeRound, ChangeFile } from "../composables/useConversationChanges";
import { useFileResolver } from "../composables/useFileResolver";
import { useDiffWindow, type DiffOpenOptions } from "../composables/useDiffWindow";
import { sessionBaseRev } from "../composables/diffSource";
import { useSessionWorkspaces } from "../composables/useSessionWorkspaces";
import { useToast } from "../composables/useToast";
import { errorText } from "../utils/errors";
import ChangeFileTree from "./ChangeFileTree.vue";
import ChangeRoundItem from "./ChangeRoundItem.vue";
import AToast from "../ui/AToast.vue";
import type { TouchedFile } from "../types";

// P2-4 合一：rounds 与撤回操作由 App.vue 的 useConversationChanges 唯一实例
// 经 props 透传（ChangeLogPanel 恒挂在活动会话，sessionId 与实例恒同）。
// 模板里 rounds/revertRound/revertSingleFile 直接按 props 名访问（script setup 展开）。
const props = defineProps<{
  sessionId: string;
  rounds: ChangeRound[];
  revertRound: (round: ChangeRound) => Promise<void>;
  revertSingleFile: (round: ChangeRound, filePath: string) => Promise<void>;
  /** 撤回某文件在**所有轮**中的记录（顶部统一树是跨轮视图，撤回的语义天然是
   *  「这个文件整体回到 HEAD」，不是「某一轮里的这一条」）。 */
  revertFileGlobally: (filePath: string) => Promise<void>;
}>();

const { openResolved } = useFileResolver();
const { openDiff: openDiffWindow } = useDiffWindow();
const { toastState, showToast } = useToast();
const sessionWs = useSessionWorkspaces();

/** 会话所属工作区根。**归集时绑定的实体归属字段**，这里只查表读一次：
 *  不再「查不到就退回全局活动工作区」——那是消费端猜测，曾导致条目被拼到
 *  旧工作区根下集体报「找不到文件」。未注册就是没有，交给解析器按相对路径处理。 */
const wsRoot = computed(() => sessionWs.workspaceOf(props.sessionId)?.wsPath || undefined);

/**
 * 轮次默认收起：整块面板要能一眼扫完十几轮，摊开成 N 行文件会把结构淹掉。
 *
 * 状态住在这一层（而不是每个轮次行自持）：轮号在各会话里都从 1 开始，
 * 换会话必须清空，否则表现为「新会话第 1 轮莫名开着」。
 */
const expandedRounds = ref<Set<number>>(new Set());

watch(() => props.sessionId, () => {
  expandedRounds.value = new Set();
});

function toggleRound(index: number) {
  const next = new Set(expandedRounds.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  expandedRounds.value = next;
}

/**
 * 「打开 ↗」：在文件查看器里打开文件本身，走文件解析器的「探测 → 工作区内按名搜索 →
 * 多命中浮层」完整兜底，与聊天文件链接同一条路径——条目被移动/改名后仍能被搜索找回，
 * 而不是直接报错。已删除（D）条目磁盘上无对应物，不渲染此入口；内容用 diff 或「撤回」恢复。
 */
async function openFile(f: ChangeFile) {
  if (f.status === "D") return;
  await openResolved(f.path, wsRoot.value);
}

/** 点条目 = 弹 diff 窗口。**口径由调用点声明**（见 diffSource.ts 的端口）：
 *  轮次行 = 本轮、顶部统一树 = 会话以来。失败给 toast——窗口没弹出来必须让用户知道，
 *  而不是点了没反应。 */
async function openDiff(row: TouchedFile, opts: DiffOpenOptions) {
  try {
    await openDiffWindow(row, opts);
  } catch (e) {
    showToast(`加载 diff 失败：${errorText(e)}`, "danger");
  }
}

/** 顶部统一树是**跨轮视图** → 会话口径；基线取首轮（会话起点），没有就退化为 HEAD 累计。 */
async function openDiffFromTree(f: ChangeFile) {
  await openDiff(asTouchedFile(f), {
    scope: "session",
    workspaceRoot: wsRoot.value,
    baseRev: sessionBaseRev(props.rounds),
  });
}

/** 轮次行 = **本轮口径**，基线取该轮开轮时的提交。 */
async function openDiffForRound(round: ChangeRound, row: TouchedFile) {
  await openDiff(row, { scope: "round", workspaceRoot: wsRoot.value, baseRev: round.baseRev });
}

/**
 * 撤回两条路径的错误出口。归集器特意把 git 失败向上抛（`revertFile` 的 catch
 * 再 throw），就是为了这一层能感知——直接 `void` 掉的话，回滚没发生而面板
 * 照旧显示"已撤回"，用户以为文件回去了。破坏性动作失败必须出声。
 */
async function revertWithToast(action: () => Promise<void>) {
  try {
    await action();
  } catch (e) {
    showToast(`撤回失败：${errorText(e)}`, "danger");
  }
}

/** 顶部统一树的输入：全会话累计（D2）。跨轮同路径合并，行数累加、状态取最新。 */
const allFiles = computed(() => mergeChangeFiles(props.rounds));

const totalFiles = computed(() => {
  let n = 0;
  for (const r of props.rounds) n += r.files.length;
  return n;
});

// 连续无变更轮次 > 2 时，中间折叠成一行省略号，点击可展开
const NOCHANGE_COLLAPSE_THRESHOLD = 2;

type RenderItem =
  | { kind: "round"; round: ChangeRound }
  | { kind: "collapsed"; key: string; hiddenCount: number };

/** ⋯N 轮无变更⋯ 的展开态。与轮次的展开态分开：那个是"看这一轮改了什么"，
 *  这个是"把中间一长串空轮摊开"，两者互不牵连。 */
const expandedNoChangeRuns = ref<Set<string>>(new Set());

function expandNoChangeRun(key: string) {
  expandedNoChangeRuns.value.add(key);
  expandedNoChangeRuns.value = new Set(expandedNoChangeRuns.value);
}

const displayedRounds = computed(() => [...props.rounds].reverse());

const renderItems = computed<RenderItem[]>(() => {
  const list = displayedRounds.value;
  const items: RenderItem[] = [];
  let i = 0;
  while (i < list.length) {
    // 进行中轮次永不进折叠分组（files 为空是常态，等文件出现）
    if (list[i].files.length > 0 || list[i].pending) {
      items.push({ kind: "round", round: list[i] });
      i++;
      continue;
    }
    let j = i;
    while (j < list.length && list[j].files.length === 0 && !list[j].pending) j++;
    const group = list.slice(i, j);
    const groupKey = String(group[0].index);
    if (group.length > NOCHANGE_COLLAPSE_THRESHOLD && !expandedNoChangeRuns.value.has(groupKey)) {
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

    <!-- 统计口径常驻：归集只吃文件编辑工具的 tool_use 事件，Bash 造成的改动不在列
         （Claude Code 官方 checkpointing 同样只跟踪 Write/Edit/NotebookEdit）。
         不写清楚，「Bash 改了文件但面板没有」会被当成 bug 反复查。
         文案刻意不列举工具名——那是 changeCard.ts:96 白名单的实现细节，
         抄一份到 UI 就是两处漂移。 -->
    <div class="changelog-scope">仅统计文件编辑工具产生的改动；Bash 命令造成的不在此列</div>

    <div class="changelog-body">
      <template v-if="rounds.length === 0">
        <div class="changelog-empty">暂无变更记录</div>
      </template>
      <template v-else>
        <!-- 顶部：全会话统一文件树（全面板只此一棵，轮次区不再各自建树）。
             树单独限高滚动：长会话几十上百个文件时不至于把下面的轮次顶出屏幕。 -->
        <div v-if="allFiles.length > 0" class="changelog-all">
          <div class="changelog-all-head">全部文件<span class="changelog-all-count">{{ allFiles.length }}</span></div>
          <div class="changelog-all-tree">
            <ChangeFileTree
              :files="allFiles"
              :open-file="openFile"
              :open-diff="openDiffFromTree"
              :revert-file="(f: ChangeFile) => revertWithToast(() => props.revertFileGlobally(f.path))"
              :workspace-root="wsRoot"
            />
          </div>
        </div>
        <template v-for="item in renderItems" :key="item.kind === 'round' ? `r-${item.round.index}` : `c-${item.key}`">
          <div
            v-if="item.kind === 'collapsed'"
            class="changelog-collapsed"
            v-tooltip="`展开 ${item.hiddenCount} 轮无变更记录`"
            @click="expandNoChangeRun(item.key)"
          >⋯ {{ item.hiddenCount }} 轮无变更 ⋯</div>
          <ChangeRoundItem
            v-else
            :round="item.round"
            :expanded="expandedRounds.has(item.round.index)"
            :workspace-root="wsRoot"
            @toggle="toggleRound(item.round.index)"
            @open-file="openFile"
            @open-diff="(row: TouchedFile) => openDiffForRound(item.round, row)"
            @revert-round="revertWithToast(() => revertRound(item.round))"
            @revert-file="(path: string) => revertWithToast(() => props.revertSingleFile(item.round, path))"
          />
        </template>
      </template>
    </div>

    <!-- 面板内提示（diff 打开失败等）：锚定本面板右下角，不进通知中心 -->
    <AToast :state="toastState" placement="inside-bottom" />
  </div>
</template>

<style scoped>
.changelog {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  position: relative; /* AToast 的定位祖先 */
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

/* ── 统计口径说明（header 下方常驻一行） ── */

.changelog-scope {
  padding: 5px 12px;
  font-size: 10px;
  line-height: 1.5;
  color: var(--aide-text-muted);
  background: var(--aide-bg-deep);
  border-bottom: 1px solid var(--aide-border);
  flex-shrink: 0;
}

/* ── Body ── */

/* 自适应布局：树能吃多少空间，取决于轮次区用完之后还剩多少——
   不是一个写死的 210px（那会在面板明明还空着时就砍掉树、逼它内部滚动）。
   规则：谁都不会被压扁（shrink: 0），只有树会在空间不够时让位（内部滚动），
   轮次永远完整可见；两边都装不下时，body 自己滚。 */
.changelog-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.changelog-body > * {
  flex-shrink: 0;
}

.changelog-empty {
  padding: 24px 16px;
  font-size: 11px;
  color: var(--aide-text-muted);
  text-align: center;
}

/* ── 顶部统一文件树 ── */

/* 分区边界：与轮次区之间**必须一眼能分开**——两段都在 bg-deep 上，1px 的
   border（10% 白）在深色玻璃面板里实测几乎看不见。2px 强调色是四种候选里
   唯一在 1:1 缩放下明确可辨的（2026-09-16 用真实组件渲染比对选定）。 */
.changelog-all {
  /* 全场唯一可收缩的块：空间不够时它让位，其余块按内容排 */
  flex: 0 1 auto;
  /* 地板 ≈ 分区标题 + 3 行文件：再挤就只剩个标题，等于把树藏了 */
  min-height: 92px;
  display: flex;
  flex-direction: column;
  border-bottom: 2px solid color-mix(in srgb, var(--aide-accent) 45%, transparent);
  background: var(--aide-bg-deep);
}

/* 分区标题：与轮次标签同级（12px），往上跟面板标题（11px 小写间距体）分开 */
.changelog-all-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--aide-text-secondary);
  background: var(--aide-bg-deep);
}

.changelog-all-count {
  font-size: 10px;
  font-weight: 400;
  font-family: var(--aide-font-mono);
  color: var(--aide-text-muted);
  background: var(--aide-surface-default);
  padding: 0 5px;
  border-radius: 7px;
}

/* 树：占满 .changelog-all 除标题外的全部高度；被压缩时才内部滚动。
   没有 max-height —— 能长多高由「轮次区用完后剩多少」决定（见 .changelog-body）。 */
.changelog-all-tree {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* ── ⋯N 轮无变更⋯ ── */

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

/* ── Scrollbar ── */

.changelog-body::-webkit-scrollbar,
.changelog-all-tree::-webkit-scrollbar {
  width: 4px;
}
.changelog-body::-webkit-scrollbar-track,
.changelog-all-tree::-webkit-scrollbar-track {
  background: transparent;
}
.changelog-body::-webkit-scrollbar-thumb,
.changelog-all-tree::-webkit-scrollbar-thumb {
  background: var(--aide-surface-hover);
  border-radius: 2px;
}
</style>
