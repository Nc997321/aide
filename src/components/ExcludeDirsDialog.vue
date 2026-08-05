<script setup lang="ts">
import { ref, watch, computed } from "vue";
import DirTreePicker from "./DirTreePicker.vue";

/**
 * 排除目录多选弹窗：DirTreePicker mode=directory + multiple + root 锁定工作空间。
 * 根锁死工作空间，无法往上跳出。确认时把选中的绝对路径转成相对工作区的路径
 * （后端 build_exclude_globs 取末段做 glob，相对路径与旧目录名共存可读）。
 */
const props = defineProps<{ visible: boolean; workspaceRoot: string }>();
const emit = defineEmits<{
  "update:visible": [v: boolean];
  confirm: [paths: string[]];
}>();

const selected = ref<string | string[]>([]);
const error = ref("");

// 每次打开清空（用户重新勾选，确认后由 LspIndicator 合并去重进 localExcludes）
watch(() => props.visible, (v) => {
  if (v) {
    selected.value = [];
    error.value = "";
  }
});

function close() {
  emit("update:visible", false);
}

/** 绝对路径 → 相对工作区根的路径（正斜杠归一）。不在工作空间内回退取末段。 */
function toRelative(abs: string, root: string): string {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const nAbs = norm(abs), nRoot = norm(root);
  if (nAbs === nRoot) return ".";
  if (nAbs.startsWith(nRoot + "/")) return nAbs.slice(nRoot.length + 1);
  // 不在 root 内（root 锁定下不应发生），回退末段
  return nAbs.split("/").pop() || nAbs;
}

const selectedCount = computed(() => (Array.isArray(selected.value) ? selected.value.length : 0));

function onConfirm() {
  const arr = Array.isArray(selected.value) ? selected.value : [];
  if (arr.length === 0) {
    error.value = "请至少勾选一个目录";
    return;
  }
  error.value = "";
  const relative = arr
    .map((p) => toRelative(p, props.workspaceRoot))
    .filter((p) => p && p !== ".");
  emit("confirm", relative);
  emit("update:visible", false);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="props.visible" class="of-overlay" @click.self="close">
      <div class="of-dialog" @click.stop>
        <div class="of-header">选择排除目录 <span class="fp-sub">（可多选 · 限工作空间内）</span></div>
        <DirTreePicker v-model="selected" mode="directory" multiple :root="workspaceRoot" />
        <div class="fp-target"><b>已选：</b>{{ selectedCount }} 个目录</div>
        <div v-if="error" class="of-error">{{ error }}</div>
        <div class="of-actions">
          <button class="of-btn cancel" @click="close">取消</button>
          <button class="of-btn confirm" @click="onConfirm">确认</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 弹窗外壳（复用 OpenFolderDialog 的 of-* 视觉，独立 scoped） */
.of-overlay {
  position: fixed; inset: 0; background: var(--aide-bg-overlay);
  display: flex; align-items: center; justify-content: center; z-index: 1100;
  padding: 24px; overflow-y: auto; animation: fadeIn 0.12s ease;
}
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.of-dialog {
  background: var(--aide-bg-raised); border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg); padding: 18px 20px;
  min-width: 460px; max-width: 600px; box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  max-height: 90vh; display: flex; flex-direction: column;
  animation: scaleIn var(--aide-ease-t);
}
@keyframes scaleIn { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
.of-header { flex-shrink: 0; font-size: 14px; font-weight: 600; color: var(--aide-text-primary); margin-bottom: 12px; user-select: none; }
.fp-sub { font-size: 11px; color: var(--aide-text-muted); font-weight: 400; }
.fp-target { flex-shrink: 0; font-size: 11px; color: var(--aide-text-muted); margin-top: 8px; }
.fp-target b { color: var(--aide-text-secondary); }
.of-error { flex-shrink: 0; font-size: 12px; color: var(--aide-danger); margin-top: 8px; }
.of-actions { flex-shrink: 0; display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.of-btn { padding: 7px 16px; border-radius: var(--aide-radius-md); font-size: 13px; cursor: pointer; font-family: inherit; border: 1px solid var(--aide-border); transition: all var(--aide-ease-t); }
.of-btn.cancel { background: transparent; color: var(--aide-text-secondary); }
.of-btn.cancel:hover { background: var(--aide-surface-hover); color: var(--aide-text-primary); }
.of-btn.confirm { background: var(--aide-accent-gradient); border-color: transparent; color: var(--aide-text-on-accent); box-shadow: var(--aide-accent-glow); }
.of-btn.confirm:hover { filter: brightness(1.07); }
</style>