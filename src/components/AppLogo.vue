<script setup lang="ts">
import iconUrl from "/icon.png";

withDefaults(
  defineProps<{
    size?: number;
    animated?: boolean;
    fast?: boolean;
  }>(),
  { size: 18, animated: false, fast: false },
);
</script>

<template>
  <img
    :src="iconUrl"
    :width="size"
    :height="size"
    class="app-logo"
    :class="{ 'app-logo--pulse': animated }"
    alt="Aide"
    aria-hidden="true"
  />
</template>

<style>
.app-logo {
  display: inline-block;
  flex-shrink: 0;
  border-radius: 3px;
}
.app-logo--pulse {
  animation: app-logo-pulse 2s ease-in-out infinite;
}
@keyframes app-logo-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
</style>
