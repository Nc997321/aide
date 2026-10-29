<script setup lang="ts">
import AInput from "@/ui/AInput.vue";
// 「用 Claude 账号登录」面板：引导页登录步与供应商设置（Anthropic 官方）共用。
// 流程与跨界决定见 composables/useClaudeLogin.ts。
import { onMounted, ref } from "vue";
import { api } from "../api";
import type { ClaudeAuthStatus } from "@aide/sdk/api";
import { useClaudeLogin } from "../composables/useClaudeLogin";

const props = defineProps<{
  /** 显示当前账号与「退出登录」（设置页用；引导页登录成功即进下一步，不需要）。 */
  showAccount?: boolean;
}>();
const emit = defineEmits<{ (e: "logged-in"): void }>();

const account = ref<ClaudeAuthStatus | null>(null);
const accountError = ref("");
const loggingOut = ref(false);
const code = ref("");

async function refreshAccount() {
  if (!props.showAccount) return;
  try {
    account.value = await api.claudeAuthStatus();
    accountError.value = "";
  } catch (e) {
    account.value = null;
    accountError.value = typeof e === "string" ? e : e instanceof Error ? e.message : "读取登录状态失败";
  }
}

const login = useClaudeLogin(() => {
  code.value = "";
  void refreshAccount();
  emit("logged-in");
});

async function logout() {
  loggingOut.value = true;
  try {
    await api.claudeLogout();
    await refreshAccount();
  } catch (e) {
    accountError.value = typeof e === "string" ? e : e instanceof Error ? e.message : "退出登录失败";
  } finally {
    loggingOut.value = false;
  }
}

function subscriptionLabel(s: ClaudeAuthStatus): string {
  if (s.subscriptionType) return `${s.subscriptionType} 订阅`;
  return s.authMethod === "console" ? "Console（API 计费）" : s.authMethod;
}

onMounted(refreshAccount);
</script>

<template>
  <div class="claude-login">
    <div v-if="showAccount && account?.loggedIn" class="account-row">
      <span class="account-text">
        已登录<template v-if="account.email">：{{ account.email }}</template>
        <span class="account-plan">{{ subscriptionLabel(account) }}</span>
      </span>
      <button class="btn-ghost logout-btn" :disabled="loggingOut" @click="logout">
        {{ loggingOut ? "退出中…" : "退出登录" }}
      </button>
    </div>
    <div v-else-if="showAccount && account" class="account-row">
      <span class="account-text muted">尚未用 Claude 账号登录</span>
    </div>
    <div v-if="accountError" class="oauth-msg">{{ accountError }}</div>

    <template v-if="login.phase.value === 'waiting'">
      <div class="waiting-text">
        <template v-if="login.hostOpensBrowser.value">
          已在浏览器打开登录页，登录完成后这里会自动继续。
        </template>
        <template v-else>
          已在本机浏览器打开登录页。登录后页面会给出一串授权码，把它粘贴到下面。
        </template>
      </div>
      <div class="code-row">
        <AInput unstyled
          v-model="code"
          class="code-input"
          type="text"
          spellcheck="false"
          :placeholder="login.hostOpensBrowser.value ? '页面给了授权码的话粘贴到这里' : '粘贴授权码'"
          @keydown.enter="login.submitCode(code)"
        />
        <button
          class="btn-primary code-submit"
          :disabled="login.submitting.value || !code.trim()"
          @click="login.submitCode(code)"
        >
          {{ login.submitting.value ? "提交中…" : "完成登录" }}
        </button>
      </div>
      <div v-if="login.error.value" class="oauth-msg">{{ login.error.value }}</div>
      <div class="waiting-actions">
        <span class="link reopen-link" @click="login.openLoginPage">浏览器没打开？点这里打开登录页</span>
        <span class="link cancel-link" @click="login.cancel">取消</span>
      </div>
    </template>

    <template v-else>
      <button
        v-if="!(showAccount && account?.loggedIn)"
        class="btn-primary oauth-btn"
        :disabled="login.phase.value === 'starting'"
        @click="login.start"
      >
        {{ login.phase.value === "starting" ? "启动中…" : "用 Claude 账号登录" }}
        <span v-if="login.phase.value !== 'starting'" class="ext">↗ 浏览器打开</span>
      </button>
      <div v-if="login.phase.value === 'failed'" class="oauth-msg">{{ login.error.value }}</div>
    </template>
  </div>
</template>

<style scoped>
.claude-login { width: 100%; display: flex; flex-direction: column; align-items: stretch; gap: 10px; }
.btn-primary {
  padding: 13px 20px; border-radius: var(--aide-radius-md);
  background: var(--aide-accent-gradient); color: var(--aide-text-on-accent); font-size: 13.5px; font-weight: 600;
  box-shadow: var(--aide-accent-glow), var(--aide-highlight-inset);
  border: 1px solid var(--aide-border); cursor: pointer; transition: all .16s var(--aide-ease);
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
}
.btn-primary:disabled { opacity: .5; cursor: not-allowed; }
.btn-primary:not(:disabled):hover { filter: brightness(1.07); transform: translateY(-1px); }
.btn-primary .ext { font-size: 10px; opacity: .7; font-weight: 500; }
.oauth-btn { width: 100%; }
.oauth-msg { font-size: 11.5px; color: var(--aide-warning); text-align: center; line-height: 1.5; word-break: break-word; }
.waiting-text { font-size: 12.5px; color: var(--aide-text-secondary); line-height: 1.6; text-align: center; }
.code-row { display: flex; gap: 8px; }
.code-input {
  flex: 1; min-width: 0; padding: 10px 12px; border-radius: var(--aide-radius-md);
  background: var(--aide-surface-default); border: 1px solid var(--aide-border);
  color: var(--aide-text-primary); font-size: 12.5px; font-family: inherit;
}
.code-input:focus { outline: none; border-color: var(--aide-accent); }
.code-submit { padding: 10px 14px; font-size: 12.5px; white-space: nowrap; }
.waiting-actions { display: flex; justify-content: space-between; gap: 12px; }
.link {
  font-size: 12px; color: var(--aide-text-muted); cursor: pointer;
  text-decoration: underline; text-decoration-color: var(--aide-border); text-underline-offset: 3px;
}
.link:hover { color: var(--aide-text-secondary); }
.account-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.account-text { font-size: 12.5px; color: var(--aide-text-primary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account-text.muted { color: var(--aide-text-muted); }
.account-plan { margin-left: 8px; font-size: 11px; color: var(--aide-text-muted); }
.btn-ghost {
  padding: 6px 12px; border-radius: var(--aide-radius-sm); background: transparent;
  border: 1px solid var(--aide-border); color: var(--aide-text-secondary); font-size: 12px; cursor: pointer;
  white-space: nowrap;
}
.btn-ghost:disabled { opacity: .5; cursor: not-allowed; }
.btn-ghost:not(:disabled):hover { color: var(--aide-text-primary); }
</style>
