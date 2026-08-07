<template>
  <div class="diagnostics-dashboard">
    <h3 class="section-title">Runtime 诊断</h3>

    <!-- Runtime 健康 -->
    <div class="card">
      <div class="card-header">Agent Runtime</div>
      <div class="stats-row">
        <div class="stat">
          <span class="stat-value">{{ health?.sessions?.active ?? 0 }}</span>
          <span class="stat-label">活跃会话</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ health?.sessions?.idle ?? 0 }}</span>
          <span class="stat-label">空闲会话</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ health?.processes?.claudeExeCount ?? 0 }}</span>
          <span class="stat-label">claude.exe 进程</span>
        </div>
      </div>
    </div>

    <!-- 累计费用 -->
    <div class="card">
      <div class="card-header">累计用量</div>
      <div class="stats-row">
        <div class="stat">
          <span class="stat-value">{{ fmtTokens(cumulativeInputTokens) }}</span>
          <span class="stat-label">输入 tokens</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ fmtTokens(cumulativeOutputTokens) }}</span>
          <span class="stat-label">输出 tokens</span>
        </div>
        <div class="stat">
          <span class="stat-value">${{ cumulativeCost.toFixed(4) }}</span>
          <span class="stat-label">费用 (USD)</span>
        </div>
      </div>

      <!-- 输入归因：SDK 按模型聚合、不按代理拆分，只能在轮级标注"本轮是否派了子代理"。
           这里把累计输入拆成"含子代理的轮次" vs "纯主会话轮次"——回答"25M 里有多少来自
           触发了子代理的轮次"，不声称知道子代理内部精确 token。子代理占比高时高亮提示。 -->
      <div class="breakdown" v-if="cumulativeInputTokens > 0">
        <div class="breakdown-row">
          <span class="bd-label">└ 含子代理轮次</span>
          <span class="bd-value" :class="{ hot: subagentShareHigh }">
            {{ fmtTokens(subagentTurnInputTokens) }}
            <span class="bd-pct" v-if="subagentSharePct > 0">({{ subagentSharePct }}%)</span>
          </span>
        </div>
        <div class="breakdown-row">
          <span class="bd-label">└ 纯主会话轮次</span>
          <span class="bd-value">{{ fmtTokens(soloInputTokens) }}</span>
        </div>
      </div>

      <!-- 按模型分桶：多模型会话（如子代理用了别的模型）才展开。单模型时 sidecar 不带 byModel。 -->
      <div class="by-model" v-if="modelEntries.length > 1">
        <div class="by-model-row" v-for="m in modelEntries" :key="m.id">
          <span class="bm-label" v-tooltip="m.id">{{ shortModel(m.id) }}</span>
          <span class="bm-value">{{ fmtTokens(m.inputTokens) }}</span>
        </div>
      </div>

      <!-- 子代理嵌套深度警告（runtime 超阈值时发 subagent_nesting_warning，warn-only 不拦截） -->
      <div class="nesting-warn" v-if="nestingWarning">
        ⚠ 子代理嵌套深度 {{ nestingWarning.depth }}（阈值 {{ nestingWarning.threshold }}）—成本会指数膨胀
      </div>
    </div>

    <!-- 速率限制 -->
    <div class="card" v-if="rateLimit?.windows?.length">
      <div class="card-header">速率限制</div>
      <div v-for="w in rateLimit.windows" :key="w.key" class="rate-limit-row">
        <span class="rl-label">{{ w.label }}</span>
        <div class="rl-bar-track">
          <div
            class="rl-bar-fill"
            :class="{ high: w.utilization > 80, critical: w.utilization > 95 }"
            :style="{ width: Math.min(w.utilization, 100) + '%' }"
          ></div>
        </div>
        <span class="rl-pct">{{ Math.round(w.utilization) }}%</span>
        <span class="rl-reset" v-if="w.resetsAt">{{ fmtReset(w.resetsAt) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useDiagnosticsDashboard } from "@/composables/useDiagnosticsDashboard";

const {
  runtimeHealth: health,
  cumulativeCost,
  cumulativeInputTokens,
  cumulativeOutputTokens,
  subagentTurnInputTokens,
  byModelCumulative,
  nestingWarning,
  rateLimit,
} = useDiagnosticsDashboard();

// 纯主会话轮次的输入 = 总输入 − 含子代理轮次的输入。
const soloInputTokens = computed(() => Math.max(0, cumulativeInputTokens.value - subagentTurnInputTokens.value));
// 含子代理轮次的输入占比（%），>60% 时高亮——提示"大头来自 fan-out"。
const subagentSharePct = computed(() =>
  cumulativeInputTokens.value > 0
    ? Math.round((subagentTurnInputTokens.value / cumulativeInputTokens.value) * 100)
    : 0,
);
const subagentShareHigh = computed(() => subagentSharePct.value > 60);

// byModel 分桶转成排序后的数组（按输入降序），只在多模型时展示。
const modelEntries = computed(() =>
  Object.entries(byModelCumulative.value)
    .map(([id, u]) => ({ id, inputTokens: u.inputTokens }))
    .sort((a, b) => b.inputTokens - a.inputTokens),
);

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

// wire model id 一般很长（claude-sonnet-5-20260101），展示时只保留末段可读部分。
function shortModel(id: string): string {
  const seg = id.split("/").pop() ?? id;
  return seg.length > 28 ? seg.slice(0, 28) + "…" : seg;
}

function fmtReset(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return "即将重置";
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h${mins % 60}m 后`;
  return `${mins}m 后`;
}
</script>

<style scoped>
.diagnostics-dashboard {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--aide-text-primary);
  margin: 0;
}

.card {
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-radius: 8px;
  padding: 12px;
}

.card-header {
  font-size: 12px;
  font-weight: 600;
  color: var(--aide-text-secondary);
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.stats-row {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 60px;
}

.stat-value {
  font-size: 18px;
  font-weight: 700;
  color: var(--aide-text-primary);
  font-variant-numeric: tabular-nums;
}

.stat-label {
  font-size: 11px;
  color: var(--aide-text-secondary);
  margin-top: 2px;
}

.stat.warn .stat-value {
  color: var(--aide-warning);
}

/* 输入归因拆分 */
.breakdown {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--aide-border);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.breakdown-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.bd-label {
  font-size: 11px;
  color: var(--aide-text-secondary);
  font-family: var(--aide-font-mono);
}

.bd-value {
  font-size: 12px;
  color: var(--aide-text-primary);
  font-variant-numeric: tabular-nums;
}

.bd-value.hot {
  color: var(--aide-warning);
  font-weight: 600;
}

.bd-pct {
  font-size: 10px;
  margin-left: 4px;
  opacity: 0.8;
}

/* 按模型分桶 */
.by-model {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--aide-border);
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.by-model-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}

.bm-label {
  font-size: 11px;
  color: var(--aide-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bm-value {
  font-size: 11px;
  color: var(--aide-text-primary);
  font-variant-numeric: tabular-nums;
}

/* 嵌套深度警告 */
.nesting-warn {
  margin-top: 10px;
  padding: 6px 8px;
  font-size: 11px;
  color: var(--aide-warning);
  background: color-mix(in srgb, var(--aide-warning) 12%, transparent);
  border-radius: 6px;
}

/* rate limit bars */
.rate-limit-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}

.rl-label {
  font-size: 12px;
  color: var(--aide-text-primary);
  min-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rl-bar-track {
  flex: 1;
  height: 8px;
  background: var(--aide-bg-deep);
  border-radius: 4px;
  overflow: hidden;
}

.rl-bar-fill {
  height: 100%;
  background: var(--aide-accent);
  border-radius: 4px;
  transition: width 0.3s ease;
}

.rl-bar-fill.high {
  background: var(--aide-warning);
}

.rl-bar-fill.critical {
  background: var(--aide-danger);
}

.rl-pct {
  font-size: 12px;
  color: var(--aide-text-primary);
  min-width: 36px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.rl-reset {
  font-size: 11px;
  color: var(--aide-text-secondary);
  min-width: 50px;
}
</style>
