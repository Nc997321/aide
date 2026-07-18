<script setup lang="ts">
withDefaults(
  defineProps<{
    value: number | string;
    color?: "accent" | "success" | "warning" | "danger";
  }>(),
  { color: "accent" },
);
</script>

<template>
  <span class="a-badge" :class="`a-badge--${color}`">{{ value }}</span>
</template>

<style scoped>
.a-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 16px;
  padding: 2.5px 9px;
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.5;
  border-radius: var(--aide-radius-sm);
  letter-spacing: 0.02em;
  text-align: center;
}

.a-badge--accent {
  background: var(--aide-accent-subtle);
  color: var(--aide-accent);
  border: 1px solid color-mix(in srgb, var(--aide-accent) 28%, transparent);
}

.a-badge--success {
  background: color-mix(in srgb, var(--aide-success) 13%, transparent);
  color: var(--aide-success);
  border: 1px solid color-mix(in srgb, var(--aide-success) 28%, transparent);
}

.a-badge--warning {
  background: color-mix(in srgb, var(--aide-warning) 13%, transparent);
  color: var(--aide-warning);
  border: 1px solid color-mix(in srgb, var(--aide-warning) 28%, transparent);
}

.a-badge--danger {
  background: color-mix(in srgb, var(--aide-danger) 13%, transparent);
  color: var(--aide-danger);
  border: 1px solid color-mix(in srgb, var(--aide-danger) 28%, transparent);
}
</style>
