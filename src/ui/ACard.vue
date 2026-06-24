<script setup lang="ts">
withDefaults(
  defineProps<{
    active?: boolean;
    hoverable?: boolean;
    glowColor?: string;
  }>(),
  { active: false, hoverable: true },
);
</script>

<template>
  <div
    class="a-card"
    :class="{ 'a-card--active': active, 'a-card--hoverable': hoverable }"
    :style="glowColor ? { '--glow-color': glowColor } as any : undefined"
  >
    <div v-if="glowColor" class="a-card__glow" />
    <slot />
  </div>
</template>

<style scoped>
.a-card {
  position: relative;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  padding: 10px 12px;
  overflow: hidden;
  transition: all 0.15s ease;
}

.a-card--hoverable:hover {
  background: var(--aide-surface-default);
  border-color: rgba(255, 255, 255, 0.1);
  box-shadow: var(--aide-shadow-sm);
}

.a-card--active {
  border-color: color-mix(in srgb, var(--aide-accent) 35%, transparent);
  background:
    linear-gradient(135deg, var(--aide-accent-subtle) 0%, transparent 60%),
    var(--aide-bg-raised);
  box-shadow: var(--aide-shadow-sm);
}

.a-card__glow {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: linear-gradient(180deg, transparent, var(--glow-color, var(--aide-success)), transparent);
  animation: a-card-glow-pulse 2s ease-in-out infinite;
}

@keyframes a-card-glow-pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}
</style>
