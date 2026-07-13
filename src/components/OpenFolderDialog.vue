<script setup lang="ts">
import { ref } from "vue";
import DirTreePicker from "./DirTreePicker.vue";

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{
  "update:visible": [v: boolean];
  confirm: [path: string];
}>();

const path = ref("");
const error = defineModel<string>("error", { default: "" });

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
    <div v-if="props.visible" class="of-overlay" @click.self="close">
      <div class="of-dialog" @click.stop>
        <div class="of-header">打开目录</div>
        <DirTreePicker v-model="path" />
        <div v-if="error" class="of-error">{{ error }}</div>
        <div class="of-actions">
          <button class="of-btn cancel" @click="close">取消</button>
          <button class="of-btn confirm" @click="onConfirm">打开并切换</button>
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
  background: var(--aide-surface-default); border: 1px solid var(--aide-surface-hover);
  border-radius: var(--aide-radius-lg); padding: 18px 20px;
  min-width: 420px; max-width: 560px; box-shadow: var(--aide-shadow-lg);
  /* 弹框上限视口高度，内容用 flex 列布局，树在内部滚动，确认按钮始终可见 */
  max-height: 90vh; display: flex; flex-direction: column;
  animation: scaleIn 0.15s ease;
}
@keyframes scaleIn { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
.of-header { flex-shrink: 0; font-size: 14px; font-weight: 600; color: var(--aide-text-primary); margin-bottom: 12px; user-select: none; }
.of-error { flex-shrink: 0; font-size: 12px; color: var(--aide-danger); margin-top: 8px; }
.of-actions { flex-shrink: 0; display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.of-btn { padding: 7px 16px; border-radius: var(--aide-radius-md); font-size: 13px; cursor: pointer; font-family: inherit; border: 1px solid var(--aide-surface-hover); }
.of-btn.cancel { background: transparent; color: var(--aide-text-secondary); }
.of-btn.cancel:hover { background: var(--aide-surface-hover); }
.of-btn.confirm { background: var(--aide-accent); border-color: var(--aide-accent); color: var(--aide-text-on-accent); }
.of-btn.confirm:hover { filter: brightness(1.1); }
</style>
