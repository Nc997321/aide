<script setup lang="ts">
import { computed } from "vue";
import type { PermissionRule } from "@/types/permissions";

const props = defineProps<{
  rule: PermissionRule;
  /** Hide edit/delete controls (managed scope or read-only source). */
  readOnly?: boolean;
}>();
const emit = defineEmits<{ (e: "edit", rule: PermissionRule): void; (e: "delete", rule: PermissionRule): void }>();

const EFFECT_LABEL = { allow: "允许", ask: "询问", deny: "拒绝" } as const;
const EFFECT_SYMBOL = { allow: "✓", ask: "?", deny: "×" } as const;

const detail = computed(() => {
  const m = props.rule.matcher;
  switch (m.kind) {
    case "tool":
      return "任意调用";
    case "bash":
      if (m.mode === "all") return "命令：全部";
      return `命令${m.mode === "prefix" ? "前缀" : "包含"}：${m.value ?? ""}`;
    case "path":
      return m.folder ? `路径：${m.folder}` : "路径：任意";
    case "field":
      return `${m.field} 等于 ${m.equals}`;
  }
});
</script>

<template>
  <article class="rule-card" :class="rule.effect">
    <span class="rule-symbol">{{ EFFECT_SYMBOL[rule.effect] }}</span>
    <div class="rule-body">
      <div class="rule-title"><code>{{ rule.tool }}</code></div>
      <div class="rule-meta">{{ detail }}</div>
    </div>
    <div class="rule-tail">
      <span class="effect-badge">{{ EFFECT_LABEL[rule.effect] }}</span>
      <span v-if="!readOnly" class="rule-actions">
        <button class="icon-btn" data-action="edit-rule" v-tooltip="'编辑规则'" @click="emit('edit', rule)">✎</button>
        <button class="icon-btn" data-action="delete-rule" v-tooltip="'删除规则'" @click="emit('delete', rule)">×</button>
      </span>
    </div>
  </article>
</template>

<style scoped>
.rule-card {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  background: var(--aide-bg-base);
}
.rule-card:hover {
  border-color: var(--aide-border-strong);
  background: var(--aide-surface-default);
}
.rule-symbol {
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: var(--aide-radius-sm);
  font-weight: 700;
  font-size: 13px;
}
.rule-card.allow .rule-symbol { color: var(--aide-success); background: color-mix(in srgb, var(--aide-success) 12%, transparent); }
.rule-card.ask .rule-symbol { color: var(--aide-warning); background: color-mix(in srgb, var(--aide-warning) 12%, transparent); }
.rule-card.deny .rule-symbol { color: var(--aide-danger); background: color-mix(in srgb, var(--aide-danger) 12%, transparent); }
.rule-body { min-width: 0; }
.rule-title code { color: var(--aide-text-primary); font-weight: 600; font-family: var(--aide-font-mono, monospace); font-size: 11.5px; }
.rule-meta {
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--aide-text-muted);
  font-family: var(--aide-font-mono, monospace);
  font-size: 10.5px;
}
.rule-tail { display: flex; align-items: center; gap: 4px; }
.effect-badge {
  display: inline-flex;
  min-width: 44px;
  justify-content: center;
  padding: 2px 6px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
}
.rule-card.allow .effect-badge { color: var(--aide-success); background: color-mix(in srgb, var(--aide-success) 13%, transparent); }
.rule-card.ask .effect-badge { color: var(--aide-warning); background: color-mix(in srgb, var(--aide-warning) 13%, transparent); }
.rule-card.deny .effect-badge { color: var(--aide-danger); background: color-mix(in srgb, var(--aide-danger) 13%, transparent); }
.rule-actions { display: flex; gap: 2px; }
.icon-btn {
  width: 22px;
  height: 22px;
  color: var(--aide-text-muted);
  border: 0;
  background: transparent;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  transition: background var(--aide-ease-t), color var(--aide-ease-t);
}
.icon-btn:hover {
  color: var(--aide-text-primary);
  background: var(--aide-surface-hover);
}
</style>