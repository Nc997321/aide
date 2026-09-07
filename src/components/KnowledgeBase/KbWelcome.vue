<script setup lang="ts">
// 知识库的**第一屏**。
//
// 设计前提：看到这个面板的人多半还没决定要不要用知识库。
// 直接甩一个登录框，他只知道自己"又要登一个东西"，却不知道这是什么、要不要自己搭。
// 所以这里先回答三个问题：这是什么 → 我要走哪条路 → 那条路怎么走。
//
// 三条路：
//   加入   —— 团队里已经有一台服务，用管理员发的邀请链接进来
//   自建   —— 还没有服务，按指引自己起一台（docker compose），起完回来填地址
//   先看   —— 连演示数据看一眼它长什么样，不需要任何服务
import { computed, ref } from "vue";
import Icon from "@/components/Icon.vue";
import { getBaseUrl, setBaseUrl } from "./kbClient";

const props = defineProps<{
  busy: boolean;
  error: string | null;
  /** null = 还没探到（服务连不上）。已初始化 = true 表示可登录/加入；false 表示空库只能建管理员。 */
  initialized?: boolean | null;
}>();

const emit = defineEmits<{
  join: [];
  login: [];
  /** 空库（initialized === false）时唯一的正向入口：去 KbLogin 的「创建管理员」。 */
  setup: [];
  demo: [];
  /** 改完服务地址后重新探测一次 */
  retry: [];
}>();

const showSetup = ref(false);
const showAddr = ref(false);
const baseUrl = ref(getBaseUrl());
const addrCopied = ref(false);

/** 连不上时才提示。没错误就别用红字吓人。 */
const offline = computed(() => props.error !== null);

function onBaseBlur(): void {
  setBaseUrl(baseUrl.value);
  baseUrl.value = getBaseUrl();
  emit("retry");
}

async function copyStartCmd(): Promise<void> {
  try {
    await navigator.clipboard.writeText("docker compose up -d");
    addrCopied.value = true;
    setTimeout(() => (addrCopied.value = false), 2000);
  } catch {
    // 剪贴板不可用时什么都不做：命令就在旁边，手抄也一样
  }
}
</script>

<template>
  <div class="kb-welcome">
    <div class="kb-hero">
      <h2>团队知识库</h2>
      <p>
        把团队的文档、规范、排障记录放在一处，支持全文检索、版本历史与回滚。
        它跑在<strong>你们自己的服务器</strong>上——数据不出你们的机房。
      </p>
      <ul class="kb-feats">
        <li><Icon name="search" :size="12" :stroke-width="1.4" /> 中文全文检索</li>
        <li><Icon name="file" :size="12" :stroke-width="1.4" /> 导入 docx / pdf / md</li>
        <li><Icon name="refresh" :size="12" :stroke-width="1.4" /> 每次保存可回滚</li>
        <li><Icon name="server" :size="12" :stroke-width="1.4" /> 私有化部署</li>
      </ul>
    </div>

    <p v-if="offline" class="kb-offline">
      {{ props.error }}
      <button class="kb-link" @click="emit('retry')">重试</button>
    </p>

    <div class="kb-choices">
      <!-- join/login 只在服务已初始化（探测过且 initialized=true）下才有意义。
           探测失败（null）时也保留，提示用户换个地址；空库（false）下隐藏，避免把用户领进死路。 -->
      <button
        v-if="props.initialized === false"
        class="kb-choice"
        @click="emit('setup')"
      >
        <span class="kb-choice-t">初始化知识库</span>
        <span class="kb-choice-d">这个实例还没有任何用户，创建第一个管理员</span>
        <span class="kb-choice-go">创建管理员 →</span>
      </button>

      <button
        v-if="props.initialized !== false"
        class="kb-choice"
        @click="emit('join')"
      >
        <span class="kb-choice-t">加入已有知识库</span>
        <span class="kb-choice-d">团队里已经有一台，我有管理员发的邀请链接</span>
        <span class="kb-choice-go">粘贴邀请链接 →</span>
      </button>

      <button class="kb-choice" :class="{ on: showSetup }" @click="showSetup = !showSetup">
        <span class="kb-choice-t">我自己部署一个</span>
        <span class="kb-choice-d">还没有服务，在一台机器上把它跑起来</span>
        <span class="kb-choice-go">{{ showSetup ? "收起指引" : "查看安装指引" }} →</span>
      </button>

      <button class="kb-choice" @click="emit('demo')">
        <span class="kb-choice-t">先看看它长什么样</span>
        <span class="kb-choice-d">用演示数据浏览，不需要任何服务</span>
        <span class="kb-choice-go">打开演示 →</span>
      </button>
    </div>

    <section v-if="showSetup" class="kb-setup">
      <ol class="kb-steps">
        <li>
          在那台机器上装好 Docker（<a href="https://www.docker.com/products/docker-desktop/" target="_blank" rel="noopener noreferrer">下载</a>）
        </li>
        <li>
          取 aide 仓库里 <code>knowledge-server/docker-compose.yml</code>，放到那台机器的任意空目录
        </li>
        <li>
          在该目录执行
          <div class="kb-cmd">
            <code>docker compose up -d</code>
            <button class="kb-link" @click="copyStartCmd()">{{ addrCopied ? "已复制" : "复制" }}</button>
          </div>
          这一条会把 PostgreSQL 和知识库服务一起拉起来，不用单独装数据库。
        </li>
        <li>
          服务默认监听 <code>8788</code>。回到这里填它的地址：
          <div class="kb-cmd">
            <input v-model="baseUrl" type="url" @blur="onBaseBlur" @keydown.enter.prevent="onBaseBlur" />
          </div>
        </li>
        <li>
          第一次连上会让你<strong>创建第一个管理员</strong>，之后由他生成邀请链接给同事
        </li>
      </ol>
      <p class="kb-note">
        需要让团队里其他人也能访问时，把 compose 里的 <code>KB_HOST</code> 改成
        <code>0.0.0.0</code>，并配置 <code>KB_ALLOWED_CIDR</code> 只允许内网网段。
      </p>
    </section>

    <div class="kb-foot">
      <button v-if="props.initialized !== false" class="kb-link" @click="emit('login')">我有账号，用口令登录</button>
      <button class="kb-link" @click="showAddr = !showAddr">服务地址：{{ getBaseUrl() }}</button>
    </div>
    <label v-if="showAddr" class="kb-addr">
      <input v-model="baseUrl" type="url" @blur="onBaseBlur" @keydown.enter.prevent="onBaseBlur" />
      <small>改完失焦自动重连。默认 http://127.0.0.1:8788</small>
    </label>
  </div>
</template>

<style scoped>
.kb-welcome {
  height: 100%;
  overflow: auto;
  padding: 28px 24px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.kb-hero h2 {
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 600;
  color: var(--aide-text-primary);
}
.kb-hero p {
  margin: 0;
  max-width: 520px;
  font-size: 12px;
  line-height: 1.8;
  color: var(--aide-text-secondary, var(--aide-text-muted));
}
.kb-hero strong { color: var(--aide-text-primary); }
.kb-feats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}
.kb-feats li {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--aide-text-muted);
}

.kb-offline {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 7px 10px;
  font-size: 11px;
  border-radius: 6px;
  color: var(--aide-text-secondary, var(--aide-text-muted));
  background: var(--aide-bg-deep);
}

.kb-choices {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px;
}
.kb-choice {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px;
  text-align: left;
  border: 1px solid var(--aide-border);
  border-radius: 10px;
  background: var(--aide-bg-secondary);
  cursor: pointer;
  transition: border-color 0.12s;
}
.kb-choice:hover { border-color: var(--aide-accent); }
.kb-choice.on { border-color: var(--aide-accent); }
.kb-choice-t {
  font-size: 13px;
  font-weight: 600;
  color: var(--aide-text-primary);
}
.kb-choice-d {
  font-size: 11px;
  line-height: 1.6;
  color: var(--aide-text-muted);
}
.kb-choice-go {
  margin-top: 4px;
  font-size: 11px;
  color: var(--aide-accent);
}

.kb-setup {
  padding: 14px 16px;
  border: 1px solid var(--aide-border);
  border-radius: 10px;
  background: var(--aide-bg-primary);
}
.kb-steps {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--aide-text-secondary, var(--aide-text-muted));
}
.kb-steps strong { color: var(--aide-text-primary); }
.kb-cmd {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 5px 0;
}
.kb-cmd code,
.kb-steps code {
  padding: 3px 6px;
  font-family: var(--aide-font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--aide-text-primary);
  background: var(--aide-bg-deep);
  border-radius: 4px;
}
.kb-cmd input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  font-size: 11px;
  font-family: var(--aide-font-mono, ui-monospace, monospace);
  color: var(--aide-text-primary);
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border);
  border-radius: 4px;
  outline: none;
}
.kb-cmd input:focus { border-color: var(--aide-accent); }
.kb-note {
  margin: 12px 0 0;
  padding-top: 10px;
  border-top: 1px solid var(--aide-border);
  font-size: 11px;
  line-height: 1.7;
  color: var(--aide-text-muted);
}

.kb-foot {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-top: auto;
  padding-top: 8px;
}
.kb-link {
  border: none;
  background: none;
  padding: 0;
  font-size: 11px;
  color: var(--aide-accent);
  cursor: pointer;
}
.kb-addr { display: flex; flex-direction: column; gap: 4px; }
.kb-addr input {
  padding: 6px 8px;
  font-size: 11px;
  color: var(--aide-text-primary);
  background: var(--aide-bg-primary);
  border: 1px solid var(--aide-border);
  border-radius: 6px;
  outline: none;
}
.kb-addr small { font-size: 10px; color: var(--aide-text-muted); }
</style>
