<script setup lang="ts">
import { ref, watch } from "vue";
import type { WorkspaceInfo } from "../types";

const props = defineProps<{ visible: boolean; workspace: WorkspaceInfo | null }>();
const emit = defineEmits<{
  "update:visible": [v: boolean];
  confirm: [mode: "hide" | "delete"];
}>();

const mode = ref<"hide" | "delete">("hide"); // 安全默认

watch(() => props.visible, (v) => { if (v) mode.value = "hide"; });

function close() { emit("update:visible", false); }
function onConfirm() { emit("confirm", mode.value); }

const wsName = () => {
  const w = props.workspace;
  if (!w) return "";
  // name 存原始 path，取末段展示
  return w.name.split(/[\\/]/).filter(Boolean).pop() || w.name;
};
</script>

<template>
  <Teleport to="body">
    <div v-if="props.visible && props.workspace" class="rw-overlay" @click.self="close">
      <div class="rw-dialog" @click.stop>
        <div class="rw-header">移除工作区「{{ wsName() }}」</div>

        <label class="rw-opt">
          <input type="radio" value="hide" v-model="mode" />
          <span>仅隐藏（保留会话记录，可恢复）</span>
        </label>
        <label class="rw-opt">
          <input type="radio" value="delete" v-model="mode" />
          <span>彻底删除（删除该工作区所有会话记录，不可恢复）</span>
        </label>

        <div v-if="mode === 'delete'" class="rw-warn">
          ⚠ 将删除 ~/.claude/projects/{{ props.workspace.key }}/ 及其全部会话 transcript
        </div>

        <div class="rw-actions">
          <button class="rw-btn cancel" @click="close">取消</button>
          <button
            class="rw-btn confirm"
            :class="{ danger: mode === 'delete' }"
            @click="onConfirm"
          >移除</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.rw-overlay {
  position: fixed; inset: 0; background: var(--aide-bg-overlay);
  display: flex; align-items: center; justify-content: center; z-index: 1100;
}
.rw-dialog {
  background: var(--aide-surface-default); border: 1px solid var(--aide-surface-hover);
  border-radius: var(--aide-radius-lg); padding: 18px 22px;
  min-width: 360px; max-width: 440px; box-shadow: var(--aide-shadow-lg);
}
.rw-header { font-size: 14px; font-weight: 600; color: var(--aide-text-primary); margin-bottom: 12px; }
.rw-opt { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 13px; color: var(--aide-text-secondary); cursor: pointer; }
.rw-warn { margin-top: 10px; font-size: 12px; color: var(--aide-danger); }
.rw-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.rw-btn { padding: 7px 16px; border-radius: var(--aide-radius-md); font-size: 13px; cursor: pointer; font-family: inherit; border: 1px solid var(--aide-surface-hover); }
.rw-btn.cancel { background: transparent; color: var(--aide-text-secondary); }
.rw-btn.cancel:hover { background: var(--aide-surface-hover); }
.rw-btn.confirm { background: var(--aide-accent); border-color: var(--aide-accent); color: var(--aide-text-on-accent); }
.rw-btn.confirm.danger { background: var(--aide-danger); border-color: var(--aide-danger); }
.rw-btn.confirm:hover { filter: brightness(1.1); }
</style>
