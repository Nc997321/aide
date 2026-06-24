<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: "primary" | "ghost" | "danger";
    size?: "sm" | "md";
    disabled?: boolean;
  }>(),
  { variant: "ghost", size: "md", disabled: false },
);
</script>

<template>
  <button
    class="a-btn"
    :class="[`a-btn--${variant}`, `a-btn--${size}`, { 'a-btn--disabled': disabled }]"
    :disabled="disabled"
  >
    <slot />
  </button>
</template>

<style scoped>
.a-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 1px solid transparent;
  border-radius: var(--aide-radius-sm);
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.a-btn--md {
  padding: 4px 12px;
  font-size: 12px;
}
.a-btn--sm {
  padding: 2px 8px;
  font-size: 11px;
}

/* Ghost */
.a-btn--ghost {
  background: var(--aide-surface-default);
  border-color: var(--aide-border);
  color: var(--aide-text-secondary);
}
.a-btn--ghost:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}

/* Primary */
.a-btn--primary {
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
  box-shadow: var(--aide-shadow-sm);
}
.a-btn--primary:hover {
  background: var(--aide-accent-hover);
}

/* Danger */
.a-btn--danger {
  background: transparent;
  border-color: color-mix(in srgb, var(--aide-danger) 30%, transparent);
  color: var(--aide-danger);
}
.a-btn--danger:hover {
  background: color-mix(in srgb, var(--aide-danger) 10%, transparent);
}

/* Disabled */
.a-btn--disabled {
  opacity: 0.5;
  pointer-events: none;
}
</style>
