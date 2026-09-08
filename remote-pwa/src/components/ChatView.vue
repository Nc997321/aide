<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { ConnState, RemoteTransport } from "@aide/sdk";
import { reloadSessionMessages, useChatSession, type ImageAttachment } from "@aide/sdk/chat";
import { useSessionWorkspaces } from "@aide/sdk/composables/useSessionWorkspaces";
import { api } from "@aide/sdk";
import { EFFORT_OPTIONS, effortLabel, normalizeEffortOption, type EffortValue } from "@aide/sdk/utils/effort";
import { fileToAttachment } from "../imageEncode";
import MessageList from "./MessageList.vue";
import PermissionSheet from "./PermissionSheet.vue";
import ProviderLogo from "./ProviderLogo.vue";

const props = defineProps<{
  /** id = null 表示「新建会话」空白面板：首条消息时由闭包生成临时 sid，
   *  session_init 后经 session-finalized 过户真实 id。 */
  session: { id: string | null; name: string };
  /** 会话归属工作区（key + 路径）；null = 跟随桌面当前工作区 */
  workspaceKey: string | null;
  workspacePath: string | null;
  /** 空态「发往工作区 X」显示名；null = 跟随桌面当前工作区 */
  workspaceName: string | null;
  /** 顶栏供应商 pill（App 层从 useProviders 挑出：kind 驱动品牌 SVG，icon 回退字符） */
  provider: { kind: string; icon?: string; name: string };
  connState: ConnState;
  /** 仅借重连信号（事件订阅由闭包全局监听承担，组件不再自己 listen）。 */
  client: Pick<RemoteTransport, "onReconnected" | "offReconnected">;
}>();

const emit = defineEmits<{
  /** 返回被抽屉取代：顶栏 ☰ 打开历史会话抽屉（App 层） */
  openDrawer: [];
  /** 顶栏供应商 pill → 供应商切换弹层（App 层） */
  openProviders: [];
  /** 顶栏 ＋ → 新会话（App 层重置路由态） */
  newSession: [];
  /** 空白面板首发成功：闭包发了临时 sid，App 把它绑到路由态上 */
  sessionBound: [sid: string];
  /** SDK 确认真实 id：App 更新路由态 + 列表归属 */
  sessionFinalized: [ids: { tempId: string; realId: string }];
}>();

const input = ref("");
const ta = ref<HTMLTextAreaElement | null>(null);

// ── 图片附件（选图 → 压缩/编码 → 随 sendMessage.images 下发）──

/** 待发图片；预览条即时渲染，发送时随 images 下发并清空。 */
const attach = ref<ImageAttachment[]>([]);
/** 编码中（大图手机上 1-3s）：禁用发送与再选，防中途发送漏图。 */
const picking = ref(false);
const fileEl = ref<HTMLInputElement | null>(null);
/** 单条消息图片上限：防 relay JSON 载荷爆炸（5 张 1568px JPEG 在 MB 级内）。 */
const MAX_ATTACH = 5;

function onAttachClick(): void {
  fileEl.value?.click();
}

function removeAttach(i: number): void {
  attach.value.splice(i, 1);
}

/** file input change：逐张编码（单张失败提示不阻断），超出上限拒绝新增。 */
async function onPickImages(e: Event): Promise<void> {
  const el = e.target as HTMLInputElement;
  const files = Array.from(el.files ?? []);
  el.value = ""; // 允许重选同一文件
  if (!files.length) return;
  const room = MAX_ATTACH - attach.value.length;
  if (files.length > room) showToast(`一次最多 ${MAX_ATTACH} 张图`, "warn");
  picking.value = true;
  try {
    for (const f of files.slice(0, room)) {
      try {
        attach.value.push(await fileToAttachment(f));
      } catch (err) {
        showToast(`图片处理失败：${err instanceof Error ? err.message : String(err)}`, "warn");
      }
    }
  } finally {
    picking.value = false;
  }
}
const toastShow = ref(false);
const toastText = ref("");
const toastKind = ref<"ok" | "info" | "warn">("info");
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

/** 顶部「加载更早」可见性：hasMoreOlder 读的是普通 Map（非响应式），
 *  借 messages 变化触发重估（hydrate/loadOlder 完成时消息数必变）。 */
const canLoadOlder = computed(() => {
  void messages.value.length;
  const sid = props.session.id;
  return sid ? chat.hasMoreOlder(sid) : false;
});

/** 新会话空态：空白面板且还没有任何消息（首条消息后自动消失）。 */
const isEmpty = computed(() => !props.session.id && messages.value.length === 0);

// ── 历史会话空态（打开的会话没有消息：建了没聊 / 残留产物）──
// 直达会话若恰好是空的，消息区会是一片黑屏空白——给一句可理解的引导而不是
// 让用户以为坏了。800ms 防闪：hydrate 在途时 messages 也是空，立即显示会闪。
const emptyHintReady = ref(false);
let emptyHintTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => props.session.id,
  () => {
    emptyHintReady.value = false;
    if (emptyHintTimer) clearTimeout(emptyHintTimer);
    emptyHintTimer = setTimeout(() => (emptyHintReady.value = true), 800);
  },
  { immediate: true },
);
const isEmptySession = computed(
  () => !!props.session.id && messages.value.length === 0 && emptyHintReady.value && !isBusy.value,
);

// ── 思考程度（会话级，三档制，对齐桌面输入框 effort 选择器）──

/** 本地选择档位：挂载时读会话元数据（sessionEffort）归一；无记录落 high。
 *  显示值优先用 sidecar 坐实的 currentEffort（effort_changed 事件，含回滚），
 *  空串（还没学到）以本地为准——与桌面选择器同语义。 */
const effortChoice = ref<EffortValue>("high");

onMounted(() => {
  const sid = props.session.id;
  if (sid) {
    void api.sessionEffort(sid)
      .then((v) => { effortChoice.value = normalizeEffortOption(v); })
      .catch(() => { /* 断线等：保持默认档 */ });
  }
});

const effortDisplay = computed(() => {
  const cur = chat.currentEffort.value;
  return effortLabel(cur || effortChoice.value);
});

function pickEffort(v: EffortValue): void {
  effortPopOpen.value = false;
  if (v === effortChoice.value && chat.currentEffort.value === v) return;
  effortChoice.value = v;
  // 存活会话即时生效（sidecar applyFlagSettings + setSessionEffort 持久化）；
  // 离线/未起会话：选择存本地，随下一条消息的 initialEffort 生效。
  chat.setEffort(v).catch(() => { /* 断线：本地选择 + 发送时兜底 */ });
  showToast(`思考 · ${effortLabel(v)}，随下一条消息生效`, "ok");
}

// 切换失败回执（sidecar 驳回 + 回滚）：瞬时提示，选择器已被事件拉回旧值。
watch(
  () => chat.effortSwitchError.value,
  (e) => { if (e) showToast(`切换失败：${e.message}`, "warn"); },
);

const effortPopOpen = ref(false);

// ── 发送 ──

/** 工作区归属（新建会话首发时种进注册表；已有会话注册表早就有，忽略）。 */
function workspaceBinding(): { wsKey: string; wsPath: string } | undefined {
  if (!props.workspacePath) return undefined;
  return { wsKey: props.workspaceKey ?? "", wsPath: props.workspacePath };
}

async function send(): Promise<void> {
  const text = input.value.trim();
  // 有图无文字也可发（prompt 空串 → 模型只收到图片块）
  if ((!text && attach.value.length === 0) || offline.value || picking.value) return;
  const images = attach.value.length ? [...attach.value] : undefined;
  input.value = "";
  attach.value = [];
  autoGrow();
  sysNote.value = null;
  try {
    const sid = await chat.sendMessage(text, {
      workspace: workspaceBinding(),
      // 离线期间选的档位随首条消息生效（存活会话已由 setEffort 即时坐实，幂等）
      initialEffort: effortChoice.value,
      images,
    });
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

// ── 权限应答（PermissionSheet 形态分发，通道全走 SDK respondPermission）──

async function onPermissionRespond(
  id: string,
  approved: boolean,
  answers?: Record<string, string>,
  nextMode?: string,
  reason?: string,
): Promise<void> {
  try {
    await chat.respondPermission(id, approved, { answers, nextMode, reason });
  } catch (e) {
    sysNote.value = `权限应答失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

// ── 顶栏供应商 pill ──

function onPillClick(): void {
  if (offline.value) {
    showToast("设备离线，无法切换供应商", "warn");
    return;
  }
  emit("openProviders");
}

// ── toast ──

function showToast(text: string, kind: "ok" | "info" | "warn" = "info"): void {
  toastText.value = text;
  toastKind.value = kind;
  toastShow.value = true;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastShow.value = false), 2400);
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
  showToast("已重连，会话历史已刷新", "ok");
  sysNote.value = "已重连 · 会话历史已刷新";
}

// ── 生命周期 ──

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
}

/** 思考程度浮层点外部关闭（对齐 goto 浮层惯例）。 */
function onDocClick(e: MouseEvent): void {
  const wrap = document.querySelector(".ef-wrap");
  if (effortPopOpen.value && wrap && !wrap.contains(e.target as Node)) {
    effortPopOpen.value = false;
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
  document.addEventListener("click", onDocClick);
});

onUnmounted(() => {
  offSessionCreated?.();
  props.client.offReconnected(onReconnected);
  if (toastTimer) clearTimeout(toastTimer);
  if (emptyHintTimer) clearTimeout(emptyHintTimer);
  document.removeEventListener("click", onDocClick);
});
</script>

<template>
  <div class="ch">
    <div class="ch-top">
      <button class="ch-back" title="历史会话" @click="emit('openDrawer')">
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M3 5.5h14M3 10h14M3 14.5h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
      <div class="ch-title">
        <div class="ch-name">{{ session.name }}</div>
        <button class="pv-pill" title="切换供应商" @click="onPillClick">
          <span class="dot" :class="stateDot"></span>
          <ProviderLogo :kind="provider.kind" :icon="provider.icon" :size="12" />
          <span class="pv-name">{{ provider.name }}</span>
          <svg width="9" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <button class="ch-back" title="新会话" @click="emit('newSession')">
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M10 4.5v11M4.5 10h11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    </div>

    <div class="ch-offbar" :class="{ show: offline }">
      <span class="spinner" style="width: 11px; height: 11px; border-width: 1.5px"></span>设备离线，自动重连中…
    </div>
    <div class="ch-toast" :class="{ show: toastShow, warn: toastKind === 'warn', ok: toastKind === 'ok' }">{{ toastText }}</div>

    <div v-if="canLoadOlder" class="ch-older">
      <button class="ch-older-btn" @click="loadOlder">↑ 加载更早的消息</button>
    </div>

    <MessageList v-if="!isEmpty && !isEmptySession" :messages="messages" :streaming="isBusy" :sys-note="sysNote" />
    <!-- 历史会话空态：有 id 但没消息（hydrate 完成后仍空）——给引导而不是黑屏空白 -->
    <div v-else-if="isEmptySession" class="ch-empty">
      <b>此会话暂无消息</b>
      <p>可能刚创建还没对话，或是残留的空会话</p>
      <button class="ch-empty-btn" @click="emit('openDrawer')">打开会话列表切换</button>
    </div>
    <div v-else class="ch-empty">
      <!-- src 动态绑定：vitest/jsdom 下静态资产路径会被转成 file:// 导致套件加载失败 -->
      <img :src="'/icon-512.png'" alt="aide" />
      <b>新会话</b>
      <p>发消息即创建 · 发往工作区 <em>{{ workspaceName ?? "桌面当前工作区" }}</em></p>
    </div>

    <PermissionSheet
      :permission="pendingPermission"
      :queue-count="pendingPermissionCount"
      :current-mode="chat.currentPermissionMode.value"
      @respond="onPermissionRespond"
    />

    <div v-if="pendingJumpCount > 0" class="ch-jumps">待发出 {{ pendingJumpCount }} 条（当前轮安全边界后自动发送）</div>

    <div class="ch-input">
      <div v-if="attach.length" class="ch-attach">
        <div v-for="(a, i) in attach" :key="i" class="ch-attach-item">
          <img :src="`data:${a.mediaType};base64,${a.data}`" alt="" />
          <button class="ch-attach-x" title="移除图片" @click="removeAttach(i)">
            <svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 1l6 6M7 1L1 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>
      <div class="ch-tools">
        <button class="ch-img-btn" title="发送图片" :disabled="offline" @click="onAttachClick">
          <svg width="17" height="17" viewBox="0 0 18 18" fill="none"><rect x="1.5" y="3.5" width="15" height="11" rx="2.5" stroke="currentColor" stroke-width="1.5"/><circle cx="6.2" cy="7.4" r="1.5" fill="currentColor"/><path d="M3 13.4l3.6-3.2a1.4 1.4 0 0 1 1.9 0l3.8 3.3M10.6 10l1.5-1.3a1.4 1.4 0 0 1 1.9 0l2.5 2.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="ef-wrap">
          <button class="ef-chip" title="思考程度" @click.stop="effortPopOpen = !effortPopOpen">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M8.8 1.5L3.5 9h3.7l-.9 5.5L11.6 7H7.9l.9-5.5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
            <span class="ef-label">思考 · {{ effortDisplay }}</span>
            <svg width="9" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="ef-pop" :class="{ show: effortPopOpen }">
            <button
              v-for="o in EFFORT_OPTIONS"
              :key="o.value"
              type="button"
              class="ws-opt"
              :class="{ on: (chat.currentEffort.value || effortChoice) === o.value }"
              @click="pickEffort(o.value)"
            >
              <span class="pv-ic">{{ o.value === "max" ? "🔥" : "⚡" }}</span>
              <span class="ws-txt">
                <b class="ws-name">{{ o.label }}</b>
                <span class="ws-desc">{{ o.value }}</span>
              </span>
              <svg class="ws-check" width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M5 8.2l2 2 4-4.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
        </div>
      </div>
      <div class="ch-input-row">
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
        <button
          v-if="isBusy"
          class="ch-send ch-stop"
          title="中断当前生成"
          @click="interrupt"
        >
          <svg width="13" height="13" viewBox="0 0 14 14"><rect x="1.5" y="1.5" width="11" height="11" rx="2" fill="currentColor"/></svg>
        </button>
        <button v-else class="ch-send" title="发送" :disabled="offline || picking" @click="send">
          <svg width="17" height="17" viewBox="0 0 18 18" fill="none"><path d="M9 14.5v-11M4 8l5-5 5 5" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <input ref="fileEl" type="file" accept="image/*" multiple hidden @change="onPickImages" />
    </div>
  </div>
</template>
