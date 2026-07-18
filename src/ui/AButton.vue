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
  gap: 7px;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: var(--aide-highlight-inset), var(--aide-shadow-sm);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  transition: all var(--aide-ease-t);
  white-space: nowrap;
}

.a-btn:hover {
  background: var(--aide-surface-hover);
  border-color: var(--aide-border-strong);
  transform: translateY(-1px);
}

.a-btn:active {
  transform: translateY(0);
  background: var(--aide-surface-active);
}

.a-btn--md {
  padding: 7px 15px;
}
.a-btn--sm {
  padding: 4px 11px;
  font-size: 11.5px;
  border-radius: var(--aide-radius-sm);
}

/* Ghost (default) */
.a-btn--ghost {
  /* base styles already match the surface button */
}

/* Primary */
.a-btn--primary {
  background: var(--aide-accent-gradient);
  border-color: rgba(255, 255, 255, 0.22);
  color: var(--aide-text-on-accent);
  font-weight: 600;
  box-shadow: var(--aide-accent-glow), inset 0 1px 0 rgba(255, 255, 255, 0.32);
}
.a-btn--primary:hover {
  filter: brightness(1.07);
}

/* Danger */
.a-btn--danger {
  background: transparent;
  border-color: color-mix(in srgb, var(--aide-danger) 35%, transparent);
  color: var(--aide-danger);
  box-shadow: none;
}
.a-btn--danger:hover {
  background: color-mix(in srgb, var(--aide-danger) 12%, transparent);
}

/* Disabled */
.a-btn--disabled {
  opacity: 0.45;
  cursor: not-allowed;
  transform: none !important;
}
</style>
