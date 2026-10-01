<script setup lang="ts">
// 「手机连接（Aide Link）」：管**这台 Host** 的手机网关——启停、扫码配对、撤销。窗口连着哪台 Host，
// 管的就是那台（配对的对象是 Host，不是桌面）。协议：docs/aide-link-protocol.md。
//
// 配对 = 手机扫二维码（含 Host 公钥 + 一次性密钥，端到端加密，中继看不到）。二维码 SVG 来自 Host
// （可能是远程机器）：只当 <img> 显示（SVG 作为图片不执行脚本），绝不 v-html 内联。
import { useLinkPairing } from "../composables/useLinkPairing";

// 状态机与二维码生命周期在 useLinkPairing（与侧栏的 LinkConnectPopover 共用），这里只管设置页的版面。
const { status, offer, error, note, busy, qrSrc, mmss, stateText, setEnabled, showOffer, hideOffer, revoke } = useLinkPairing();

const toggle = (e: Event) => setEnabled((e.target as HTMLInputElement).checked);
</script>

<template>
  <section class="link-section" data-testid="link-section">
    <div class="settings-field">
      <label class="field-label">手机连接（Aide Link）</label>
      <div class="toggle-row">
        <span class="field-hint">
          手机扫码直连<strong>这台 Host</strong>{{ status?.hostName ? `（${status.hostName}）` : "" }}——端到端加密；无需输入配对码。
        </span>
        <label class="toggle">
          <input type="checkbox" :checked="status?.enabled ?? false" :disabled="busy || !status" data-testid="link-toggle" @change="toggle" />
          <span class="toggle-track"></span>
        </label>
      </div>
      <span class="field-hint" data-testid="link-state">{{ stateText }}</span>
      <span v-if="status?.enabled && !status.connected && status.lastError" class="field-hint link-warn">{{ status.lastError }}</span>
    </div>

    <div class="settings-field">
      <label class="field-label">配对手机</label>
      <div class="field-control">
        <span class="field-hint" data-testid="link-paired">{{ status?.paired ? "已配对 1 台手机" : "尚未配对" }}</span>
        <button class="link-btn" :disabled="busy || !status" data-testid="link-pair" @click="showOffer">
          {{ status?.paired ? "配对新手机" : "配对手机" }}
        </button>
        <button v-if="status?.paired" class="link-btn" :disabled="busy" data-testid="link-revoke" @click="revoke">撤销</button>
      </div>
      <span class="field-hint">同时只允许一台：配对新手机会自动顶掉当前这台，旧手机将提示重新配对。</span>
    </div>

    <div v-if="offer" class="link-offer" data-testid="link-offer">
      <img class="link-qr" :src="qrSrc" alt="配对二维码" />
      <div class="link-offer-side">
        <span class="field-hint">用手机 APP 扫描此二维码（{{ mmss }} 内有效，只能用一次）。</span>
        <button class="link-btn" :disabled="busy" data-testid="link-cancel" @click="hideOffer">关闭二维码</button>
      </div>
    </div>

    <span v-if="note" class="field-hint link-ok" data-testid="link-note">{{ note }}</span>
    <span v-if="error" class="field-hint link-warn" data-testid="link-error">{{ error }}</span>
  </section>
</template>

<style scoped>
.link-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 14px;
  margin-bottom: 14px;
  border-bottom: 1px solid var(--aide-border-subtle);
}
.link-btn {
  background: transparent;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  color: var(--aide-text-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  padding: 3px 10px;
}
.link-btn:hover:not(:disabled) {
  border-color: var(--aide-accent);
  color: var(--aide-text-primary);
}
.link-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.link-offer {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  padding: 12px;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  background: var(--aide-surface-default);
}
.link-qr {
  width: 220px;
  height: 220px;
  flex: none;
  /* 二维码自带黑白对比，不随主题变色（扫码器要对比度） */
  image-rendering: pixelated;
}
.link-offer-side {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}
.link-warn {
  color: var(--aide-warning);
}
.link-ok {
  color: var(--aide-success);
}
</style>
