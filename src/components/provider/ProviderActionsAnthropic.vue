<script setup lang="ts">
import { useProviderActions } from "@/composables/useProviderActions";
import { useToast } from "@/composables/useToast";
import { useProviders } from "@/composables/useProviders";

const props = defineProps<{ providerId: string }>();
const { testConnection, testing, connectionResult, viewQuota, quotaLoading, quotaResult, refreshModels, refreshing } = useProviderActions();
const { load } = useProviders();
const toast = useToast();

async function onTest() {
  const r = await testConnection(props.providerId);
  if (r) toast.showToast(r.detail || (r.ok ? "连接成功" : "连接失败"), r.ok ? "success" : "danger");
}
async function onRefresh() {
  const m = await refreshModels(props.providerId);
  if (m) {
    await load(); // 同步前端 ref（refresh_models 持久化到 providers[]）
    toast.showToast("已更新模型映射", "success");
  }
}
async function onQuota() {
  const r = await viewQuota();
  if (r) toast.showToast(JSON.stringify(r), "info");
}
</script>

<template>
  <div class="actions-area">
    <button class="action-btn" :disabled="refreshing" @click="onRefresh">{{ refreshing ? "刷新中…" : "刷新模型列表" }}</button>
    <button class="action-btn" :disabled="quotaLoading" @click="onQuota">{{ quotaLoading ? "查询中…" : "查看额度" }}</button>
    <button class="action-btn" :disabled="testing" @click="onTest">{{ testing ? "测试中…" : "测试连接" }}</button>
    <span v-if="connectionResult" class="status-badge" :class="connectionResult.ok ? 'ok' : 'fail'">{{ connectionResult.ok ? "可连接" : "不可连接" }}</span>
  </div>
</template>

<style scoped>
.actions-area { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 10px 0; }
.action-btn { padding: 6px 14px; border-radius: var(--aide-radius-sm); background: var(--aide-surface-default); color: var(--aide-text-primary); border: 1px solid var(--aide-border); cursor: pointer; font-size: 14px; }
.action-btn:hover:not(:disabled) { background: var(--aide-surface-hover); }
.action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.status-badge { padding: 2px 8px; border-radius: var(--aide-radius-sm); font-size: 12px; }
.status-badge.ok { background: var(--aide-success); color: var(--aide-text-on-accent); }
.status-badge.fail { background: var(--aide-danger); color: var(--aide-text-on-accent); }
</style>