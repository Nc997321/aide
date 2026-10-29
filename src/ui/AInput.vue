<script setup lang="ts" generic="T extends string | number = string">
import { ref } from "vue";

const props = withDefaults(defineProps<{
  modelValue?: T;
  modelModifiers?: { trim?: boolean; number?: boolean; lazy?: boolean };
  type?: string;
  autocomplete?: string;
  /** 保留调用页面的布局与外观；输入行为始终由本组件统一管理。 */
  unstyled?: boolean;
}>(), { type: "text", autocomplete: "off" });
const emit = defineEmits<{ "update:modelValue": [value: T] }>();
const element = ref<HTMLInputElement | null>(null);
let composing = false;

function update(event: Event): void {
  const input = event.target as HTMLInputElement;
  let value: string | number = props.modelModifiers?.trim ? input.value.trim() : input.value;
  if (props.modelModifiers?.number || props.type === "number") {
    const number = Number.parseFloat(String(value));
    if (!Number.isNaN(number)) value = number;
  }
  emit("update:modelValue", value as T);
}
function onInput(event: Event): void {
  if (!composing && !props.modelModifiers?.lazy) update(event);
}
function onChange(event: Event): void {
  if (props.modelModifiers?.lazy) update(event);
  if (props.modelModifiers?.trim && element.value) element.value.value = element.value.value.trim();
}
function onCompositionEnd(event: CompositionEvent): void {
  if (!composing) return;
  composing = false;
  // 与 Vue 原生 v-model 一致：组合输入完成后再派发 input，让调用方也读到完整文字。
  (event.target as HTMLInputElement).dispatchEvent(new Event("input", { bubbles: true }));
}

defineExpose({
  element,
  focus: (options?: FocusOptions) => element.value?.focus(options),
  blur: () => element.value?.blur(),
  select: () => element.value?.select(),
});
</script>

<template>
  <input
    ref="element"
    :class="unstyled ? undefined : 'a-input__field'"
    :type="type"
    :autocomplete="autocomplete"
    :value="modelValue === undefined ? $attrs.value : modelValue"
    @input="onInput"
    @change="onChange"
    @compositionstart="composing = true"
    @compositionend="onCompositionEnd"
  />
</template>

<style scoped>
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

.a-input__field.error {
  border-color: color-mix(in srgb, var(--aide-danger) 55%, transparent);
}

</style>
