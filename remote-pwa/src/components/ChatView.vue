<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { ConnState, RemoteTransport } from "@aide/sdk";
import { reloadSessionMessages, useChatSession } from "@aide/sdk/chat";
import { useSessionWorkspaces } from "@aide/sdk/composables/useSessionWorkspaces";
import MessageList from "./MessageList.vue";

const props = defineProps<{
  /** id = null 表示「新建会话」空白面板：首条消息时由闭包生成临时 sid，
   *  session_init 后经 session-finalized 过户真实 id。 */
  session: { id: string | null; name: string };
  /** 会话归属工作区（key + 路径）；null = 跟随桌面当前工作区 */
  workspaceKey: string | null;
  workspacePath: string | null;
  connState: ConnState;
  /** 仅借重连信号（事件订阅由闭包全局监听承担，组件不再自己 listen）。 */
  client: Pick<RemoteTransport, "onReconnected" | "offReconnected">;
}>();

const emit = defineEmits<{
  back: [];
  /** 空白面板首发成功：闭包发了临时 sid，App 把它绑到路由态上 */
  sessionBound: [sid: string];
  /** SDK 确认真实 id：App 更新路由态 + 列表归属 */
  sessionFinalized: [ids: { tempId: string; realId: string }];
}>();

const input = ref("");
const ta = ref<HTMLTextAreaElement | null>(null);
const toastShow = ref(false);
const sysNote = ref<string | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

// ── 会话状态（共享闭包：与桌面同一套 store/事件/分页实现）──

const sidRef = computed(() => props.session.id);
const chat = useChatSession(sidRef);
const messages = chat.messages;
const isBusy = chat.isBusy;
const pendingPermission = chat.pendingPermission;
const pendingPermissionCount = chat.pendingPermissionCount;
const pendingJumpCount = computed(() => chat.pendingJumps.value.length);

const offline = computed(() => props.connState === "offline");

const stateDot = computed(() => {
  switch (props.connState) {
    case "authed":
      return "ok";
    case "connecting":
      return "warn";
    default:
      return "off";
  }
});

const stateText = computed(() => {
  switch (props.connState) {
    case "authed":
      return "已连接";
    case "connecting":
      return "重连中…";
    case "offline":
      return "设备离线";
    default:
      return "未连接";
  }
});

/** 顶部「加载更早」可见性：hasMoreOlder 读的是普通 Map（非响应式），
 *  借 messages 变化触发重估（hydrate/loadOlder 完成时消息数必变）。 */
const canLoadOlder = computed(() => {
  void messages.value.length;
  const sid = props.session.id;
  return sid ? chat.hasMoreOlder(sid) : false;
});

// ── 发送 ──

/** 工作区归属（新建会话首发时种进注册表；已有会话注册表早就有，忽略）。 */
function workspaceBinding(): { wsKey: string; wsPath: string } | undefined {
  if (!props.workspacePath) return undefined;
  return { wsKey: props.workspaceKey ?? "", wsPath: props.workspacePath };
}

async function send(): Promise<void> {
  const text = input.value.trim();
  if (!text || offline.value) return;
  input.value = "";
  autoGrow();
  sysNote.value = null;
  try {
    const sid = await chat.sendMessage(text, { workspace: workspaceBinding() });
    if (!props.session.id && sid) emit("sessionBound", sid);
  } catch (e) {
    sysNote.value = `发送失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

async function interrupt(): Promise<void> {
  try {
    await chat.interrupt();
  } catch (e) {
    sysNote.value = `中断失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

async function loadOlder(): Promise<void> {
  const sid = props.session.id;
  if (!sid) return;
  await chat.loadOlderMessages(sid, 256 * 1024); // 与闭包 HYDRATE_PAGE_BYTES 同页大小
}

// ── 权限应答（极简条：允许 / 拒绝；「始终允许」等高级项留在桌面）──

/** 工具输入摘要：优先取语义化字段，截断到一行。 */
function permissionSummary(input: unknown): string {
  if (input && typeof input === "object") {
    const r = input as Record<string, unknown>; // JSON 边界：sidecar 透传的工具输入
    for (const k of ["command", "file_path", "pattern", "path", "url"]) {
      const v = r[k];
      if (typeof v === "string") return v.length > 120 ? v.slice(0, 120) + "…" : v;
    }
  }
  return "";
}

async function answerPermission(approved: boolean): Promise<void> {
  const p = pendingPermission.value;
  if (!p) return;
  try {
    await chat.respondPermission(p.id, approved);
  } catch (e) {
    sysNote.value = `权限应答失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

// ── 重连补齐 ──

function onReconnected(): void {
  const sid = props.session.id;
  if (sid) {
    // 断线期间的事件缺口：整页重载对齐（消息/分页清零 → 重新 hydrate）
    void reloadSessionMessages(sid).catch(() => {
      // 重载失败（如会话已删）：保持现状，用户可返回列表刷新
    });
  }
  toastShow.value = true;
  sysNote.value = "已重连 · 会话历史已刷新";
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastShow.value = false), 2400);
}

// ── 生命周期 ──

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
}

function autoGrow(): void {
  const el = ta.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 108) + "px";
}

let offSessionCreated: (() => void) | null = null;

onMounted(() => {
  // 打开历史会话：补种工作区归属（本会话进程内注册表为空时的兜底，
  // 与桌面 SidebarLeft 加载列表时的 setMany 同语义）。
  if (props.session.id && props.workspacePath) {
    useSessionWorkspaces().setWorkspace(props.session.id, {
      wsKey: props.workspaceKey ?? "",
      wsPath: props.workspacePath,
    });
  }
  offSessionCreated = chat.onSessionCreated((tempId, realId) => {
    if (props.session.id === tempId) emit("sessionFinalized", { tempId, realId });
  });
  props.client.onReconnected(onReconnected);
});

onUnmounted(() => {
  offSessionCreated?.();
  props.client.offReconnected(onReconnected);
  if (toastTimer) clearTimeout(toastTimer);
});
</script>

<template>
  <div class="ch">
    <div class="ch-top">
      <button class="ch-back" title="返回" @click="emit('back')">
        <svg width="19" height="19" viewBox="0 0 20 20" fill="none"><path d="M12.5 4L6.5 10l6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="ch-title">
        <div class="ch-name">{{ session.name }}</div>
        <div class="ch-state"><span class="dot" :class="stateDot"></span><span>{{ stateText }}</span></div>
      </div>
      <span class="spacer"></span>
      <button v-if="isBusy" class="ch-stop" title="中断当前生成" @click="interrupt">■ 中断</button>
    </div>

    <div class="ch-offbar" :class="{ show: offline }">
      <span class="spinner" style="width: 11px; height: 11px; border-width: 1.5px"></span>设备离线，自动重连中…
    </div>
    <div class="ch-toast" :class="{ show: toastShow }">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.6"/><path d="M5 8.2l2 2 4-4.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>已重连，会话历史已刷新
    </div>

    <div v-if="canLoadOlder" class="ch-older">
      <button class="ch-older-btn" @click="loadOlder">↑ 加载更早的消息</button>
    </div>

    <MessageList :messages="messages" :streaming="isBusy" :sys-note="sysNote" />

    <div v-if="pendingPermission" class="ch-perm">
      <div class="ch-perm-head">
        <span class="ch-perm-tool">{{ pendingPermission.name }}</span>
        <span v-if="pendingPermission.fromSubagent" class="ch-perm-sub">来自子代理 {{ pendingPermission.fromSubagent.agentName }}</span>
        <span v-if="pendingPermissionCount > 1" class="ch-perm-sub">还有 {{ pendingPermissionCount - 1 }} 条待确认</span>
      </div>
      <div v-if="permissionSummary(pendingPermission.input)" class="ch-perm-input">{{ permissionSummary(pendingPermission.input) }}</div>
      <div class="ch-perm-actions">
        <button class="ch-perm-allow" @click="answerPermission(true)">允许</button>
        <button class="ch-perm-deny" @click="answerPermission(false)">拒绝</button>
      </div>
    </div>

    <div v-if="pendingJumpCount > 0" class="ch-jumps">待发出 {{ pendingJumpCount }} 条（当前轮安全边界后自动发送）</div>

    <div class="ch-input">
      <div class="ch-ta-wrap">
        <textarea
          ref="ta"
          v-model="input"
          rows="1"
          :placeholder="offline ? '设备离线，等待重连…' : '发消息给桌面 aide…'"
          :disabled="offline"
          @input="autoGrow"
          @keydown="onKeydown"
        ></textarea>
      </div>
      <button class="ch-send" title="发送" :disabled="offline" @click="send">
        <svg width="17" height="17" viewBox="0 0 18 18" fill="none"><path d="M9 14.5v-11M4 8l5-5 5 5" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
  </div>
</template>
