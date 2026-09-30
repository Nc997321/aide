<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import DirTreePicker from "./DirTreePicker.vue";
import { vOverlayLayer } from "../directives/overlayLayer";
import { remoteWorkspaceApi, remoteDesktopPath, type RemoteTargets } from "@aide/sdk";
import type { FileEntry } from "../types";

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{
  "update:visible": [v: boolean];
  confirm: [path: string];
}>();

const path = ref("");
const error = defineModel<string>("error", { default: "" });

// ── 机器选择：本机 / WSL 发行版 / SSH 主机 ──
// 远程工作区的 GUI 仍在本机；选中目标机后，下面的目录树经 IPC 拦截层列的是目标机的目录，
// 选中的路径是桌面形态（\\wsl.localhost\… / \\aide-ssh.invalid\…），打开流程与本机完全相同。
const LOCAL = "local";
const machine = ref<string>(LOCAL);
const targets = ref<RemoteTargets>({ wsl: [], ssh: [] });
const customSsh = ref("");
const showCustomSsh = ref(false);
/** 远程连接阶段：idle → connecting → ready / failed */
const phase = ref<"idle" | "connecting" | "ready" | "failed">("idle");
const phaseDetail = ref("");
const remoteRoots = ref<FileEntry[] | undefined>(undefined);

const machines = computed(() => [
  { key: LOCAL, label: "本机" },
  ...targets.value.wsl.map((d) => ({ key: `wsl:${d}`, label: `WSL: ${d}` })),
  ...targets.value.ssh.map((h) => ({ key: `ssh:${h}`, label: `SSH: ${h}` })),
]);

onMounted(loadTargets);
watch(
  () => props.visible,
  (v) => {
    if (v) void loadTargets();
  },
);

async function loadTargets() {
  try {
    targets.value = await remoteWorkspaceApi.targets();
  } catch {
    targets.value = { wsl: [], ssh: [] };
  }
}

async function selectMachine(key: string) {
  if (machine.value === key && phase.value !== "failed") return;
  machine.value = key;
  path.value = "";
  error.value = "";
  remoteRoots.value = undefined;
  if (key === LOCAL) {
    phase.value = "idle";
    return;
  }
  phase.value = "connecting";
  phaseDetail.value = "";
  try {
    // 首次连接会把远程套件装到目标机（~/.aide/host），之后秒连
    const st = await remoteWorkspaceApi.connect(key);
    const home = st.home ?? remoteDesktopPath(key, "/");
    remoteRoots.value = [
      { name: "Home", path: home, is_dir: true, children: null },
      { name: "/", path: remoteDesktopPath(key, "/"), is_dir: true, children: null },
    ];
    path.value = home;
    phase.value = "ready";
  } catch (e) {
    phase.value = "failed";
    phaseDetail.value = String(e);
  }
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
  void selectMachine(`ssh:${h}`);
}

const pickerReady = computed(() => machine.value === LOCAL || phase.value === "ready");

function close() {
  emit("update:visible", false);
  error.value = "";
}

async function onConfirm() {
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

        <div v-if="machine !== LOCAL && phase === 'connecting'" class="of-status">
          正在连接 {{ machines.find((m) => m.key === machine)?.label }}…首次连接会在目标机安装 Aide 远程组件，可能需要一分钟。
        </div>
        <div v-else-if="phase === 'failed'" class="of-status failed">
          <div>连接失败</div>
          <pre>{{ phaseDetail }}</pre>
          <button class="of-machine" @click="selectMachine(machine)">重试</button>
        </div>

        <DirTreePicker v-if="pickerReady" :key="machine" v-model="path" :roots="remoteRoots" />

        <div v-if="error" class="of-error">{{ error }}</div>
        <div class="of-actions">
          <button class="of-btn cancel" @click="close">取消</button>
          <button class="of-btn confirm" :disabled="!pickerReady" @click="onConfirm">打开并切换</button>
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
