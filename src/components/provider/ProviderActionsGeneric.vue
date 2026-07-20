<script setup lang="ts">
import { useProviderActions } from "@/composables/useProviderActions";
import { useToast } from "@/composables/useToast";

const props = defineProps<{ providerId: string }>();
const { testConnection, testing, connectionResult } = useProviderActions();
const toast = useToast();

async function onTest() {
  const r = await testConnection(props.providerId);
  if (r) toast.showToast(r.detail || (r.ok ? "连接成功" : "连接失败"), r.ok ? "success" : "danger");
}
</script>

<template>
  <div class="actions-area">
    <button class="action-btn" :disabled="testing" @click="onTest">
      {{ testing ? "测试中…" : "测试连接" }}
    </button>
    <span v-if="connectionResult" class="status-badge" :class="connectionResult.ok ? 'ok' : 'fail'">
      {{ connectionResult.ok ? "可连接" : "不可连接" }}
    </span>
  </div>
</template>

<style scoped>
.actions-area { display: flex; gap: 10px; align-items: center; padding: 10px 0; }
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
</style>