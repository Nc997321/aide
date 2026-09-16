<script setup lang="ts">
/**
 * ModelSwitchConfirm —— 模型切换的成本确认对话框（SDK PreModelSwitch hook 驱动）。
 *
 * sidecar 在「缓存热 + 上下文达阈值」时挂起切换并 emit model_switch_confirm；
 * 本对话框展示**进程真相**（上下文体量 / 缓存温度 / 预估重铺成本），用户的
 * 允许/取消经 api.modelSwitchConfirmDecision 回传 sidecar 裁决挂起的 hook。
 * 取消时本地同步回滚下拉草稿（draft 优先级高于 runtime，不清则 deny 后下拉
 * 仍卡在新模型上——回滚广播拉不回 draft）。
 *
 * 弹窗在切换发生**之前**弹出（hook 挂起期间 setModel 不 resolve），与既有
 * 「发送前确认」不同轴：那是供应商 respawn 场景，本框是切换场景的唯一确认形态。
 */
import { computed } from "vue";
import { api } from "@/api";
import { useChatSession } from "@aide/sdk/chat";
import { formatTokens } from "./contextUsage";
import { vOverlayLayer } from "../../directives/overlayLayer";

const props = defineProps<{
  sessionId: string;
}>();

const chat = useChatSession(computed(() => props.sessionId));

const request = computed(() => chat.modelSwitchConfirm.value);

function fmtUsd(usd: number): string {
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

async function decide(approve: boolean): Promise<void> {
  const req = chat.modelSwitchConfirm.value;
  if (!req) return;
  try {
    if (!approve) chat.rollbackModelChoice();
    await api.modelSwitchConfirmDecision(props.sessionId, req.confirmId, approve);
  } catch (e) {
    console.warn("[modelSwitchConfirm] decision send failed:", e);
  } finally {
    chat.modelSwitchConfirm.value = null;
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="request" class="mswitch-overlay" v-overlay-layer role="dialog" aria-label="切换模型确认">
      <div class="mswitch-panel">
        <div class="mswitch-title">切换模型确认</div>
        <div class="mswitch-body">
          <div class="mswitch-line">
            <span class="mswitch-label">切换到</span>
            <span class="mswitch-value">{{ request.toModel }}</span>
          </div>
          <div class="mswitch-line" v-if="request.fromModel">
            <span class="mswitch-label">当前模型</span>
            <span class="mswitch-value">{{ request.fromModel }}</span>
          </div>
          <div class="mswitch-stats">
            <span>上下文 {{ formatTokens(request.contextTokens) }} tokens</span>
            <span>缓存 {{ request.promptCacheWarm ? "热" : "冷" }}（TTL {{ request.cacheTtl }}）</span>
            <span>重铺预估 {{ fmtUsd(request.estimatedCacheWriteUsd) }}</span>
          </div>
          <p class="mswitch-info">
            确认后切换在进程内立即生效，当前提示缓存作废并按新模型重新写入；
            取消则保持原模型不变。
          </p>
        </div>
        <div class="mswitch-actions">
          <button type="button" class="mswitch-btn" @click="decide(false)">取消</button>
          <button type="button" class="mswitch-btn mswitch-btn--primary" @click="decide(true)">
            继续切换
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mswitch-overlay {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}
.mswitch-panel {
  width: 360px;
  padding: 18px;
  border-radius: var(--aide-radius-lg);
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border);
  box-shadow: var(--aide-shadow-lg);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
}
.mswitch-title {
  font-size: 15px;
  font-weight: 500;
  color: var(--aide-text-primary);
  margin-bottom: 12px;
}
.mswitch-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
}
.mswitch-line {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
}
.mswitch-label {
  color: var(--aide-text-muted);
  width: 64px;
  flex-shrink: 0;
}
.mswitch-value {
  color: var(--aide-text-primary);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mswitch-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  font-size: 12px;
  color: var(--aide-text-secondary);
  padding: 8px 10px;
  border-radius: var(--aide-radius-md);
  background: var(--aide-surface-default);
  font-variant-numeric: tabular-nums;
}
.mswitch-info {
  font-size: 12px;
  color: var(--aide-text-muted);
  line-height: 1.5;
  margin: 0;
}
.mswitch-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.mswitch-btn {
  border: 1px solid var(--aide-border);
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
  font-size: 12px;
  padding: 6px 14px;
  border-radius: var(--aide-radius-md);
  cursor: pointer;
  transition: background var(--aide-ease-t), border-color var(--aide-ease-t);
}
.mswitch-btn:hover {
  background: var(--aide-surface-hover);
  border-color: var(--aide-border-strong);
}
.mswitch-btn--primary {
  background: var(--aide-accent-gradient);
  border-color: transparent;
  color: var(--aide-text-on-accent);
  box-shadow: var(--aide-accent-glow);
}
.mswitch-btn--primary:hover {
  background: var(--aide-accent-gradient);
  filter: brightness(1.08);
}
</style>