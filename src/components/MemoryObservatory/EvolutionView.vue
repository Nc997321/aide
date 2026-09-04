<script setup lang="ts">
/**
 * 演化 tab：生长曲线（按创建日累积，SVG 手绘不引图表库）+ 最近变化 +
 * 快照 diff（与上次打开观测台相比）+ 停滞提示。
 */
import { computed } from "vue";
import type { MemoryScanResult, MemorySnapshotDiff } from "@aide/sdk/api";
import { growthCurve, recentChanges, daysSinceLatest, fmtDay } from "./observatory";

const props = defineProps<{ scan: MemoryScanResult; diff: MemorySnapshotDiff | null; hideDiff?: boolean }>();

const curve = computed(() => growthCurve(props.scan.topics));
const changes = computed(() => recentChanges(props.scan.topics));
const stagnantDays = computed(() => daysSinceLatest(props.scan.topics));

const oldestDays = computed(() => {
  const oldest = props.scan.topics.reduce<number | null>((acc, t) => {
    const ms = t.createdMs ?? t.modifiedMs;
    return ms != null && (acc == null || ms < acc) ? ms : acc;
  }, null);
  return oldest == null ? null : Math.floor((Date.now() - oldest) / 86400_000);
});

// ── 生长曲线 SVG 路径 ──
const W = 800;
const H = 180;
const PAD = 8;

const chart = computed(() => {
  const pts = curve.value;
  if (pts.length === 0) return null;
  const max = Math.max(...pts.map((p) => p.count), 1);
  const xs = (i: number) => (pts.length === 1 ? W / 2 : (i / (pts.length - 1)) * (W - PAD * 2) + PAD);
  const ys = (c: number) => H - PAD - (c / max) * (H - PAD * 2 - 20);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${xs(i).toFixed(1)},${ys(p.count).toFixed(1)}`).join(" ");
  const area = `${line} L${xs(pts.length - 1).toFixed(1)},${H - PAD} L${xs(0).toFixed(1)},${H - PAD} Z`;
  const gridY = [0.25, 0.5, 0.75].map((f) => (PAD + f * (H - PAD * 2)).toFixed(1));
  const first = pts[0].day;
  const last = pts[pts.length - 1].day;
  return { line, area, gridY, first, last, endX: xs(pts.length - 1), endY: ys(pts[pts.length - 1].count) };
});
</script>

<template>
  <div>
    <div class="chart-wrap">
      <div class="chart-title">
        记忆生长 · {{ chart ? `${chart.first} → ${chart.last}` : "无数据" }}
      </div>
      <svg v-if="chart" :viewBox="`0 0 ${W} ${H}`" width="100%" height="180" preserveAspectRatio="none">
        <g class="grid">
          <line v-for="y in chart.gridY" :key="y" x1="0" :y1="y" :x2="W" :y2="y" />
        </g>
        <path class="area" :d="chart.area" />
        <path class="line" :d="chart.line" />
        <circle class="end" :cx="chart.endX" :cy="chart.endY" r="3" />
      </svg>
      <div v-else class="empty">还没有记忆</div>
    </div>

    <div class="cols" :class="{ single: hideDiff }">
      <div>
        <div class="section-label">最近变化 · 7 天</div>
        <div v-if="changes.length === 0" class="empty">近 7 天无变化</div>
        <div v-for="c in changes" :key="`${c.op}-${c.name}-${c.ts}`" class="evo-item">
          <span class="when">{{ fmtDay(c.ts) }}</span>
          <span class="op" :class="c.op === 'created' ? 'add' : 'mod'">{{ c.op === "created" ? "+" : "~" }}</span>
          <span class="nm">{{ c.name.replace(/\.md$/, "") }}</span>
        </div>
      </div>
      <div v-if="!hideDiff">
        <div class="section-label">
          距上次观测
          <span v-if="diff?.previousTs" class="muted">· 快照 diff</span>
        </div>
        <template v-if="diff?.previousTs">
          <div class="evo-item"><span class="op add">+{{ diff.added.length }}</span><span class="nm">新增记忆</span></div>
          <div class="evo-item"><span class="op mod">~{{ diff.modified.length }}</span><span class="nm">被修订</span></div>
          <div class="evo-item"><span class="op del">−{{ diff.removed.length }}</span><span class="nm">消失</span></div>
        </template>
        <div v-else class="empty">首次观测，已建立基线快照</div>
        <div v-if="stagnantDays != null" class="stale">
          最近新记忆 <b>{{ stagnantDays }} 天前</b>
          <template v-if="oldestDays != null"> · 最老记忆 {{ oldestDays }} 天</template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chart-wrap {
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-md);
  padding: 14px 16px 6px;
  margin-bottom: 20px;
  background: var(--aide-surface-default);
}
.chart-title { font-size: 11.5px; color: var(--aide-text-secondary); margin-bottom: 6px; }
.grid line { stroke: var(--aide-border-subtle); stroke-width: 1; }
.area { fill: var(--aide-accent); opacity: 0.14; }
.line { fill: none; stroke: var(--aide-accent); stroke-width: 1.5; }
.end { fill: var(--aide-accent); }

.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.cols.single { grid-template-columns: 1fr; }
.section-label { font-size: 11px; color: var(--aide-text-muted); letter-spacing: 0.05em; margin-bottom: 8px; }
.section-label .muted { color: var(--aide-text-muted); opacity: 0.7; }
.evo-item {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 6px 2px;
  border-bottom: 1px solid var(--aide-border-subtle);
  font-size: 12.5px;
}
.evo-item:last-of-type { border-bottom: none; }
.when {
  color: var(--aide-text-muted);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11.5px;
  width: 42px;
  flex-shrink: 0;
}
.op { width: 20px; flex-shrink: 0; font-family: ui-monospace, Consolas, monospace; }
.op.add { color: var(--aide-success); }
.op.mod { color: var(--aide-warning); }
.op.del { color: var(--aide-danger); }
.nm { color: var(--aide-text-primary); }
.empty { color: var(--aide-text-muted); font-size: 12px; padding: 12px 0; }
.stale { margin-top: 10px; color: var(--aide-text-secondary); font-size: 12.5px; }
.stale b { color: var(--aide-text-primary); font-variant-numeric: tabular-nums; }
</style>
