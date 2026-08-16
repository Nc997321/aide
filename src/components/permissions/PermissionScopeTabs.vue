<script setup lang="ts">
import { computed } from "vue";
import type { PermissionScope, ScopeAvailability } from "@/types/permissions";

const props = defineProps<{
  scopes: readonly ScopeAvailability[];
  modelValue: PermissionScope;
}>();
const emit = defineEmits<{ (e: "update:modelValue", value: PermissionScope): void }>();

// Fixed display order — must not follow object enumeration. `session` is
// in-memory only and never shown as a tab, but the LABELS record covers every
// scope so the type is exhaustive.
const ORDER: PermissionScope[] = ["user", "project", "local", "managed"];
const LABELS: Record<PermissionScope, string> = {
  user: "用户全局",
  project: "项目共享",
  local: "项目本地",
  managed: "受管策略",
  session: "本会话",
};

const byScope = computed(() => {
  const m = new Map<PermissionScope, ScopeAvailability>();
  for (const s of props.scopes) m.set(s.scope, s);
  return m;
});

const ordered = computed(() =>
  ORDER.map((scope) => byScope.value.get(scope)).filter((s): s is ScopeAvailability => !!s),
);
</script>

<template>
  <div class="scope-tabs" role="tablist">
    <button
      v-for="s in ordered"
      :key="s.scope"
      class="scope-tab"
      :class="{ active: s.scope === modelValue }"
      :data-scope="s.scope"
      :disabled="!s.editable"
      role="tab"
      v-tooltip="s.editable ? '' : s.reason"
      @click="s.editable && emit('update:modelValue', s.scope)"
    >
      {{ LABELS[s.scope] }}
    </button>
  </div>
</template>

<style scoped>
/* 4 个 scope tab 在 300px 面板宽度下一行必溢出，故 2×2 网格（窄版布局
   见 docs/superpowers/design-previews/2026-07-22-permission-settings.html） */
.scope-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--aide-border-subtle);
  background: var(--aide-bg-base);
  border-radius: var(--aide-radius-md);
}
.scope-tab {
  padding: 6px 4px;
  font-size: 11.5px;
  color: var(--aide-text-muted);
  border: 0;
  background: transparent;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  text-align: center;
  transition: background var(--aide-ease-t), color var(--aide-ease-t);
}
.scope-tab:hover:not(:disabled) {
  color: var(--aide-text-primary);
}
.scope-tab.active {
  background: var(--aide-surface-active);
  color: var(--aide-text-primary);
}
.scope-tab:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>