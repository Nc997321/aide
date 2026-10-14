<script setup lang="ts">
/** 一个侧栏应用的面板：未同意时是同意卡片，同意后是沙箱 iframe + 桥。
 *
 *  安全边界（设计 §4，P0 实验已验证）：应用界面是用户或 agent 写的代码，必须拿不到 Tauri IPC。
 *  - 页面从回环地址加载（`app_frame_base`），Tauri 视为远程来源，ACL 一律拒绝；
 *  - sandbox **不给** allow-same-origin / allow-top-navigation：来源不透明，带不走主页面；
 *  - 收消息只认 `event.source` 是不是这个 iframe（不透明来源没法校验 origin）；
 *  - 应用提供的任何字符串只进文本节点，绝不 v-html。
 *  右栏与主区两种位置共用本组件。 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { APP_EVENT, appsApi, type AppEventPayload } from "@aide/sdk/api/apps";
import { hostApi } from "@aide/sdk/api/host";
import type { AppInfo } from "@aide/sdk/types/apps";

import { listen } from "@aide/sdk";
import {
  handleBridgeMessage,
  hostKindOf,
  projectSessionEvent,
  projectTreeChange,
  type BridgeHost,
  type ThemePayload,
} from "../../composables/appBridge";
import { useAppProcesses } from "../../composables/useAppProcesses";
import { useApps } from "../../composables/useApps";
import { useFileResolver } from "../../composables/useFileResolver";
import AppProcessList from "./AppProcessList.vue";
import { useComposerInserter } from "../../composables/useComposerInserter";
import { useNotifications } from "../../composables/useNotifications";
import { errorText } from "../../utils/errors";
import { describePermission } from "./appPermissions";

const props = defineProps<{
  app: AppInfo;
  /** 窗口当前显示的工作区根（空串 = 没有打开工作区）。 */
  workspaceRoot?: string;
}>();

/** 这个应用够得着工作区吗（读写文件、起进程）。够不着的应用与工作区无关：切工作区不重载它，
 *  它的后端也只起一个。 */
const WORKSPACE_PERMISSIONS = ["workspace:read", "workspace:write", "process"];
const workspace = computed(() =>
  props.workspaceRoot && props.app.permissions.some((p) => WORKSPACE_PERMISSIONS.includes(p)) ? props.workspaceRoot : null,
);

const { badges, refresh, moveTo } = useApps();
const { openResolved } = useFileResolver();
const frame = ref<HTMLIFrameElement | null>(null);
const base = ref<string | null>(null);
const failure = ref<string | null>(null);
const busy = ref(false);

const SANDBOX = "allow-scripts allow-forms allow-pointer-lock";

const ready = computed(() => !props.app.error && props.app.enabled && props.app.consented);
/** 带上 revision：应用文件一变地址就变，iframe 整页重载（热加载）。 */
const src = computed(() =>
  ready.value && base.value ? `${base.value}${props.app.entry}?r=${props.app.revision}` : null,
);
/** iframe 的身份再带上工作区：用户切去看另一个工程时整页重载，应用从新工程重新开始
 *  （它在旧工程起的进程照跑，切回来用 `process.list` / `attach` 续上）。不这么做，面板会停在
 *  旧工程的内容上，而它的调用已经落到新工程里。 */
const frameKey = computed(() => `${src.value}|${workspace.value ?? ""}`);

async function loadBase() {
  if (!ready.value || base.value) return;
  try {
    base.value = await appsApi.frameBase(props.app.id);
    failure.value = null;
  } catch (e) {
    failure.value = errorText(e);
  }
}
watch(ready, () => void loadBase(), { immediate: true });

function theme(): ThemePayload {
  const style = document.documentElement.style;
  const vars: Record<string, string> = {};
  for (let i = 0; i < style.length; i++) {
    const name = style.item(i);
    if (name.startsWith("--aide-")) vars[name] = style.getPropertyValue(name);
  }
  return { vars, colorScheme: style.getPropertyValue("color-scheme") };
}

const host: BridgeHost = {
  theme,
  toast: (text) =>
    useNotifications().push({
      severity: "info",
      source: `app:${props.app.id}`,
      title: props.app.name,
      body: text,
      timestamp: Date.now(),
    }),
  setBadge: (count) => {
    badges[props.app.id] = count;
  },
  hasPermission: (permission) => props.app.permissions.includes(permission),
  fillComposer: (text) => useComposerInserter().insertText(text),
  openFile: (path, line) => openResolved(path, workspace.value ?? undefined, line),
  hostKind: async () => hostKindOf((await hostApi.identity()).key),
  hostCall: (method, params) => appsApi.call(props.app.id, method, params, workspace.value),
};

function post(event: string, payload: unknown) {
  frame.value?.contentWindow?.postMessage({ aideApp: 1, event, payload }, "*");
}

async function onMessage(e: MessageEvent) {
  const target = frame.value?.contentWindow;
  if (!target || e.source !== target) return;
  const reply = await handleBridgeMessage(e.data, host);
  if (reply) target.postMessage(reply, "*");
}

/** 主题切换时推给应用（applyTheme 改的是根元素的内联样式）。 */
let themeObserver: MutationObserver | null = null;
/** 会话事件只推给申请了 session:read 的应用；推的是投影后的形状，不带任何内容。 */
const unlisteners: (() => void)[] = [];
let unmounted = false;
function subscribe<T>(event: string, handler: (payload: T) => void) {
  void listen<T>(event, (e) => handler(e.payload)).then((unlisten) => {
    if (unmounted) unlisten();
    else unlisteners.push(unlisten);
  });
}
onMounted(() => {
  window.addEventListener("message", onMessage);
  subscribe<unknown>("chat-event", (raw) => {
    if (!props.app.permissions.includes("session:read")) return;
    const payload = projectSessionEvent(raw);
    if (payload) post("session", payload);
  });
  // Host 发给应用的事件（后端推的、进程的动静）：只收自己的、自己所在工作区的
  subscribe<AppEventPayload>(APP_EVENT, (e) => {
    if (e.appId === props.app.id && (e.workspace ?? null) === workspace.value) post(e.channel, e.payload);
  });
  // 工作区里的文件变了（文件树的那一份监听）：只说哪些目录变了，应用自己去重读
  subscribe<string[]>("file-tree-changed", (dirs) => {
    if (!props.app.permissions.includes("workspace:read") || !workspace.value) return;
    const payload = projectTreeChange(dirs, workspace.value);
    if (payload) post("fs", payload);
  });
  themeObserver = new MutationObserver(() => post("theme", theme()));
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
});
onBeforeUnmount(() => {
  window.removeEventListener("message", onMessage);
  themeObserver?.disconnect();
  unmounted = true;
  for (const unlisten of unlisteners) unlisten();
  document.removeEventListener("click", onDocClick);
  delete badges[props.app.id];
});

async function act(run: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  failure.value = null;
  try {
    await run();
    // 状态只认 Host：等它的回答，不本地改
    await refresh();
  } catch (e) {
    failure.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
const consent = () => act(() => appsApi.consent(props.app.id, props.app.grant));
const setEnabled = (enabled: boolean) => act(() => appsApi.setEnabled(props.app.id, enabled));

// ── 这个应用起的进程（顶条的「运行中」）──
const procs = useAppProcesses();
/** 本应用的，当前工作区的排前面。 */
const myProcesses = computed(() =>
  procs.visible.value
    .filter((p) => p.appId === props.app.id)
    .sort((a, b) => Number(b.workspace === props.workspaceRoot) - Number(a.workspace === props.workspaceRoot)),
);
const myRunning = computed(() => procs.running.value.filter((p) => p.appId === props.app.id));
const runningHere = computed(() => myRunning.value.filter((p) => p.workspace === props.workspaceRoot).length);
const runningElsewhere = computed(() => myRunning.value.length - runningHere.value);
const procsOpen = ref(false);
const procsEl = ref<HTMLElement | null>(null);
function onDocClick(e: MouseEvent) {
  if (procsEl.value && !procsEl.value.contains(e.target as Node)) procsOpen.value = false;
}
onMounted(() => document.addEventListener("click", onDocClick));
watch(myProcesses, (list) => {
  if (list.length === 0) procsOpen.value = false;
});
/** 「并结束 N 个进程」：禁用 / 卸载会连带结束它起的进程，动手前说清楚。 */
const alsoEnds = computed(() => (myRunning.value.length ? `并结束 ${myRunning.value.length} 个进程` : ""));
/** 有进程在跑时禁用要点两次（没有就一次，和原来一样）。 */
const confirmingDisable = ref(false);
function disable() {
  if (myRunning.value.length && !confirmingDisable.value) {
    confirmingDisable.value = true;
    return;
  }
  confirmingDisable.value = false;
  void setEnabled(false);
}
/** 位置是用户说了算的：清单只给初值。按钮常驻在面板顶上——不摆出来，没人知道应用还能待在另一侧。 */
const relocation = computed(() =>
  props.app.placement === "right"
    ? { label: "移到主区", to: "main" as const, tip: "入口挪到左侧栏，点开占满主区——适合要空间的工具" }
    : { label: "移到右栏", to: "right" as const, tip: "入口挪到右侧工具栏，和对话并排——适合小工具" },
);
const relocate = () => act(() => moveTo(props.app.id, relocation.value.to));
/** 安装成功要有回音：面板会换成安装版（带后端的还要再同意一次），用户得知道刚才发生了什么。 */
const install = () =>
  act(async () => {
    const { name, hasServer, installed } = props.app;
    await appsApi.install(props.app.id);
    useNotifications().push({
      severity: "info",
      source: `app:${props.app.id}`,
      title: installed ? `「${name}」已更新` : `「${name}」已安装`,
      body: hasServer
        ? "它带有后端程序，请在面板里再确认一次。"
        : "以后打开任何工作区，它都在侧栏里。",
      timestamp: Date.now(),
    });
  });
/** 开发态应用的提示条：告诉用户这一份还没装进 Aide（否则没人知道要装）。 */
const devNotice = computed(() => {
  if (props.app.source !== "workspace" || props.app.error) return null;
  if (props.app.installed) return { text: "这个应用改过了，改动还没有装进 Aide。", action: "更新安装" };
  // 说真话：只有在项目里做的开发态才「切走就不见」；日常里做的到哪都在，安装的意义是把它固定下来
  return props.app.alwaysVisible
    ? { text: "这是开发中的版本，agent 的改动会立刻生效。用着满意就安装，它会固定下来，之后的改动要你确认才生效。", action: "安装到 Aide" }
    : { text: "这是开发中的版本，只在打开这个工作区时出现，agent 的改动会立刻生效。用着满意就安装，它会一直留在 Aide 里。", action: "安装到 Aide" };
});
/** 「删掉眼前这一个」在三种状态下的叫法。Host 那边是同一条命令，删什么由它按状态定。 */
const removal = computed(() => {
  if (props.app.source === "user") {
    return { label: "卸载", confirm: `确认卸载${alsoEnds.value}`, tip: "从 Aide 里彻底删掉这个应用（工作区里那份一样的副本也一起删）；它保存的数据会留着，重装还在" };
  }
  return props.app.installed
    ? { label: "放弃改动", confirm: `确认放弃${alsoEnds.value}`, tip: "删掉这份还没安装的改动，回到已经安装的版本" }
    : { label: "删除", confirm: `确认删除${alsoEnds.value}`, tip: "删掉工作区里这个开发中的应用；它保存的数据会留着" };
});
/** 卸载要点两次：第一次只是亮出确认。 */
const confirmingUninstall = ref(false);
function uninstall() {
  if (!confirmingUninstall.value) {
    confirmingUninstall.value = true;
    return;
  }
  confirmingUninstall.value = false;
  void act(() => appsApi.uninstall(props.app.id));
}
</script>

<template>
  <div class="app-panel">
    <div class="app-bar">
      <span class="app-name">{{ app.name }}</span>
      <span v-if="app.source === 'workspace'" class="app-tag" v-tooltip="'来自当前工作区的 .aide/apps，文件一改就重载'">开发中</span>
      <div v-if="myProcesses.length > 0" ref="procsEl" class="app-procs">
        <button
          class="app-procs-badge"
          v-tooltip="'这个应用正在运行的进程'"
          :aria-expanded="procsOpen"
          @click="procsOpen = !procsOpen"
        >
          <span class="app-procs-dot" :class="{ 'app-procs-dot--idle': runningHere === 0 }" />
          <span>运行中 {{ runningHere }}</span>
          <span v-if="runningElsewhere > 0" class="app-procs-else">· 别处 {{ runningElsewhere }}</span>
        </button>
        <div v-if="procsOpen" class="app-procs-panel" role="dialog" :aria-label="`${app.name}正在运行的进程`">
          <AppProcessList :items="myProcesses" :current-workspace="workspaceRoot ?? ''" />
        </div>
      </div>
      <span class="app-spacer" />
      <button v-if="!app.error" class="app-btn" :disabled="busy" v-tooltip="relocation.tip" @click="relocate">
        {{ relocation.label }}
      </button>
      <button
        v-if="app.enabled && !app.error"
        class="app-btn"
        :class="{ 'app-btn--danger': confirmingDisable }"
        :disabled="busy"
        v-tooltip="'暂时关掉这个应用；它的数据保留，随时可以再启用。它起的进程会一并结束'"
        @click="disable"
        @blur="confirmingDisable = false"
      >
        {{ confirmingDisable ? `禁用${alsoEnds}` : "禁用" }}
      </button>
      <button
        class="app-btn"
        :class="{ 'app-btn--danger': confirmingUninstall }"
        :disabled="busy"
        v-tooltip="removal.tip"
        @click="uninstall"
        @blur="confirmingUninstall = false"
      >
        {{ confirmingUninstall ? removal.confirm : removal.label }}
      </button>
    </div>

    <div v-if="devNotice" class="app-notice">
      <span class="app-notice-text">{{ devNotice.text }}</span>
      <button
        class="app-btn app-btn--primary"
        :disabled="busy"
        v-tooltip="'把它复制到这台 Host 的 ~/.aide/apps，之后不依赖这个工作区'"
        @click="install"
      >
        {{ devNotice.action }}
      </button>
    </div>

    <div v-if="app.error" class="app-card">
      <div class="app-card-title">这个应用的清单有问题</div>
      <div class="app-card-text">{{ app.error }}</div>
    </div>

    <div v-else-if="!app.enabled" class="app-card">
      <div class="app-card-title">「{{ app.name }}」已禁用</div>
      <button class="app-btn app-btn--primary" :disabled="busy" @click="setEnabled(true)">启用</button>
    </div>

    <div v-else-if="!app.consented" class="app-card">
      <div class="app-card-title">启用「{{ app.name }}」？</div>
      <div class="app-card-text">这个应用由你或 agent 编写，界面运行在隔离的沙箱里。</div>
      <template v-if="app.permissions.length">
        <div class="app-card-text">它申请了这些权限：</div>
        <ul class="app-perms">
          <li v-for="p in app.permissions" :key="p">{{ describePermission(p) }}</li>
        </ul>
      </template>
      <div v-else class="app-card-text">它没有申请任何权限，只能在自己的面板里活动。</div>
      <div v-if="app.hasServer" class="app-card-text app-card-warn">
        它带有后端程序：同意后，这个程序会以你的身份在这台 Host 上运行，agent 也能调用它提供的工具。
        沙箱只管得住界面，管不住后端。
        {{ app.source === "user" ? "它标成只读的工具，agent 调用时不会逐次问你。" : "开发中的应用，agent 每次调用它的工具都会先问你。" }}
      </div>
      <button class="app-btn app-btn--primary" :disabled="busy" @click="consent">同意并启用</button>
    </div>

    <iframe
      v-else-if="src"
      ref="frame"
      :key="frameKey"
      class="app-frame"
      :src="src"
      :sandbox="SANDBOX"
      :aria-label="app.name"
      referrerpolicy="no-referrer"
    />

    <div v-if="failure" class="app-failure">{{ failure }}</div>
  </div>
</template>

<style scoped>
.app-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--aide-bg-base);
  color: var(--aide-text-primary);
}

.app-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  height: 32px;
  padding: 0 10px;
  border-bottom: 1px solid var(--aide-border-subtle);
  font-size: 12px;
}

.app-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-tag {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: var(--aide-radius-sm);
  color: var(--aide-accent);
  background: var(--aide-accent-subtle);
}

.app-procs {
  position: relative;
  flex-shrink: 0;
}

.app-procs-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 20px;
  padding: 0 8px;
  border: 1px solid var(--aide-border);
  border-radius: 99px;
  background: transparent;
  color: var(--aide-text-secondary);
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}

.app-procs-badge:hover {
  color: var(--aide-text-primary);
}

.app-procs-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--aide-success);
}

.app-procs-dot--idle {
  background: var(--aide-text-muted);
}

.app-procs-else {
  color: var(--aide-text-muted);
}

.app-procs-panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 20;
  width: min(360px, 80vw);
  max-height: 50vh;
  overflow-y: auto;
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-md);
  background: var(--aide-bg-raised);
  box-shadow: var(--aide-shadow-lg);
}

.app-notice {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  padding: 8px 10px;
  border-bottom: 1px solid var(--aide-border-subtle);
  background: var(--aide-accent-subtle);
  font-size: 12px;
  line-height: 1.5;
}

.app-notice-text {
  flex: 1;
  min-width: 0;
}

.app-notice .app-btn--primary {
  align-self: center;
}

.app-spacer {
  flex: 1;
}

.app-btn {
  flex-shrink: 0;
  padding: 2px 10px;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  background: transparent;
  color: var(--aide-text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.app-btn:hover:not(:disabled) {
  color: var(--aide-text-primary);
}

.app-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.app-btn--danger {
  border-color: var(--aide-danger);
  color: var(--aide-danger);
}

.app-btn--primary {
  align-self: flex-start;
  border-color: var(--aide-accent);
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
}

.app-btn--primary:hover:not(:disabled) {
  background: var(--aide-accent-hover);
  color: var(--aide-text-on-accent);
}

.app-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 16px;
  padding: 14px 16px;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  background: var(--aide-bg-raised);
  font-size: 13px;
  line-height: 1.6;
}

.app-card-title {
  font-weight: 600;
}

.app-card-text {
  color: var(--aide-text-secondary);
  overflow-wrap: anywhere;
}

.app-card-warn {
  color: var(--aide-danger);
}

.app-perms {
  margin: 0;
  padding-left: 18px;
}

.app-frame {
  flex: 1;
  min-height: 0;
  width: 100%;
  border: 0;
  background: var(--aide-bg-base);
}

.app-failure {
  flex-shrink: 0;
  padding: 6px 10px;
  color: var(--aide-danger);
  font-size: 12px;
  overflow-wrap: anywhere;
}
</style>
