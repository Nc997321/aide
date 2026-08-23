<script setup lang="ts">
import { computed, ref } from "vue";
import type { ConnState } from "../protocol";

const props = defineProps<{
  connState: ConnState;
  relayUrl: string; // 上次输入（localStorage）
  pairError: "badcode" | "revoked" | null;
  hasCreds: boolean;
}>();

const emit = defineEmits<{
  connect: [relayUrl: string, code: string];
  clearError: [];
}>();

const relayUrl = ref(props.relayUrl);
const code = ref("");

// 配对码输入：只留数字，最多 6 位；输入即清除错误态（原型：error 时输入回 idle）
function onCodeInput(): void {
  code.value = code.value.replace(/\D/g, "").slice(0, 6);
  if (props.pairError) emit("clearError");
}

const busy = computed(
  () => props.connState === "connecting" || props.connState === "bridged" || props.connState === "authed",
);

function onConnect(): void {
  if (busy.value || code.value.length !== 6) return;
  emit("connect", relayUrl.value.trim(), code.value);
}

// 状态展示区：五种状态互斥（原型 data-st 映射）
const status = computed<"connecting" | "connected" | "offline" | "badcode" | "revoked" | null>(() => {
  switch (props.connState) {
    case "connecting":
    case "bridged":
      return "connecting";
    case "authed":
      return "connected";
    case "offline":
      return "offline";
    case "needsPairing":
      return props.pairError === "revoked" ? "revoked" : "badcode";
    default:
      return null;
  }
});
</script>

<template>
  <div class="conn">
    <img class="conn-logo" src="/icon-512.png" alt="aide" />
    <h2>aide 远程</h2>
    <p class="sub">用手机远程控制你的桌面 aide</p>

    <div class="field">
      <label>中继服务器<small>记住上次输入</small></label>
      <input v-model="relayUrl" class="mono" type="text" spellcheck="false" placeholder="wss://relay.example.com" />
    </div>
    <div class="field">
      <label>配对码</label>
      <input
        v-model="code"
        class="code"
        :class="{ error: status === 'badcode' }"
        type="text"
        inputmode="numeric"
        maxlength="6"
        placeholder="––––––"
        autocomplete="one-time-code"
        @input="onCodeInput"
      />
      <div class="tip">
        <em v-if="status === 'badcode'">配对码无效或已过期，请重新输入</em>
        <template v-else>桌面 aide → 设置 → 远程控制，查看 6 位配对码</template>
      </div>
    </div>

    <button class="btn-primary" :disabled="busy || code.length !== 6" @click="onConnect">
      <span v-if="busy" class="spinner" style="width: 13px; height: 13px"></span>
      <span>{{ busy ? "连接中" : "连 接" }}</span>
    </button>

    <!-- 状态展示区：同一位置互斥展示五种状态 -->
    <div class="conn-status">
      <div class="st info" :class="{ show: status === 'connecting' }">
        <span class="st-ic"><span class="spinner" style="color: var(--accent)"></span></span>
        <span><b>正在连接中继服务器…</b><small>{{ relayUrl || "wss://relay.example.com" }}</small></span>
      </div>
      <div class="st ok" :class="{ show: status === 'connected' }">
        <span class="st-ic">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.6"/><path d="M5 8.2l2 2 4-4.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>
        <span><b>已连接，正在进入会话…</b><small>正在加载会话列表</small></span>
      </div>
      <div class="st warn" :class="{ show: status === 'offline' }">
        <span class="st-ic"><span class="spinner" style="color: #f0a868"></span></span>
        <span><b>设备离线</b><small>桌面 aide 未开启远程控制，或中继无法连接<br />正在自动重试…</small></span>
      </div>
      <div class="st danger" :class="{ show: status === 'badcode' }">
        <span class="st-ic">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.6"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </span>
        <span><b>配对码无效或已过期</b><small>请回到桌面 aide 重新获取配对码</small></span>
      </div>
      <div class="st danger" :class="{ show: status === 'revoked' }">
        <span class="st-ic">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 1.8L14 4v4c0 3.4-2.5 5.7-6 6.8C4.5 13.7 2 11.4 2 8V4l6-2.2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 5.2v3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="10.6" r=".9" fill="currentColor"/></svg>
        </span>
        <span><b>需要重新配对</b><small>本设备的登录凭证已被吊销，请输入新配对码</small></span>
      </div>
    </div>

    <div v-if="hasCreds" class="conn-foot">
      <span class="kv"><span class="dot ok"></span>本设备已配对 · 下次启动自动连接</span>
    </div>
  </div>
</template>
