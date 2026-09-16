<script setup lang="ts">
import { ref, watch } from "vue";
import DirTreePicker from "./DirTreePicker.vue";
import { vOverlayLayer } from "../directives/overlayLayer";

/**
 * 单文件选择弹窗（通用）：复用 DirTreePicker 的 mixed 模式（目录可展开、文件可选），单选。
 * 外壳视觉与 OpenFolderDialog 一致。带盘符入口 + 可编辑地址栏 → 能选到任意路径的文件。
 *
 * 现有使用方：LSP server 二进制选择（title 用默认值）、内嵌浏览器书签导入。
 */
const props = withDefaults(
  defineProps<{
    visible: boolean;
    /** 弹窗标题（不同使用方各自措辞）。 */
    title?: string;
    /** 未选文件时点确认的提示。 */
    emptyError?: string;
  }>(),
  { title: "选择 server 文件", emptyError: "请选择 server 文件" },
);
const emit = defineEmits<{
  "update:visible": [v: boolean];
  confirm: [path: string];
}>();

// DirTreePicker 的 model 类型是 string | string[]；单选下只产 string，用联合类型 ref 兼容。
const path = ref<string | string[]>("");
const error = ref("");

// 每次打开清空（重新选）
watch(() => props.visible, (v) => {
  if (v) {
    path.value = "";
    error.value = "";
  }
});

function close() {
  emit("update:visible", false);
}

function onConfirm() {
  const p = typeof path.value === "string" ? path.value.trim() : "";
  if (!p) {
    error.value = props.emptyError;
    return;
  }
  error.value = "";
  emit("confirm", p);
  emit("update:visible", false);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="props.visible" class="of-overlay" v-overlay-layer @click.self="close">
      <div class="of-dialog" @click.stop>
        <div class="of-header">{{ props.title }}</div>
        <DirTreePicker v-model="path" mode="mixed" />
        <div class="fp-target">
          <b>已选：</b>{{ typeof path === "string" ? path || "（未选择）" : "（未选择）" }}
        </div>
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
/* 弹窗外壳（复用 OpenFolderDialog 的 of-* 视觉，独立 scoped 避免跨组件样式耦合） */
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
.fp-target { flex-shrink: 0; font-size: 11px; color: var(--aide-text-muted); margin-top: 8px; word-break: break-all; }
.fp-target b { color: var(--aide-text-secondary); }
.of-error { flex-shrink: 0; font-size: 12px; color: var(--aide-danger); margin-top: 8px; }
.of-actions { flex-shrink: 0; display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.of-btn { padding: 7px 16px; border-radius: var(--aide-radius-md); font-size: 13px; cursor: pointer; font-family: inherit; border: 1px solid var(--aide-border); transition: all var(--aide-ease-t); }
.of-btn.cancel { background: transparent; color: var(--aide-text-secondary); }
.of-btn.cancel:hover { background: var(--aide-surface-hover); color: var(--aide-text-primary); }
.of-btn.confirm { background: var(--aide-accent-gradient); border-color: transparent; color: var(--aide-text-on-accent); box-shadow: var(--aide-accent-glow); }
.of-btn.confirm:hover { filter: brightness(1.07); }
</style>