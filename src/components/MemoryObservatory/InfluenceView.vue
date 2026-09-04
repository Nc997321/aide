<script setup lang="ts">
/**
 * 影响 tab：可达性分级（L0~L3，纯 scan 推导）+ 使用统计（事件台账聚合：
 * 本周新增/使用、使用与 Learning 趋势、最常用 TOP5、最近活动、本次任务 chip）。
 * 聚合逻辑全部在 observatory.ts 纯函数层，这里只做呈现。
 */
import { computed } from "vue";
import type { MemoryEvent, MemoryScanResult } from "@aide/sdk/api";
import {
  reachLevels,
  weeklyCounts,
  dailyCounts,
  topUsed,
  recentActivity,
  sessionMemoryIds,
  sessionsOfMemory,
  usageByMemory,
  fmtDay,
  type DayCount,
  type ReachLevels,
} from "./observatory";

const props = defineProps<{
  scan: MemoryScanResult;
  events: MemoryEvent[];
  sessionNames: Record<string, string>;
  currentSessionId?: string | null;
  /** P2 全局模式：可达性分级由父级 sumReachLevels 汇总后传入（合成 scan 的窗口语义不成立）。 */
  reachOverride?: ReachLevels | null;
  /** P2 全局模式：workspaceKey → 项目显示名，活动 feed 标注来源项目。 */
  projectNames?: Record<string, string>;
  showProject?: boolean;
}>();

// ── 可达性分级 ──
const reach = computed(() => props.reachOverride ?? reachLevels(props.scan));
const reachRows = computed(() => {
  const r = reach.value;
  const total = r.l0 + r.l1.length + r.l2.length + r.l3.length || 1;
  return [
    { key: "l0", label: "L0 · 常驻", desc: "CLAUDE.md + 截断窗口内索引，每会话必达", n: r.l0, cls: "lv0" },
    { key: "l1", label: "L1 · 可达", desc: "窗口内索引引用，可按需加载", n: r.l1.length, cls: "lv1" },
    { key: "l2", label: "L2 · 半衰", desc: "索引引用在截断线外，实际不可达", n: r.l2.length, cls: "lv2" },
    { key: "l3", label: "L3 · 沉没", desc: "孤儿：无索引引用，永远不会被看到", n: r.l3.length, cls: "lv3" },
  ].map((x) => ({ ...x, pct: Math.round((x.n / total) * 100) }));
});

// ── 使用统计 ──
const week = computed(() => weeklyCounts(props.events));
const totalReads = computed(() => {
  let n = 0;
  for (const s of usageByMemory(props.events).values()) n += s.reads;
  return n;
});
const useTrend = computed(() => dailyCounts(props.events, ["read"]));
const learnTrend = computed(() => dailyCounts(props.events, ["created", "updated"]));
const top5 = computed(() =>
  topUsed(props.events, 5).map((t) => ({
    ...t,
    sessions: sessionsOfMemory(props.events, t.memoryId).size,
  })),
);
const activity = computed(() => recentActivity(props.events, 12));

const sessionChip = computed(() => {
  if (!props.currentSessionId) return null;
  const ids = sessionMemoryIds(props.events, props.currentSessionId);
  if (ids.size === 0) return null;
  return { count: ids.size, names: [...ids].map((n) => n.replace(/\.md$/, "")) };
});

function sessionLabel(id: string): string {
  if (!id) return "";
  return props.sessionNames[id] ?? `${id.slice(0, 8)}…`;
}

function projectLabel(key: string): string {
  return props.projectNames?.[key] ?? key;
}

const OP_META: Record<string, { sym: string; cls: string; label: string }> = {
  read: { sym: "→", cls: "read", label: "读取" },
  created: { sym: "+", cls: "add", label: "新增" },
  updated: { sym: "~", cls: "mod", label: "更新" },
  deleted: { sym: "−", cls: "del", label: "删除" },
};
function opMeta(op: string) {
  return OP_META[op] ?? { sym: "·", cls: "", label: op };
}

// ── 迷你趋势图（手绘 SVG，与演化 tab 同路子）──
const W = 360;
const H = 110;
const PAD = 6;

function sparkline(pts: DayCount[]) {
  if (pts.length === 0) return null;
  const max = Math.max(...pts.map((p) => p.count), 1);
  const xs = (i: number) => (pts.length === 1 ? W / 2 : (i / (pts.length - 1)) * (W - PAD * 2) + PAD);
  const ys = (c: number) => H - PAD - (c / max) * (H - PAD * 2 - 14);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${xs(i).toFixed(1)},${ys(p.count).toFixed(1)}`).join(" ");
  const area = `${line} L${xs(pts.length - 1).toFixed(1)},${H - PAD} L${xs(0).toFixed(1)},${H - PAD} Z`;
  return { line, area, first: pts[0].day, last: pts[pts.length - 1].day };
}
const useChart = computed(() => sparkline(useTrend.value));
const learnChart = computed(() => sparkline(learnTrend.value));
</script>

<template>
  <div>
    <!-- 本次任务 chip -->
    <div v-if="sessionChip" class="session-chip">
      本次任务使用了 <b>{{ sessionChip.count }}</b> 条记忆
      <span class="names">{{ sessionChip.names.join("、") }}</span>
    </div>

    <!-- 可达性分级 -->
    <div class="section-label">可达性 · 记忆在会话里的真实能见度</div>
    <div class="reach-bar">
      <i
        v-for="r in reachRows"
        :key="r.key"
        :class="r.cls"
        :style="{ width: `${Math.max(r.pct, r.n > 0 ? 2 : 0)}%` }"
        v-tooltip="`${r.label} · ${r.n} 条`"
      />
    </div>
    <div class="reach-rows">
      <div v-for="r in reachRows" :key="r.key" class="reach-row">
        <span class="lv-dot" :class="r.cls" />
        <span class="lv-label">{{ r.label }}</span>
        <span class="lv-desc">{{ r.desc }}</span>
        <span class="lv-n">{{ r.n }}</span>
      </div>
    </div>

    <!-- 使用统计 -->
    <div class="section-label">使用 · 来自实时事件台账</div>
    <template v-if="events.length > 0">
      <div class="stats">
        <div class="stat">
          <div class="v">{{ week.created }}</div>
          <div class="l">本周新增</div>
        </div>
        <div class="stat">
          <div class="v">{{ week.used }}</div>
          <div class="l">本周使用</div>
        </div>
        <div class="stat">
          <div class="v">{{ totalReads }}</div>
          <div class="l">累计使用</div>
        </div>
      </div>

      <div class="charts">
        <div class="chart-wrap">
          <div class="chart-title">使用趋势 · 按天读取</div>
          <svg v-if="useChart" :viewBox="`0 0 ${W} ${H}`" width="100%" height="110" preserveAspectRatio="none">
            <path class="area a-use" :d="useChart.area" />
            <path class="line l-use" :d="useChart.line" />
          </svg>
          <div v-else class="empty">暂无读取事件</div>
        </div>
        <div class="chart-wrap">
          <div class="chart-title">Learning 趋势 · 新增 + 更新</div>
          <svg v-if="learnChart" :viewBox="`0 0 ${W} ${H}`" width="100%" height="110" preserveAspectRatio="none">
            <path class="area a-learn" :d="learnChart.area" />
            <path class="line l-learn" :d="learnChart.line" />
          </svg>
          <div v-else class="empty">暂无写入事件</div>
        </div>
      </div>

      <div class="cols">
        <div>
          <div class="sub-label">最常用 · TOP 5</div>
          <div v-if="top5.length === 0" class="empty">还没有使用记录</div>
          <div v-for="t in top5" :key="t.memoryId" class="item">
            <span class="reads">{{ t.reads }}×</span>
            <span class="nm">{{ t.memoryId.replace(/\.md$/, "") }}</span>
            <span class="meta">{{ t.sessions }} 会话 · {{ fmtDay(t.lastTs) }}</span>
          </div>
        </div>
        <div>
          <div class="sub-label">最近活动</div>
          <div v-for="(e, i) in activity" :key="`${e.ts}-${i}`" class="item">
            <span class="op" :class="opMeta(e.op).cls">{{ opMeta(e.op).sym }}</span>
            <span class="nm">{{ e.memoryId.replace(/\.md$/, "") }}</span>
            <span class="meta">
              <template v-if="showProject && e.workspaceKey">[{{ projectLabel(e.workspaceKey) }}] </template>
              <template v-if="e.sessionId">{{ sessionLabel(e.sessionId) }} · </template>{{ fmtDay(e.ts) }}
            </span>
          </div>
        </div>
      </div>
    </template>
    <div v-else class="empty-block">
      还没有使用事件。事件台账由 sidecar 的 PostToolUse hook 实时埋点，
      在新会话里读写记忆后，这里会出现使用趋势与最常用排行。
    </div>
  </div>
</template>

<style scoped>
.session-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 5px 13px;
  border-radius: 999px;
  border: 1px solid var(--aide-accent);
  color: var(--aide-accent);
  font-size: 12px;
  margin-bottom: 20px;
}
.session-chip b { font-variant-numeric: tabular-nums; }
.session-chip .names { color: var(--aide-text-muted); font-size: 11px; }

.section-label { font-size: 11px; color: var(--aide-text-muted); letter-spacing: 0.05em; margin: 0 0 10px; }
.section-label:not(:first-child) { margin-top: 26px; }
.session-chip + .section-label { margin-top: 0; }

.reach-bar {
  display: flex;
  height: 6px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--aide-surface-active);
  margin-bottom: 12px;
}
.reach-bar i { display: block; height: 100%; }
.reach-bar .lv0 { background: var(--aide-accent); }
.reach-bar .lv1 { background: var(--aide-success); }
.reach-bar .lv2 { background: var(--aide-info); }
.reach-bar .lv3 { background: var(--aide-warning); }

.reach-rows { display: flex; flex-direction: column; }
.reach-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 6px 2px;
  border-bottom: 1px solid var(--aide-border-subtle);
  font-size: 12.5px;
}
.reach-row:last-child { border-bottom: none; }
.lv-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; align-self: center; }
.lv-dot.lv0 { background: var(--aide-accent); }
.lv-dot.lv1 { background: var(--aide-success); }
.lv-dot.lv2 { background: var(--aide-info); }
.lv-dot.lv3 { background: var(--aide-warning); }
.lv-label { color: var(--aide-text-primary); font-weight: 500; width: 76px; flex-shrink: 0; }
.lv-desc { color: var(--aide-text-muted); font-size: 11.5px; flex: 1; min-width: 0; }
.lv-n { color: var(--aide-text-primary); font-variant-numeric: tabular-nums; font-family: ui-monospace, Consolas, monospace; }

.stats { display: flex; gap: 44px; margin-bottom: 18px; }
.stat .v { font-size: 24px; font-weight: 600; color: var(--aide-text-primary); font-variant-numeric: tabular-nums; }
.stat .l { font-size: 11px; color: var(--aide-text-secondary); margin-top: 2px; }

.charts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
.chart-wrap {
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-md);
  padding: 12px 14px 4px;
  background: var(--aide-surface-default);
}
.chart-title { font-size: 11.5px; color: var(--aide-text-secondary); margin-bottom: 4px; }
.area { opacity: 0.14; }
.a-use { fill: var(--aide-accent); }
.l-use { fill: none; stroke: var(--aide-accent); stroke-width: 1.5; }
.a-learn { fill: var(--aide-success); }
.l-learn { fill: none; stroke: var(--aide-success); stroke-width: 1.5; }

.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.sub-label { font-size: 11px; color: var(--aide-text-muted); letter-spacing: 0.05em; margin-bottom: 8px; }
.item {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 6px 2px;
  border-bottom: 1px solid var(--aide-border-subtle);
  font-size: 12.5px;
}
.item:last-of-type { border-bottom: none; }
.reads {
  color: var(--aide-accent);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11.5px;
  width: 34px;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.op { width: 16px; flex-shrink: 0; font-family: ui-monospace, Consolas, monospace; }
.op.read { color: var(--aide-info); }
.op.add { color: var(--aide-success); }
.op.mod { color: var(--aide-warning); }
.op.del { color: var(--aide-danger); }
.nm { color: var(--aide-text-primary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { color: var(--aide-text-muted); font-size: 11px; flex-shrink: 0; }

.empty { color: var(--aide-text-muted); font-size: 12px; padding: 12px 0; }
.empty-block {
  color: var(--aide-text-muted);
  font-size: 12.5px;
  line-height: 1.7;
  padding: 18px;
  border: 1px dashed var(--aide-border);
  border-radius: var(--aide-radius-md);
}
</style>
