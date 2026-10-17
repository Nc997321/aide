<script setup lang="ts">
/**
 * 模型 · 档位合一的选择器（单行输入框，2026-10-16）：一个 chip「Opus 5.5 · 进阶 ▾」，
 * 点开一个弹层，上半模型列表、下半三档思考深度。
 *
 * 只是外观合一：选模型与选档位仍各走各的处理函数（ChatInputBox 的 handleModelChange /
 * handleEffortChange），本组件不持有选择状态。btw 期间整体禁用（支线跟随主会话）。
 */
import { computed, ref } from "vue";
import ComposerPopover from "./ComposerPopover.vue";

interface Option {
  value: string;
  label: string;
}

const props = defineProps<{
  models: Option[];
  model: string;
  efforts: readonly Option[];
  effort: string;
  disabled?: boolean;
  title?: string;
}>();

const emit = defineEmits<{
  "update:model": [value: string];
  "update:effort": [value: string];
}>();

const open = ref(false);
const triggerRef = ref<HTMLElement | null>(null);

const modelLabel = computed(() => props.models.find((m) => m.value === props.model)?.label ?? props.model);
const effortLabel = computed(() => props.efforts.find((e) => e.value === props.effort)?.label ?? "");

function toggle() {
  if (props.disabled) return;
  open.value = !open.value;
}

function pickModel(v: string) {
  emit("update:model", v);
  open.value = false;
}

function pickEffort(v: string) {
  emit("update:effort", v);
  open.value = false;
}
</script>

<template>
  <button
    ref="triggerRef"
    type="button"
    class="mep"
    :class="{ 'mep--open': open, 'mep--disabled': disabled }"
    :disabled="disabled"
    v-tooltip="title ?? '模型与思考深度'"
    @click="toggle"
  >
    <span v-if="models.length" class="mep-model">{{ modelLabel }}</span>
    <span v-if="models.length && effortLabel" class="mep-sep">·</span>
    <span v-if="effortLabel" class="mep-effort">{{ effortLabel }}</span>
    <svg class="mep-chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 6.5L5 3.5L8 6.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>
  <ComposerPopover :open="open" :anchor="triggerRef" :min-width="220" @close="open = false">
    <div v-if="models.length" class="mep-sec">模型</div>
    <div role="listbox" aria-label="模型">
      <button
        v-for="m in models"
        :key="m.value"
        type="button"
        role="option"
        class="mep-opt"
        :class="{ 'mep-opt--on': m.value === model }"
        :aria-selected="m.value === model"
        @click="pickModel(m.value)"
      >
        <span class="mep-opt-label">{{ m.label }}</span>
        <svg v-if="m.value === model" class="mep-check" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 6.5L4.8 8.8L9.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
    <div class="mep-sec">思考深度</div>
    <div class="mep-seg" role="radiogroup" aria-label="思考深度">
      <button
        v-for="e in efforts"
        :key="e.value"
        type="button"
        role="radio"
        class="mep-seg-btn"
        :class="{ 'mep-seg-btn--on': e.value === effort }"
        :aria-checked="e.value === effort"
        @click="pickEffort(e.value)"
      >{{ e.label }}</button>
    </div>
    <div class="mep-hint">快速 = 关闭思考；切换从下一轮起生效，不影响缓存</div>
  </ComposerPopover>
</template>

<style scoped>
.mep {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  max-width: 220px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: var(--aide-radius-sm);
  background: transparent;
  color: var(--aide-text-secondary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--aide-ease-t);
}
/* 静止时是纯文字，悬停 / 展开才浮出底色（同 ThemedSelect.compact） */
.mep:hover:not(.mep--disabled),
.mep--open {
  background: var(--aide-surface-hover);
}
.mep--disabled {
  opacity: 0.45;
  cursor: default;
}

.mep-model {
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--aide-text-primary);
}
.mep-sep {
  color: var(--aide-text-muted);
}
.mep-chev {
  flex-shrink: 0;
  color: var(--aide-text-muted);
}

.mep-sec {
  padding: 6px 10px 4px;
  font-size: 11px;
  color: var(--aide-text-muted);
}

.mep-opt {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: var(--aide-radius-sm);
  background: none;
  color: var(--aide-text-secondary);
  font-family: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.mep-opt:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
.mep-opt--on {
  background: var(--aide-accent-subtle);
  color: var(--aide-text-primary);
}
.mep-opt-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mep-check {
  flex-shrink: 0;
  color: var(--aide-accent);
}

.mep-seg {
  display: flex;
  gap: 4px;
  padding: 0 6px 4px;
}
.mep-seg-btn {
  flex: 1;
  height: 28px;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  background: none;
  color: var(--aide-text-secondary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}
.mep-seg-btn:hover {
  background: var(--aide-surface-hover);
}
.mep-seg-btn--on {
  border-color: color-mix(in srgb, var(--aide-accent) 45%, transparent);
  background: var(--aide-accent-subtle);
  color: var(--aide-text-primary);
}

.mep-hint {
  padding: 4px 10px 6px;
  font-size: 11px;
  color: var(--aide-text-muted);
}
</style>
