<script setup lang="ts">
import { computed } from "vue";
import type { PermissionRequest } from "@/types/chat";
import { marked } from "@/utils/markdown";

const props = defineProps<{
  permission: PermissionRequest | null;
}>();

const emit = defineEmits<{
  respond: [id: string, approved: boolean, always?: boolean];
}>();

/** ExitPlanMode = plan 模式的出口确认：呈现的是"批准这份计划"而不是
 *  "允许一次工具调用"，计划正文按 Markdown 渲染，批准后 sidecar 自动切回默认模式。 */
const isPlanApproval = computed(() => props.permission?.name === "ExitPlanMode");

const planHtml = computed(() => {
  if (!isPlanApproval.value) return "";
  const input = props.permission?.input as Record<string, unknown> | undefined;
  return marked.parse(String(input?.plan ?? "")) as string;
});

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
      <div class="perm-dialog" :class="{ 'perm-dialog--plan': isPlanApproval }">
        <h3 class="perm-title">
          <template v-if="isPlanApproval">批准执行计划？</template>
          <template v-else>允许工具调用：<span class="perm-tool-name">{{ permission.name }}</span></template>
        </h3>
        <!-- plan 来自本会话模型输出，信任边界与 ChatMessage 的 v-html="marked.parse(...)" 完全一致 -->
        <div v-if="isPlanApproval" class="perm-plan" v-html="planHtml" />
        <pre v-else class="perm-input">{{ inputSummary }}</pre>
        <div class="perm-actions">
          <button class="perm-btn perm-btn--deny" @click="emit('respond', permission.id, false)">
            {{ isPlanApproval ? "继续修改计划" : "拒绝" }}
          </button>
          <button v-if="!isPlanApproval" class="perm-btn perm-btn--always" @click="emit('respond', permission.id, true, true)">
            总是允许
          </button>
          <button class="perm-btn perm-btn--allow" @click="emit('respond', permission.id, true)">
            {{ isPlanApproval ? "批准并开始执行" : "允许" }}
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

.perm-dialog--plan {
  width: 640px;
  max-width: calc(100vw - 48px);
}

.perm-plan {
  max-height: 50vh;
  overflow: auto;
  border-radius: var(--aide-radius-sm);
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border);
  padding: 10px 14px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--aide-text-secondary);
  margin-bottom: 16px;
}

.perm-plan :deep(h1),
.perm-plan :deep(h2),
.perm-plan :deep(h3) {
  font-size: 13px;
  font-weight: 600;
  color: var(--aide-text-primary);
  margin: 10px 0 4px;
}

.perm-plan :deep(p),
.perm-plan :deep(ul),
.perm-plan :deep(ol) {
  margin: 4px 0;
}

.perm-plan :deep(ul),
.perm-plan :deep(ol) {
  padding-left: 18px;
}

.perm-plan :deep(code) {
  font-family: 'Cascadia Code', 'Consolas', monospace;
  font-size: 12px;
  background: var(--aide-surface-default);
  border-radius: 3px;
  padding: 0 4px;
}

.perm-plan :deep(pre) {
  background: var(--aide-surface-default);
  border-radius: var(--aide-radius-sm);
  padding: 8px 10px;
  overflow-x: auto;
  margin: 6px 0;
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
