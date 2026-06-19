<script setup lang="ts">
import { ref } from "vue";
import SearchBox from "./SearchBox.vue";
import WindowControls from "./WindowControls.vue";

const searchBoxRef = ref<InstanceType<typeof SearchBox> | null>(null);

defineExpose({ searchBox: searchBoxRef });
</script>

<template>
  <div class="titlebar" data-tauri-drag-region>
    <div class="titlebar-logo" data-tauri-drag-region>
      <img class="titlebar-logo-icon" src="/icon.png" alt="Aide" />
      <span class="titlebar-logo-text">Aide</span>
    </div>

    <SearchBox ref="searchBoxRef" />

    <WindowControls />
  </div>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  height: 38px;
  flex-shrink: 0;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--surface);
  user-select: none;
}

.titlebar-logo {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 14px;
  height: 100%;
  flex-shrink: 0;
}

.titlebar-logo-icon {
  width: 16px;
  height: 16px;
  object-fit: contain;
  image-rendering: auto;
}

.titlebar-logo-text {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  letter-spacing: 0.3px;
}
</style>
