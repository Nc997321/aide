<script setup lang="ts">
// 知识库入口。打开面板未登录时直接落在这里，没有中间首屏。
// 三种互斥状态，由服务端的 initialized 决定走哪条：
//
//   setup —— 空库，创建第一个管理员（口令可选）
//   login —— 用用户名/邮箱 + 口令登录
//   join  —— 粘贴管理员发的邀请链接，一次性领取账号
//
// ⚠️ 刻意**没有注册入口**：私有化部署下服务地址就在客户内网，
// "谁能注册"等价于"谁能进内网"，而 internal/public 空间对任何已登录用户可读。
// 账号一律由管理员创建，见 knowledge-server/src/api/auth.rs 的模块注释。
import { computed, ref, watch } from "vue";
import { getBaseUrl, parseInviteToken, setBaseUrl } from "./kbClient";
import KbGuide from "./KbGuide.vue";

const props = defineProps<{
  busy: boolean;
  error: string | null;
  /** null = 还没探到（服务连不上）。此时按"已初始化"走，显示登录页 + 网络错误。 */
  initialized: boolean | null;
}>();

const emit = defineEmits<{
  setup: [username: string, displayName: string, password: string, email: string];
  login: [account: string, password: string];
  join: [token: string];
  /** 改完服务地址后重新探测（initialized 可能翻转，模式随之切换）。 */
  retry: [];
}>();

type Mode = "setup" | "login" | "join";

/** 空库时只能是 setup；否则默认 login。 */
const mode = ref<Mode>(props.initialized === false ? "setup" : "login");

/** 改服务地址重新探测后，initialized 可能翻转——模式必须跟着走，
 *  否则指向一台空库还停在登录页（必然 401）。 */
watch(
  () => props.initialized,
  (v) => {
    if (v === false) mode.value = "setup";
    else if (v === true && mode.value === "setup") mode.value = "login";
  },
);

// 空库时不该让人看到"去登录"——那个入口此刻必然失败。
// 反之已初始化时也不该再出现"创建管理员"。
const modes = computed<{ id: Mode; label: string }[]>(() => {
  if (props.initialized === false) return [{ id: "setup", label: "创建管理员" }];
  return [
    { id: "login", label: "口令登录" },
    { id: "join", label: "邀请链接加入" },
  ];
});

const username = ref("");
const displayName = ref("");
const password = ref("");
const email = ref("");
const account = ref("");
const inviteInput = ref("");

const baseUrl = ref(getBaseUrl());
const showAddr = ref(false);

function onBaseBlur(): void {
  setBaseUrl(baseUrl.value);
  baseUrl.value = getBaseUrl();
  emit("retry");
}

const canSubmit = computed(() => {
  if (mode.value === "setup") return username.value.trim() !== "" && displayName.value.trim() !== "";
  if (mode.value === "login") return account.value.trim() !== "" && password.value !== "";
  return parseInviteToken(inviteInput.value) !== "";
});

function onSubmit(): void {
  if (!canSubmit.value || props.busy) return;
  if (mode.value === "setup") {
    emit("setup", username.value.trim(), displayName.value.trim(), password.value, email.value.trim());
  } else if (mode.value === "login") {
    emit("login", account.value.trim(), password.value);
  } else {
    emit("join", parseInviteToken(inviteInput.value));
  }
}

/** 粘贴时直接提交：邀请链接长且不可读，让人再点一次按钮是多余的。 */
function onInvitePaste(e: ClipboardEvent): void {
  const text = e.clipboardData?.getData("text") ?? "";
  if (!text) return;
  e.preventDefault();
  inviteInput.value = text;
  if (parseInviteToken(text)) void onSubmit();
}
</script>

<template>
  <!-- 双栏：左边表单，右边内置指南。登录前就能看到产品本来的样子——
       第一次搭服务的人需要的部署指引也正好在指南第一节。窄面板下指南被
       压缩（min-width:0），文字自然折行，不会挤坏表单。 -->
  <div class="kb-login">
    <div class="kb-login-form">
      <form class="kb-card" @submit.prevent="onSubmit">
      <h2>{{ mode === "setup" ? "初始化知识库" : mode === "join" ? "加入知识库" : "登录知识库" }}</h2>
      <p v-if="mode === 'setup'" class="kb-sub">
        这个实例还没有任何用户。创建第一个管理员，之后由他邀请同事。
      </p>
      <p v-else-if="mode === 'join'" class="kb-sub">
        把管理员发来的邀请链接整条粘贴进来。链接只能用一次。
      </p>
      <!-- 这一页是**兜底**：正常情况下凭据由 Aide 替你带着，打开面板直接进去。
           走到这里只有两种情况——从来没登录过，或者凭据失效了。 -->
      <p v-else class="kb-sub">
        账号由管理员分配，没有注册入口。平时不用来这里——凭据失效了才需要重新登录一次。
      </p>

      <div v-if="modes.length > 1" class="kb-tabs">
        <button
          v-for="m in modes"
          :key="m.id"
          type="button"
          class="kb-tab"
          :class="{ on: mode === m.id }"
          @click="mode = m.id"
        >
          {{ m.label }}
        </button>
      </div>

      <template v-if="mode === 'setup'">
        <label>
          <span>用户名</span>
          <input v-model="username" type="text" autocomplete="username" placeholder="登录用，如 zhangsan" />
        </label>
        <label>
          <span>昵称</span>
          <input v-model="displayName" type="text" placeholder="团队里显示的名字" />
        </label>
        <label>
          <span>口令（可留空）</span>
          <input v-model="password" type="password" autocomplete="new-password" placeholder="留空则只能凭邀请链接进入" />
        </label>
        <label>
          <span>邮箱（可选）</span>
          <input v-model="email" type="email" placeholder="仅用于找回与通知" />
        </label>
      </template>

      <template v-else-if="mode === 'login'">
        <label>
          <span>用户名或邮箱</span>
          <input v-model="account" type="text" autocomplete="username" required />
        </label>
        <label>
          <span>口令</span>
          <input v-model="password" type="password" autocomplete="current-password" required />
        </label>
      </template>

      <template v-else>
        <label>
          <span>邀请链接</span>
          <input
            v-model="inviteInput"
            type="text"
            placeholder="http://host:8788/join#… 或直接贴令牌"
            @paste="onInvitePaste"
          />
        </label>
      </template>

      <p v-if="props.error" class="kb-err">{{ props.error }}</p>

      <button class="kb-primary" type="submit" :disabled="props.busy || !canSubmit">
        {{ props.busy ? "处理中…" : mode === "setup" ? "创建并进入" : mode === "join" ? "领取账号" : "登录" }}
      </button>

      <div class="kb-foot">
        <button type="button" class="kb-link" @click="showAddr = !showAddr">服务地址</button>
      </div>

      <label v-if="showAddr" class="kb-addr">
        <span>knowledge-server 地址</span>
        <input v-model="baseUrl" type="url" @blur="onBaseBlur" @keydown.enter.prevent="onBaseBlur" />
        <small>默认 http://127.0.0.1:8788。改完失焦生效。</small>
      </label>
    </form>
    </div>
    <aside class="kb-login-guide">
      <KbGuide deploy />
    </aside>
  </div>
</template>

<style scoped>
/* 登录兜底页：左边是表单本身，**不套卡片**（框是模板感的来源）；
   右边是同一份《使用指南》（还没连上服务器也能看到产品本来的样子）。
   表单直接落在平面上，靠一条大标题和留白立住，不靠盒子。 */

.kb-login {
  display: flex;
  height: 100%;
  overflow: hidden;
}
.kb-login-form {
  width: 420px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
  overflow: auto;
}
.kb-login-guide {
  flex: 1;
  min-width: 0;
  border-left: 1px solid var(--aide-border-subtle);
  overflow: hidden;
}
.kb-card {
  width: 100%;
  max-width: 320px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.kb-card h2 {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.01em;
  color: var(--aide-text-primary);
}
.kb-sub {
  margin: -8px 0 0;
  font-size: 12.5px;
  color: var(--aide-text-muted);
  line-height: 1.7;
}

/* tab 不做出"槽 + 选中块"，改成下划线——少一层填充就少一分模板感 */
.kb-tabs {
  display: flex;
  gap: 20px;
  border-bottom: 1px solid var(--aide-border-subtle);
}
.kb-tab {
  flex: none;
  padding: 0 0 8px;
  margin-bottom: -1px;
  font: inherit;
  font-size: 13px;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--aide-text-muted);
  cursor: pointer;
  transition: color var(--aide-ease-t), border-color var(--aide-ease-t);
}
.kb-tab:hover { color: var(--aide-text-secondary); }
.kb-tab.on {
  color: var(--aide-text-primary);
  border-bottom-color: var(--aide-accent);
}
.kb-tab:focus-visible { outline: none; box-shadow: var(--aide-accent-ring); }

label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--aide-text-muted);
}
input {
  padding: 8px 10px;
  font: inherit;
  font-size: 13px;
  color: var(--aide-text-primary);
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-sm);
  outline: none;
  transition: box-shadow var(--aide-ease-t);
}
input:focus { box-shadow: var(--aide-accent-ring); }
input::placeholder { color: var(--aide-text-muted); }

.kb-err {
  margin: 0;
  font-size: 12px;
  color: var(--aide-danger);
  line-height: 1.6;
}
.kb-primary {
  padding: 9px;
  font: inherit;
  font-size: 13px;
  color: var(--aide-text-on-accent);
  background: var(--aide-accent);
  border: none;
  border-radius: var(--aide-radius-sm);
  box-shadow: var(--aide-highlight-inset);
  cursor: pointer;
  transition: background var(--aide-ease-t);
}
.kb-primary:hover:not(:disabled) { background: var(--aide-accent-hover); }
.kb-primary:disabled { opacity: 0.45; cursor: default; }
.kb-primary:focus-visible { outline: none; box-shadow: var(--aide-accent-ring); }
.kb-foot {
  display: flex;
  justify-content: flex-end;
}
.kb-link {
  border: none;
  background: none;
  padding: 2px 0;
  font: inherit;
  font-size: 12px;
  color: var(--aide-text-muted);
  cursor: pointer;
  transition: color var(--aide-ease-t);
}
.kb-link:hover { color: var(--aide-text-primary); }
.kb-link:focus-visible { outline: none; box-shadow: var(--aide-accent-ring); border-radius: 3px; }
.kb-addr small {
  font-size: 11.5px;
  color: var(--aide-text-muted);
  line-height: 1.6;
}
</style>
