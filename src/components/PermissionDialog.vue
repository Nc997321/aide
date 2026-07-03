<script setup lang="ts">
import { computed } from "vue";
import type { PermissionRequest } from "@/types/chat";

const props = defineProps<{
  permission: PermissionRequest | null;
}>();

const emit = defineEmits<{
  respond: [id: string, approved: boolean, always?: boolean];
}>();

const inputSummary = computed(() => {
  if (!props.permission) return "";
  const input = props.permission.input as Record<string, unknown>;
  if (props.permission.name === "Bash") return `命令：${input?.command ?? ""}`;
  if (["Write", "Edit"].includes(props.permission.name)) return `文件：${input?.file_path ?? ""}`;
  if (props.permission.name === "WebFetch") return `URL：${input?.url ?? ""}`;
  return JSON.stringify(input, null, 2).slice(0, 200);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="permission" class="perm-overlay">
      <div class="perm-dialog">
        <h3 class="perm-title">
          允许工具调用：<span class="perm-tool-name">{{ permission.name }}</span>
        </h3>
        <pre class="perm-input">{{ inputSummary }}</pre>
        <div class="perm-actions">
          <button class="perm-btn perm-btn--deny" @click="emit('respond', permission.id, false)">
            拒绝
          </button>
          <button class="perm-btn perm-btn--always" @click="emit('respond', permission.id, true, true)">
            总是允许
          </button>
          <button class="perm-btn perm-btn--allow" @click="emit('respond', permission.id, true)">
            允许
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.perm-overlay {
  position: fixed;
  inset: 0;
  z-index: 9000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--aide-bg-overlay);
}

.perm-dialog {
  width: 480px;
  border-radius: var(--aide-radius-md);
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border);
  box-shadow: var(--aide-shadow-lg);
  padding: 20px;
}

.perm-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--aide-text-primary);
  margin-bottom: 8px;
}

.perm-tool-name {
  color: var(--aide-accent);
}

.perm-input {
  max-height: 128px;
  overflow: auto;
  border-radius: var(--aide-radius-sm);
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border);
  padding: 8px 12px;
  font-size: 12px;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  color: var(--aide-text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  margin-bottom: 16px;
}

.perm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.perm-btn {
  border-radius: var(--aide-radius-sm);
  border: none;
  padding: 6px 16px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}

.perm-btn--deny {
  background: var(--aide-surface-default);
  color: var(--aide-text-secondary);
}

.perm-btn--deny:hover {
  background: var(--aide-surface-hover);
}

.perm-btn--always {
  background: var(--aide-surface-default);
  color: var(--aide-text-secondary);
  border: 1px solid var(--aide-border);
}

.perm-btn--always:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}

.perm-btn--allow {
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
  font-weight: 500;
}

.perm-btn--allow:hover {
  background: var(--aide-accent-hover);
}
</style>
