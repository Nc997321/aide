<script setup lang="ts">
import { computed, ref } from "vue";
import { mergeChangeFiles } from "../utils/changeFiles";
import type { ChangeRound, ChangeFile } from "../composables/useConversationChanges";
import { useFileResolver } from "../composables/useFileResolver";
import { useSessionWorkspaces } from "../composables/useSessionWorkspaces";
import ChangeFileTree from "./ChangeFileTree.vue";
import ChangeFileList from "./ChangeFileList.vue";
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
const sessionWs = useSessionWorkspaces();

/** 会话所属工作区根。**归集时绑定的实体归属字段**，这里只查表读一次：
 *  不再「查不到就退回全局活动工作区」——那是消费端猜测，曾导致条目被拼到
 *  旧工作区根下集体报「找不到文件」。未注册就是没有，交给解析器按相对路径处理。 */
const wsRoot = computed(() => sessionWs.workspaceOf(props.sessionId)?.wsPath || undefined);

// 连续无变更轮次 > 2 时，中间折叠成一行省略号，点击可展开
const NOCHANGE_COLLAPSE_THRESHOLD = 2;

type RenderItem =
  | { kind: "round"; round: ChangeRound }
  | { kind: "collapsed"; key: string; hiddenCount: number };

const expandedGroups = ref<Set<string>>(new Set());

function expandGroup(key: string) {
  expandedGroups.value.add(key);
  expandedGroups.value = new Set(expandedGroups.value);
}

/**
 * 打开变更文件：走文件解析器的「探测 → 工作区内按名搜索 → 多命中浮层」完整兜底，
 * 与聊天文件链接同一条路径——条目被移动/改名后仍能被搜索找回，而不是直接报错。
 * 已删除（D）条目磁盘上无对应物，「打开 ↗」不渲染；内容用 diff 或「撤回」恢复。
 */
async function openFile(f: ChangeFile) {
  if (f.status === "D") return;
  await openResolved(f.path, wsRoot.value);
}

function revertFileInRound(round: ChangeRound, f: ChangeFile) {
  void props.revertSingleFile(round, f.path);
}

/** 轮内平铺的行：内存有本轮片段就带片段（点开 = 本轮精确 diff），历史轮没有 →
 *  空片段数组，走累计视图。补齐成同一种形状，渲染层不做「有没有 touches」的分支。 */
function rowsOf(round: ChangeRound): TouchedFile[] {
  if (round.touches) return round.touches;
  return round.files.map((f) => ({ ...f, segments: [] }));
}

/** 顶部统一树的输入：全会话累计（D2）。跨轮同路径合并，行数累加、状态取最新。 */
const allFiles = computed(() => mergeChangeFiles(props.rounds));

const totalFiles = computed(() => {
  let n = 0;
  for (const r of props.rounds) n += r.files.length;
  return n;
});

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
    if (group.length > NOCHANGE_COLLAPSE_THRESHOLD && !expandedGroups.value.has(groupKey)) {
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
         （Claude Code 官方 checkpointing 同样只跟踪 Write/Edit/NotebookEdit，
         见 docs/reference/使用checkpointing回滚文件更改.md）。不写清楚，
         「Bash 改了文件但面板没有」会被当成 bug 反复查。
         文案刻意不列举工具名——那是 changeCard.ts:96 白名单的实现细节，
         抄一份到 UI 就是两处漂移。 -->
    <div class="changelog-scope">仅统计文件编辑工具产生的改动；Bash 命令造成的不在此列</div>

    <div class="changelog-body">
      <template v-if="rounds.length === 0">
        <div class="changelog-empty">暂无变更记录</div>
      </template>
      <template v-else>
        <!-- 顶部：全会话统一文件树（全面板只此一棵，轮次区不再各自建树） -->
        <div v-if="allFiles.length > 0" class="changelog-all">
          <div class="changelog-all-head">全部文件 · {{ allFiles.length }}</div>
          <ChangeFileTree
            :files="allFiles"
            :open-file="openFile"
            :revert-file="(f: ChangeFile) => void props.revertFileGlobally(f.path)"
            :workspace-root="wsRoot"
            diff-mode="unified"
            cumulative-note="全会话累计：显示该文件相对 HEAD 的全部差异"
          />
        </div>
        <template v-for="item in renderItems" :key="item.kind === 'round' ? `r-${item.round.index}` : `c-${item.key}`">
          <div
            v-if="item.kind === 'collapsed'"
            class="changelog-collapsed"
            v-tooltip="`展开 ${item.hiddenCount} 轮无变更记录`"
            @click="expandGroup(item.key)"
          >⋯ {{ item.hiddenCount }} 轮无变更 ⋯</div>
          <div v-else class="changelog-round" :class="{ 'changelog-round--live': item.round.pending }">
            <div class="changelog-round-header">
              <span class="changelog-round-label">轮 {{ item.round.index }}</span>
              <span
                class="changelog-round-title"
                :class="{ 'changelog-round-title--empty': !item.round.prompt }"
                v-tooltip="item.round.prompt || undefined"
              >{{ item.round.prompt || '（无提问记录）' }}</span>
              <span
                v-if="item.round.pending"
                class="changelog-round-live"
                v-tooltip="'本轮进行中，文件变更实时刷新'"
              ><i class="live-dot"></i>进行中</span>
              <button
                v-if="item.round.rewindTo !== undefined"
                class="changelog-round-revert"
                v-tooltip="'撤回到此处：回滚对话与文件到该轮之前'"
                @click="revertRound(item.round)"
              ><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6.69 3L3 13"/></svg></button>
            </div>
            <div class="changelog-round-time">{{ item.round.time }}</div>
            <div
              v-if="item.round.files.length === 0"
              class="changelog-nochange"
              :class="{ 'changelog-nochange--pending': item.round.pending }"
            >{{ item.round.pending ? '等待文件变更…' : '无变更' }}</div>
            <ChangeFileList
              v-else
              :rows="rowsOf(item.round)"
              :workspace-root="wsRoot"
              mode="split"
              :open-file="openFile"
              :revert-file="(f: ChangeFile) => revertFileInRound(item.round, f)"
            />
          </div>
        </template>
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

/* ── 顶部统一文件树 ── */

.changelog-all {
  border-bottom: 1px solid var(--aide-border);
  background: var(--aide-bg-deep);
}

.changelog-all-head {
  padding: 5px 12px 3px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--aide-text-muted);
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
  flex-shrink: 0;
  font-weight: 600;
  color: var(--aide-accent);
}

.changelog-round-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--aide-text-secondary);
}

.changelog-round-title--empty {
  color: var(--aide-text-muted);
  font-style: italic;
}

/* ── 进行中轮次 ── */

.changelog-round-live {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--aide-accent);
  background: color-mix(in srgb, var(--aide-accent) 10%, transparent);
  border-radius: 8px;
  padding: 1px 7px;
}

.live-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--aide-accent);
  animation: live-breathe 1.4s ease-in-out infinite;
}

@keyframes live-breathe {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.35; }
}

@media (prefers-reduced-motion: reduce) {
  .live-dot { animation: none; }
}

.changelog-round-time {
  padding: 0 12px 4px;
  font-size: 10px;
  color: var(--aide-text-muted);
  background: var(--aide-bg-deep);
}

.changelog-round-revert {
  background: none;
  border: none;
  color: var(--aide-text-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 1px 4px;
  border-radius: 2px;
  transition: color 0.15s ease, background 0.15s ease;
  font-family: inherit;
}
.changelog-round-revert:hover {
  color: var(--aide-danger);
  background: color-mix(in srgb, var(--aide-danger) 12%, transparent);
}

.changelog-nochange {
  padding: 4px 12px;
  font-size: 11px;
  color: var(--aide-text-muted);
  font-style: italic;
}

.changelog-nochange--pending {
  color: var(--aide-text-secondary);
}

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
