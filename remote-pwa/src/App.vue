<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { RemoteClient, type ConnState, type ConnectCreds } from "./protocol";
import { clearCreds, loadCreds, loadRelayUrl, saveCreds, saveRelayUrl } from "./storage";
import { newSessionId } from "./session";
import type { ChatEvent, Session, Workspace } from "./types";
import ConnectView from "./components/ConnectView.vue";
import SessionList from "./components/SessionList.vue";
import ChatView from "./components/ChatView.vue";

type View = "conn" | "sessions" | "chat";

const client = ref<RemoteClient | null>(null);
const connState = ref<ConnState>("idle");
const view = ref<View>("conn");
const sessions = ref<Session[]>([]);
const activeSession = ref<{ id: string; name: string; workspaceKey: string | null } | null>(null);
const liveSessions = reactive(new Set<string>());
const pairError = ref<"badcode" | "revoked" | null>(null);
const hasCreds = ref(false);
const refreshing = ref(false);
const pairing = ref(false);
const savedRelayUrl = loadRelayUrl();
const errorMsg = ref<string | null>(null);
let errorTimer: ReturnType<typeof setTimeout> | null = null;

// ── 工作区 ──
const workspaces = ref<Workspace[]>([]);
/** null = 跟随桌面当前活动工作区（列表不带 key 拉取，与桌面实时同步） */
const activeWorkspaceKey = ref<string | null>(null);
/** 会话 → 归属工作区 key：列表按工作区拉取时记录，聊天发消息用（历史会话 cwd 必须落对目录） */
const sessionWs = new Map<string, string>();

// ── 连接 ──

function connect(relayUrl: string, creds: ConnectCreds): void {
  client.value?.disconnect(); // 换 URL / 换凭据时关掉旧连接
  const c = new RemoteClient(relayUrl);
  c.onStateChange(handleState);
  c.onEvent(handleEvent);
  // 桌面侧执行错误（如会话创建失败）——显示出来，否则「发消息没响应」无从诊断
  c.onError((m) => {
    errorMsg.value = m;
    if (errorTimer) clearTimeout(errorTimer);
    errorTimer = setTimeout(() => (errorMsg.value = null), 5000);
  });
  client.value = c;
  c.connect(creds);
}

function handleState(s: ConnState): void {
  connState.value = s;
  if (s === "authed") {
    if (view.value === "conn") view.value = "sessions";
    refreshWorkspaces();
    refreshSessions();
  } else if (s === "needsPairing") {
    // 配对失败（badcode）与 token 被吊销（revoked）都回连接屏
    clearCreds();
    hasCreds.value = false;
    pairError.value = pairing.value ? "badcode" : "revoked";
    view.value = "conn";
  }
}

function handleEvent(e: ChatEvent): void {
  // 会话列表"回复中"徽标：收到事件标记 live，message_stop 清除
  if (!e.session_id) return;
  if (e.type === "message_stop") liveSessions.delete(e.session_id);
  else liveSessions.add(e.session_id);
}

/** 配对：连接中继 → 发 pair → 成功存凭据进会话列表 */
async function pairWithCode(relayUrl: string, code: string): Promise<void> {
  pairing.value = true;
  pairError.value = null;
  saveRelayUrl(relayUrl);
  connect(relayUrl, { code });
  try {
    const ok = await client.value?.pair(code);
    if (ok) {
      saveCreds({ relayUrl, deviceId: ok.device_id, token: ok.token });
      hasCreds.value = true;
    }
  } catch {
    // auth_error → handleState 已置 needsPairing + badcode；连接断开 → offline 自动重试
  } finally {
    pairing.value = false;
  }
}

// ── 会话列表 ──

async function refreshWorkspaces(): Promise<void> {
  const c = client.value;
  if (!c || connState.value !== "authed") return;
  try {
    workspaces.value = await c.listWorkspaces();
  } catch {
    // 断线等，保持现状
  }
}

/** 切换工作区：固定选择后会话列表按该工作区拉取；新会话发往该工作区 */
function changeWorkspace(key: string): void {
  activeWorkspaceKey.value = key;
  refreshSessions();
}

async function refreshSessions(): Promise<void> {
  const c = client.value;
  if (!c || connState.value !== "authed") return;
  refreshing.value = true;
  try {
    sessions.value = await c.listSessions(activeWorkspaceKey.value ?? undefined);
    // 记录会话归属工作区：发历史会话消息时带其 key，cwd 才落对目录
    const wsKey = activeWorkspaceKey.value;
    if (wsKey) {
      for (const s of sessions.value) sessionWs.set(s.id, wsKey);
    }
  } catch {
    // 断线等，保持现状
  } finally {
    refreshing.value = false;
  }
}

function openSession(s: Session): void {
  activeSession.value = {
    id: s.id,
    name: s.name,
    // 跟随桌面（null）时列表没记 key——不带 key 发消息 = 桌面当前工作区，恰好一致
    workspaceKey: sessionWs.get(s.id) ?? null,
  };
  view.value = "chat";
}

function newSession(): void {
  activeSession.value = {
    id: newSessionId(),
    name: "新会话",
    workspaceKey: activeWorkspaceKey.value, // 新建会话发往当前所选工作区
  };
  view.value = "chat";
}

function backToSessions(): void {
  view.value = "sessions";
  refreshSessions(); // 回列表时刷新，新会话/新消息可见
}

// ── 启动：有凭据自动连接 ──

onMounted(() => {
  const creds = loadCreds();
  if (creds) {
    hasCreds.value = true;
    connect(creds.relayUrl, { deviceId: creds.deviceId, token: creds.token });
  }
});
</script>

<template>
  <div class="app">
    <ConnectView
      v-if="view === 'conn'"
      :conn-state="connState"
      :relay-url="savedRelayUrl"
      :pair-error="pairError"
      :has-creds="hasCreds"
      @connect="pairWithCode"
      @clear-error="pairError = null"
    />
    <SessionList
      v-else-if="view === 'sessions'"
      :conn-state="connState"
      :sessions="sessions"
      :live-sessions="liveSessions"
      :refreshing="refreshing"
      :workspaces="workspaces"
      :active-workspace-key="activeWorkspaceKey"
      @open="openSession"
      @new-session="newSession"
      @refresh="refreshSessions"
      @workspace-change="changeWorkspace"
    />
    <ChatView
      v-else-if="view === 'chat' && client && activeSession"
      :client="client"
      :session="activeSession"
      :workspace-key="activeSession.workspaceKey"
      :conn-state="connState"
      @back="backToSessions"
    />
    <div class="app-toast" :class="{ show: !!errorMsg }">{{ errorMsg }}</div>
  </div>
</template>
