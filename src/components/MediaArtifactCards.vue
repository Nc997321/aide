<script setup lang="ts">
import { ref } from "vue";
import type { MediaArtifact } from "@aide/sdk/utils/mediaArtifacts";
import { useMediaPreview } from "@/composables/useMediaPreview";

const props = defineProps<{
  files: MediaArtifact[];
  draftKey: string;
}>();

const { open } = useMediaPreview();
const errorMessage = ref("");

async function openFile(index: number): Promise<void> {
  errorMessage.value = "";
  try {
    await open({ files: props.files, selected: index, draftKey: props.draftKey });
  } catch (error) {
    errorMessage.value = `无法打开媒体预览：${String(error)}`;
  }
}
</script>

<template>
  <div class="media-artifacts" aria-label="回答中的媒体文件">
    <button
      v-for="(file, index) in files"
      :key="file.path"
      type="button"
      class="media-artifact"
      :title="file.path"
      @click="openFile(index)"
    >
      <span class="media-artifact-kind" aria-hidden="true">媒体</span>
      <span class="media-artifact-title">{{ file.title }}</span>
      <span class="media-artifact-open">打开 ›</span>
    </button>
    <div v-if="errorMessage" class="media-artifact-error" role="status">{{ errorMessage }}</div>
  </div>
</template>

<style scoped>
.media-artifacts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
  margin-top: 2px;
}

.media-artifact {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  padding: 5px 8px;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  background: var(--aide-bg-raised);
  color: var(--aide-text-primary);
  text-align: left;
  font: inherit;
  cursor: pointer;
}

.media-artifact:hover {
  border-color: var(--aide-accent);
  background: var(--aide-surface-hover);
}

.media-artifact:focus-visible {
  outline: 2px solid var(--aide-accent);
  outline-offset: 2px;
}

.media-artifact-kind,
.media-artifact-open {
  flex: none;
  color: var(--aide-text-muted);
  font-size: 11px;
}

.media-artifact-title {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 12px;
}

.media-artifact-error {
  flex-basis: 100%;
  color: var(--aide-danger);
  font-size: 11px;
}
</style>
