<script setup lang="ts">
// 侧栏「连接移动端」卡片（LinkConnectPopover 点开后的内容）：配对二维码 + 中继地址 + 权限模式 + 开关。
// **中继地址没有出厂默认**（2026-10-05 起）：用户自己填、点「生成」出码；改地址 = Host 立即重连，
// 已配对的手机连的是旧地址、需要重新扫码（单设备模型，地址烧在二维码里）。
//
// 二维码只在**确认安全**时自动生成：网关已启用、配了地址、且还没配对过手机。
// 已配对时不自动出码——配对新手机会顶掉当前这台，必须是用户明确点「配对新手机」。
// 卡片卸载（点外面 / Esc）= useLinkPairing 撤掉还开着的一次性密钥，所以界面上不需要「关闭二维码」。
//
// 权限模式用分段控件、不用设置页原来的 ThemedSelect：它的弹层 Teleport 到 body，会被本卡片的
// 「点外面关闭」误判成外部点击——点一下选项就关卡片并撤掉一次性密钥。分段没有弹层，绕开这个坑。
import { computed, watch } from "vue";
import AppLogo from "./AppLogo.vue";
import { useLinkPairing } from "../composables/useLinkPairing";
import { useSettings } from "../composables/useSettings";

const { status, offer, error, note, busy, qrSrc, secondsLeft, mmss, stateText, relayDraft, setEnabled, showOffer, hideOffer, regenerate, revoke } = useLinkPairing();

// ── 远程会话权限模式（从设置页「远程控制」tab 搬来；落盘仍是 settings.remote.permissionMode）──
// 旧值迁移：权限模式 id 由 `default` 更名为 `manual`（对齐 CLI 命名）；旧文件读回来映射，别显示空白。
function normalizePermissionMode(v: string | undefined): string {
  return !v || v === "default" ? "manual" : v;
}
const { settings, update } = useSettings();
const permissionMode = computed(() => normalizePermissionMode(settings.remote.permissionMode));
function setPermissionMode(v: string) {
  update({ remote: { ...settings.remote, permissionMode: v } });
}

/** 前端只做最轻的一条校验（权威在 Rust）：填了东西、但不是 ws:// / wss:// 开头才提示。 */
const relayError = computed(() => {
  const v = relayDraft.value.trim();
  return v && !/^wss?:\/\//i.test(v) ? "地址需以 ws:// 或 wss:// 开头" : "";
});
/** 「生成」按钮：忙碌 / 校验不过时禁用。**空地址仍可点**——那是「清除配置」的路径（Host 会记成未配置）。 */
const canGenerate = computed(() => !!status.value && !busy.value && !relayError.value);

// 首次拿到状态：已启用、配了地址、没配对过 → 直接出码（对标「点开就是二维码」）
const stop = watch(status, (s) => {
  if (!s) return;
  stop();
  if (s.enabled && s.relayUrl && !s.paired && !offer.value) void showOffer();
});

async function onToggle(e: Event) {
  const on = (e.target as HTMLInputElement).checked;
  if (!on && offer.value) await hideOffer(); // 关网关前先撤掉 Host 上那把一次性密钥
  await setEnabled(on);
  if (on && status.value?.relayUrl && !status.value.paired) await showOffer();
}

/** 只有「需要用户知道」的状态才露出来：dev 构建不连网 / 未配地址 / 连接出错。正常的连接中、已就绪不打扰。 */
const warning = computed(() => {
  const s = status.value;
  if (!s?.enabled) return "";
  if (s.relaySuppressed) return stateText.value;
  if (!s.relayUrl) return "未配置中继地址：填好地址后点「生成」。";
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
        <template v-else-if="!status.relayUrl">请先填写中继地址</template>
        <template v-else-if="!status.enabled">开启下方开关后显示配对二维码</template>
        <template v-else-if="status.paired">
          <span>已配对 1 台手机</span>
          <button class="lc-btn" :disabled="busy" data-testid="link-connect-repair" @click="regenerate(relayDraft)">配对新手机</button>
          <button class="lc-btn" :disabled="busy" data-testid="link-connect-revoke" @click="revoke">撤销</button>
        </template>
        <template v-else>
          <span>二维码未生成或已过期</span>
          <button class="lc-btn" :disabled="!canGenerate || !status.relayUrl" data-testid="link-connect-refresh" @click="regenerate(relayDraft)">生成二维码</button>
        </template>
      </div>
    </div>

    <p class="lc-caption" :class="{ 'lc-warn': expiring }" data-testid="link-connect-caption">
      <template v-if="offer">{{ expiring ? `二维码将在 ${mmss} 后失效` : "使用 Aide 手机端扫码连接电脑" }}</template>
      <template v-else-if="status?.paired && status.enabled">配对新手机会顶掉当前这台</template>
      <template v-else>&nbsp;</template>
    </p>

    <span class="lc-field-label">中继地址</span>
    <div class="lc-relay-row">
      <input
        class="lc-input"
        type="text"
        placeholder="wss://你的中继"
        :value="relayDraft"
        :disabled="busy || !status"
        data-testid="link-relay-input"
        @input="relayDraft = ($event.target as HTMLInputElement).value"
      />
      <button class="lc-btn lc-primary" :disabled="!canGenerate" data-testid="link-relay-generate" @click="regenerate(relayDraft)">生成</button>
    </div>
    <p class="lc-relay-hint" :class="{ 'lc-warn': !!relayError }" data-testid="link-relay-hint">
      {{ relayError || "自建或你信任的中继（ws:// 或 wss://）；点「生成」出新二维码。" }}
    </p>

    <div class="lc-seg-row">
      <span class="lc-label">远程会话权限</span>
      <span class="lc-seg" data-testid="link-permission-mode">
        <button type="button" :aria-pressed="permissionMode === 'auto'" :disabled="busy" @click="setPermissionMode('auto')">自动</button>
        <button type="button" :aria-pressed="permissionMode === 'manual'" :disabled="busy" @click="setPermissionMode('manual')">手动</button>
      </span>
    </div>
    <p class="lc-seg-hint">自动批准非危险工具；手动每次询问（不推荐远程使用）。</p>

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
  width: 200px;
  height: 200px;
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
/* ── 中继地址行 ── */
.lc-field-label {
  margin-top: 2px;
  font-size: 11px;
  color: var(--aide-text-muted);
}
.lc-relay-row {
  display: flex;
  gap: 8px;
}
.lc-input {
  flex: 1;
  min-width: 0;
  padding: 5px 9px;
  font: inherit;
  font-size: 11.5px;
  font-family: var(--aide-font-mono);
  color: var(--aide-text-primary);
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-md);
}
.lc-input::placeholder {
  color: var(--aide-text-muted);
}
.lc-input:focus {
  outline: none;
  border-color: var(--aide-accent);
}
.lc-input:disabled {
  opacity: 0.55;
}
.lc-relay-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--aide-text-muted);
}
/* ── 权限模式分段控件 ── */
.lc-seg-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px solid var(--aide-border-subtle);
}
.lc-seg {
  display: inline-flex;
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-md);
  overflow: hidden;
  flex-shrink: 0;
}
.lc-seg button {
  border: 0;
  background: transparent;
  color: var(--aide-text-secondary);
  font: inherit;
  font-size: 11px;
  padding: 4px 12px;
  cursor: pointer;
}
.lc-seg button + button {
  border-left: 1px solid var(--aide-border-subtle);
}
.lc-seg button[aria-pressed="true"] {
  background: var(--aide-accent-gradient);
  color: var(--aide-text-on-accent);
  font-weight: 600;
}
.lc-seg button:disabled {
  opacity: 0.5;
  cursor: default;
}
.lc-seg-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--aide-text-muted);
}
.lc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 2px;
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
.lc-primary {
  border-color: transparent;
  background: var(--aide-accent-gradient);
  color: var(--aide-text-on-accent);
  font-weight: 600;
}
.lc-primary:hover:not(:disabled) {
  color: var(--aide-text-on-accent);
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
