<script setup lang="ts">
// 侧栏「连接移动端」卡片（LinkConnectPopover 点开后的内容）：开关 + 配对二维码。
// 与设置页的 LinkPairingSection 共用 useLinkPairing 状态机——这里只是更短的一条路径：点开即见码。
// 中继地址是产品内置的（aide-core DEFAULT_RELAY_URL），这里不提、不展示。
//
// 二维码只在**确认安全**时自动生成：网关已启用、且还没配对过手机。
// 已配对时不自动出码——配对新手机会顶掉当前这台（单设备模型），必须是用户明确点「配对新手机」。
// 卡片卸载（点外面 / Esc）= useLinkPairing 撤掉还开着的一次性密钥，所以界面上不需要「关闭二维码」。
import { computed, watch } from "vue";
import AppLogo from "./AppLogo.vue";
import { useLinkPairing } from "../composables/useLinkPairing";

const { status, offer, error, note, busy, qrSrc, secondsLeft, mmss, stateText, setEnabled, showOffer, hideOffer, revoke } = useLinkPairing();

// 首次拿到状态：已启用且没配对过 → 直接出码（对标「点开就是二维码」）
const stop = watch(status, (s) => {
  if (!s) return;
  stop();
  if (s.enabled && !s.paired && !offer.value) void showOffer();
});

async function onToggle(e: Event) {
  const on = (e.target as HTMLInputElement).checked;
  if (!on && offer.value) await hideOffer(); // 关网关前先撤掉 Host 上那把一次性密钥
  await setEnabled(on);
  if (on && !status.value?.paired) await showOffer();
}

/** 只有「需要用户知道」的状态才露出来：dev 构建不连网 / 连接出错。正常的连接中、已就绪不打扰。 */
const warning = computed(() => {
  const s = status.value;
  if (!s?.enabled) return "";
  if (s.relaySuppressed) return stateText.value;
  return !s.connected ? s.lastError : "";
});
/** 倒计时只在最后一分钟提醒——平时 10 分钟的数字只是噪音。 */
const expiring = computed(() => !!offer.value && secondsLeft.value <= 60);
</script>

<template>
  <div class="lc-card" data-testid="link-connect-card">
    <h3 class="lc-title">连接移动端</h3>

    <div class="lc-qr-box">
      <template v-if="offer">
        <img class="lc-qr" :src="qrSrc" alt="配对二维码" data-testid="link-connect-qr" />
        <!-- logo 只盖中心约 4% 面积，在二维码纠错容量之内（中心压一块白底，扫码器看不到被盖住的模块） -->
        <span class="lc-logo"><AppLogo :size="36" /></span>
      </template>
      <div v-else class="lc-qr-empty" data-testid="link-connect-empty">
        <template v-if="!status">…</template>
        <template v-else-if="!status.enabled">开启下方开关后显示配对二维码</template>
        <template v-else-if="status.paired">
          <span>已配对 1 台手机</span>
          <button class="lc-btn" :disabled="busy" data-testid="link-connect-repair" @click="showOffer">配对新手机</button>
          <button class="lc-btn" :disabled="busy" data-testid="link-connect-revoke" @click="revoke">撤销</button>
        </template>
        <template v-else>
          <span>二维码未生成或已过期</span>
          <button class="lc-btn" :disabled="busy" data-testid="link-connect-refresh" @click="showOffer">生成二维码</button>
        </template>
      </div>
    </div>

    <p class="lc-caption" :class="{ 'lc-warn': expiring }" data-testid="link-connect-caption">
      <template v-if="offer">{{ expiring ? `二维码将在 ${mmss} 后失效` : "使用 Aide 手机端扫码连接电脑" }}</template>
      <template v-else-if="status?.paired && status.enabled">配对新手机会顶掉当前这台</template>
      <template v-else>&nbsp;</template>
    </p>

    <div class="lc-row">
      <span class="lc-label">允许移动端连接此设备</span>
      <label class="lc-toggle">
        <input type="checkbox" :checked="status?.enabled ?? false" :disabled="busy || !status" data-testid="link-connect-toggle" @change="onToggle" />
        <span class="lc-toggle-track"></span>
      </label>
    </div>
    <p v-if="warning" class="lc-state lc-warn" data-testid="link-connect-state">{{ warning }}</p>
    <p v-if="note" class="lc-state lc-ok" data-testid="link-connect-note">{{ note }}</p>
    <p v-if="error" class="lc-state lc-warn" data-testid="link-connect-error">{{ error }}</p>
  </div>
</template>

<style scoped>
.lc-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 300px;
  padding: 16px 18px 14px;
}
.lc-title {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 600;
  color: var(--aide-text-primary);
}
.lc-qr-box {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  align-self: center;
  width: 224px;
  height: 224px;
  border: 1px dashed var(--aide-border);
  border-radius: var(--aide-radius-lg);
  background: var(--aide-surface-default);
  overflow: hidden;
}
.lc-qr {
  width: 100%;
  height: 100%;
  /* 二维码自带黑白对比，不随主题变色（扫码器要对比度）；底色由 SVG 自身提供 */
  image-rendering: pixelated;
}
.lc-logo {
  position: absolute;
  top: 50%;
  left: 50%;
  display: flex;
  padding: 3px;
  transform: translate(-50%, -50%);
  /* 与二维码底色同为纯白（扫码器要对比度，不随主题变色） */
  background: #ffffff;
  border-radius: 8px;
  pointer-events: none;
}
.lc-qr-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 0 20px;
  text-align: center;
  font-size: 12px;
  color: var(--aide-text-muted);
}
.lc-caption {
  margin: 0;
  text-align: center;
  font-size: 12px;
  color: var(--aide-text-muted);
}
.lc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 6px;
  padding-top: 12px;
  border-top: 1px solid var(--aide-border-subtle);
}
.lc-label {
  font-size: 13px;
  color: var(--aide-text-primary);
}
.lc-state {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--aide-text-muted);
}
.lc-warn {
  color: var(--aide-warning);
}
.lc-ok {
  color: var(--aide-success);
}
.lc-btn {
  background: transparent;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  color: var(--aide-text-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  padding: 3px 10px;
}
.lc-btn:hover:not(:disabled) {
  border-color: var(--aide-accent);
  color: var(--aide-text-primary);
}
.lc-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.lc-toggle {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  cursor: pointer;
  flex-shrink: 0;
}
.lc-toggle input {
  opacity: 0;
  width: 0;
  height: 0;
  position: absolute;
}
.lc-toggle-track {
  position: absolute;
  inset: 0;
  background: var(--aide-surface-hover);
  border-radius: 10px;
  transition: background 0.15s;
}
.lc-toggle-track::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: var(--aide-text-primary);
  border-radius: 50%;
  transition: transform 0.15s;
}
.lc-toggle input:checked + .lc-toggle-track {
  background: var(--aide-accent-gradient);
}
.lc-toggle input:checked + .lc-toggle-track::after {
  transform: translateX(16px);
  background: var(--aide-text-on-accent);
  transition: transform 0.15s, background 0.15s;
}
</style>
