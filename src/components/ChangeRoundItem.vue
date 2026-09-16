<script setup lang="ts">
import { computed } from "vue";
import type { ChangeRound, ChangeFile, TouchedFile } from "../types";
import { roundRows } from "../utils/changeFiles";
import ChangeFileList from "./ChangeFileList.vue";

/**
 * 一轮变更 = 收起态**一行**：轮号 · 提问 · 规模（N 文件 +a -d）· 时间。
 *
 * 收起是默认态：面板要能一眼扫完十几轮，而不是每轮摊开成 N 行文件把结构淹掉
 * （历史轮头另占一行时间的写法，6 轮就铺满整屏）。展开才出文件行。
 *
 * 展开态由父组件持有（`expanded` prop）：轮号在各会话里都从 1 开始，
 * 「换会话清空展开态」必须发生在有会话 id 的那一层，子组件自持会漏掉这一跳。
 */
const props = defineProps<{
  round: ChangeRound;
  expanded: boolean;
  /** 会话所属工作区根：拼绝对路径（打开 / 片段行号定位）、给 git 当 cwd */
  workspaceRoot?: string;
}>();

const emit = defineEmits<{
  toggle: [];
  "open-file": [f: ChangeFile];
  "open-diff": [row: TouchedFile];
  "revert-round": [];
  "revert-file": [path: string];
}>();

/** 本轮有没有可展开的东西：无变更轮摆一个点开也空的折叠入口只会让人白点一次。 */
const hasFiles = computed(() => props.round.files.length > 0);

const rows = computed(() => roundRows(props.round));

/** 收起态能看到的规模：逐文件累加。用 files 而非 touches —— 两者同源按路径去重，
 *  但 files 恒在（历史轮只有它）。 */
const totals = computed(() => {
  let additions = 0;
  let deletions = 0;
  for (const f of props.round.files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { additions, deletions };
});

const emptyLabel = computed(() => (props.round.pending ? "等待文件变更…" : "无变更"));
</script>

<template>
  <div
    class="changelog-round"
    :class="{ 'changelog-round--live': round.pending }"
    :data-round="round.index"
  >
    <div class="changelog-round-header">
      <button
        class="changelog-round-toggle"
        :aria-expanded="expanded ? 'true' : 'false'"
        :disabled="!hasFiles"
        @click="emit('toggle')"
      >
        <svg
          class="changelog-round-chev" :class="{ expanded }"
          width="12" height="12" viewBox="0 0 12 12" fill="none"
        >
          <path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="changelog-round-label">轮 {{ round.index }}</span>
        <span
          class="changelog-round-title"
          :class="{ 'changelog-round-title--empty': !round.prompt }"
          v-tooltip="round.prompt || undefined"
        >{{ round.prompt || '（无提问记录）' }}</span>
        <span
          v-if="round.pending"
          class="changelog-round-live"
          v-tooltip="'本轮进行中，文件变更实时刷新'"
        ><i class="live-dot"></i>进行中</span>
        <span class="changelog-round-meta">
          <template v-if="hasFiles">
            <span class="changelog-round-count">{{ round.files.length }} 文件</span>
            <span v-if="totals.additions > 0" class="changelog-add">+{{ totals.additions }}</span>
            <span v-if="totals.deletions > 0" class="changelog-del">-{{ totals.deletions }}</span>
          </template>
          <span v-else class="changelog-round-meta--empty">{{ emptyLabel }}</span>
        </span>
        <span class="changelog-round-time">{{ round.time }}</span>
      </button>
      <button
        v-if="round.rewindTo !== undefined"
        class="changelog-round-revert"
        v-tooltip="'撤回到此处：回滚对话与文件到该轮之前'"
        @click="emit('revert-round')"
      ><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6.69 3L3 13"/></svg></button>
    </div>

    <!-- 展开态：文件行缩进 + 一条导引线，明示「这些属于上面那一轮」 -->
    <div v-if="expanded && hasFiles" class="changelog-round-files">
      <ChangeFileList
        :rows="rows"
        :workspace-root="workspaceRoot"
        :open-file="(f: ChangeFile) => emit('open-file', f)"
        :open-diff="(row: TouchedFile) => emit('open-diff', row)"
        :revert-file="(f: ChangeFile) => emit('revert-file', f.path)"
      />
    </div>
  </div>
</template>

<style scoped>
.changelog-round {
  border-bottom: 1px solid var(--aide-border-subtle);
}

.changelog-round:last-child {
  border-bottom: none;
}

/* ── 轮次头（收起态 = 全部内容都在这一行） ── */

.changelog-round-header {
  display: flex;
  align-items: center;
  background: var(--aide-bg-deep);
}

.changelog-round-toggle {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 4px 4px 8px;
  border: none;
  background: none;
  font-family: inherit;
  /* button 的 UA 默认字号是 13.33px：不兜住，将来漏标字号的后代就吃到它 */
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s ease;
}

.changelog-round-toggle:hover:not(:disabled) {
  background: var(--aide-surface-default);
}

.changelog-round-toggle:focus-visible {
  outline: 1px solid var(--aide-accent);
  outline-offset: -1px;
}

/* 无变更轮没有可展开的东西：按钮保留（布局同一套），但不给任何点击反馈 */
.changelog-round-toggle:disabled {
  cursor: default;
}

.changelog-round-chev {
  flex-shrink: 0;
  color: var(--aide-text-muted);
  transition: transform 0.16s ease;
}

.changelog-round-chev.expanded {
  transform: rotate(90deg);
  color: var(--aide-accent);
}

.changelog-round-label {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--aide-accent);
}

.changelog-round-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
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
  padding: 0 7px;
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

/* ── 元信息：规模 / 时间（都挂在轮次头右端） ── */

.changelog-round-meta {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  font-family: var(--aide-font-mono);
  color: var(--aide-text-muted);
}

.changelog-round-meta--empty {
  font-family: var(--aide-font-ui);
  font-style: italic;
}

.changelog-add { color: var(--aide-success); }
.changelog-del { color: var(--aide-danger); }

.changelog-round-time {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  font-family: var(--aide-font-mono);
  color: var(--aide-text-muted);
}

/* 规模与时间之间的分隔点：两个数字串并排，不给分隔会读成一串 */
.changelog-round-time::before {
  content: "·";
  font-family: var(--aide-font-ui);
  color: var(--aide-border);
}

.changelog-round-revert {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--aide-text-muted);
  cursor: pointer;
  padding: 1px 4px;
  border-radius: 2px;
  transition: color 0.15s ease, background 0.15s ease;
  font-family: inherit;
}

.changelog-round-revert:hover {
  color: var(--aide-danger);
  background: color-mix(in srgb, var(--aide-danger) 12%, transparent);
}

/* ── 展开态文件区 ── */

.changelog-round-files {
  border-left: 1px solid var(--aide-border);
  margin-left: 13px;
}
</style>
