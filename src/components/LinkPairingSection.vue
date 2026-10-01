<script setup lang="ts">
// 「手机连接（Aide Link）」：管**这台 Host** 的手机网关——启停、扫码配对、撤销。窗口连着哪台 Host，
// 管的就是那台（配对的对象是 Host，不是桌面）。协议：docs/aide-link-protocol.md。
//
// 配对 = 手机扫二维码（含 Host 公钥 + 一次性密钥，端到端加密，中继看不到）。二维码 SVG 来自 Host
// （可能是远程机器）：只当 <img> 显示（SVG 作为图片不执行脚本），绝不 v-html 内联。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { linkApi, type LinkOffer, type LinkStatus } from "@aide/sdk";

const POLL_MS = 2000;

const status = ref<LinkStatus | null>(null);
const offer = ref<LinkOffer | null>(null);
const error = ref("");
const note = ref("");
const busy = ref(false);
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;

const qrSrc = computed(() => (offer.value ? `data:image/svg+xml;utf8,${encodeURIComponent(offer.value.qrSvg)}` : ""));
const secondsLeft = computed(() => (offer.value ? Math.max(0, Math.ceil(offer.value.expiresAtUnix - now.value / 1000)) : 0));
const mmss = computed(() => `${Math.floor(secondsLeft.value / 60)}:${String(secondsLeft.value % 60).padStart(2, "0")}`);
const stateText = computed(() => {
  const s = status.value;
  if (!s) return "…";
  if (!s.enabled) return "未启用";
  return s.connected ? "已在中继上注册，手机可以连接" : "已启用，正在连接中继…";
});

async function refresh() {
  try {
    status.value = await linkApi.status();
    now.value = Date.now();
    // 二维码打开期间：手机配对成功（二维码被用掉）或过期，就收起它
    if (offer.value) {
      if (status.value.paired && !status.value.offerActive) {
        offer.value = null;
        note.value = "配对成功，手机已连上这台 Host。";
      } else if (secondsLeft.value <= 0 || !status.value.offerActive) {
        offer.value = null;
        note.value = "二维码已过期，请重新生成。";
      }
    }
  } catch (e) {
    error.value = String(e);
  }
}

onMounted(() => {
  void refresh();
  timer = setInterval(() => void refresh(), POLL_MS);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  // 关掉设置页 = 不再展示二维码，也就不该留着一个有效的一次性密钥
  if (offer.value) void linkApi.cancelOffer().catch(() => {});
});

async function guard(fn: () => Promise<void>) {
  busy.value = true;
  error.value = "";
  note.value = "";
  try {
    await fn();
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

const toggle = (e: Event) => guard(async () => {
  status.value = await linkApi.setEnabled((e.target as HTMLInputElement).checked);
});

const showOffer = () => guard(async () => {
  offer.value = await linkApi.createOffer();
  await refresh();
});

const hideOffer = () => guard(async () => {
  offer.value = null;
  await linkApi.cancelOffer();
  await refresh();
});

const revoke = () => guard(async () => {
  await linkApi.revoke();
  note.value = "已撤销，该手机已被断开。";
  await refresh();
});
</script>

<template>
  <section class="link-section" data-testid="link-section">
    <div class="settings-field">
      <label class="field-label">手机连接（Aide Link）</label>
      <div class="toggle-row">
        <span class="field-hint">
          手机扫码直连<strong>这台 Host</strong>{{ status?.hostName ? `（${status.hostName}）` : "" }}——端到端加密，中继只转发密文；无需输入配对码。
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
        <button class="link-btn" :disabled="busy || !status?.relayConfigured" data-testid="link-pair" @click="showOffer">
          {{ status?.paired ? "配对新手机" : "配对手机" }}
        </button>
        <button v-if="status?.paired" class="link-btn" :disabled="busy" data-testid="link-revoke" @click="revoke">撤销</button>
      </div>
      <span v-if="status && !status.relayConfigured" class="field-hint link-warn" data-testid="link-needs-relay">
        请先在下方填写「中继 URL」（手机与这台 Host 都经它相遇）。
      </span>
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
