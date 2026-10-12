<script setup lang="ts">
// Host 窗口的连接状态条：还在连 / 连不上 / 连接意外断开时如实说出来，并给「重新连接」。
//
// 建连（开窗后的第一次）：
// - `installing` / `connecting`：正在装远程套件 / 握手——窗口里的命令都在等它，侧栏只会「加载中」，
//   所以这里必须说清在干什么（套件升级后要重新下 Claude CLI，可能几分钟）；
// - `error`：没连上——给原因和「重新连接」。
//
// 断线分三种（Rust 侧 `RemoteWorkspaces`，Host 是常驻守护进程）：
// - `reconnecting`：正在自动重连，Host 上的会话还在——只提示，不给按钮；成功了条自己消失；
// - `resync`：重连上了原来的 Host，但断线太久、错过的更新补不齐——会话在，界面状态不可信，
//   提示重新加载；
// - `disconnected` / `error`：连不回原来的 Host（它重启过 / 一直连不上）——会话已终止。
//
// 为什么「重新连接 / 重新加载」= 重载窗口：窗口里各处持有的都是旧状态，逐个修补必有遗漏；
// 重载让所有消费方从 Host 重新取（会话历史在 Host 磁盘上，不丢）。
//
// 本机窗口恒不显示（本机 Host 在进程内，没有「连接」可断）。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  hostApi,
  listen,
  remoteWorkspaceApi,
  REMOTE_WORKSPACE_STATUS_EVENT,
  type RemoteHostStatus,
} from "@aide/sdk";

const hostKey = ref("");
const hostLabel = ref("");
const status = ref<RemoteHostStatus | null>(null);
const reconnecting = ref(false);
const failure = ref("");
let unlisten: (() => void) | null = null;

const state = computed(() => status.value?.state ?? "");
const broken = computed(() => state.value === "disconnected" || state.value === "error");
// 没连上过（建连失败），区别于连上之后断开：没有「进行中的会话」可言
const neverConnected = computed(() => state.value === "error");
const pending = computed(() => state.value === "installing" || state.value === "connecting");
const autoReconnecting = computed(() => state.value === "reconnecting");
const resync = computed(() => state.value === "resync");
const visible = computed(
  () =>
    !!hostKey.value &&
    (broken.value || pending.value || autoReconnecting.value || resync.value || reconnecting.value),
);
const label = computed(() => status.value?.label || hostLabel.value || hostKey.value);
const detail = computed(() => failure.value || status.value?.detail || "");
const progress = computed(() => {
  if (state.value === "installing") {
    return `正在连接 ${label.value}：${status.value?.detail || "正在检查远程套件…"}`;
  }
  return `正在连接 ${label.value}…`;
});
// 进度条：下载 / 上传这类量得出的步骤给确定进度，其余建连步骤给不确定的流动条
const working = computed(() => pending.value || reconnecting.value);
const ratio = computed(() => {
  const p = pending.value ? status.value?.progress : undefined;
  return typeof p === "number" ? Math.min(1, Math.max(0, p)) : null;
});
const percent = computed(() => (ratio.value === null ? "" : `${Math.round(ratio.value * 100)}%`));

function apply(next: RemoteHostStatus) {
  if (next.host !== hostKey.value) return;
  status.value = next;
}

onMounted(async () => {
  try {
    // 身份不等连接（`current()` 要等连接就绪——连不上时这条恰恰最该出现）
    const h = await hostApi.identity();
    if (h.key === "local") return;
    hostKey.value = h.key;
    hostLabel.value = h.label;
    unlisten = await listen<RemoteHostStatus>(REMOTE_WORKSPACE_STATUS_EVENT, (e) => apply(e.payload));
    // 窗口晚于断开事件才挂上时，补读一次当前状态
    const known = (await remoteWorkspaceApi.statuses()).find((s) => s.host === h.key);
    if (known) apply(known);
  } catch {
    /* 非桌面环境：不显示 */
  }
});

onBeforeUnmount(() => unlisten?.());

async function reconnect() {
  reconnecting.value = true;
  failure.value = "";
  try {
    await remoteWorkspaceApi.connect(hostKey.value);
    window.location.reload();
  } catch (e) {
    failure.value = String(e);
    reconnecting.value = false;
  }
}
</script>

<template>
  <div v-if="visible" class="host-banner" :class="{ working }" role="alert">
    <span class="host-banner-text" :title="detail || undefined">
      <template v-if="reconnecting || pending">{{ progress }}</template>
      <template v-else-if="autoReconnecting">与 {{ label }} 的连接已断开，正在自动重新连接…（Host 上的会话仍在运行）</template>
      <template v-else-if="resync">与 {{ label }} 断线期间错过了部分更新（会话仍在运行）。重新加载窗口即可同步。</template>
      <template v-else-if="neverConnected">
        无法连接 {{ label }}<template v-if="detail">：{{ detail }}</template>。重新连接会重载此窗口。
      </template>
      <template v-else>
        与 {{ label }} 的连接已断开<template v-if="detail">：{{ detail }}</template>。进行中的会话已终止，历史保留；重新连接会重载此窗口。
      </template>
    </span>
    <template v-if="working">
      <span v-if="percent" class="host-banner-percent">{{ percent }}</span>
      <div
        class="host-banner-bar"
        :class="{ indeterminate: ratio === null }"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="ratio === null ? undefined : Math.round(ratio * 100)"
      >
        <div class="host-banner-bar-fill" :style="ratio === null ? undefined : { width: percent }" />
      </div>
    </template>
    <button v-if="!reconnecting && !pending && !autoReconnecting" class="host-banner-btn" type="button" @click="reconnect">
      {{ resync ? "重新加载" : "重新连接" }}
    </button>
  </div>
</template>

<style scoped>
.host-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 14px;
  font-size: 12px;
  color: var(--aide-text-primary);
  background: var(--aide-bg-raised);
  border-bottom: 1px solid var(--aide-danger);
}
/* 正在连接不是故障：不用报错色 */
.host-banner.working {
  border-bottom-color: var(--aide-accent);
}
.host-banner-percent {
  flex: none;
  font-variant-numeric: tabular-nums;
  color: var(--aide-text-secondary);
}
.host-banner-bar {
  flex: none;
  width: 180px;
  height: 4px;
  overflow: hidden;
  background: var(--aide-border);
  border-radius: 2px;
}
.host-banner-bar-fill {
  height: 100%;
  background: var(--aide-accent);
  border-radius: 2px;
  transition: width 0.2s linear;
}
.host-banner-bar.indeterminate .host-banner-bar-fill {
  width: 35%;
  animation: host-banner-slide 1.2s ease-in-out infinite;
}
@keyframes host-banner-slide {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(286%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .host-banner-bar.indeterminate .host-banner-bar-fill {
    animation: none;
    width: 100%;
    opacity: 0.5;
  }
}
.host-banner-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.host-banner-btn {
  flex: none;
  padding: 2px 12px;
  font-size: 12px;
  color: var(--aide-text-on-accent);
  background: var(--aide-accent);
  border: none;
  border-radius: 4px;
  cursor: pointer;
}
.host-banner-btn:hover {
  background: var(--aide-accent-hover);
}
</style>
