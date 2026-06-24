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
  min-width: 16px;
  padding: 0 5px;
  font-size: 10px;
  font-weight: 700;
  line-height: 1.5;
  border-radius: 8px;
  text-align: center;
}

.a-badge--accent {
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
}
.a-badge--success {
  background: var(--aide-success);
  color: var(--aide-text-on-accent);
}
.a-badge--warning {
  background: var(--aide-warning);
  color: var(--aide-text-on-accent);
}
.a-badge--danger {
  background: var(--aide-danger);
  color: var(--aide-text-on-accent);
}
</style>
