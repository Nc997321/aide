<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import DirTreePicker from "./DirTreePicker.vue";
import { vOverlayLayer } from "../directives/overlayLayer";
import { hostApi, remoteWorkspaceApi, type CurrentHost, type RemoteTargets } from "@aide/sdk";
import type { FileEntry } from "../types";

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{
  "update:visible": [v: boolean];
  confirm: [path: string];
}>();

const path = ref("");
const error = defineModel<string>("error", { default: "" });

// ── 一个窗口 = 一个 Host ──
// 本窗口连着的 Host 上的目录直接在这里选（Host 窗口列的就是 Host 自己的文件系统，路径是 Host
// 原生路径）。别的机器（WSL 发行版 / SSH 主机）= 另一台 Host → 在它自己的窗口里打开。
const LOCAL = "local";
const host = ref<CurrentHost | null>(null);
const machine = ref<string>(LOCAL);
const targets = ref<RemoteTargets>({ wsl: [], ssh: [] });
const customSsh = ref("");
const showCustomSsh = ref(false);
const opening = ref(false);

/** 本窗口是 Host 窗口（连的不是本机）。 */
const isHostWindow = computed(() => !!host.value && host.value.key !== LOCAL);
/** 选中的是本窗口自己的 Host（在这里选目录），还是别的 Host（开它的窗口）。 */
const isOwnHost = computed(() => machine.value === (host.value?.key ?? LOCAL));

const machines = computed(() => {
  const own = { key: host.value?.key ?? LOCAL, label: host.value?.label ?? "本机" };
  // 没有「主窗口」：窗口连着谁是它当下的属性，所以远程窗口里「本机」也是一台普通的别的 Host
  // （新窗口打开 / 把本窗口换回本机）
  const others = [
    ...(own.key === LOCAL ? [] : [{ key: LOCAL, label: "本机" }]),
    ...targets.value.wsl.map((d) => ({ key: `wsl:${d}`, label: `WSL: ${d}` })),
    ...targets.value.ssh.map((h) => ({ key: `ssh:${h}`, label: `SSH: ${h}` })),
  ].filter((m) => m.key !== own.key);
  return [own, ...others];
});

/** Host 窗口的目录起点：Host 家目录 + 根。本机窗口交给 DirTreePicker 自己的盘符 / 快捷根。 */
const hostRoots = computed<FileEntry[] | undefined>(() =>
  isHostWindow.value && host.value
    ? [
        { name: "Home", path: host.value.home, is_dir: true, children: null },
        { name: "/", path: "/", is_dir: true, children: null },
      ]
    : undefined,
);

onMounted(init);
watch(
  () => props.visible,
  (v) => {
    if (v) void init();
  },
);

async function init() {
  try {
    host.value = await hostApi.current();
  } catch {
    host.value = null;
  }
  if (machine.value === LOCAL && host.value) {
    machine.value = host.value.key;
    if (isHostWindow.value && !path.value) path.value = host.value.home;
  }
  try {
    targets.value = await remoteWorkspaceApi.targets();
  } catch {
    targets.value = { wsl: [], ssh: [] };
  }
}

function selectMachine(key: string) {
  machine.value = key;
  error.value = "";
}

function connectCustomSsh() {
  const h = customSsh.value.trim();
  if (!/^[A-Za-z0-9._@-]+$/.test(h) || h.startsWith("-")) {
    error.value = "主机名只能包含字母、数字与 . _ @ -（可用 ~/.ssh/config 里的别名）";
    return;
  }
  if (!targets.value.ssh.includes(h)) targets.value = { ...targets.value, ssh: [...targets.value.ssh, h] };
  showCustomSsh.value = false;
  customSsh.value = "";
  selectMachine(`ssh:${h}`);
}

function close() {
  emit("update:visible", false);
  error.value = "";
}

/** 别的 Host：新开（或聚焦）它的窗口，或把本窗口换成它——两条路都在那边选目录，首次会在目标机安装 Aide 组件。 */
async function openOtherHost(mode: "newWindow" | "thisWindow") {
  opening.value = true;
  error.value = "";
  try {
    if (mode === "newWindow") await hostApi.openWindow(machine.value);
    else await hostApi.switchWindow(machine.value);
    close();
  } catch (e) {
    error.value = String(e);
  } finally {
    opening.value = false;
  }
}

async function onConfirm() {
  if (!isOwnHost.value) return openOtherHost("newWindow");
  if (!path.value.trim()) {
    error.value = "请选择或输入目录路径";
    return;
  }
  error.value = "";
  emit("confirm", path.value.trim());
}
</script>

<template>
  <Teleport to="body">
    <div v-if="props.visible" class="of-overlay" v-overlay-layer @click.self="close">
      <div class="of-dialog" @click.stop>
        <div class="of-header">打开目录</div>

        <div class="of-machines">
          <button
            v-for="m in machines"
            :key="m.key"
            class="of-machine"
            :class="{ active: machine === m.key }"
            @click="selectMachine(m.key)"
          >
            {{ m.label }}
          </button>
          <button v-if="!showCustomSsh" class="of-machine add" @click="showCustomSsh = true">+ SSH 主机</button>
          <span v-else class="of-ssh-input">
            <input
              v-model="customSsh"
              placeholder="别名或 user@host"
              spellcheck="false"
              @keydown.enter="connectCustomSsh"
              @keydown.esc="showCustomSsh = false"
            />
            <button class="of-machine" @click="connectCustomSsh">连接</button>
          </span>
        </div>

        <div v-if="!isOwnHost" class="of-status">
          {{ machines.find((m) => m.key === machine)?.label }} 是另一台 Host（一个窗口 = 一个 Host）：可以在新窗口里打开，
          也可以把当前窗口换成它。首次打开会在目标机安装 Aide 组件，可能需要一分钟；进度在它的窗口里显示。
        </div>
        <DirTreePicker v-else :key="machine" v-model="path" :roots="hostRoots" />

        <div v-if="error" class="of-error">{{ error }}</div>
        <div class="of-actions">
          <button class="of-btn cancel" @click="close">取消</button>
          <button v-if="!isOwnHost" class="of-btn cancel" :disabled="opening" data-testid="of-open-here" @click="openOtherHost('thisWindow')">
            在此窗口中打开
          </button>
          <button class="of-btn confirm" :disabled="opening" data-testid="of-open-confirm" @click="onConfirm">
            {{ isOwnHost ? "打开并切换" : "在新窗口中打开" }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.of-overlay {
  position: fixed; inset: 0; background: var(--aide-bg-overlay);
  display: flex; align-items: center; justify-content: center; z-index: 1100;
  padding: 24px; overflow-y: auto;
  animation: fadeIn 0.12s ease;
}
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.of-dialog {
  background: var(--aide-bg-raised); border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg); padding: 18px 20px;
  min-width: 420px; max-width: 560px; box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  max-height: 90vh; display: flex; flex-direction: column;
  animation: scaleIn var(--aide-ease-t);
}
@keyframes scaleIn { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
.of-header { flex-shrink: 0; font-size: 14px; font-weight: 600; color: var(--aide-text-primary); margin-bottom: 12px; user-select: none; }
.of-machines { flex-shrink: 0; display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.of-machine {
  font-size: 12px; padding: 4px 10px; border-radius: var(--aide-radius-md);
  border: 1px solid var(--aide-border); background: var(--aide-surface-default);
  color: var(--aide-text-secondary); cursor: pointer; font-family: inherit;
  transition: all var(--aide-ease-t);
}
.of-machine:hover { background: var(--aide-surface-hover); color: var(--aide-text-primary); }
.of-machine.active { border-color: var(--aide-accent); color: var(--aide-accent); background: var(--aide-accent-subtle); }
.of-machine.add { border-style: dashed; }
.of-ssh-input { display: inline-flex; gap: 6px; }
.of-ssh-input input {
  font-size: 12px; padding: 4px 8px; border-radius: var(--aide-radius-md);
  border: 1px solid var(--aide-border); background: var(--aide-bg-deep);
  color: var(--aide-text-primary); font-family: var(--aide-font-mono); width: 180px;
}
.of-status {
  flex-shrink: 0; font-size: 12px; color: var(--aide-text-secondary);
  padding: 10px 12px; border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-md); background: var(--aide-surface-default); margin-bottom: 10px;
}
.of-status.failed { color: var(--aide-danger); display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.of-status pre {
  margin: 0; white-space: pre-wrap; word-break: break-all; max-height: 160px; overflow-y: auto;
  font-family: var(--aide-font-mono); font-size: 11px; color: var(--aide-text-secondary);
}
.of-error { flex-shrink: 0; font-size: 12px; color: var(--aide-danger); margin-top: 8px; }
.of-actions { flex-shrink: 0; display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.of-btn { padding: 7px 16px; border-radius: var(--aide-radius-md); font-size: 13px; cursor: pointer; font-family: inherit; border: 1px solid var(--aide-border); transition: all var(--aide-ease-t); }
.of-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.of-btn.cancel { background: transparent; color: var(--aide-text-secondary); }
.of-btn.cancel:hover { background: var(--aide-surface-hover); color: var(--aide-text-primary); }
.of-btn.confirm { background: var(--aide-accent-gradient); border-color: transparent; color: var(--aide-text-on-accent); box-shadow: var(--aide-accent-glow); }
.of-btn.confirm:hover { filter: brightness(1.07); }
</style>
