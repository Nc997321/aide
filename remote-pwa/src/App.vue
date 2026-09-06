<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import {
  api,
  RemoteTransport,
  setTransport,
  type ConnState,
  type ConnectCreds,
} from "@aide/sdk";
import type { ProviderConfig, Session, WorkspaceInfo } from "@aide/sdk/types";
import { useProviders } from "@aide/sdk/composables/useProviders";
import { useSessionNames } from "@aide/sdk/composables/useSessionNames";
import { clearCreds, loadCreds, loadRelayUrl, saveCreds, saveRelayUrl } from "./storage";
import ConnectView from "./components/ConnectView.vue";
import ChatView from "./components/ChatView.vue";
import Drawer from "./components/Drawer.vue";
import ProviderLogo from "./components/ProviderLogo.vue";

type View = "conn" | "chat";

const client = ref<RemoteTransport | null>(null);
const connState = ref<ConnState>("idle");
const view = ref<View>("conn");
const sessions = ref<Session[]>([]);
/** id = null：新建会话空白面板（首条消息时闭包生成临时 sid，session-finalized 过户真实 id） */
const activeSession = ref<{
  id: string | null;
  name: string;
  workspaceKey: string | null;
  workspacePath: string | null;
} | null>(null);
const liveSessions = reactive(new Set<string>());
const pairError = ref<"badcode" | "revoked" | null>(null);
const hasCreds = ref(false);
const refreshing = ref(false);
const pairing = ref(false);
const savedRelayUrl = loadRelayUrl();

// ── 全局 toast（桌面侧执行错误 + 供应商切换反馈共用一槽）──

const appToastText = ref<string | null>(null);
const appToastKind = ref<"ok" | "warn">("ok");
let appToastTimer: ReturnType<typeof setTimeout> | null = null;

function showAppToast(text: string, kind: "ok" | "warn" = "ok"): void {
  appToastText.value = text;
  appToastKind.value = kind;
  if (appToastTimer) clearTimeout(appToastTimer);
  appToastTimer = setTimeout(() => (appToastText.value = null), kind === "warn" ? 5000 : 2400);
}

// ── 抽屉 / 供应商弹层（v3 导航：聊天是主屏，会话列表收进左侧抽屉）──

const drawerOpen = ref(false);
const pvOpen = ref(false);

// ── 供应商（SDK 共享闭包单例；RPC 白名单已含 get/set providers 与 active id）──

const providers = useProviders();
// 解构为顶层绑定：模板自动解包（嵌套在普通对象里的 ref 不会自动解包）
const providerList = providers.displayList;
const activeProvider = providers.activeProvider;
const activeProviderId = providers.activeProviderId;

/** 顶栏 pill / 抽屉徽标共用：当前供应商三件套（kind 驱动品牌 SVG（SDK
 *  providerLogos，与桌面同库），icon 是无商标时的回退字符，name 显示名）。 */
const providerPick = computed(() => {
  const p = activeProvider.value;
  return { kind: p.kind, icon: p.icon, name: p.name };
});

/** 副行只显示模型名（对齐桌面 ProviderSwitcher 的信息边界）：
 *  baseUrl/kind 一律不暴露——api 地址不该出现在切换界面。 */
function providerDesc(p: ProviderConfig): string {
  if (p.kind === "system_default") return "跟随桌面全局设置";
  return p.model || "";
}

/** 打开供应商弹层：网关只转发 chat-event 一种事件，provider_changed 推送收不到
 *  → 每次打开重新 load() 拉最新（对齐桌面打开切换器时的刷新语义）。 */
function openProviderSheet(): void {
  if (connState.value !== "authed") return;
  pvOpen.value = true;
  void providers.load();
}

async function pickProvider(id: string): Promise<void> {
  pvOpen.value = false;
  if (id === activeProviderId.value) return;
  const p = providerList.value.find((x) => x.id === id);
  try {
    await providers.setActiveProvider(id);
    if (p) showAppToast(`已切换至 ${p.name}`, "ok");
  } catch (e) {
    showAppToast(`切换供应商失败：${e instanceof Error ? e.message : String(e)}`, "warn");
  }
}

// ── 工作区 ──

const workspaces = ref<WorkspaceInfo[]>([]);
/** null = 跟随桌面当前活动工作区（列表不带 key 拉取，与桌面实时同步） */
const activeWorkspaceKey = ref<string | null>(null);
/** 会话 → 归属工作区（key+路径）：列表按工作区拉取时记录，聊天发消息/种归属用 */
const sessionWs = new Map<string, { wsKey: string; wsPath: string }>();

/** 空态「发往工作区 X」显示名：null = 跟随桌面当前工作区。 */
const workspaceName = computed(() => {
  const key = activeWorkspaceKey.value;
  if (!key) return null;
  const w = workspaces.value.find((x) => x.key === key);
  if (!w) return null;
  return w.name.split(/[\\/]/).filter(Boolean).pop() ?? w.name;
});

// ── 连接 ──

function connect(relayUrl: string, creds: ConnectCreds): void {
  // 传输实例只建一次（监听/闭包 listener 挂在实例上，重建会让 listener 挂死连接）；
  // 换 URL/凭据走同一实例的重连。
  if (!client.value) {
    const t = new RemoteTransport(relayUrl);
    setTransport(t); // 此后所有 api.* 调用走远程 RPC
    t.onStateChange(handleState);
    // 会话列表"回复中"徽标：收到事件标记 live，message_stop 清除
    void t.listen<Record<string, unknown>>("chat-event", ({ payload }) => {
      const sid = payload["session_id"];
      if (typeof sid !== "string") return;
      if (payload["type"] === "message_stop") liveSessions.delete(sid);
      else liveSessions.add(sid);
    });
    // 桌面侧执行错误（如会话创建失败）——显示出来，否则「发消息没响应」无从诊断
    t.onError((m) => showAppToast(m, "warn"));
    client.value = t;
  }
  client.value.connect(creds, relayUrl);
}

function handleState(s: ConnState): void {
  connState.value = s;
  if (s === "authed") {
    void onAuthed();
  } else if (s === "needsPairing") {
    // 配对失败（badcode）与 token 被吊销（revoked）都回连接屏
    clearCreds();
    hasCreds.value = false;
    pairError.value = pairing.value ? "badcode" : "revoked";
    view.value = "conn";
    drawerOpen.value = false;
    pvOpen.value = false;
  }
}

/** authed（含断线重连）：拉齐供应商/工作区/会话列表；首次（还在配对屏）直达
 *  最近「有消息」的会话（无则新会话空态）。重连时 view 已是 chat → 只刷新
 *  数据，不动路由态。 */
async function onAuthed(): Promise<void> {
  void providers.load();
  await Promise.all([refreshWorkspaces(), refreshSessions()]);
  if (view.value === "conn") {
    const target = await pickLandingSession();
    if (target) openSession(target);
    else if (sessions.value.length > 0) openSession(sessions.value[0]); // 全空：仍开最近的（空态有引导）
    else newSession();
  }
}

/** 直达落点：最近一个「有消息」的会话。list_sessions 会把「建了还没聊」的空
 *  会话与各类残留会话也列出来（第二遍元数据扫描），直达它们 = 打开即空白——
 *  用 1 字节预算的探测请求跳过（最多看前 5 个防长循环；探测失败视作空继续）。 */
async function pickLandingSession(): Promise<Session | null> {
  for (const s of sessions.value.slice(0, 5)) {
    try {
      const r = await api.loadMessages(s.id, null, 1);
      if (r && Array.isArray(r.messages) && r.messages.length > 0) return s;
    } catch {
      // 断线等：视作空，继续下一个
    }
  }
  return null;
}

/** 配对：连接中继 → 发 pair → 成功存凭据（authed 由 handleState 接管直达聊天） */
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

// ── 会话 ──

async function refreshWorkspaces(): Promise<void> {
  if (!client.value || connState.value !== "authed") return;
  try {
    workspaces.value = await api.listWorkspaces();
  } catch {
    // 断线等，保持现状
  }
}

/** 切换工作区：固定选择后会话列表按该工作区拉取；新会话发往该工作区 */
function changeWorkspace(key: string): void {
  activeWorkspaceKey.value = key;
  refreshSessions();
}

/** key → 路径（workspace.name 即解码后的路径字符串，见桌面 list_workspaces）。 */
function workspacePathOf(key: string): string | null {
  return workspaces.value.find((w) => w.key === key)?.name ?? null;
}

async function refreshSessions(): Promise<void> {
  if (!client.value || connState.value !== "authed") return;
  refreshing.value = true;
  try {
    const wsKey = activeWorkspaceKey.value;
    sessions.value = wsKey
      ? await api.listSessionsForWorkspace(wsKey)
      : await api.listSessions();
    // 记录会话归属工作区：发历史会话消息时带其 cwd，才落对目录
    if (wsKey) {
      const wsPath = workspacePathOf(wsKey);
      if (wsPath) for (const s of sessions.value) sessionWs.set(s.id, { wsKey, wsPath });
    }
  } catch {
    // 拉取失败不静默：列表空会直接落「新会话」空态，用户无从知道为什么
    if (connState.value === "authed") showAppToast("会话列表拉取失败，可在抽屉里重试", "warn");
  } finally {
    refreshing.value = false;
  }
}

/** 打开抽屉：历史会话列表在抽屉里，打开时刷新（新会话/新消息可见）。 */
function openDrawer(): void {
  drawerOpen.value = true;
  void refreshSessions();
}

function openSession(s: Session): void {
  const ws = sessionWs.get(s.id);
  activeSession.value = {
    id: s.id,
    name: s.name,
    workspaceKey: ws?.wsKey ?? null,
    // 跟随桌面（null）时列表没记路径——不传 = 桌面当前工作区，恰好一致
    workspacePath: ws?.wsPath ?? null,
  };
  drawerOpen.value = false;
  view.value = "chat";
}

function newSession(): void {
  const key = activeWorkspaceKey.value;
  activeSession.value = {
    id: null, // 空白面板：首条消息时闭包生成临时 sid
    name: "新会话",
    workspaceKey: key,
    workspacePath: key ? workspacePathOf(key) : null, // 新建会话发往当前所选工作区
  };
  drawerOpen.value = false;
  view.value = "chat";
}

/** 空白面板首发：闭包发了临时 sid，绑到路由态（消息流即时可见）。 */
function onSessionBound(sid: string): void {
  if (activeSession.value && !activeSession.value.id) {
    activeSession.value = { ...activeSession.value, id: sid };
  }
}

/** SDK 确认真实 id：路由态过户 + 归属表搬迁 + 元数据落盘（显示名；
 *  失败仅影响列表显示名——auto-rename 随后会补，不阻断，故只记日志）。 */
function onSessionFinalized({ tempId, realId }: { tempId: string; realId: string }): void {
  const ws = sessionWs.get(tempId);
  if (ws) {
    sessionWs.set(realId, ws);
    sessionWs.delete(tempId);
  }
  if (activeSession.value?.id === tempId) {
    activeSession.value = { ...activeSession.value, id: realId };
  }
  // 名字取 sidecar 截取首条消息生成的标题（session_title 早于本回调到达，
  // 已随 finalizeSession 从 tempId 迁到 realId）；没有标题才退回占位名。
  const name = useSessionNames().takePendingTitle(realId) || "新会话";
  useSessionNames().setName(realId, name);
  void api.createSession(realId, name).catch((e) => console.warn("createSession failed:", e));
}

/** 断开连接（抽屉 quit）：停自动重连 + 清凭据 + 回配对屏，弹层全部收起。
 *  传输实例保留——下次配对复用（connect() 会重置 closedByUser）。 */
function disconnectAll(): void {
  drawerOpen.value = false;
  pvOpen.value = false;
  client.value?.disconnect(); // 停重连；state → idle 由 handleState 同步回写
  clearCreds();
  hasCreds.value = false;
  view.value = "conn";
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
    <ChatView
      v-else-if="view === 'chat' && client && activeSession"
      :client="client"
      :session="activeSession"
      :workspace-key="activeSession.workspaceKey"
      :workspace-path="activeSession.workspacePath"
      :workspace-name="workspaceName"
      :provider="providerPick"
      :conn-state="connState"
      @open-drawer="openDrawer"
      @open-providers="openProviderSheet"
      @new-session="newSession"
      @session-bound="onSessionBound"
      @session-finalized="onSessionFinalized"
    />
    <Drawer
      :open="drawerOpen"
      :conn-state="connState"
      :sessions="sessions"
      :live-sessions="liveSessions"
      :refreshing="refreshing"
      :workspaces="workspaces"
      :active-workspace-key="activeWorkspaceKey"
      :current-session-id="activeSession?.id ?? null"
      :provider="providerPick"
      @close="drawerOpen = false"
      @open-session="openSession"
      @new-session="newSession"
      @refresh="refreshSessions"
      @workspace-change="changeWorkspace"
      @open-providers="openProviderSheet"
      @quit="disconnectAll"
    />
    <!-- 供应商选择（底部弹层，与工作区弹层同款；z 高于抽屉，两个入口共用） -->
    <div class="ws-mask pv-mask" :class="{ show: pvOpen }" @click.self="pvOpen = false">
      <div class="ws-sheet">
        <div class="ws-head">
          <b>选择供应商</b>
          <small>切换桌面 aide 的模型供应商</small>
        </div>
        <button
          v-for="p in providerList"
          :key="p.id"
          class="ws-opt"
          :class="{ on: p.id === activeProviderId }"
          @click="pickProvider(p.id)"
        >
          <span class="pv-ic"><ProviderLogo :kind="p.kind" :icon="p.icon" :size="16" /></span>
          <span class="ws-txt">
            <b class="ws-name">{{ p.name }}</b>
            <span v-if="providerDesc(p)" class="ws-desc">{{ providerDesc(p) }}</span>
          </span>
          <svg class="ws-check" width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M5 8.2l2 2 4-4.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <p v-if="providerList.length === 0" class="dr-none">正在加载供应商…</p>
        <div class="pv-foot">管理 / 新增供应商请回桌面 aide → 设置 → 供应商</div>
      </div>
    </div>
    <div class="app-toast" :class="{ show: !!appToastText, ok: appToastKind === 'ok', warn: appToastKind === 'warn' }">{{ appToastText }}</div>
  </div>
</template>
