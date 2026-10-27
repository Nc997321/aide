<script setup lang="ts">
import { ref } from "vue";
import type { DocumentArtifact } from "@aide/sdk/utils/documentArtifacts";
import { resolveFileLinkPath } from "@aide/sdk/utils/fileLink";
import { useFileViewer } from "@/composables/useFileViewer";
import Icon from "./Icon.vue";

const props = defineProps<{ documents: DocumentArtifact[]; workspacePath?: string }>();
const viewer = useFileViewer();
const opening = ref<string | null>(null);
const error = ref("");

async function openDocument(document: DocumentArtifact) {
  if (opening.value) return;
  error.value = "";
  if (!props.workspacePath && !/^(?:[a-z]:[\\/]|[\\/])/i.test(document.path)) {
    error.value = "无法确定这条会话的工作区，请恢复工作区后再打开文档。";
    return;
  }
  opening.value = document.path;
  try {
    // 明确的交付路径不做同名模糊搜索，避免误开另一个文件。错误由现有弹窗显示。
    await viewer.open(resolveFileLinkPath(document.path, props.workspacePath), { refreshIfClean: true });
  } catch (e) {
    error.value = `打开文档失败：${String(e)}`;
  } finally {
    opening.value = null;
  }
}
</script>

<template>
  <div class="document-artifacts" aria-label="交付文档">
    <button
      v-for="document in documents"
      :key="document.path"
      type="button"
      class="document-artifact"
      :aria-label="`打开文档：${document.title}`"
      :aria-busy="opening === document.path"
      :disabled="opening !== null"
      @click="openDocument(document)"
    >
      <span class="document-artifact-icon" aria-hidden="true"><Icon name="instruction" :size="20" /></span>
      <span class="document-artifact-content">
        <span class="document-artifact-title">{{ document.title }}</span>
        <span class="document-artifact-path">{{ document.path }}</span>
        <span v-if="document.summary" class="document-artifact-summary">{{ document.summary }}</span>
        <span class="document-artifact-kind">{{ /\.txt$/i.test(document.path) ? "纯文本" : "Markdown" }} · {{ opening === document.path ? "正在打开…" : "打开文档" }}</span>
      </span>
      <span class="document-artifact-arrow" aria-hidden="true">↗</span>
    </button>
    <span v-if="error" class="document-artifact-error" role="alert">{{ error }}</span>
  </div>
</template>

<style scoped>
.document-artifacts { display: grid; gap: calc(var(--aide-space-unit) * 2); margin: calc(var(--aide-space-unit) * 3) 0; }
.document-artifact { display: flex; align-items: flex-start; gap: calc(var(--aide-space-unit) * 3); width: 100%; min-width: 0; padding: calc(var(--aide-space-unit) * 3); border: 1px solid var(--aide-border); border-radius: var(--aide-radius-md); background: var(--aide-bg-base); color: var(--aide-text-primary); text-align: left; font: inherit; cursor: pointer; transition: background var(--aide-ease-t), border-color var(--aide-ease-t); }
.document-artifact:hover { background: var(--aide-surface-hover); border-color: var(--aide-border-strong); }
.document-artifact:focus-visible { outline: 2px solid var(--aide-accent); outline-offset: 2px; }
.document-artifact:disabled { cursor: wait; }
.document-artifact-icon { flex-shrink: 0; padding: calc(var(--aide-space-unit) * 2); border-radius: var(--aide-radius-sm); background: var(--aide-surface-default); color: var(--aide-agent-accent); }
.document-artifact-content { display: grid; flex: 1; min-width: 0; gap: var(--aide-space-unit); overflow-wrap: anywhere; }
.document-artifact-title { font-size: 13px; font-weight: 600; }
.document-artifact-path { font: 11px/1.6 var(--aide-font-mono); color: var(--aide-text-muted); }
.document-artifact-summary { font-size: 12px; color: var(--aide-text-secondary); }
.document-artifact-kind { font-size: 11px; color: var(--aide-text-muted); }
.document-artifact-arrow { flex-shrink: 0; color: var(--aide-text-muted); }
.document-artifact-error { color: var(--aide-danger); font-size: 12px; overflow-wrap: anywhere; }
</style>
