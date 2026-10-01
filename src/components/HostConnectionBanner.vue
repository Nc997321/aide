<script setup lang="ts">
// Host 窗口的连接状态条：连接意外断开（或建连失败）时如实说出来，并给「重新连接」。
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
const status = ref<RemoteHostStatus | null>(null);
const reconnecting = ref(false);
const failure = ref("");
let unlisten: (() => void) | null = null;

const state = computed(() => status.value?.state ?? "");
const broken = computed(() => state.value === "disconnected" || state.value === "error");
const autoReconnecting = computed(() => state.value === "reconnecting");
const resync = computed(() => state.value === "resync");
const visible = computed(
  () => !!hostKey.value && (broken.value || autoReconnecting.value || resync.value || reconnecting.value),
);
const label = computed(() => status.value?.label ?? hostKey.value);
const detail = computed(() => failure.value || status.value?.detail || "");
const progress = computed(() => {
  const s = status.value?.state;
  return s === "installing" ? "正在安装远程套件…" : "正在重新连接…";
});

function apply(next: RemoteHostStatus) {
  if (next.host !== hostKey.value) return;
  status.value = next;
}

onMounted(async () => {
  try {
    const h = await hostApi.current();
    if (h.key === "local") return;
    hostKey.value = h.key;
    unlisten = await listen<RemoteHostStatus>(REMOTE_WORKSPACE_STATUS_EVENT, (e) => apply(e.payload));
    // 窗口晚于断开事件才挂上时，补读一次当前状态
    const known = (await remoteWorkspaceApi.statuses()).find((s) => s.host === h.key);
    if (known) apply(known);
  } catch {
    /* 非桌面环境 / 连接未就绪：不显示 */
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
  <div v-if="visible" class="host-banner" role="alert">
    <span class="host-banner-text">
      <template v-if="reconnecting">{{ progress }}</template>
      <template v-else-if="autoReconnecting">与 {{ label }} 的连接已断开，正在自动重新连接…（Host 上的会话仍在运行）</template>
      <template v-else-if="resync">与 {{ label }} 断线期间错过了部分更新（会话仍在运行）。重新加载窗口即可同步。</template>
      <template v-else>
        与 {{ label }} 的连接已断开<template v-if="detail">：{{ detail }}</template>。进行中的会话已终止，历史保留；重新连接会重载此窗口。
      </template>
    </span>
    <button v-if="!reconnecting && !autoReconnecting" class="host-banner-btn" type="button" @click="reconnect">
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
