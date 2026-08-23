<script setup lang="ts">
import { ref, watch } from "vue";
import type { CustomizationItem } from "../../../types/customization";
import { instructionApi } from "../../../api/customization";

defineOptions({ name: "InstructionEditor" });
const props = defineProps<{ item: CustomizationItem | null }>();
defineEmits<{ update: [data: Partial<CustomizationItem>]; delete: []; back: [] }>();

const scope = ref<"global" | "project">("global");
const content = ref("");
const loaded = ref(false);
const saving = ref(false);
const savedMsg = ref("");

function initScope(item: CustomizationItem | null) {
  scope.value = item?.id === "project" ? "project" : "global";
  content.value = "";
  loaded.value = false;
  savedMsg.value = "";
}
initScope(props.item);
watch(() => props.item, (n) => initScope(n));

async function load() {
  if (loaded.value) return;
  loaded.value = true;
  try {
    const it = scope.value === "global"
      ? await instructionApi.getGlobal()
      : await instructionApi.getProject();
    // metadata 是通用 JSON 字段：content 必须是 string 才取用，否则回落空串
    const md = it.metadata;
    content.value = md && typeof md.content === "string" ? md.content : "";
  } catch {
    content.value = "";
  }
}

async function switchScope(s: "global" | "project") {
  if (scope.value === s) return;
  scope.value = s;
  loaded.value = false;
  content.value = "";
  await load();
}

async function save() {
  saving.value = true;
  try {
    if (scope.value === "global") await instructionApi.saveGlobal(content.value);
    else await instructionApi.saveProject(content.value);
    savedMsg.value = "已保存";
  } catch (e: unknown) {
    savedMsg.value = `失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="instr-editor">
    <div class="ed-head">
      <span class="ed-title">指令</span>
      <div class="seg">
        <button :class="{ on: scope === 'global' }" @click="switchScope('global')">全局 (CLAUDE.md)</button>
        <button :class="{ on: scope === 'project' }" @click="switchScope('project')">项目 (CLAUDE.md)</button>
      </div>
    </div>
    <textarea
      class="cm-mock"
      v-model="content"
      @focus="load()"
      :placeholder="loaded ? '' : '加载中…'"
    ></textarea>
    <div class="ed-actions">
      <button class="btn btn-accent save-btn" @click="save" :disabled="saving">保存</button>
      <span class="saved-msg" v-if="savedMsg">{{ savedMsg }}</span>
    </div>
  </div>
</template>

<style scoped>
.instr-editor { display: flex; flex-direction: column; padding: 16px; }
.ed-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--aide-surface-default); }
.ed-title { font-size: 14px; font-weight: 600; }
.seg { display: inline-flex; background: var(--aide-bg-deep); border: 1px solid var(--aide-border); border-radius: var(--aide-radius-sm); padding: 2px; }
.seg button { font-size: 12px; padding: 5px 12px; border: none; background: transparent; color: var(--aide-text-secondary); cursor: pointer; border-radius: 4px; }
.seg button.on { background: var(--aide-accent); color: var(--aide-text-on-accent); font-weight: 600; }
.cm-mock { width: 100%; box-sizing: border-box; background: var(--aide-bg-deep); border: 1px solid var(--aide-border); border-radius: var(--aide-radius-sm); padding: 12px; font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.6; color: var(--aide-text-primary); min-height: 240px; resize: vertical; outline: none; }
.ed-actions { display: flex; gap: 10px; align-items: center; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--aide-surface-default); }
.saved-msg { font-size: 11px; color: var(--aide-success); }
.btn { font-size: 12px; padding: 6px 11px; border-radius: var(--aide-radius-sm); border: 1px solid var(--aide-border); background: var(--aide-surface-default); color: var(--aide-text-secondary); cursor: pointer; }
.btn:disabled { opacity: 0.6; cursor: default; }
.btn-accent { background: var(--aide-accent); color: var(--aide-text-on-accent); border-color: var(--aide-accent); font-weight: 600; }
</style>