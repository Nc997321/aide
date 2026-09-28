<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ChangeFile, ChangeRound, TouchedFile } from "@/types";
import { roundRows } from "../../utils/changeFiles";
import { barSegments, formatCount, roundStats } from "./turnChangeStats";
import { useSessionWorkspaces } from "../../composables/useSessionWorkspaces";
import { useDiffWindow } from "../../composables/useDiffWindow";
import { useFileResolver } from "../../composables/useFileResolver";
import { useRightPanel } from "../../composables/useRightPanel";
import { useToast } from "../../composables/useToast";
import { errorText } from "../../utils/errors";
import ChangeFileList from "../ChangeFileList.vue";
import AToast from "../../ui/AToast.vue";
import type { TurnChangesFeed } from "./turnChanges";

/**
 * 回合变更结算卡：消息流尾部的「这一轮一共改了什么」（spec 2026-09-24；
 * 形态与生命周期以 docs/prototypes/2026-09-24-turn-change-footer.html 为准）。
 *
 * 为什么在流尾：做"这轮我接不接受"这个决定时人就在流尾（流式输出把视口钉在底部），
 * 而右栏那个 8 分之 1 的图标在视线边缘。它跟随**当前轮**——下一轮开始就变回
 * `正在改`，上一轮的账单退场（面板里留档，`变更面板 ↗` 就是通往它的门）。
 *
 * 数据只有一个来源：App 的 useConversationChanges 唯一实例（TURN_CHANGES_KEY）。
 * **绝不自建第二份**——见 turnChanges.ts 顶部注释。
 */
const props = defineProps<{
  /** 唯一一份轮次数据（含它属于哪个会话） */
  feed: TurnChangesFeed;
  /** 本面板的会话 id：与 feed.sid 不等时这卡不属于这里（分屏的另一组） */
  sessionId: string | null;
}>();

const isMine = computed(() => props.feed.sid === props.sessionId);

/** 当前轮 = 最新一轮。锚在流尾跟随它，不堆叠历史（spec §5）。 */
const round = computed<ChangeRound | undefined>(() => {
  const list = props.feed.rounds;
  return list.length ? list[list.length - 1] : undefined;
});

/** 进行中 = 轮自己还没结算（startRound 建轮 → solidifyRound 落定）。
 *  不用 `sessionState === "running"`：等权限（attention）时轮没结束，按那个判据
 *  会把半成品的账单亮出来。 */
const live = computed(() => round.value?.pending === true);

/** 0 个文件的轮整卡不渲染——进行中同样适用：卡在第一个文件落下时才出现，
 *  那一刻的"出现"自带信息量。 */
const visible = computed(() => isMine.value && !!round.value && round.value.files.length > 0);

const stats = computed(() => roundStats(round.value?.files ?? []));
const segments = computed(() => barSegments(stats.value));
const rows = computed(() => (round.value ? roundRows(round.value) : []));

const { workspaceOf } = useSessionWorkspaces();
const { openResolved } = useFileResolver();
const { openDiff: openDiffWindow } = useDiffWindow();
const { toastState, showToast } = useToast();
const { ensureTabShown } = useRightPanel();

/** 会话所属工作区根：会话级事实，不猜活动工作区（同 ChangeLogPanel）。 */
const wsRoot = computed(() => workspaceOf(props.feed.sid)?.wsPath || undefined);

/** 展开态是纯展示状态，住在卡内；换轮或换会话即复位——展开态属于"这一张账单"，
 *  不该被下一张继承。 */
const expanded = ref(false);
watch(() => [props.feed.sid, round.value?.index], () => { expanded.value = false; });

function toggleExpand() {
  if (live.value) return; // 进行中没有账单可看（spec §3）
  expanded.value = !expanded.value;
}

/** `变更面板 ↗`：**确保显示**而非 select()——select 是 toggle，已经在该 tab 时
 *  点它会把面板收起来（"给我看看"变成"把你的面板关掉"）。 */
function openPanel() {
  ensureTabShown("changes");
}

async function openFile(f: ChangeFile) {
  await openResolved(f.path, wsRoot.value);
}

/** 点文件行 = 弹该文件 diff（失败出声——窗口没弹出来不能是"点了没反应"）。 */
async function openDiff(row: TouchedFile) {
  try {
    await openDiffWindow(row, wsRoot.value);
  } catch (e) {
    showToast(`加载 diff 失败：${errorText(e)}`, "danger");
  }
}

/** 单文件撤回（与面板同款错误出口）：破坏性动作失败必须出声，否则回滚没发生
 *  而卡上照旧显示"已撤回"。整轮撤回**不在此列**（不可逆操作留在有确认弹窗的面板）。 */
async function revertFile(path: string) {
  const r = round.value;
  if (!r) return;
  try {
    await props.feed.revertSingleFile(r, path);
  } catch (e) {
    showToast(`撤回失败：${errorText(e)}`, "danger");
  }
}
</script>

<template>
  <div
    v-if="visible"
    class="tf"
    :class="{ 'tf--live': live }"
    @click="toggleExpand"
  >
    <div class="tf-top">
      <span v-if="live" class="tf-dot" aria-hidden="true" />
      <span class="tf-label">{{ live ? "正在改" : "本轮变更" }}</span>
      <!-- 进行中：文件数占行 1 右端（此刻行 1 没有动作可放） -->
      <span v-if="live" class="tf-unit tf-unit--end">
        <span class="tf-unit-n">{{ formatCount(stats.files) }}</span> 个文件
      </span>
      <template v-else>
        <button class="tf-panel-link tf-unit--end" @click.stop="openPanel">变更面板 ↗</button>
        <button
          class="tf-pill"
          :aria-expanded="expanded ? 'true' : 'false'"
          @click.stop="toggleExpand"
        >
          {{ expanded ? "收起" : "展开" }}
          <span class="tf-caret" :class="{ 'tf-caret--down': expanded }" aria-hidden="true" />
        </button>
      </template>
    </div>

    <div class="tf-nums">
      <span v-if="!live" class="tf-unit">
        <span class="tf-unit-n">{{ formatCount(stats.files) }}</span> 个文件
      </span>
      <span v-if="stats.additions > 0" class="tf-big tf-big--add">+{{ formatCount(stats.additions) }}</span>
      <span v-if="stats.deletions > 0" class="tf-big tf-big--del">−{{ formatCount(stats.deletions) }}</span>
      <!-- 长度恒定、只表达增删比例：量级由左边的数字承担（spec §2.4）。
           `flex` 写成整串（同原型的 style="flex:12"）：grow=行数、shrink=1、basis=0% -->
      <span class="tf-bar" aria-hidden="true">
        <i
          v-for="seg in segments"
          :key="seg.kind"
          class="tf-bar-seg"
          :class="`tf-bar-seg--${seg.kind}`"
          :style="{ flex: `${seg.flex} 1 0%` }"
        />
      </span>
    </div>

    <!-- 展开体：本轮清单（ChangeFileList 的状态徽标 / 文件图标 / 弱化目录段 / hover 出的
         撤回全现成）。@click.stop —— 点文件行或行内图标不该冒泡成"收起卡片"。 -->
    <div v-if="!live && expanded" class="tf-body" @click.stop>
      <ChangeFileList
        :rows="rows"
        :workspace-root="wsRoot"
        :open-file="openFile"
        :open-diff="openDiff"
        :revert-file="(f: ChangeFile) => revertFile(f.path)"
      />
    </div>

    <!-- 卡内失败出口（diff 打不开 / 撤回失败）：锚在本卡，不进通知中心 -->
    <AToast :state="toastState" placement="inside-bottom" />
  </div>
</template>

<style scoped>
/* ── 卡面（值取自原型页 .tf，颜色一律走 --aide-* token） ── */
.tf {
  position: relative; /* AToast 的定位祖先 */
  margin: 4px 12px; /* 与 .msg-row 的 padding: 4px 12px 对齐（原型是单卡演示页，没有对话列） */
  padding: 9px 13px 11px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  border: 1px solid color-mix(in srgb, var(--aide-accent) 24%, transparent);
  border-radius: var(--aide-radius-md);
  background: radial-gradient(130% 190% at 0% 0%, var(--aide-accent-subtle), transparent 58%), var(--aide-bg-base);
  box-shadow: var(--aide-highlight-inset);
  font-family: var(--aide-font-ui);
  color: var(--aide-text-secondary);
  transition: border-color var(--aide-ease-t), background var(--aide-ease-t);
}

/* 悬停只给可交互（已结算）的卡：进行中的卡没有任何可点处，亮起来是承诺一个不存在的动作。
   只动 accent 透明度与底色——加边框会改盒模型让整卡"抖"。 */
.tf:not(.tf--live) {
  cursor: pointer;
}
.tf:not(.tf--live):hover {
  border-color: color-mix(in srgb, var(--aide-accent) 40%, transparent);
  background: radial-gradient(130% 190% at 0% 0%, color-mix(in srgb, var(--aide-accent) 22%, transparent), transparent 58%), var(--aide-bg-raised);
}

/* ── 进行中：灰调 + 呼吸点，与"结算完成的产出"用颜色分开 ── */
.tf--live {
  border-color: color-mix(in srgb, var(--aide-text-muted) 22%, transparent);
  background: var(--aide-bg-base);
  cursor: default;
}
.tf--live .tf-label {
  color: var(--aide-text-muted);
}

/* ── 行 1：身份 + 动作 ── */
.tf-top {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.tf-label {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 1.1px;
  color: var(--aide-accent);
  text-transform: uppercase;
  white-space: nowrap;
}
.tf-dot {
  flex-shrink: 0;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--aide-accent);
  opacity: 0.85;
  animation: tf-breathe 1.7s ease-in-out infinite;
}
@keyframes tf-breathe {
  0%, 100% { opacity: 0.35; transform: scale(0.85); }
  50%      { opacity: 0.95; transform: scale(1.15); }
}

/* ── 行 2：全部统计量 ── */
.tf-nums {
  display: flex;
  align-items: baseline;
  gap: 10px;
  max-width: 480px; /* 不封顶则数字与条之间裂出几百像素空带（宽窗最终形态待定，spec §11） */
}
.tf-nums .tf-unit {
  margin-right: 5px;
}
.tf-unit {
  font-size: 13px;
  color: var(--aide-text-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.tf-unit-n {
  font-family: var(--aide-font-mono);
  color: var(--aide-text-primary);
  font-weight: 600;
  font-size: 14px;
}
.tf-unit--end {
  margin-left: auto;
}
.tf-big {
  font-family: var(--aide-font-mono);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1;
  font-size: 19px;
}
.tf-big--add { color: var(--aide-success); }
.tf-big--del { color: var(--aide-danger); }

/* ── 比例条：绿=加、红=删，按行数分**比例**（不是量级）。长度恒定、贴右端、右端不挂文字 ── */
.tf-bar {
  display: flex;
  gap: 1.5px;
  height: 5px;
  border-radius: 99px;
  background: var(--aide-surface-hover); /* surface-default 太淡：纯新增轮会变成一根凭空浮着的绿线 */
  overflow: hidden;
  min-width: 0;
  align-self: center;
  flex: 0 1 230px;
  margin-left: auto;
}
.tf-bar-seg {
  display: block;
  border-radius: 99px;
  min-width: 2px; /* −1 行也看得见（flex-grow/shrink/basis 由行内 style 给） */
}
.tf-bar-seg--add { background: var(--aide-success); opacity: 0.9; }
.tf-bar-seg--del { background: var(--aide-danger); opacity: 0.9; }

/* ── 展开按钮 / 箭头（border 三角同 ProcessGroup：字符 ▾ 与 emoji 换字体就变形） ── */
.tf-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  border: 1px solid var(--aide-border);
  border-radius: 99px;
  background: var(--aide-surface-default);
  color: var(--aide-text-secondary);
  font-size: 11px;
  padding: 3px 10px;
  font-family: var(--aide-font-ui);
  white-space: nowrap;
  cursor: pointer;
}
.tf:not(.tf--live):hover .tf-pill {
  background: var(--aide-surface-hover);
  border-color: var(--aide-border-strong);
  color: var(--aide-text-primary);
}
.tf-caret {
  flex-shrink: 0;
  width: 0;
  height: 0;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  border-left: 5px solid currentColor;
  opacity: 0.7;
  transition: transform var(--aide-ease-t);
}
.tf-caret--down {
  transform: rotate(90deg);
}

/* ── 面板入口：沿用变更卡头部「打开 ↗」的既有形制（11px accent 无底无边） ── */
.tf-panel-link {
  flex-shrink: 0;
  background: none;
  border: 0;
  padding: 0;
  color: var(--aide-accent);
  font-size: 11px;
  font-family: var(--aide-font-ui);
  white-space: nowrap;
  cursor: pointer;
}
.tf-panel-link:hover {
  text-decoration: underline;
}

/* ── 展开体 ── */
.tf-body {
  margin-top: 8px; /* 原型逐字；若真机观感偏大，属形态微调，需先拍板 */
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-md);
  padding: 3px 0;
}

@media (prefers-reduced-motion: reduce) {
  .tf-dot { animation: none; }
  .tf-caret { transition: none; }
}
</style>
