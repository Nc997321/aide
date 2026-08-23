<script setup lang="ts">
import { ref, onMounted } from "vue";
import { open } from "@tauri-apps/plugin-shell";
import { api } from "../../../api";
import { useOnboarding } from "../../../composables/useOnboarding";
import { useProviders } from "../../../composables/useProviders";

const ob = useOnboarding();
const { systemDefault, saveSystemDefaultApiKey, activeProviderId, SYSTEM_DEFAULT_ID } = useProviders();

const showApiKey = ref(false);
const apiKey = ref("");
const saving = ref(false);
const error = ref("");
const oauthBusy = ref(false);
const oauthMessage = ref("");

// 已登录/已用别的供应商 → 自动跳过 Claude 登录步：
//  - 当前激活供应商非 SystemDefault（ollama/cpa_gpt/custom 等）→ 不强制 Claude 登录
//  - SystemDefault：credentials.json 存在 或 apiKey 已配置 → 已就绪
onMounted(async () => {
  if (activeProviderId.value !== SYSTEM_DEFAULT_ID) { ob.advance(); return; }
  try {
    const credsExist = await api.claudeCredentialsExist();
    if (credsExist || systemDefault.value.apiKeyConfigured) {
      ob.advance();
    }
  } catch {
    // 检测失败不阻塞——留在登录步让用户配
  }
});

async function startOAuth() {
  oauthBusy.value = true;
  oauthMessage.value = "";
  try {
    const r = await api.claudeStartLogin();
    if (r.authorizeUrl) {
      // A2 成功——打开浏览器，轮询 credentials.json 出现
      await open(r.authorizeUrl);
      oauthMessage.value = "请在浏览器中完成 Claude 登录…";
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 500));
        if (await api.claudeCredentialsExist()) { ob.advance(); return; }
      }
      oauthMessage.value = "浏览器登录未完成，请改用 API key。";
      showApiKey.value = true;
    } else {
      // degraded（A2/A1 未接入）——降级到 API key
      oauthMessage.value = "浏览器登录暂不可用，请改用 API key（OAuth 即将支持）。";
      showApiKey.value = true;
    }
  } catch (e: unknown) {
    oauthMessage.value = typeof e === "string" ? e : (e instanceof Error ? e.message : "登录启动失败");
    showApiKey.value = true;
  } finally {
    oauthBusy.value = false;
  }
}

async function saveApiKey() {
  const k = apiKey.value.trim();
  if (!k) { error.value = "请输入 API key"; return; }
  saving.value = true; error.value = "";
  try {
    await saveSystemDefaultApiKey(k);
    ob.advance();
  } catch (e: unknown) {
    error.value = typeof e === "string" ? e : (e instanceof Error ? e.message : "保存失败");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="eyebrow">03 / 04 · 登录 Claude</div>
  <div class="headline">登录你的 Claude 账号</div>
  <div class="support">aide 需要凭证才能发消息、跑模型。用浏览器登录 Claude 账号最省事；没有账号也能用 API key。</div>
  <div class="login-stack">
    <button class="btn-primary oauth-btn" :disabled="oauthBusy" @click="startOAuth">
      {{ oauthBusy ? "启动中…" : "用 Claude 账号登录" }}
      <span v-if="!oauthBusy" class="ext">↗ 浏览器打开</span>
    </button>
    <div v-if="oauthMessage" class="oauth-msg">{{ oauthMessage }}</div>
    <div class="divider">或</div>
    <span class="link" @click="showApiKey = true">改用 API key（去 console.anthropic.com 申请）</span>
    <template v-if="showApiKey">
      <input class="api-key-input" type="password" autocomplete="new-password" v-model="apiKey" placeholder="sk-ant-..." />
      <div v-if="error" class="err">{{ error }}</div>
      <button class="btn-primary save-btn" :disabled="saving || !apiKey.trim()" @click="saveApiKey">
        {{ saving ? "保存中…" : "保存并继续" }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.eyebrow {
  font-size: 10px; color: var(--aide-accent); font-weight: 600;
  letter-spacing: .14em; text-transform: uppercase;
}
.headline {
  font-size: 24px; font-weight: 600; letter-spacing: -.015em; color: var(--aide-text-primary);
}
.support {
  font-size: 13px; color: var(--aide-text-secondary); line-height: 1.65; max-width: 440px;
}
.login-stack { width: 100%; max-width: 380px; display: flex; flex-direction: column; align-items: center; gap: 12px; }
.btn-primary {
  width: 100%; padding: 13px 20px; border-radius: var(--aide-radius-md);
  background: var(--aide-accent-gradient); color: var(--aide-text-on-accent); font-size: 13.5px; font-weight: 600;
  box-shadow: var(--aide-accent-glow), var(--aide-highlight-inset);
  border: 1px solid rgba(150,170,255,.45); cursor: pointer; transition: all .16s var(--aide-ease);
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
}
.btn-primary:disabled { opacity: .5; cursor: not-allowed; }
.btn-primary:not(:disabled):hover { filter: brightness(1.07); transform: translateY(-1px); }
.btn-primary .ext { font-size: 10px; opacity: .7; font-weight: 500; }
.oauth-msg { font-size: 11.5px; color: var(--aide-warning); width: 100%; text-align: center; }
.divider { display: flex; align-items: center; gap: 10px; width: 100%; color: var(--aide-text-muted); font-size: 10.5px; }
.divider::before, .divider::after { content: ""; height: 1px; flex: 1; background: var(--aide-border); }
.link {
  font-size: 12px; color: var(--aide-text-muted); cursor: pointer;
  text-decoration: underline; text-decoration-color: var(--aide-border); text-underline-offset: 3px;
}
.link:hover { color: var(--aide-text-secondary); text-decoration-color: var(--aide-border-strong); }
.api-key-input {
  width: 100%; padding: 9px 12px; border-radius: var(--aide-radius-md);
  background: var(--aide-bg-deep); border: 1px solid var(--aide-border); color: var(--aide-text-primary);
  font-size: 12.5px; font-family: var(--aide-font-mono); box-shadow: var(--aide-highlight-inset);
}
.api-key-input:focus {
  outline: none; border-color: var(--aide-accent);
  box-shadow: var(--aide-highlight-inset), 0 0 0 2.5px rgba(150,170,255,.42);
}
.err { font-size: 11.5px; color: var(--aide-danger); width: 100%; text-align: left; }
@media (prefers-reduced-motion: reduce) {
  .btn-primary { transition: none; }
  .btn-primary:not(:disabled):hover { transform: none; }
}
</style>