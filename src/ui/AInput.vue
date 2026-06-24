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
  background: var(--aide-surface-default);
  border: 1px solid transparent;
  border-radius: var(--aide-radius-md);
  padding: 6px 10px;
  transition: all 0.15s ease;
}

.a-input:focus-within {
  border-color: var(--aide-accent);
  box-shadow: 0 0 0 2px var(--aide-accent-subtle);
}

.a-input__icon {
  font-size: 13px;
  color: var(--aide-text-muted);
  flex-shrink: 0;
}

.a-input__field {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  color: var(--aide-text-primary);
  font-size: 12px;
  font-family: inherit;
}

.a-input__field::placeholder {
  color: var(--aide-text-muted);
}
</style>
