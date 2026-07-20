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
        <div class="stat" :class="{ warn: (health?.sessions?.stalled ?? 0) > 0 }">
          <span class="stat-value">{{ health?.sessions?.stalled ?? 0 }}</span>
          <span class="stat-label">卡死</span>
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
        <span class="rl-reset" v-if="w.resets_at">{{ fmtReset(w.resets_at) }}</span>
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
  rateLimit,
} = useDiagnosticsDashboard();

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
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
  color: var(--aide-text);
  margin: 0;
}

.card {
  background: var(--aide-surface);
  border: 1px solid var(--aide-border);
  border-radius: 8px;
  padding: 12px;
}

.card-header {
  font-size: 12px;
  font-weight: 600;
  color: var(--aide-text-secondary, #888);
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
  color: var(--aide-text);
  font-variant-numeric: tabular-nums;
}

.stat-label {
  font-size: 11px;
  color: var(--aide-text-secondary, #888);
  margin-top: 2px;
}

.stat.warn .stat-value {
  color: var(--aide-warning, #f0a020);
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
  color: var(--aide-text);
  min-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rl-bar-track {
  flex: 1;
  height: 8px;
  background: var(--aide-bg-deep, #1a1a2e);
  border-radius: 4px;
  overflow: hidden;
}

.rl-bar-fill {
  height: 100%;
  background: var(--aide-accent, #4a9eff);
  border-radius: 4px;
  transition: width 0.3s ease;
}

.rl-bar-fill.high {
  background: var(--aide-warning, #f0a020);
}

.rl-bar-fill.critical {
  background: var(--aide-danger, #e04040);
}

.rl-pct {
  font-size: 12px;
  color: var(--aide-text);
  min-width: 36px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.rl-reset {
  font-size: 11px;
  color: var(--aide-text-secondary, #888);
  min-width: 50px;
}
</style>
