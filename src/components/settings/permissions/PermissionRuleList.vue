<script setup lang="ts">
import { computed } from "vue";
import type { PermissionRule, ScopeAvailability } from "@/types/permissions";
import PermissionRuleCard from "./PermissionRuleCard.vue";

const props = defineProps<{
  rules: PermissionRule[];
  scope: ScopeAvailability;
}>();
const emit = defineEmits<{
  (e: "edit", rule: PermissionRule): void;
  (e: "delete", rule: PermissionRule): void;
}>();

// Managed scope (or any non-editable scope) shows no mutation controls.
const readOnly = computed(() => !props.scope.editable);
</script>

<template>
  <div class="rule-list">
    <PermissionRuleCard
      v-for="rule in rules"
      :key="rule.id"
      :rule="rule"
      :read-only="readOnly"
      @edit="(r) => emit('edit', r)"
      @delete="(r) => emit('delete', r)"
    />
    <p v-if="rules.length === 0" class="empty-hint">
      {{ readOnly ? "受管策略未配置规则。" : "该作用域下暂无规则，点击「添加规则」创建。" }}
    </p>
  </div>
</template>

<style scoped>
.rule-list {
  display: grid;
  gap: 8px;
}
.empty-hint {
  margin: 0;
  padding: 16px;
  text-align: center;
  color: var(--aide-text-muted);
  font-size: 12px;
  border: 1px dashed var(--aide-border);
  border-radius: var(--aide-radius-md);
}
</style>