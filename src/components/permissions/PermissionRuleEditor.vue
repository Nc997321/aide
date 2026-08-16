<script setup lang="ts">
import { ref } from "vue";
import ThemedSelect from "@/components/ThemedSelect.vue";
import type { PermissionEffect, PermissionMatcher, PermissionRuleDraft } from "@/types/permissions";

const props = defineProps<{
  initial: PermissionRuleDraft;
}>();
const emit = defineEmits<{
  (e: "submit", draft: PermissionRuleDraft): void;
  (e: "cancel"): void;
}>();

const EFFECT_OPTIONS = [
  { value: "allow", label: "允许" },
  { value: "ask", label: "询问" },
  { value: "deny", label: "拒绝" },
];
const TOOL_OPTIONS = [
  "Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit",
  "WebFetch", "WebSearch", "Glob", "Grep", "Agent", "Task",
  "AskUserQuestion", "ExitPlanMode",
].map((t) => ({ value: t, label: t }));
const KIND_OPTIONS = [
  { value: "tool", label: "任意调用" },
  { value: "bash", label: "Bash 命令" },
  { value: "path", label: "文件路径" },
  { value: "field", label: "字段精确匹配" },
];
const BASH_MODE_OPTIONS = [
  { value: "all", label: "全部命令" },
  { value: "prefix", label: "前缀" },
  { value: "contains", label: "包含" },
];
const PATH_FIELD_OPTIONS = [
  { value: "file_path", label: "file_path" },
  { value: "path", label: "path" },
  { value: "notebook_path", label: "notebook_path" },
];
const FIELD_NAME_OPTIONS = [
  { value: "command", label: "command" },
  { value: "url", label: "url" },
  { value: "query", label: "query" },
];

const effect = ref<PermissionEffect>(props.initial.effect);
const tool = ref(props.initial.tool);
const matcherKind = ref<PermissionMatcher["kind"]>(props.initial.matcher.kind);
const bashMode = ref(props.initial.matcher.kind === "bash" ? props.initial.matcher.mode : "prefix");
const bashValue = ref(props.initial.matcher.kind === "bash" ? props.initial.matcher.value ?? "" : "");
const pathField = ref(props.initial.matcher.kind === "path" ? props.initial.matcher.field : "file_path");
const pathFolder = ref(props.initial.matcher.kind === "path" ? props.initial.matcher.folder ?? "" : "");
const fieldName = ref(props.initial.matcher.kind === "field" ? props.initial.matcher.field : "command");
const fieldEquals = ref(props.initial.matcher.kind === "field" ? props.initial.matcher.equals : "");
const formError = ref<string | null>(null);

function buildMatcher(): PermissionMatcher {
  switch (matcherKind.value) {
    case "tool":
      return { kind: "tool" };
    case "bash":
      return {
        kind: "bash",
        mode: bashMode.value,
        ...(bashValue.value.trim() ? { value: bashValue.value.trim() } : {}),
      };
    case "path":
      return {
        kind: "path",
        field: pathField.value,
        ...(pathFolder.value.trim() ? { folder: pathFolder.value.trim() } : {}),
      };
    case "field":
      return { kind: "field", field: fieldName.value, equals: fieldEquals.value.trim() };
  }
}

function validate(): string | null {
  if (!tool.value.trim()) return "工具名不能为空";
  const k = matcherKind.value;
  if (k === "bash") {
    if (bashMode.value !== "all" && !bashValue.value.trim()) return "命令匹配值不能为空";
    if (bashMode.value === "contains" && effect.value === "allow") {
      return "「包含文本」不能用于始终允许 Bash";
    }
  }
  if (k === "field" && !fieldEquals.value.trim()) return "匹配值不能为空";
  return null;
}

function onSubmit() {
  const err = validate();
  if (err) {
    formError.value = err;
    return;
  }
  formError.value = null;
  emit("submit", { effect: effect.value, tool: tool.value.trim(), matcher: buildMatcher() });
}
</script>

<template>
  <form class="rule-editor" @submit.prevent="onSubmit">
    <p v-if="formError" class="form-error" data-error>{{ formError }}</p>

    <div class="field-row">
      <label class="field">
        <span class="field-label">效果</span>
        <ThemedSelect v-model="effect" :options="EFFECT_OPTIONS" block />
      </label>
      <label class="field">
        <span class="field-label">工具</span>
        <ThemedSelect v-model="tool" :options="TOOL_OPTIONS" block />
      </label>
    </div>

    <label class="field">
      <span class="field-label">匹配方式</span>
      <ThemedSelect v-model="matcherKind" :options="KIND_OPTIONS" block />
    </label>

    <div v-if="matcherKind === 'bash'" class="field-row">
      <label class="field">
        <span class="field-label">模式</span>
        <ThemedSelect v-model="bashMode" :options="BASH_MODE_OPTIONS" block />
      </label>
      <label v-if="bashMode !== 'all'" class="field">
        <span class="field-label">{{ bashMode === "prefix" ? "前缀文本" : "包含文本" }}</span>
        <input v-model="bashValue" class="text-input" :placeholder="bashMode === 'prefix' ? 'pnpm test' : 'rm -rf'" />
      </label>
    </div>

    <div v-if="matcherKind === 'path'" class="field-row">
      <label class="field">
        <span class="field-label">字段</span>
        <ThemedSelect v-model="pathField" :options="PATH_FIELD_OPTIONS" block />
      </label>
      <label class="field">
        <span class="field-label">文件夹（可选，留空=任意路径）</span>
        <input v-model="pathFolder" class="text-input" placeholder="/path/to/folder" />
      </label>
    </div>

    <div v-if="matcherKind === 'field'" class="field-row">
      <label class="field">
        <span class="field-label">字段名</span>
        <ThemedSelect v-model="fieldName" :options="FIELD_NAME_OPTIONS" block />
      </label>
      <label class="field">
        <span class="field-label">等于</span>
        <input v-model="fieldEquals" class="text-input" placeholder="https://example.com" />
      </label>
    </div>

    <div class="editor-actions">
      <button type="button" class="btn-secondary" @click="emit('cancel')">取消</button>
      <button type="submit" class="btn-primary">保存</button>
    </div>
  </form>
</template>

<style scoped>
.rule-editor { display: grid; gap: 12px; }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.field { display: grid; gap: 4px; }
.field-label { font-size: 11px; color: var(--aide-text-secondary); }
.text-input {
  height: 31px;
  padding: 0 10px;
  color: var(--aide-text-primary);
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  font-size: 12px;
}
.text-input:focus { outline: none; border-color: var(--aide-accent); }
.form-error {
  margin: 0;
  padding: 8px 10px;
  color: var(--aide-danger);
  background: color-mix(in srgb, var(--aide-danger) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-danger) 28%, var(--aide-border));
  border-radius: var(--aide-radius-md);
  font-size: 12px;
}
.editor-actions { display: flex; justify-content: flex-end; gap: 8px; }
.btn-primary, .btn-secondary {
  height: 31px;
  padding: 0 14px;
  border-radius: var(--aide-radius-md);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.btn-primary {
  border: 1px solid color-mix(in srgb, var(--aide-accent) 55%, var(--aide-border));
  background: var(--aide-accent-gradient);
  color: var(--aide-text-on-accent);
}
.btn-secondary {
  border: 1px solid var(--aide-border);
  background: var(--aide-surface-default);
  color: var(--aide-text-secondary);
}
</style>