<script setup lang="ts">
// Host 启动页：一眼看到所有 Host（本机 / WSL 发行版 / SSH 主机）与各自的最近项目，点一下进
// 它的窗口。最近项目是桌面自己记的（不连接任何 Host 就能列），连接发生在点开之后——一个窗口
// = 一个 Host，点哪台就开（或聚焦）哪台的窗口。
import { computed, ref, watch } from "vue";
import { vOverlayLayer } from "../directives/overlayLayer";
import {
  hostApi,
  listen,
  remoteWorkspaceApi,
  REMOTE_WORKSPACE_STATUS_EVENT,
  type CurrentHost,
  type HostRecents,
  type RemoteHostStatus,
  type RemoteTargets,
} from "@aide/sdk";

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ "update:visible": [v: boolean] }>();

const LOCAL = "local";
/** 每台 Host 列出的最近项目数（更多的在 Host 自己窗口的侧栏里）。 */
const SHOWN = 5;

const current = ref<CurrentHost | null>(null);
const recents = ref<HostRecents[]>([]);
const targets = ref<RemoteTargets>({ wsl: [], ssh: [] });
const statuses = ref<Record<string, RemoteHostStatus>>({});
const customSsh = ref("");
const showCustomSsh = ref(false);
const opening = ref("");
const error = ref("");
let unlisten: (() => void) | null = null;

interface HostRow {
  key: string;
  label: string;
  projects: HostRecents["projects"];
}

/** 本机在前，其后是已知目标与「用过但不在目标清单里」的 Host（如手输过的 SSH 主机）。 */
const rows = computed<HostRow[]>(() => {
  const byKey = new Map(recents.value.map((r) => [r.host, r]));
  const keys = [
    LOCAL,
    ...targets.value.wsl.map((d) => `wsl:${d}`),
    ...targets.value.ssh.map((h) => `ssh:${h}`),
    ...recents.value.map((r) => r.host),
  ];
  const seen = new Set<string>();
  const out: HostRow[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const known = byKey.get(key);
    out.push({
      key,
      label: known?.label ?? labelOf(key),
      projects: (known?.projects ?? []).slice(0, SHOWN),
    });
  }
  return out;
});

function labelOf(key: string): string {
  if (key === LOCAL) return "本机";
  if (key.startsWith("wsl:")) return `WSL: ${key.slice(4)}`;
  if (key.startsWith("ssh:")) return `SSH: ${key.slice(4)}`;
  return key;
}

const STATE_TEXT: Record<string, string> = {
  connecting: "连接中…",
  installing: "安装中…",
  connected: "已连接",
  disconnected: "已断开",
  reconnecting: "重新连接中…",
  resync: "需要重新加载",
  error: "连接失败",
};

function stateOf(key: string): { text: string; tone: string } | null {
  const s = statuses.value[key]?.state;
  return s && STATE_TEXT[s] ? { text: STATE_TEXT[s], tone: s } : null;
}

function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

async function refresh() {
  error.value = "";
  current.value = await hostApi.current().catch(() => null);
  const [r, t, s] = await Promise.all([
    hostApi.recents().catch(() => [] as HostRecents[]),
    remoteWorkspaceApi.targets().catch(() => ({ wsl: [], ssh: [] }) as RemoteTargets),
    remoteWorkspaceApi.statuses().catch(() => [] as RemoteHostStatus[]),
  ]);
  recents.value = r;
  targets.value = t;
  statuses.value = Object.fromEntries(s.map((x) => [x.host, x]));
}

watch(
  () => props.visible,
  async (v) => {
    if (v) {
      await refresh();
      unlisten?.();
      unlisten = await listen<RemoteHostStatus>(REMOTE_WORKSPACE_STATUS_EVENT, (e) => {
        statuses.value = { ...statuses.value, [e.payload.host]: e.payload };
      });
    } else {
      unlisten?.();
      unlisten = null;
    }
  },
  { immediate: true },
);

function close() {
  emit("update:visible", false);
}

/** 开（或聚焦）某台 Host 的窗口；`folder` 给了就让它直接打开这个项目。 */
async function open(key: string, folder?: string) {
  opening.value = key;
  error.value = "";
  try {
    await hostApi.openWindow(key, folder);
    close();
  } catch (e) {
    error.value = String(e);
  } finally {
    opening.value = "";
  }
}

async function forget(key: string, path: string) {
  await hostApi.forgetRecent(key, path).catch(() => {});
  recents.value = recents.value
    .map((r) => (r.host === key ? { ...r, projects: r.projects.filter((p) => p.path !== path) } : r))
    .filter((r) => r.projects.length > 0);
}

function addCustomSsh() {
  const h = customSsh.value.trim();
  if (!/^[A-Za-z0-9._@-]+$/.test(h) || h.startsWith("-")) {
    error.value = "主机名只能包含字母、数字与 . _ @ -（可用 ~/.ssh/config 里的别名）";
    return;
  }
  customSsh.value = "";
  showCustomSsh.value = false;
  void open(`ssh:${h}`);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="props.visible" class="hl-overlay" v-overlay-layer @click.self="close">
      <div class="hl-dialog" @click.stop>
        <div class="hl-header">连接到 Host</div>
        <div class="hl-hint">一个窗口连一台 Host：会话、文件、终端都跑在那台机器上。</div>

        <div class="hl-list">
          <section v-for="row in rows" :key="row.key" class="hl-host" :data-host="row.key">
            <div class="hl-host-head">
              <span class="hl-host-name">{{ row.label }}</span>
              <span v-if="row.key === (current?.key ?? LOCAL)" class="hl-badge here">当前窗口</span>
              <span v-if="stateOf(row.key)" class="hl-badge" :class="stateOf(row.key)!.tone">{{ stateOf(row.key)!.text }}</span>
              <button class="hl-open" :disabled="!!opening" @click="open(row.key)">
                {{ opening === row.key ? "打开中…" : "打开" }}
              </button>
            </div>
            <ul v-if="row.projects.length" class="hl-projects">
              <li v-for="p in row.projects" :key="p.path" class="hl-project">
                <button class="hl-project-btn" :disabled="!!opening" :title="p.path" @click="open(row.key, p.path)">
                  <span class="hl-project-name">{{ baseName(p.path) }}</span>
                  <span class="hl-project-path">{{ p.path }}</span>
                </button>
                <button class="hl-forget" title="从最近项目里移除" @click="forget(row.key, p.path)">×</button>
              </li>
            </ul>
            <div v-else class="hl-empty">还没有最近项目</div>
          </section>
        </div>

        <div class="hl-add">
          <button v-if="!showCustomSsh" class="hl-link" @click="showCustomSsh = true">+ SSH 主机</button>
          <span v-else class="hl-ssh-input">
            <input v-model="customSsh" placeholder="~/.ssh/config 别名或 user@host" @keydown.enter="addCustomSsh" />
            <button class="hl-open" @click="addCustomSsh">连接</button>
          </span>
        </div>

        <div v-if="error" class="hl-error">{{ error }}</div>
        <div class="hl-actions">
          <button class="hl-btn" @click="close">关闭</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.hl-overlay {
  position: fixed; inset: 0; background: var(--aide-bg-overlay);
  display: flex; align-items: center; justify-content: center; z-index: 1100;
  padding: 24px; overflow-y: auto; animation: fadeIn 0.12s ease;
}
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.hl-dialog {
  background: var(--aide-bg-raised); border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg); padding: 18px 20px;
  width: 520px; max-width: 100%; box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  max-height: 90vh; display: flex; flex-direction: column;
}
.hl-header { font-size: 14px; font-weight: 600; color: var(--aide-text-primary); user-select: none; }
.hl-hint { font-size: 12px; color: var(--aide-text-muted); margin: 4px 0 12px; }
.hl-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.hl-host { border: 1px solid var(--aide-border-subtle); border-radius: var(--aide-radius-md); background: var(--aide-surface-default); padding: 8px 10px; }
.hl-host-head { display: flex; align-items: center; gap: 8px; }
.hl-host-name { font-size: 13px; font-weight: 600; color: var(--aide-text-primary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hl-badge { font-size: 11px; padding: 1px 6px; border-radius: var(--aide-radius-md); color: var(--aide-text-secondary); border: 1px solid var(--aide-border); }
.hl-badge.here { color: var(--aide-accent); border-color: var(--aide-accent); }
.hl-badge.connected { color: var(--aide-success); border-color: var(--aide-success); }
.hl-badge.disconnected, .hl-badge.error { color: var(--aide-danger); border-color: var(--aide-danger); }
.hl-badge.connecting, .hl-badge.installing, .hl-badge.reconnecting, .hl-badge.resync { color: var(--aide-warning); border-color: var(--aide-warning); }
.hl-open {
  font-size: 12px; padding: 3px 12px; border-radius: var(--aide-radius-md); cursor: pointer; font-family: inherit;
  border: 1px solid var(--aide-border); background: transparent; color: var(--aide-text-secondary);
}
.hl-open:hover:not(:disabled) { background: var(--aide-surface-hover); color: var(--aide-text-primary); }
.hl-open:disabled { opacity: 0.5; cursor: not-allowed; }
.hl-projects { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.hl-project { display: flex; align-items: center; gap: 4px; }
.hl-project-btn {
  flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; text-align: left;
  padding: 3px 6px; border: none; border-radius: var(--aide-radius-md); background: transparent;
  color: var(--aide-text-secondary); cursor: pointer; font-family: inherit; font-size: 12px;
}
.hl-project-btn:hover:not(:disabled) { background: var(--aide-surface-hover); color: var(--aide-text-primary); }
.hl-project-name { flex: none; color: var(--aide-text-primary); }
.hl-project-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--aide-text-muted); font-family: var(--aide-font-mono); font-size: 11px; }
.hl-forget { border: none; background: transparent; color: var(--aide-text-muted); cursor: pointer; font-size: 14px; padding: 0 4px; }
.hl-forget:hover { color: var(--aide-danger); }
.hl-empty { font-size: 12px; color: var(--aide-text-muted); margin-top: 6px; }
.hl-add { margin-top: 10px; }
.hl-link { border: none; background: transparent; color: var(--aide-accent); cursor: pointer; font-size: 12px; font-family: inherit; padding: 0; }
.hl-ssh-input { display: inline-flex; gap: 6px; }
.hl-ssh-input input {
  font-size: 12px; padding: 4px 8px; border-radius: var(--aide-radius-md); width: 240px;
  border: 1px solid var(--aide-border); background: var(--aide-bg-deep); color: var(--aide-text-primary); font-family: var(--aide-font-mono);
}
.hl-error { font-size: 12px; color: var(--aide-danger); margin-top: 8px; }
.hl-actions { display: flex; justify-content: flex-end; margin-top: 14px; }
.hl-btn {
  padding: 7px 16px; border-radius: var(--aide-radius-md); font-size: 13px; cursor: pointer; font-family: inherit;
  border: 1px solid var(--aide-border); background: transparent; color: var(--aide-text-secondary);
}
.hl-btn:hover { background: var(--aide-surface-hover); color: var(--aide-text-primary); }
</style>
