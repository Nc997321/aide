<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { CustomizationItem } from "../../../types/customization";
import { customizationApi, getSkillContent, skillScriptApi } from "../../../api/customization";

defineOptions({ name: "SkillEditor" });
const props = defineProps<{ item: CustomizationItem | null }>();
const emit = defineEmits<{ update: [data: Partial<CustomizationItem>]; delete: []; back: [] }>();

const readOnly = computed(() => props.item?.source === "builtin" || props.item?.source === "plugin");
const tab = ref<"meta" | "body" | "scripts">("meta");

const name = ref("");
const description = ref("");
const body = ref("");
const bodyLoaded = ref(false);
const scripts = ref<string[]>([]);
const curScript = ref<string | null>(null);
const curScriptContent = ref("");
const saving = ref(false);
const savedMsg = ref("");

function initForm(item: CustomizationItem | null) {
  name.value = item?.name ?? "";
  description.value = item?.description ?? "";
  scripts.value = Array.isArray(item?.metadata?.scripts) ? [...item.metadata.scripts] : [];
  body.value = "";
  bodyLoaded.value = false;
  curScript.value = null;
  curScriptContent.value = "";
  tab.value = "meta";
  savedMsg.value = "";
}
initForm(props.item);
watch(() => props.item, (n) => initForm(n));

async function loadBody() {
  if (!props.item || readOnly.value || bodyLoaded.value) return;
  bodyLoaded.value = true;
  try {
    body.value = await getSkillContent(props.item.id);
  } catch {
    body.value = "";
  }
}

async function selectScript(filename: string) {
  if (!props.item || readOnly.value) return;
  curScript.value = filename;
  try {
    curScriptContent.value = await skillScriptApi.read(props.item.id, filename);
  } catch {
    curScriptContent.value = "";
  }
}

async function saveBody() {
  if (!props.item) return;
  saving.value = true;
  try {
    await customizationApi.update("skill", props.item.id, { content: body.value } as any);
    savedMsg.value = "正文已保存";
  } catch (e: any) {
    savedMsg.value = `失败：${e?.message ?? e}`;
  } finally {
    saving.value = false;
  }
}

async function saveScript() {
  if (!props.item || !curScript.value) return;
  saving.value = true;
  try {
    await skillScriptApi.write(props.item.id, curScript.value, curScriptContent.value);
    savedMsg.value = `${curScript.value} 已保存`;
  } catch (e: any) {
    savedMsg.value = `失败：${e?.message ?? e}`;
  } finally {
    saving.value = false;
  }
}

async function deleteScript() {
  if (!props.item || !curScript.value) return;
  await skillScriptApi.delete(props.item.id, curScript.value);
  scripts.value = scripts.value.filter((s) => s !== curScript.value);
  curScript.value = null;
  curScriptContent.value = "";
}

function newScript() {
  const fn = window.prompt("脚本文件名（如 build.sh）：");
  if (!fn) return;
  if (!scripts.value.includes(fn)) scripts.value.push(fn);
  curScript.value = fn;
  curScriptContent.value = "";
}

function sourceLabel(s: NonNullable<CustomizationItem["source"]>): string {
  return s === "builtin" ? "内置" : s === "project" ? "项目" : s === "plugin" ? "插件" : "用户";
}
</script>

<template>
  <div class="skill-editor">
    <div class="ed-head">
      <span class="ed-title">{{ item?.name }}</span>
      <span class="src-badge" :class="`src-${item?.source ?? 'user'}`" v-if="item?.source">{{ sourceLabel(item.source) }}</span>
    </div>

    <div class="tabs">
      <button :class="{ on: tab === 'meta' }" @click="tab = 'meta'">基本信息</button>
      <button :class="{ on: tab === 'body' }" @click="tab = 'body'; loadBody()">正文 (SKILL.md)</button>
      <button :class="{ on: tab === 'scripts' }" @click="tab = 'scripts'">脚本 ({{ scripts.length }})</button>
    </div>

    <div v-if="tab === 'meta'" class="tab-pane">
      <div class="field"><label>name</label><input v-model="name" :disabled="readOnly" /></div>
      <div class="field"><label>description</label><textarea v-model="description" :disabled="readOnly" /></div>
      <div class="ed-actions" v-if="!readOnly"><button class="btn btn-accent save-btn" @click="emit('update', { name: name, description: description })">保存</button></div>
    </div>

    <div v-else-if="tab === 'body'" class="tab-pane">
      <textarea class="cm-mock" v-model="body" :disabled="readOnly" :placeholder="bodyLoaded ? '' : '加载中…'"></textarea>
      <div class="ed-actions" v-if="!readOnly"><button class="btn btn-accent save-btn" @click="saveBody" :disabled="saving">保存正文</button></div>
    </div>

    <div v-else-if="tab === 'scripts'" class="tab-pane">
      <div class="scripts-list">
        <span v-for="s in scripts" :key="s" class="script-chip" :class="{ on: curScript === s }" @click="selectScript(s)">{{ s }}</span>
        <button v-if="!readOnly" class="btn btn-ghost add-script" @click="newScript">+ 新建</button>
      </div>
      <textarea v-if="curScript" class="cm-mock" v-model="curScriptContent" :disabled="readOnly"></textarea>
      <div class="ed-actions" v-if="!readOnly && curScript">
        <button class="btn btn-accent save-btn" @click="saveScript" :disabled="saving">保存脚本</button>
        <button class="btn btn-ghost" @click="deleteScript">删除脚本</button>
      </div>
      <div v-if="!curScript && scripts.length === 0" class="hint">暂无脚本。点 + 新建添加。</div>
    </div>

    <div class="ed-actions" v-if="!readOnly" style="margin-top: 14px">
      <button class="btn btn-ghost" @click="emit('delete')">删除技能</button>
    </div>
    <div class="readonly-note" v-else>插件来源 · 只读</div>
    <div class="saved-msg" v-if="savedMsg">{{ savedMsg }}</div>
  </div>
</template>

<style scoped>
.skill-editor { display: flex; flex-direction: column; padding: 16px; }
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
.field input, .field textarea { width: 100%; box-sizing: border-box; background: var(--aide-surface-default); border: 1px solid transparent; border-radius: var(--aide-radius-md); padding: 8px 10px; font-size: 13px; color: var(--aide-text-primary); outline: none; font-family: inherit; }
.field input:focus, .field textarea:focus { border-color: var(--aide-accent); }
.field input:disabled { opacity: 0.7; }
.cm-mock { width: 100%; box-sizing: border-box; background: var(--aide-bg-deep); border: 1px solid var(--aide-border); border-radius: var(--aide-radius-sm); padding: 12px; font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.6; color: var(--aide-text-primary); min-height: 160px; resize: vertical; }
.scripts-list { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 12px; align-items: center; }
.script-chip { font-size: 11.5px; padding: 5px 10px; border-radius: var(--aide-radius-sm); background: var(--aide-surface-default); border: 1px solid var(--aide-border); cursor: pointer; color: var(--aide-text-secondary); }
.script-chip.on { border-color: var(--aide-accent); color: var(--aide-text-primary); background: var(--aide-surface-active); }
.add-script { font-size: 11px; }
.hint { font-size: 11px; color: var(--aide-text-muted); }
.ed-actions { display: flex; gap: 8px; align-items: center; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--aide-surface-default); }
.readonly-note { font-size: 12px; color: var(--aide-text-muted); font-style: italic; margin-top: 14px; }
.saved-msg { font-size: 11px; color: var(--aide-success); margin-top: 8px; }
.btn { font-size: 12px; padding: 6px 11px; border-radius: var(--aide-radius-sm); border: 1px solid var(--aide-border); background: var(--aide-surface-default); color: var(--aide-text-secondary); cursor: pointer; }
.btn:disabled { opacity: 0.6; cursor: default; }
.btn-accent { background: var(--aide-accent); color: var(--aide-text-on-accent); border-color: var(--aide-accent); font-weight: 600; }
.btn-ghost { background: transparent; }
</style>