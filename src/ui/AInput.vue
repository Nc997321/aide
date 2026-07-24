<script setup lang="ts">
defineProps<{
  modelValue: string;
  placeholder?: string;
  icon?: string;
}>();

defineEmits<{
  "update:modelValue": [value: string];
}>();
</script>

<template>
  <div class="a-input">
    <span v-if="icon" class="a-input__icon">{{ icon }}</span>
    <input
      class="a-input__field"
      :value="modelValue"
      :placeholder="placeholder"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
  </div>
</template>

<style scoped>
.a-input {
  display: flex;
  align-items: center;
  gap: 8px;
  position: relative;
  width: 100%;
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
}

.a-input__icon {
  position: absolute;
  left: 11px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 13px;
  color: var(--aide-text-muted);
  pointer-events: none;
  flex-shrink: 0;
}

.a-input__field {
  flex: 1;
  width: 100%;
  padding: 8px 12px;
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  outline: none;
  color: var(--aide-text-primary);
  font-size: 12.5px;
  font-family: inherit;
  box-shadow: var(--aide-shadow-inset);
  transition: all var(--aide-ease-t);
}

.a-input__field::placeholder {
  color: var(--aide-text-muted);
}

.a-input__field:focus {
  border-color: var(--aide-accent);
  box-shadow: var(--aide-accent-ring), var(--aide-shadow-inset);
}

.a-input.error .a-input__field {
  border-color: color-mix(in srgb, var(--aide-danger) 55%, transparent);
}

.a-input__icon + .a-input__field {
  padding-left: 32px;
}
</style>
