<script setup lang="ts">
import WindowControls from "./WindowControls.vue";

defineEmits<{
  "open-palette": [];
}>();
</script>

<template>
  <div class="titlebar" data-tauri-drag-region>
    <div class="titlebar-logo" data-tauri-drag-region>
      <img class="titlebar-logo-icon" src="/icon.png" alt="Aide" />
      <span class="titlebar-logo-text">Aide</span>
    </div>

    <button class="titlebar-search-trigger" @click="$emit('open-palette')">
      <span class="titlebar-search-icon">&#x1F50D;</span>
      <span class="titlebar-search-text">搜索会话、文件或命令...</span>
      <kbd class="titlebar-search-kbd">Ctrl+P</kbd>
    </button>

    <WindowControls />
  </div>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  height: 42px;
  flex-shrink: 0;
  background: var(--aide-bg-deep);
  border-bottom: 1px solid var(--aide-border);
  padding: 0 16px;
  gap: 16px;
  user-select: none;
}

.titlebar-logo {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.titlebar-logo-icon {
  width: 18px;
  height: 18px;
  object-fit: contain;
}

.titlebar-logo-text {
  font-size: 12px;
  font-weight: 600;
  color: var(--aide-text-secondary);
  letter-spacing: 0.5px;
}

.titlebar-search-trigger {
  flex: 1;
  max-width: 400px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  padding: 6px 14px;
  color: var(--aide-text-muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
}

.titlebar-search-trigger:hover {
  background: var(--aide-surface-hover);
  border-color: var(--aide-border-subtle);
}

.titlebar-search-icon {
  font-size: 11px;
  flex-shrink: 0;
}

.titlebar-search-text {
  flex: 1;
  text-align: left;
}

.titlebar-search-kbd {
  margin-left: auto;
  background: var(--aide-bg-deep);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  color: var(--aide-text-muted);
  border: 1px solid var(--aide-border);
  font-family: inherit;
}
</style>
