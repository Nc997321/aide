<script setup lang="ts">
import type { MediaRef, MediaSelection, MediaSource } from "@/types/chat";

const props = defineProps<{ mediaRef: MediaRef }>();
const emit = defineEmits<{
  open: [request: { source: MediaSource; selection: MediaSelection; expectedRevision: string }];
}>();

function timeLabel(ms: number): string {
  const wholeSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const seconds = wholeSeconds % 60;
  const millis = ms % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function openMedia() {
  emit("open", {
    source: props.mediaRef.source,
    selection: props.mediaRef.selection,
    expectedRevision: props.mediaRef.source.revision,
  });
}
</script>

<template>
  <button type="button" class="media-ref-card" :title="mediaRef.source.path" @click="openMedia">
    <span class="media-ref-icon" aria-hidden="true">▶</span>
    <span class="media-ref-copy">
      <strong>{{ mediaRef.source.title || mediaRef.source.path }}</strong>
      <span v-if="mediaRef.frameIndex !== undefined" class="media-ref-time">附图 {{ mediaRef.frameIndex + 1 }}</span>
      <span class="media-ref-time">
        <template v-if="mediaRef.selection.kind === 'point'">{{ timeLabel(mediaRef.selection.atMs) }}</template>
        <template v-else>{{ timeLabel(mediaRef.selection.startMs) }} – {{ timeLabel(mediaRef.selection.endMs) }}</template>
      </span>
    </span>
  </button>
</template>

<style scoped>
.media-ref-card {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  max-width: min(420px, 100%);
  padding: 8px 11px;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  background: var(--aide-bg-deep);
  color: var(--aide-text-primary);
  text-align: left;
  cursor: pointer;
}
.media-ref-card:hover { border-color: var(--aide-focus-border); }
.media-ref-card:focus-visible { outline: 2px solid var(--aide-focus-border); outline-offset: 2px; }
.media-ref-icon {
  display: grid;
  place-items: center;
  width: 27px;
  height: 27px;
  flex: 0 0 auto;
  border-radius: 8px;
  background: var(--aide-accent-subtle);
  color: var(--aide-accent);
  font-size: 11px;
}
.media-ref-copy { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
.media-ref-copy strong { overflow-wrap: anywhere; white-space: normal; font-size: 12px; font-weight: 600; }
.media-ref-time { color: var(--aide-text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
</style>
