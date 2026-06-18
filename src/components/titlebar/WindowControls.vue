<script setup lang="ts">
import { onMounted } from "vue";
import { useWindowControls } from "../../composables/useWindowControls";

const { isMaximized, init, minimize, toggleMaximize, close } = useWindowControls();

onMounted(() => {
  init();
});
</script>

<template>
  <div class="window-controls" @mousedown.stop>
    <button class="win-btn win-btn-min" title="最小化" @click="minimize">
      <svg width="12" height="12" viewBox="0 0 12 12">
        <rect x="1" y="5.5" width="10" height="1" fill="currentColor" />
      </svg>
    </button>
    <button class="win-btn win-btn-max" title="最大化" @click="toggleMaximize">
      <svg v-if="!isMaximized" width="12" height="12" viewBox="0 0 12 12">
        <rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
      </svg>
      <svg v-else width="12" height="12" viewBox="0 0 12 12">
        <rect x="3" y="0.5" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
        <rect x="0.5" y="3.5" width="8" height="8" rx="1" fill="var(--bg-secondary)" stroke="currentColor" stroke-width="1.2" />
      </svg>
    </button>
    <button class="win-btn win-btn-close" title="关闭" @click="close">
      <svg width="12" height="12" viewBox="0 0 12 12">
        <line x1="1" y1="1" x2="11" y2="11" stroke="currentColor" stroke-width="1.3" />
        <line x1="11" y1="1" x2="1" y2="11" stroke="currentColor" stroke-width="1.3" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.window-controls {
  display: flex;
  flex-shrink: 0;
  height: 100%;
}

.win-btn {
  width: 42px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.12s;
  font-family: inherit;
}

.win-btn:hover {
  color: var(--text-primary);
  background: var(--surface-hover);
}

.win-btn-close:hover {
  color: #fff;
  background: var(--accent-red);
}
</style>
