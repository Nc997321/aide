<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { CustomizationItem } from "../../../types/customization";
import { customizationApi, getAgentContent } from "../../../api/customization";

defineOptions({ name: "AgentEditor" });
const props = defineProps<{ item: CustomizationItem | null }>();
// model/tools 是 agent frontmatter 的写字段，后端 update_agent 用 as_str() 取值——
// 都是逗号分隔 string（见 src-tauri/commands/customizations.rs update_agent）。
// 故 emit 类型在 Partial<CustomizationItem> 上扩 model?/tools?: string，而非用
// Partial<Agent>（Agent.tools: string[] 是 list 侧的读类型，与写字段不符）。
const emit = defineEmits<{ update: [data: Partial<CustomizationItem> & { model?: string; tools?: string }]; delete: []; back: [] }>();

const readOnly = computed(() => props.item?.source === "builtin" || props.item?.source === "plugin");
const tab = ref<"meta" | "body">("meta");

const name = ref("");
const description = ref("");
const model = ref("");
const toolsStr = ref("");
const body = ref("");
const bodyLoaded = ref(false);
const saving = ref(false);
const savedMsg = ref("");

function parseFrontmatter(content: string): { fm: Record<string, string>; body: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: content };
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { fm, body: m[2] };
}

function initForm(item: CustomizationItem | null) {
  name.value = item?.name ?? "";
  description.value = item?.description ?? "";
  model.value = "";
  toolsStr.value = "";
  body.value = "";
  bodyLoaded.value = false;
  tab.value = "meta";
  savedMsg.value = "";
}
initForm(props.item);
watch(() => props.item, (n) => initForm(n));

async function loadContent() {
  if (!props.item || readOnly.value || bodyLoaded.value) return;
  bodyLoaded.value = true;
  try {
    const full = await getAgentContent(props.item.id);
    const { fm } = parseFrontmatter(full);
    model.value = fm.model ?? "";
    toolsStr.value = fm.tools ?? "";
    body.value = full;
  } catch {
    body.value = "";
  }
}

async function saveBody() {
  if (!props.item) return;
  saving.value = true;
  try {
    // content 是 Agent 的写字段（不在 CustomizationItem 上），单跳断言
    await customizationApi.update("agent", props.item.id, { content: body.value } as Partial<CustomizationItem>);
    savedMsg.value = "正文已保存";
  } catch (e: unknown) {
    savedMsg.value = `失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    saving.value = false;
  }
}

function saveMeta() {
  emit("update", {
    name: name.value,
    description: description.value,
    model: model.value,
    tools: toolsStr.value,
  });
}

function sourceLabel(s: NonNullable<CustomizationItem["source"]>): string {
  return s === "builtin" ? "内置" : s === "project" ? "项目" : s === "plugin" ? "插件" : "用户";
}
</script>

<template>
  <div class="agent-editor">
    <div class="ed-head">
      <span class="ed-title">{{ item?.name }}</span>
      <span class="src-badge" :class="`src-${item?.source ?? 'user'}`" v-if="item?.source">{{ sourceLabel(item.source) }}</span>
    </div>

    <div class="tabs">
      <button :class="{ on: tab === 'meta' }" @click="tab = 'meta'">基本信息</button>
      <button :class="{ on: tab === 'body' }" @click="tab = 'body'; loadContent()">正文 (agent.md)</button>
    </div>

    <div v-if="tab === 'meta'" class="tab-pane">
      <div class="field"><label>name</label><input v-model="name" :disabled="readOnly" /></div>
      <div class="field"><label>description</label><input v-model="description" :disabled="readOnly" /></div>
      <div class="field"><label>model <span class="hint">如 claude-sonnet-5 或 haiku</span></label><input v-model="model" :disabled="readOnly" /></div>
      <div class="field"><label>tools <span class="hint">逗号分隔，如 Read, Grep, Bash</span></label><input v-model="toolsStr" :disabled="readOnly" /></div>
      <div class="ed-actions" v-if="!readOnly"><button class="btn btn-accent save-btn" @click="saveMeta">保存</button></div>
    </div>

    <div v-else-if="tab === 'body'" class="tab-pane">
      <textarea class="cm-mock" v-model="body" :disabled="readOnly"></textarea>
      <div class="ed-actions" v-if="!readOnly"><button class="btn btn-accent save-btn" @click="saveBody" :disabled="saving">保存正文</button></div>
    </div>

    <div class="ed-actions" v-if="!readOnly" style="margin-top: 14px">
      <button class="btn btn-ghost" @click="emit('delete')">删除智能体</button>
    </div>
    <div class="readonly-note" v-else>插件来源 · 只读</div>
    <div class="saved-msg" v-if="savedMsg">{{ savedMsg }}</div>
  </div>
</template>

<style scoped>
.agent-editor { display: flex; flex-direction: column; padding: 16px; }
.ed-head { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--aide-surface-default); }
.ed-title { font-size: 14px; font-weight: 600; }
.src-badge { font-size: 10px; font-weight: 500; padding: 2px 7px; border-radius: 10px; }
.src-user { background: color-mix(in srgb, var(--aide-info) 14%, transparent); color: var(--aide-info); }
.src-project { background: color-mix(in srgb, var(--aide-success) 14%, transparent); color: var(--aide-success); }
.src-plugin { background: color-mix(in srgb, var(--aide-warning) 14%, transparent); color: var(--aide-warning); }
.src-builtin { background: var(--aide-surface-active); color: var(--aide-text-muted); }
.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--aide-surface-default); margin-bottom: 14px; }
.tabs button { font-size: 12.5px; padding: 8px 14px; background: transparent; border: none; color: var(--aide-text-secondary); cursor: pointer; border-bottom: 2px solid transparent; }
.tabs button.on { color: var(--aide-accent); border-bottom-color: var(--aide-accent); }
.field { margin-bottom: 12px; }
.field label { display: block; font-size: 12px; color: var(--aide-text-secondary); margin-bottom: 5px; }
.field input { width: 100%; box-sizing: border-box; background: var(--aide-surface-default); border: 1px solid transparent; border-radius: var(--aide-radius-md); padding: 8px 10px; font-size: 13px; color: var(--aide-text-primary); outline: none; font-family: inherit; }
.field input:focus { border-color: var(--aide-accent); }
.field input:disabled { opacity: 0.7; }
.hint { font-size: 11px; color: var(--aide-text-muted); margin-left: 6px; }
.cm-mock { width: 100%; box-sizing: border-box; background: var(--aide-bg-deep); border: 1px solid var(--aide-border); border-radius: var(--aide-radius-sm); padding: 12px; font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.6; color: var(--aide-text-primary); min-height: 160px; resize: vertical; }
.ed-actions { display: flex; gap: 8px; align-items: center; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--aide-surface-default); }
.readonly-note { font-size: 12px; color: var(--aide-text-muted); font-style: italic; margin-top: 14px; }
.saved-msg { font-size: 11px; color: var(--aide-success); margin-top: 8px; }
.btn { font-size: 12px; padding: 6px 11px; border-radius: var(--aide-radius-sm); border: 1px solid var(--aide-border); background: var(--aide-surface-default); color: var(--aide-text-secondary); cursor: pointer; }
.btn:disabled { opacity: 0.6; cursor: default; }
.btn-accent { background: var(--aide-accent); color: var(--aide-text-on-accent); border-color: var(--aide-accent); font-weight: 600; }
.btn-ghost { background: transparent; }
</style>