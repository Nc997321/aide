<script setup lang="ts">
import { computed } from "vue";
import ThinkingMark from "./ThinkingMark.vue";
import InterruptButton from "../InterruptButton.vue";
import ContextCompactionStatus from "../ContextCompactionStatus.vue";
import UsageTipText from "../ChatPanel/UsageTipText.vue";
import type { UsageTip } from "../ChatPanel/usageTips";
import type { ContextCompactionState } from "@/types/chat";
import type { ActivityChip, ActivityChipTarget } from "./activityChips";

/**
 * 活动带（2026-10-16 会话组成重排）：一行装下「此刻在进行中的东西」——
 * 左：活动状态（压缩中 / 正在思考 + 计时 + 轮换提示）；中：每类后台活一个 chip
 * （子会话 / 子代理 / 后台任务，点开活动抽屉的对应 tab）；右：中断。
 *
 * 取代原来竖着堆的三条（思考行、子代理状态条、后台任务条）。没有任何内容时整条不渲染、
 * 不占高度。「有待确认卡片时不显示正在思考」由调用方算进 thinking（会话在等用户，不是在想）。
 *
 * 「正在思考」主体已搬到消息流末尾（ThinkingLine，跟着回答走）；这里在忙时照样占位（中断要够得着），
 * 只在那一行被翻出可视区时（thinkingLabel）亮出精简的「思考中 12s」（淡入）。
 * 那一行看得见时这里**整块不渲染**（2026-10-17）：原先只调透明度、隐身的「思考中」仍占宽度，
 * 把后台 chip 挤到右边、还留一条孤立分隔线。整条高度由 min-height 兜，不跳；
 * 字样出现时 chip 横移一次，代价可接受。
 */
const props = defineProps<{
  compaction: ContextCompactionState | null;
  thinking: boolean;
  /** 是否显示「思考中」字样（消息流末尾那行看不见时才要）；缺省显示 */
  thinkingLabel?: boolean;
  /** 状态词（与消息流末尾那行同一个，见 ChatPanel/workingVerbs.ts）；缺省「处理中」 */
  label?: string;
  elapsedSeconds: number;
  tip: UsageTip | null;
  chips: ActivityChip[];
}>();

const emit = defineEmits<{
  interrupt: [];
  toggle: [tab: ActivityChipTarget];
}>();

const compacting = computed(() => props.compaction?.stage === "compacting");
const showInterrupt = computed(() => compacting.value || (!props.compaction && props.thinking));
const visible = computed(() => !!props.compaction || props.thinking || props.chips.length > 0);
/** 「思考中」字样此刻要不要占位：只有消息流末尾那行看不见时才要 */
const showThinking = computed(() => props.thinking && props.thinkingLabel !== false);
</script>

<template>
  <div v-if="visible" class="astrip">
    <ContextCompactionStatus
      v-if="compaction"
      inline
      :status="compaction"
      :elapsed-seconds="elapsedSeconds"
    />
    <div v-else-if="showThinking" class="astrip-thinking">
      <ThinkingMark :size="16" />
      <span class="astrip-thinking-text">{{ label ?? "处理中" }}</span>
      <span class="astrip-elapsed">{{ elapsedSeconds }}s</span>
      <Transition name="astrip-tip" mode="out-in">
        <UsageTipText v-if="tip" :key="tip.id" class="astrip-tip" :text="tip.text" />
      </Transition>
    </div>

    <div v-if="chips.length" class="astrip-chips" :class="{ 'astrip-chips--alone': !compaction && !showThinking }">
      <button
        v-for="chip in chips"
        :key="chip.tab"
        type="button"
        class="astrip-chip"
        :class="[`astrip-chip--${chip.tone}`, { 'astrip-chip--open': chip.open }]"
        :aria-expanded="chip.open"
        v-tooltip="chip.title"
        @click="emit('toggle', chip.tab)"
      >
        <span class="astrip-chip-dot" aria-hidden="true"></span>
        <span>{{ chip.label }}</span>
        <span v-if="chip.running !== null" class="astrip-chip-n">{{ chip.running }}</span>
        <span v-else class="astrip-chip-state">{{ chip.stateText ?? (chip.tone === "err" ? "有失败" : "已完成") }}</span>
        <span v-if="chip.note" class="astrip-chip-note">{{ chip.note }}</span>
      </button>
    </div>

    <InterruptButton v-if="showInterrupt" class="astrip-interrupt" @click="emit('interrupt')" />
  </div>
</template>

<style scoped>
.astrip {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 34px;
  /* 左右 10px：内容与输入框下方状态行的文字（「自动模式」/ 模型）对齐，输入框上下两行同一条边 */
  padding: 4px 10px;
  font-size: 12px;
  color: var(--aide-text-muted);
}

.astrip-thinking {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 0 1 auto;
  animation: astrip-fade-in .2s var(--aide-ease);
}
@keyframes astrip-fade-in {
  from { opacity: 0; }
}

.astrip-thinking-text {
  position: relative;
  flex-shrink: 0;
  font-weight: 500;
  background: linear-gradient(
    90deg,
    var(--aide-text-muted) 0%,
    var(--aide-text-muted) 33%,
    var(--aide-agent-accent) 50%,
    var(--aide-text-muted) 67%,
    var(--aide-text-muted) 100%
  );
  background-size: 300% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: astrip-shimmer 2.5s linear infinite;
}

@keyframes astrip-shimmer {
  0% { background-position: 100% center; }
  100% { background-position: 0% center; }
}

.astrip-elapsed {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}

/* 轮换提示：窄了就省略号，不挤 chip 与中断钮 */
.astrip-tip {
  margin-left: 6px;
  min-width: 0;
  overflow: hidden;
}

.astrip-tip-enter-active,
.astrip-tip-leave-active {
  transition: opacity .4s var(--aide-ease);
}
.astrip-tip-enter-from,
.astrip-tip-leave-to {
  opacity: 0;
}

.astrip-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding-left: 10px;
  border-left: 1px solid var(--aide-border);
}
.astrip-chips--alone {
  padding-left: 0;
  border-left: 0;
}

.astrip-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px;
  border-radius: 12px;
  border: 1px solid var(--aide-border);
  background: var(--aide-bg-raised);
  color: var(--aide-text-secondary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: border-color var(--aide-ease-t), background var(--aide-ease-t);
}
.astrip-chip:hover {
  background: var(--aide-surface-hover);
}
.astrip-chip--open {
  border-color: var(--aide-border-strong);
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
}

.astrip-chip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--aide-text-muted);
}
.astrip-chip--run .astrip-chip-dot {
  background: var(--aide-success);
  animation: astrip-pulse 1.4s infinite;
}
.astrip-chip--err .astrip-chip-dot {
  background: var(--aide-danger);
}
.astrip-chip--attn {
  border-color: color-mix(in srgb, var(--aide-warning) 45%, var(--aide-border));
}
.astrip-chip--attn .astrip-chip-dot {
  background: var(--aide-warning);
  animation: astrip-pulse 1.4s infinite;
}
.astrip-chip-note {
  font-size: 11px;
  color: var(--aide-warning);
}

@keyframes astrip-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .35; }
}

.astrip-chip-n {
  font-family: var(--aide-font-mono);
  font-size: 11px;
  color: var(--aide-accent);
}
.astrip-chip-state {
  font-size: 11px;
  color: var(--aide-text-muted);
}
.astrip-chip--err .astrip-chip-state {
  color: var(--aide-danger);
}

.astrip-interrupt {
  margin-left: auto;
}

@media (prefers-reduced-motion: reduce) {
  .astrip-thinking,
  .astrip-thinking-text {
    animation: none;
    background: var(--aide-text-muted);
    -webkit-background-clip: initial;
    background-clip: initial;
    -webkit-text-fill-color: initial;
  }
  .astrip-chip--run .astrip-chip-dot,
  .astrip-chip--attn .astrip-chip-dot {
    animation: none;
  }
  .astrip-tip-enter-active,
  .astrip-tip-leave-active {
    transition: none;
  }
}
</style>
