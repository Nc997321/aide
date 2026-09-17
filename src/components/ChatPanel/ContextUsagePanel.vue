<script setup lang="ts">
/**
 * ContextUsagePanel —— 上下文用量的会话体检弹层（usage.html 原型移植）。
 *
 * 结构：header（标题+关闭）/ 大百分比+已用上限 / 分段彩条（ContextUsageSegments，
 * 含保留区条纹段）/ 分类明细列表（dot 色与分段同源）/ 5h 额度环（压缩入口在发送分裂按钮的命令菜单，不在此重复）。
 *
 * 定位与关闭复用 ThemedSelect/ChatSendButton 已验证的方案：Teleport to body +
 * position fixed，从 anchor（环形指示）位置向上展示；close 按钮 / 点击外部 / Esc
 * 三路关闭（Esc 带消费标记，避免同时触发别处 Esc 负面动作）。面板不自治开关：
 * 打开/卸载由父 v-if 管理，三路关闭统一 emit close。全配色走 var(--aide-*)。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import type { ContextUsage, RateLimitInfo } from "@/types/chat";
import ContextUsageSegments from "./ContextUsageSegments.vue";
import ContextUsageBreakdown from "./ContextUsageBreakdown.vue";
import { chartVarFor, formatTokens, clampPct } from "./contextUsage";

const props = defineProps<{
  /** 会话的上下文用量快照；null 时显示占位（旧 sidecar 降级态）。 */
  usage: ContextUsage | null;
  /** 锚定元素（发送按钮左侧的环形指示）；用于落位。 */
  anchor: HTMLElement | null;
  /** 订阅额度窗口（5h/7d…），无窗口时额度环区隐藏。 */
  rateLimit?: RateLimitInfo | null;
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();

const panelRef = ref<HTMLElement>();
const positioned = ref(false); // 定位算完前先隐藏，避免在 (0,0) 闪一帧
const panelStyle = ref<Record<string, string>>({});

async function position() {
  await nextTick();
  const panel = panelRef.value;
  const anchor = props.anchor;
  if (!panel || !anchor) return;
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const spaceBelow = window.innerHeight - rect.bottom;
  // 下方空间不足则向上弹（输入框贴底时常态）。向上弹**锚 bottom 而不是算死 top**：
  // 「占用来源」区可以展开，面板高度在打开之后还会变——锚 bottom 时长高只向上伸
  // （伸进当初判定过"更宽裕"的上方），锚 top 则会把底边一路推下去盖住输入框。
  const openUp = spaceBelow < height + margin && rect.top > spaceBelow;
  let left = rect.left;
  if (left + width > window.innerWidth - margin) {
    left = window.innerWidth - width - margin;
  }
  const leftPx = `${Math.max(margin, left)}px`;
  panelStyle.value = openUp
    ? { bottom: `${Math.max(margin, window.innerHeight - rect.top + 6)}px`, left: leftPx }
    : { top: `${rect.bottom + 6}px`, left: leftPx };
  positioned.value = true;
}

// ---- 大百分比区 ----
const pct = computed(() => clampPct(props.usage?.percentage ?? 0));
const detailText = computed(() => {
  const u = props.usage;
  return u ? `${formatTokens(u.totalTokens)} / ${formatTokens(u.maxTokens)}` : "";
});

// ---- 明细列表（dot 色 = 分段同源，chartVarFor 单一来源）----
const detailRows = computed(() =>
  (props.usage?.categories ?? [])
    .filter((c) => c.tokens > 0)
    .map((c) => ({
      name: c.name,
      tokens: c.tokens,
      color: chartVarFor(c.name),
      isDeferred: c.isDeferred ?? false,
    })),
);

// ---- 额度环（承接 RateLimitInfo；状态色语义与既有额度徽标一致） ----
const RING_CIRC = 2 * Math.PI * 15;
const rateWindows = computed(() =>
  (props.rateLimit?.windows ?? []).map((w) => {
    const p = clampPct(w.utilization);
    return {
      key: w.key,
      label: w.label,
      pct: Math.round(p),
      status: p >= 100 ? "danger" : p >= 80 ? "warning" : "ok",
      dashOffset: RING_CIRC * (1 - p / 100),
    };
  }),
);

function close() {
  emit("close");
}

function onDocPointer(e: PointerEvent) {
  const target = e.target as Node;
  // 面板内 / 锚定元素（环形）内不关：点环形归 ChatInputBox 的 open 语义
  // （open-only 非 toggle），这里豁免是为了不吞成「外点关了、open 又开」闪烁
  if (panelRef.value?.contains(target) || props.anchor?.contains(target)) return;
  close();
}

function onKeydown(e: KeyboardEvent) {
  // 消费标记：Esc 开着时只关本面板，不连带触发别处（权限弹窗等）的负面动作
  if (e.key === "Escape") {
    e.preventDefault();
    close();
  }
}

watch(
  () => props.anchor,
  async (v) => {
    if (v) {
      positioned.value = false;
      await position();
    }
  },
  { immediate: true },
);

onMounted(() => {
  document.addEventListener("pointerdown", onDocPointer, true);
  document.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", position);
});

onUnmounted(() => {
  document.removeEventListener("pointerdown", onDocPointer, true);
  document.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", position);
});
</script>

<template>
  <Teleport to="body">
    <div
      ref="panelRef"
      class="usage-panel"
      :style="[panelStyle, positioned ? {} : { visibility: 'hidden' }]"
      role="dialog"
      aria-label="上下文用量"
    >
      <div class="usage-panel__header">
        <span class="usage-panel__title">上下文用量</span>
        <button type="button" class="usage-panel__close" aria-label="关闭" @click="close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>

      <div class="usage-panel__stats">
        <span class="usage-panel__percent">{{ Math.round(pct) }}%</span>
        <span class="usage-panel__detail">已使用 {{ detailText }}</span>
      </div>

      <div class="usage-panel__bar">
        <ContextUsageSegments v-if="usage" :usage="usage" />
      </div>

      <div class="usage-panel__list" v-if="detailRows.length">
        <div class="usage-panel__item" v-for="r in detailRows" :key="r.name">
          <span
            class="usage-panel__dot"
            :class="{ 'is-deferred': r.isDeferred }"
            :style="{ background: r.color }"
          />
          <span class="usage-panel__name">{{ r.name }}</span>
          <span class="usage-panel__value">{{ formatTokens(r.tokens) }}</span>
        </div>
      </div>
      <div class="usage-panel__list usage-panel__empty" v-else>
        <span class="usage-panel__value">暂无占用明细</span>
      </div>

      <!-- 占用来源：分类列表之外的第二个切面（这些 token 是谁的）。缺席（旧
           sidecar / provider 未提供明细）时整块不渲染，面板其余部分照常。 -->
      <ContextUsageBreakdown v-if="usage?.breakdown" :breakdown="usage.breakdown" />

      <div class="usage-panel__footer" v-if="rateWindows.length">
        <div class="usage-panel__rates">
          <div
            class="usage-panel__rate"
            v-for="w in rateWindows"
            :key="w.key"
            v-tooltip="`${w.label} 额度已用 ${w.pct}%`"
          >
            <svg width="18" height="18" viewBox="0 0 36 36" :class="`usage-panel__ring usage-panel__ring--${w.status}`">
              <circle cx="18" cy="18" r="15" fill="none" stroke-width="3" class="usage-panel__ring-track" />
              <circle
                cx="18" cy="18" r="15" fill="none" stroke-width="3" stroke-linecap="round"
                class="usage-panel__ring-arc"
                :stroke-dasharray="RING_CIRC" :stroke-dashoffset="w.dashOffset" transform="rotate(-90 18 18)"
              />
            </svg>
            <span class="usage-panel__rate-label">{{ w.label }}</span>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.usage-panel {
  position: fixed;
  z-index: 1000;
  width: 320px;
  padding: 16px;
  border-radius: var(--aide-radius-lg);
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border);
  box-shadow: var(--aide-shadow-lg);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
}

.usage-panel__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.usage-panel__title {
  font-size: 14px;
  font-weight: 500;
  color: var(--aide-text-primary);
}
.usage-panel__close {
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px;
  border-radius: var(--aide-radius-sm);
  color: var(--aide-text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background var(--aide-ease-t), color var(--aide-ease-t);
}
.usage-panel__close:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}

.usage-panel__stats {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 10px;
}
.usage-panel__percent {
  font-size: 26px;
  font-weight: 500;
  color: var(--aide-text-primary);
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.usage-panel__detail {
  font-size: 12px;
  color: var(--aide-text-muted);
  font-variant-numeric: tabular-nums;
}

.usage-panel__bar {
  margin-bottom: 14px;
}

.usage-panel__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}
.usage-panel__empty {
  align-items: center;
  justify-content: center;
  padding: 6px 0;
}
.usage-panel__item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.usage-panel__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.usage-panel__dot.is-deferred {
  opacity: 0.6;
}
.usage-panel__name {
  color: var(--aide-text-primary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.usage-panel__value {
  color: var(--aide-text-muted);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}

.usage-panel__footer {
  display: flex;
  align-items: center;
  margin-top: 4px;
  padding-top: 10px;
  border-top: 1px solid var(--aide-border-subtle);
}
.usage-panel__rates {
  display: flex;
  gap: 12px;
}
.usage-panel__rate {
  display: flex;
  align-items: center;
  gap: 5px;
}
.usage-panel__rate-label {
  font-size: 11px;
  color: var(--aide-text-muted);
}
.usage-panel__ring-track {
  stroke: var(--aide-border-strong);
}
.usage-panel__ring-arc {
  stroke: var(--aide-success);
  transition: stroke-dashoffset var(--aide-ease-t);
}
.usage-panel__ring--warning .usage-panel__ring-arc {
  stroke: var(--aide-warning);
}
.usage-panel__ring--danger .usage-panel__ring-arc {
  stroke: var(--aide-danger);
}
</style>