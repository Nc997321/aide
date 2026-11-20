<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "@aide/sdk/api";
import { hostApi } from "@aide/sdk";
import type { FileEntry } from "../types";
import DirTreePicker from "./DirTreePicker.vue";
import { vOverlayLayer } from "../directives/overlayLayer";
const props = defineProps<{ visible: boolean; initialPath: string }>();
const emit = defineEmits<{ "update:visible": [value: boolean]; confirm: [path: string, isDir: boolean] }>();
const path = ref<string | string[]>("");
const kind = ref<"file" | "dir" | "none">("none");
const error = ref("");
const loading = ref(false);
const ready = ref(false);
const roots = ref<FileEntry[] | undefined>();
const selected = computed(() => typeof path.value === "string" ? path.value.trim() : "");
let version = 0;
watch(() => props.visible, async (visible) => {
  version++;
  if (!visible) return;
  const current = version;
  ready.value = false;
  error.value = "";
  path.value = props.initialPath;
  roots.value = undefined;
  try {
    const host = await hostApi.current();
    if (current !== version) return;
    if (host.key !== "local") roots.value = [
      { name: "Home", path: host.home, is_dir: true, children: null },
      { name: "/", path: "/", is_dir: true, children: null },
    ];
  } catch (e) {
    if (current === version) error.value = `无法获取当前主机：${String(e)}`;
    return;
  }
  if (current === version) ready.value = true;
}, { immediate: true });
let probe = 0;
watch(selected, async (value) => {
  const current = ++probe;
  kind.value = "none";
  if (!value) return;
  try {
    const [type] = await api.pathTypes([value]);
    if (current === probe) kind.value = type ?? "none";
  } catch { /* 确认时显示具体错误。 */ }
}, { immediate: true });
function close() { if (!loading.value) emit("update:visible", false); }
async function confirm() {
  if (loading.value) return;
  const value = selected.value;
  loading.value = true;
  error.value = "";
  try {
    const [type] = await api.pathTypes([value]);
    if (value !== selected.value || !props.visible) return;
    if (!value || (type !== "dir" && type !== "file")) throw new Error("请选择存在的文件或文件夹");
    // 探测未完成时不能把目录当文件，绕过明确的目录授权文案。
    if (type === "dir" && kind.value !== "dir") { kind.value = "dir"; return; }
    emit("confirm", value, type === "dir");
    emit("update:visible", false);
  } catch (e) { error.value = String(e); }
  finally { loading.value = false; }
}
</script>
<template>
  <Teleport to="body">
    <div v-if="visible" class="of-overlay" v-overlay-layer @click.self="close" @keydown.esc.stop.prevent="close">
      <div class="of-dialog" role="dialog" aria-modal="true" aria-label="添加引用" @click.stop>
        <div class="of-header">添加引用</div>
        <DirTreePicker v-if="ready" v-model="path" mode="mixed" select-directories :roots="roots" />
        <div v-else-if="!error" class="fp-target">正在连接当前主机…</div>
        <div class="fp-target"><b>已选：</b>{{ selected || '（未选择）' }}</div>
        <p v-if="kind === 'dir'" class="fp-target">发送后允许本会话访问此目录，不自动加载工程规则与记忆。</p>
        <div v-if="error" class="of-error" role="alert">{{ error }}</div>
        <div class="of-actions">
          <button class="of-btn cancel" :disabled="loading" @click="close">取消</button>
          <button class="of-btn confirm" :disabled="loading || !ready || !selected" @click="confirm">{{ loading ? '检查中…' : kind === 'dir' ? '允许并添加' : '添加引用' }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
<style scoped>
/* 弹窗外壳（复用 OpenFolderDialog 的 of-* 视觉，独立 scoped 避免跨组件样式耦合） */
.of-overlay {
  position: fixed; inset: 0; background: var(--aide-bg-overlay);
  display: flex; align-items: center; justify-content: center; z-index: 1100;
  padding: 24px; overflow-y: auto; animation: fadeIn 0.12s ease;
}
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.of-dialog {
  background: var(--aide-bg-raised);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur); border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg); padding: 18px 20px;
  max-width: 600px; box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  width: min(600px, 100%); min-width: 0; height: min(560px, 90vh);
  max-height: 90vh; display: flex; flex-direction: column;
  animation: scaleIn var(--aide-ease-t);
}
@keyframes scaleIn { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
.of-header { flex-shrink: 0; font-size: 14px; font-weight: 600; color: var(--aide-text-primary); margin-bottom: 12px; user-select: none; }
.fp-target { flex-shrink: 0; font-size: 11px; color: var(--aide-text-muted); margin-top: 8px; word-break: break-all; }
.fp-target b { color: var(--aide-text-secondary); }
.of-error { flex-shrink: 0; font-size: 12px; color: var(--aide-danger); margin-top: 8px; }
.of-actions { flex-shrink: 0; display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.of-btn { padding: 7px 16px; border-radius: var(--aide-radius-md); font-size: 13px; cursor: pointer; font-family: inherit; border: 1px solid var(--aide-border); transition: all var(--aide-ease-t); }
.of-btn.cancel { background: transparent; color: var(--aide-text-secondary); }
.of-btn.cancel:hover { background: var(--aide-surface-hover); color: var(--aide-text-primary); }
.of-btn.confirm { background: var(--aide-accent-gradient); border-color: transparent; color: var(--aide-text-on-accent); box-shadow: var(--aide-shadow-sm); }
.of-btn.confirm:hover { filter: brightness(1.07); }
</style>