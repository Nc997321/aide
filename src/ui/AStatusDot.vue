<script setup lang="ts">
defineProps<{
  status: "stopped" | "running" | "waiting" | "attention";
}>();
</script>

<template>
  <span class="a-status-dot" :class="`a-status-dot--${status}`" />
</template>

<style scoped>
.a-status-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.a-status-dot--stopped {
  background: var(--aide-text-muted);
}

.a-status-dot--running {
  background: var(--aide-success);
  box-shadow: 0 0 6px color-mix(in srgb, var(--aide-success) 50%, transparent);
  animation: a-dot-pulse 2s ease-in-out infinite;
}

.a-status-dot--waiting {
  background: var(--aide-accent);
}

.a-status-dot--attention {
  background: var(--aide-warning);
  box-shadow: 0 0 6px color-mix(in srgb, var(--aide-warning) 50%, transparent);
  animation: a-dot-pulse 2s ease-in-out infinite;
}

@keyframes a-dot-pulse {
  0%, 100% { opacity: 0.7; }
  50% { opacity: 1; }
}
</style>
