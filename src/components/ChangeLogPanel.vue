<script setup lang="ts">
import { computed, ref } from "vue";
import type { ChangeRound, ChangeFile } from "../composables/useConversationChanges";
import { useFileResolver } from "../composables/useFileResolver";
import { useSessionWorkspaces } from "../composables/useSessionWorkspaces";
import { api } from "../api";
import ChangeFileTree from "./ChangeFileTree.vue";

// P2-4 合一：rounds 与撤回操作由 App.vue 的 useConversationChanges 唯一实例
// 经 props 透传（ChangeLogPanel 恒挂在活动会话，sessionId 与实例恒同）。
// 模板里 rounds/revertRound/revertSingleFile 直接按 props 名访问（script setup 展开）。
const props = defineProps<{
  sessionId: string;
  rounds: ChangeRound[];
  revertRound: (round: ChangeRound) => Promise<void>;
  revertSingleFile: (round: ChangeRound, filePath: string) => Promise<void>;
}>();

const { openResolved } = useFileResolver();
const sessionWs = useSessionWorkspaces();

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
 * 变更条目所属的工作区根：优先会话注册表（混合 tab 布局下会话可来自任意工作区，
 * 捕获变更时 git 就以它为 cwd），未注册时退回当前活动工作区。
 * 点击时现取、不缓存——曾缓存于 onMounted，工作区切换/晚恢复后失锚，
 * 所有点击都被拼到旧根下报「找不到文件」。
 */
async function workspaceRootOf(sessionId: string): Promise<string | undefined> {
  const registered = sessionWs.workspaceOf(sessionId)?.wsPath;
  if (registered) return registered;
  try {
    const info = await api.getProjectInfo();
    return info.root || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 打开变更文件：走文件解析器的「探测 → 工作区内按名搜索 → 多命中浮层」完整兜底，
 * 与聊天文件链接同一条路径——条目被移动/改名后仍能被搜索找回，而不是直接报错。
 * 已删除（D）条目磁盘上无对应物，不可点开；内容可用「撤回此文件」恢复。
 */
async function openFile(f: ChangeFile) {
  if (f.status === "D") return;
  await openResolved(f.path, await workspaceRootOf(props.sessionId));
}

function revertFileInRound(round: ChangeRound, f: ChangeFile) {
  void props.revertSingleFile(round, f.path);
}

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

    <div class="changelog-body">
      <template v-if="rounds.length === 0">
        <div class="changelog-empty">暂无变更记录</div>
      </template>
      <template v-else>
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
            <ChangeFileTree
              v-else
              :files="item.round.files"
              :open-file="(f: ChangeFile) => openFile(f)"
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
