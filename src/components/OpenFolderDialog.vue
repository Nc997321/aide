<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import DirTreePicker from "./DirTreePicker.vue";
import { vOverlayLayer } from "../directives/overlayLayer";
import { hostApi, remoteWorkspaceApi, type CurrentHost, type RemoteTargets } from "@aide/sdk";
import { api } from "@aide/sdk/api";
import type { FileEntry } from "../types";

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{
  "update:visible": [v: boolean];
  confirm: [path: string];
}>();

const path = ref("");
const error = defineModel<string>("error", { default: "" });
const mode = ref<"directory" | "git">("directory");
const gitUrl = ref("");
const directoryName = ref("");
const directoryNameEdited = ref(false);
const cloneParent = ref("");
const cloning = ref(false);

function suggestDirectoryName(url: string): string {
  let repoPath = url.trim();
  if (repoPath.includes("://")) {
    try {
      repoPath = new URL(repoPath).pathname;
    } catch {
      return "";
    }
  }
  const name = repoPath.replace(/[?#].*$/, "").replace(/[\\/]+$/, "").split(/[\\/:]/).pop() ?? "";
  try {
    return decodeURIComponent(name).replace(/\.git$/i, "");
  } catch {
    return name.replace(/\.git$/i, "");
  }
}

watch(gitUrl, (url) => {
  if (!directoryNameEdited.value) directoryName.value = suggestDirectoryName(url);
});

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
const busy = computed(() => opening.value || cloning.value);
const cloneDestination = computed(() => {
  const parent = cloneParent.value.trim();
  if (!parent || !directoryName.value) return "";
  const separator = host.value?.os === "windows" ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${separator}${directoryName.value}`;
});

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
  if (busy.value) return;
  machine.value = key;
  error.value = "";
}

function selectMode(value: "directory" | "git") {
  if (busy.value) return;
  mode.value = value;
  error.value = "";
  if (value === "git" && !cloneParent.value) cloneParent.value = path.value || host.value?.home || "";
}

async function cloneAndOpen() {
  if (busy.value || !isOwnHost.value) return;
  const url = gitUrl.value.trim();
  const parentPath = cloneParent.value.trim();
  const name = directoryName.value;
  if (!url) {
    error.value = "请输入 Git 仓库地址";
    return;
  }
  if (!name.trim() || name === "." || name === ".." || name.includes("/") || /[<>:"\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name)) {
    error.value = "请输入有效的项目目录名，不能包含路径分隔符或特殊字符";
    return;
  }
  if (!parentPath) {
    error.value = "请选择或输入保存父目录";
    return;
  }
  cloning.value = true;
  error.value = "";
  try {
    const clonedPath = await api.gitClone({ url, parentPath, directoryName: name });
    // 先回到已有目录：后续登记/打开失败时，只重试打开，不再次克隆。
    path.value = clonedPath;
    mode.value = "directory";
    emit("confirm", clonedPath);
  } catch (e) {
    error.value = String(e);
  } finally {
    cloning.value = false;
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
  selectMachine(`ssh:${h}`);
}

function close() {
  if (cloning.value) return;
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
  if (busy.value) return;
  if (!isOwnHost.value) return openOtherHost("newWindow");
  if (mode.value === "git") return cloneAndOpen();
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
            :disabled="busy"
            @click="selectMachine(m.key)"
          >
            {{ m.label }}
          </button>
          <button v-if="!showCustomSsh" class="of-machine add" :disabled="busy" @click="showCustomSsh = true">+ SSH 主机</button>
          <span v-else class="of-ssh-input">
            <input
              v-model="customSsh"
              :disabled="busy"
              placeholder="别名或 user@host"
              spellcheck="false"
              @keydown.enter="connectCustomSsh"
              @keydown.esc="showCustomSsh = false"
            />
            <button class="of-machine" :disabled="busy" @click="connectCustomSsh">连接</button>
          </span>
        </div>

        <div v-if="!isOwnHost" class="of-status">
          {{ machines.find((m) => m.key === machine)?.label }} 是另一台 Host（一个窗口 = 一个 Host）：可以在新窗口里打开，
          也可以把当前窗口换成它。首次打开会在目标机安装 Aide 组件，可能需要一分钟；进度在它的窗口里显示。
        </div>
        <template v-else>
          <div class="of-modes" aria-label="打开方式">
            <button class="of-mode" :class="{ active: mode === 'directory' }" :aria-pressed="mode === 'directory'" :disabled="busy" @click="selectMode('directory')">
              打开已有目录
            </button>
            <button class="of-mode" :class="{ active: mode === 'git' }" :aria-pressed="mode === 'git'" :disabled="busy" @click="selectMode('git')">
              从 Git 克隆
            </button>
          </div>
          <DirTreePicker v-if="mode === 'directory'" :key="machine" v-model="path" :roots="hostRoots" />
          <fieldset v-else class="of-clone" :disabled="cloning" :inert="cloning" :aria-busy="cloning">
            <p class="of-hint">克隆到 {{ host?.label ?? '当前 Host' }}，使用该 Host 已配置的 Git 凭据。目标目录必须尚不存在。</p>
            <label class="of-field">
              <span>仓库地址</span>
              <input v-model="gitUrl" data-testid="of-git-url" placeholder="HTTPS 或 SSH 仓库地址" spellcheck="false" autocomplete="off" @keydown.enter.prevent="onConfirm" />
            </label>
            <label class="of-field">
              <span>项目目录名</span>
              <input v-model="directoryName" data-testid="of-git-name" placeholder="从仓库地址自动填写，可修改" spellcheck="false" @input="directoryNameEdited = true" @keydown.enter.prevent="onConfirm" />
            </label>
            <span class="of-field-label">保存父目录</span>
            <DirTreePicker :key="`clone-${machine}`" v-model="cloneParent" :roots="hostRoots" />
            <div v-if="cloneDestination" class="of-destination" data-testid="of-git-destination">
              <span>将创建</span>
              <code>{{ cloneDestination }}</code>
            </div>
          </fieldset>
        </template>

        <div v-if="cloning" class="of-progress" role="status">正在克隆…完成后自动打开，请勿关闭窗口。</div>
        <div v-if="error" class="of-error" role="alert">{{ error }}</div>
        <div class="of-actions">
          <button class="of-btn cancel" :disabled="cloning" @click="close">取消</button>
          <button v-if="!isOwnHost" class="of-btn cancel" :disabled="opening" data-testid="of-open-here" @click="openOtherHost('thisWindow')">
            在此窗口中打开
          </button>
          <button class="of-btn confirm" :disabled="busy" data-testid="of-open-confirm" @click="onConfirm">
            {{ !isOwnHost ? "在新窗口中打开" : cloning ? "正在克隆…" : mode === 'git' ? "克隆并打开" : "打开并切换" }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.of-overlay {
  position: fixed; inset: 0; background: var(--aide-bg-overlay);
  backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
  display: flex; align-items: center; justify-content: center; z-index: 1100;
  padding: 24px; overflow-y: auto;
  animation: fadeIn 0.12s ease;
}
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.of-dialog {
  background: var(--aide-bg-raised); border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg); padding: 18px 20px;
  width: 560px; min-width: 0; max-width: 100%; box-sizing: border-box; box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  max-height: 90vh; display: flex; flex-direction: column;
  /* 玻璃主题的 bg-raised 是半透明的：不糊掉底下的内容，聊天正文会直接透出来盖住对话框文字。
     不透明主题 surface-blur 为 none，无副作用。 */
  backdrop-filter: var(--aide-surface-blur); -webkit-backdrop-filter: var(--aide-surface-blur);
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
.of-modes {
  display: flex; flex-shrink: 0; gap: calc(var(--aide-space-unit) * 2);
  margin-bottom: calc(var(--aide-space-unit) * 3);
  border-bottom: 1px solid var(--aide-border);
}
.of-mode {
  padding: calc(var(--aide-space-unit) * 2); font: inherit; font-size: 12px;
  border: 0; border-bottom: 2px solid transparent; background: transparent;
  color: var(--aide-text-secondary); cursor: pointer;
}
.of-mode.active { color: var(--aide-accent); border-bottom-color: var(--aide-accent); }
.of-mode:hover:not(:disabled) { color: var(--aide-text-primary); }
.of-mode:disabled, .of-machine:disabled { opacity: 0.5; cursor: not-allowed; }
.of-clone {
  display: flex; flex-direction: column; gap: calc(var(--aide-space-unit) * 2);
  flex: 1 1 auto; min-width: 0; min-height: 0; overflow-y: auto;
  border: 0; padding: 0; margin: 0;
}
.of-hint { margin: 0; color: var(--aide-text-muted); font-size: 12px; line-height: 1.6; }
.of-field { display: flex; flex-direction: column; gap: var(--aide-space-unit); }
.of-field, .of-field-label { font-size: 12px; color: var(--aide-text-secondary); }
.of-field input {
  box-sizing: border-box; width: 100%; min-width: 0;
  padding: calc(var(--aide-space-unit) * 2) calc(var(--aide-space-unit) * 3);
  border: 1px solid var(--aide-border); border-radius: var(--aide-radius-md);
  background: var(--aide-bg-base); color: var(--aide-text-primary); font: inherit;
}
.of-mode:focus-visible, .of-field input:focus-visible {
  outline: 2px solid var(--aide-accent); outline-offset: 2px;
}
.of-clone :deep(.dir-picker) { min-height: 140px; }
.of-destination { display: flex; flex-direction: column; gap: var(--aide-space-unit); font-size: 12px; color: var(--aide-text-secondary); }
.of-destination code { font-family: var(--aide-font-mono); overflow-wrap: anywhere; }
.of-progress { flex-shrink: 0; margin-top: calc(var(--aide-space-unit) * 2); color: var(--aide-text-secondary); font-size: 12px; }
.of-error { flex-shrink: 0; font-size: 12px; color: var(--aide-danger); margin-top: 8px; overflow-wrap: anywhere; }
.of-actions { flex-shrink: 0; display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.of-btn { padding: 7px 16px; border-radius: var(--aide-radius-md); font-size: 13px; cursor: pointer; font-family: inherit; border: 1px solid var(--aide-border); transition: all var(--aide-ease-t); }
.of-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.of-btn.cancel { background: transparent; color: var(--aide-text-secondary); }
.of-btn.cancel:hover { background: var(--aide-surface-hover); color: var(--aide-text-primary); }
.of-btn.confirm { background: var(--aide-accent-gradient); border-color: transparent; color: var(--aide-text-on-accent); box-shadow: var(--aide-accent-glow); }
.of-btn.confirm:hover { filter: brightness(1.07); }
</style>
