<script setup lang="ts">
// 知识库入口。三种互斥状态，由服务端的 initialized 决定走哪条：
//
//   setup —— 空库，创建第一个管理员（口令可选）
//   login —— 用用户名/邮箱 + 口令登录
//   join  —— 粘贴管理员发的邀请链接，一次性领取账号
//
// ⚠️ 刻意**没有注册入口**：私有化部署下服务地址就在客户内网，
// "谁能注册"等价于"谁能进内网"，而 internal/public 空间对任何已登录用户可读。
// 账号一律由管理员创建，见 knowledge-server/src/api/auth.rs 的模块注释。
import { computed, ref } from "vue";
import { getBaseUrl, parseInviteToken, setBaseUrl } from "./kbClient";

const props = defineProps<{
  busy: boolean;
  error: string | null;
  /** null = 还没探到（服务连不上）。此时按"已初始化"走，显示登录页 + 网络错误。 */
  initialized: boolean | null;
  /** KnowledgeBase.vue 在 KbWelcome 触发 join/login 时显式指定。 */
  preferMode?: "login" | "join";
}>();

const emit = defineEmits<{
  setup: [username: string, displayName: string, password: string, email: string];
  login: [account: string, password: string];
  join: [token: string];
  cancel: [];
}>();

type Mode = "setup" | "login" | "join";

/** 初始化优先级：preferMode > initialized 推断。空库时无论 preferMode 是什么都只能 setup。 */
const mode = ref<Mode>(
  props.initialized === false
    ? "setup"
    : props.preferMode ?? "login",
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
  <div class="kb-login">
    <form class="kb-card" @submit.prevent="onSubmit">
      <h2>{{ mode === "setup" ? "初始化知识库" : mode === "join" ? "加入知识库" : "登录知识库" }}</h2>
      <p v-if="mode === 'setup'" class="kb-sub">
        这个实例还没有任何用户。创建第一个管理员，之后由他邀请同事。
      </p>
      <p v-else-if="mode === 'join'" class="kb-sub">
        把管理员发来的邀请链接整条粘贴进来。链接只能用一次。
      </p>
      <p v-else class="kb-sub">账号由管理员分配，没有注册入口。</p>

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
        <button type="button" class="kb-link" @click="emit('cancel')">← 返回</button>
        <button type="button" class="kb-link" @click="showAddr = !showAddr">服务地址</button>
      </div>

      <label v-if="showAddr" class="kb-addr">
        <span>knowledge-server 地址</span>
        <input v-model="baseUrl" type="url" @blur="onBaseBlur" @keydown.enter.prevent="onBaseBlur" />
        <small>默认 http://127.0.0.1:8788。改完失焦生效。</small>
      </label>
    </form>
  </div>
</template>

<style scoped>
.kb-login {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 24px;
  overflow: auto;
}
.kb-card {
  width: 320px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 22px;
  border: 1px solid var(--aide-border);
  border-radius: 12px;
  background: var(--aide-bg-secondary);
}
.kb-card h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--aide-text-primary);
}
.kb-sub {
  margin: -4px 0 4px;
  font-size: 11px;
  color: var(--aide-text-muted);
  line-height: 1.6;
}
.kb-tabs {
  display: flex;
  gap: 4px;
  padding: 2px;
  border-radius: 8px;
  background: var(--aide-bg-deep);
}
.kb-tab {
  flex: 1;
  padding: 5px 6px;
  font-size: 11px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--aide-text-muted);
  cursor: pointer;
}
.kb-tab.on {
  background: var(--aide-bg-secondary);
  color: var(--aide-text-primary);
}
label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--aide-text-muted);
}
input {
  padding: 7px 9px;
  font-size: 12px;
  color: var(--aide-text-primary);
  background: var(--aide-bg-primary);
  border: 1px solid var(--aide-border);
  border-radius: 6px;
  outline: none;
}
input:focus {
  border-color: var(--aide-accent);
}
.kb-err {
  margin: 0;
  font-size: 11px;
  color: var(--aide-error, #d0453b);
  line-height: 1.5;
}
.kb-primary {
  padding: 8px;
  font-size: 12px;
  color: #fff;
  background: var(--aide-accent);
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.kb-primary:disabled {
  opacity: 0.6;
  cursor: default;
}
.kb-foot {
  display: flex;
  justify-content: flex-end;
}
.kb-link {
  border: none;
  background: none;
  padding: 0;
  font-size: 11px;
  color: var(--aide-accent);
  cursor: pointer;
}
.kb-addr small {
  font-size: 10px;
  color: var(--aide-text-muted);
}
</style>
