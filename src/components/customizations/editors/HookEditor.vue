<script setup lang="ts">
import { reactive, computed, watch } from "vue";
import type { CustomizationItem, HookEvent } from "../../../types/customization";

defineOptions({ name: "HookEditor" });
const props = defineProps<{ item: CustomizationItem | null }>();
const emit = defineEmits<{ update: [data: Partial<CustomizationItem>]; delete: []; back: [] }>();

const readOnly = computed(() => props.item?.source === "builtin" || props.item?.source === "plugin");

const EVENTS: HookEvent[] = ["PreToolUse", "PostToolUse", "Notification", "Stop"];
const form = reactive<{
  event: HookEvent;
  matcher: string;
  command: string;
  timeout: string;
  asyncRewake: boolean;
}>({
  event: "PreToolUse",
  matcher: "",
  command: "",
  timeout: "",
  asyncRewake: false,
});

function initForm(item: CustomizationItem | null) {
  const m: any = item?.metadata ?? {};
  form.event = (m.event as HookEvent) ?? "PreToolUse";
  form.matcher = m.matcher ?? "";
  form.command = m.command ?? "";
  form.timeout = m.timeout != null ? String(m.timeout) : "";
  form.asyncRewake = !!m.asyncRewake;
}
initForm(props.item);
watch(() => props.item, (n) => initForm(n));

function sourceLabel(s: NonNullable<CustomizationItem["source"]>): string {
  return s === "builtin" ? "内置" : s === "project" ? "项目" : s === "plugin" ? "插件" : "用户";
}

function save() {
  const data: any = { event: form.event, matcher: form.matcher, command: form.command };
  if (form.timeout) data.timeout = Number(form.timeout);
  if (form.asyncRewake) data.asyncRewake = true;
  emit("update", data);
}
</script>

<template>
  <div class="hook-editor">
    <div class="ed-head">
      <span class="ed-title">{{ item?.name }}</span>
      <span class="src-badge" :class="`src-${item?.source ?? 'user'}`" v-if="item?.source">{{ sourceLabel(item.source) }}</span>
    </div>

    <div class="field">
      <label>event</label>
      <select v-model="form.event" :disabled="readOnly">
        <option v-for="e in EVENTS" :key="e" :value="e">{{ e }}</option>
      </select>
    </div>
    <div class="field">
      <label>matcher <span class="hint">正则，匹配工具名（如 ^Read$ 或 .*）</span></label>
      <input v-model="form.matcher" :disabled="readOnly" />
    </div>
    <div class="field">
      <label>command <span class="hint">shell 命令</span></label>
      <input v-model="form.command" :disabled="readOnly" />
    </div>
    <div class="field">
      <label>timeout <span class="hint">秒，可选</span></label>
      <input v-model="form.timeout" type="number" :disabled="readOnly" />
    </div>
    <div class="field">
      <label>asyncRewake</label>
      <input type="checkbox" v-model="form.asyncRewake" :disabled="readOnly" />
    </div>

    <div class="ed-actions" v-if="!readOnly">
      <button class="btn btn-accent save-btn" @click="save">保存</button>
      <button class="btn btn-ghost" @click="emit('delete')">删除</button>
      <span class="hint">下次新会话生效</span>
    </div>
    <div class="readonly-note" v-else>内置/插件来源 · 只读</div>
  </div>
</template>

<style scoped>
.hook-editor { display: flex; flex-direction: column; padding: 16px; }
.ed-head { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--aide-surface-default); }
.ed-title { font-size: 14px; font-weight: 600; }
.src-badge { font-size: 10px; font-weight: 500; padding: 2px 7px; border-radius: 10px; }
.src-user { background: color-mix(in srgb, var(--aide-info) 14%, transparent); color: var(--aide-info); }
.src-project { background: color-mix(in srgb, var(--aide-success) 14%, transparent); color: var(--aide-success); }
.src-plugin { background: color-mix(in srgb, var(--aide-warning) 14%, transparent); color: var(--aide-warning); }
.src-builtin { background: var(--aide-surface-active); color: var(--aide-text-muted); }
.field { margin-bottom: 12px; }
.field label { display: block; font-size: 12px; color: var(--aide-text-secondary); margin-bottom: 5px; }
.field input, .field select {
  width: 100%; box-sizing: border-box; background: var(--aide-surface-default);
  border: 1px solid transparent; border-radius: var(--aide-radius-md);
  padding: 8px 10px; font-size: 13px; color: var(--aide-text-primary);
  outline: none; font-family: inherit;
}
.field input:focus, .field select:focus { border-color: var(--aide-accent); }
.field input:disabled, .field select:disabled { opacity: 0.7; }
.hint { font-size: 11px; color: var(--aide-text-muted); margin-left: 6px; }
.ed-actions { display: flex; gap: 8px; align-items: center; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--aide-surface-default); }
.readonly-note { font-size: 12px; color: var(--aide-text-muted); font-style: italic; margin-top: 14px; }
.btn { font-size: 12px; padding: 6px 11px; border-radius: var(--aide-radius-sm); border: 1px solid var(--aide-border); background: var(--aide-surface-default); color: var(--aide-text-secondary); cursor: pointer; }
.btn-accent { background: var(--aide-accent); color: var(--aide-text-on-accent); border-color: var(--aide-accent); font-weight: 600; }
.btn-ghost { background: transparent; }
</style>