<script setup lang="ts">
import { computed } from "vue";
import { useProviderActions } from "@/composables/useProviderActions";
import { useToast } from "@/composables/useToast";
import type { ProviderKind } from "@/types";

const props = defineProps<{
  providerId: string;
  kind: ProviderKind;
  /** 由父层按 catalog 的 `view_usage` 声明给出，最终来源是 Rust 用量策略注册表。 */
  canViewUsage: boolean;
}>();
const {
  testConnection, testing, connectionResult,
  viewUsage, usageLoading, usageResult, lastError,
} = useProviderActions();
const toast = useToast();
// useProviderActions 是模块级单例：切到别的供应商时别把上一家的用量留在这里。
const windows = computed(() =>
  usageResult.value?.kind === props.kind ? usageResult.value.windows : [],
);

async function onTest() {
  const r = await testConnection(props.providerId);
  if (r) toast.showToast(r.detail || (r.ok ? "连接成功" : "连接失败"), r.ok ? "success" : "danger");
}

async function onUsage() {
  const r = await viewUsage(props.providerId);
  if (!r && lastError.value) toast.showToast(lastError.value, "danger");
}

function pct(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

function status(v: number): "ok" | "warning" | "danger" {
  const p = pct(v);
  return p >= 100 ? "danger" : p >= 80 ? "warning" : "ok";
}

function formatReset(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) return "即将重置";
  const hours = Math.floor(diff / 3_600_000);
  if (hours >= 24) return `约 ${Math.round(hours / 24)} 天后重置`;
  if (hours >= 1) return `约 ${hours} 小时后重置`;
  return `约 ${Math.max(1, Math.round(diff / 60_000))} 分钟后重置`;
}
</script>

<template>
  <div class="actions-column">
    <div class="actions-area">
      <button v-if="canViewUsage" class="action-btn" :disabled="usageLoading" @click="onUsage">
        {{ usageLoading ? "查询中…" : "查看用量" }}
      </button>
      <button class="action-btn" :disabled="testing" @click="onTest">
        {{ testing ? "测试中…" : "测试连接" }}
      </button>
      <span v-if="connectionResult" class="status-badge" :class="connectionResult.ok ? 'ok' : 'fail'">
        {{ connectionResult.ok ? "可连接" : "不可连接" }}
      </span>
    </div>

    <!-- 用量直接铺在设置页主面板里，不弹窗；窗口为空时不显示 -->
    <div v-if="canViewUsage && windows.length" class="usage-panel">
      <div v-for="w in windows" :key="w.key" class="usage-row">
        <span class="usage-label">{{ w.label }}</span>
        <span class="usage-track">
          <span class="usage-fill" :class="status(w.utilization)" :style="{ width: pct(w.utilization) + '%' }" />
        </span>
        <span class="usage-pct">{{ pct(w.utilization) }}% 已用</span>
        <span v-if="w.resetsAt" class="usage-reset">{{ formatReset(w.resetsAt) }}</span>
      </div>
      <div class="usage-note">数据来自供应商未公开的用量接口，可能随接口调整失效</div>
    </div>
  </div>
</template>

<style scoped>
.actions-column { padding: 10px 0; }
.actions-area { display: flex; gap: 10px; align-items: center; padding: 0; flex-wrap: wrap; }
.action-btn {
  padding: 6px 14px; border-radius: var(--aide-radius-sm);
  background: var(--aide-surface-default); color: var(--aide-text-primary);
  border: 1px solid var(--aide-border); cursor: pointer; font-size: 14px;
}
.action-btn:hover:not(:disabled) { background: var(--aide-surface-hover); }
.action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.status-badge { padding: 2px 8px; border-radius: var(--aide-radius-sm); font-size: 12px; }
.status-badge.ok { background: var(--aide-success); color: var(--aide-text-on-accent); }
.status-badge.fail { background: var(--aide-danger); color: var(--aide-text-on-accent); }

.usage-panel { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.usage-row { display: flex; align-items: center; gap: 10px; font-size: 14px; }
.usage-label { min-width: 72px; color: var(--aide-text-primary); }
.usage-track { flex: 1; max-width: 260px; height: 6px; border-radius: 3px; background: var(--aide-surface-hover); overflow: hidden; }
.usage-fill { display: block; height: 100%; border-radius: 3px; }
.usage-fill.ok { background: var(--aide-success); }
.usage-fill.warning { background: var(--aide-warning); }
.usage-fill.danger { background: var(--aide-danger); }
.usage-pct { min-width: 68px; color: var(--aide-text-primary); }
.usage-reset { color: var(--aide-text-secondary); }
.usage-note { font-size: 12px; color: var(--aide-text-secondary); }
</style>
