<script setup lang="ts">
import { onMounted } from "vue";
import { useProviderActions } from "@/composables/useProviderActions";
import { useToast } from "@/composables/useToast";

const props = defineProps<{ providerId: string }>();
const { testConnection, testing, connectionResult, cpaProbe, probing, probeResult, cpaOpenManagement, cpaLoginStatus, loginChecking, loginResult } = useProviderActions();
const toast = useToast();

onMounted(() => { void cpaProbe(); void cpaLoginStatus(); });

async function onTest() {
  const r = await testConnection(props.providerId);
  if (r) toast.showToast(r.detail || (r.ok ? "连接成功" : "连接失败"), r.ok ? "success" : "danger");
}
async function onReprobe() {
  const r = await cpaProbe();
  if (r) toast.showToast(r.detail || (r.alive ? "端口在线" : "端口离线"), r.alive ? "success" : "danger");
}
</script>

<template>
  <div class="actions-area">
    <span class="status-badge" :class="probeResult?.alive ? 'ok' : 'fail'" v-tooltip="probeResult?.detail">
      CPA 端口：{{ probeResult ? (probeResult.alive ? '在线' : '离线') : '…' }}
    </span>
    <span class="status-badge" :class="loginResult?.logged_in ? 'ok' : 'warn'">
      Codex 登录：{{ loginResult ? (loginResult.logged_in ? '已登录' : '未登录') : '…' }}
    </span>
    <button class="action-btn" :disabled="probing" @click="onReprobe">{{ probing ? "探测中…" : "重新探测" }}</button>
    <button class="action-btn" @click="cpaOpenManagement">打开管理面板</button>
    <button class="action-btn" :disabled="testing" @click="onTest">{{ testing ? "测试中…" : "测试连接" }}</button>
  </div>
</template>

<style scoped>
.actions-area { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 10px 0; }
.action-btn { padding: 6px 14px; border-radius: var(--aide-radius-sm); background: var(--aide-surface-default); color: var(--aide-text-primary); border: 1px solid var(--aide-border); cursor: pointer; font-size: 14px; }
.action-btn:hover:not(:disabled) { background: var(--aide-surface-hover); }
.action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.status-badge { padding: 2px 8px; border-radius: var(--aide-radius-sm); font-size: 12px; }
.status-badge.ok { background: var(--aide-success); color: var(--aide-text-on-accent); }
.status-badge.warn { background: var(--aide-warning); color: var(--aide-text-on-accent); }
.status-badge.fail { background: var(--aide-danger); color: var(--aide-text-on-accent); }
</style>