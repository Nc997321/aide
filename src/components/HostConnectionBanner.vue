<script setup lang="ts">
// Host 窗口的连接状态条：连接意外断开（或建连失败）时如实说出来，并给「重新连接」。
//
// 为什么重新连接 = 重载窗口：断线时 Host 上的 serve 随之收掉——进行中的会话、文件监听、终端、
// 语言服务器都没了，新连接是一个全新的 Host 进程。窗口里各处持有的都是旧进程的状态，
// 逐个修补必有遗漏；重载让所有消费方从新 Host 重新取（会话历史在 Host 磁盘上，不丢）。
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

const broken = computed(() => status.value?.state === "disconnected" || status.value?.state === "error");
const visible = computed(() => !!hostKey.value && (broken.value || reconnecting.value));
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
      <template v-else>
        与 {{ label }} 的连接已断开<template v-if="detail">：{{ detail }}</template>。进行中的会话已终止，历史保留；重新连接会重载此窗口。
      </template>
    </span>
    <button v-if="!reconnecting" class="host-banner-btn" type="button" @click="reconnect">重新连接</button>
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
