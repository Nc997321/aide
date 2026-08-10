<script setup lang="ts">
import { ref, reactive, computed, watch } from "vue";
import type { CustomizationItem } from "../../../types/customization";
import { testMcpConnection } from "../../../api/customization";

defineOptions({ name: "McpServerEditor" });
const props = defineProps<{ item: CustomizationItem | null }>();
const emit = defineEmits<{ update: [data: Partial<CustomizationItem>]; delete: []; back: [] }>();

const readOnly = computed(
  () => props.item?.source === "builtin" || props.item?.source === "plugin",
);

const form = reactive<{ transport: "stdio" | "sse" | "http"; command: string; url: string }>({
  transport: "stdio",
  command: "",
  url: "",
});
const argsText = ref("");
const envEntries = ref<[string, string][]>([]);
const headersEntries = ref<[string, string][]>([]);
const status = ref<"unk" | "spin" | "ok" | "fail">("unk");
const toolsCount = ref(0);
const errMsg = ref("");

function deriveTransport(meta: any): "stdio" | "sse" | "http" {
  if (meta?.command) return "stdio";
  if (meta?.headers) return "http";
  if (meta?.url) return "sse";
  return "stdio";
}
function initForm(item: CustomizationItem | null) {
  const meta: any = item?.metadata ?? {};
  form.transport = deriveTransport(meta);
  form.command = meta.command ?? "";
  argsText.value = Array.isArray(meta.args) ? meta.args.join("\n") : "";
  envEntries.value = meta.env ? Object.entries(meta.env) : [];
  form.url = meta.url ?? "";
  headersEntries.value = meta.headers ? Object.entries(meta.headers) : [];
  status.value = "unk";
  toolsCount.value = 0;
  errMsg.value = "";
}
initForm(props.item);
watch(() => props.item, (n) => initForm(n));

function sourceLabel(s: NonNullable<CustomizationItem["source"]>): string {
  return s === "builtin" ? "内置" : s === "project" ? "项目" : s === "plugin" ? "插件" : "用户";
}

async function testConn() {
  status.value = "spin";
  try {
    const cfg: Record<string, any> = { transport: form.transport };
    if (form.transport === "stdio") {
      cfg.command = form.command;
      cfg.args = argsText.value.split("\n").filter((s) => s.length > 0);
      cfg.env = Object.fromEntries(envEntries.value.filter((e) => e[0]));
    } else if (form.transport === "sse") {
      cfg.url = form.url;
    } else {
      cfg.url = form.url;
      cfg.headers = Object.fromEntries(headersEntries.value.filter((e) => e[0]));
    }
    const r = await testMcpConnection(cfg);
    status.value = r.status === "ok" ? "ok" : "fail";
    toolsCount.value = r.tools.length;
    errMsg.value = r.error ?? "";
  } catch (e: any) {
    status.value = "fail";
    errMsg.value = String(e?.message ?? e);
  }
}

function save() {
  const data: any = { transport: form.transport };
  if (form.transport === "stdio") {
    data.command = form.command;
    data.args = argsText.value.split("\n").filter((s) => s.length > 0);
    data.env = Object.fromEntries(envEntries.value.filter((e) => e[0]));
  } else if (form.transport === "sse") {
    data.url = form.url;
  } else {
    data.url = form.url;
    data.headers = Object.fromEntries(headersEntries.value.filter((e) => e[0]));
  }
  emit("update", data);
}
</script>

<template>
  <div class="mcp-editor">
    <div class="ed-head">
      <span class="ed-title">{{ item?.name }}</span>
      <span class="src-badge" :class="`src-${item?.source ?? 'user'}`" v-if="item?.source">{{ sourceLabel(item.source) }}</span>
    </div>

    <div class="field">
      <label>传输类型</label>
      <div class="seg">
        <button :class="{ on: form.transport === 'stdio' }" :disabled="readOnly" @click="form.transport = 'stdio'">stdio</button>
        <button :class="{ on: form.transport === 'sse' }" :disabled="readOnly" @click="form.transport = 'sse'">sse</button>
        <button :class="{ on: form.transport === 'http' }" :disabled="readOnly" @click="form.transport = 'http'">http</button>
      </div>
    </div>

    <template v-if="form.transport === 'stdio'">
      <div class="field">
        <label>command</label>
        <input v-model="form.command" :disabled="readOnly" />
      </div>
      <div class="field">
        <label>args <span class="hint">每行一个，避免引号转义</span></label>
        <textarea v-model="argsText" :disabled="readOnly" />
      </div>
      <div class="field">
        <label>env</label>
        <div class="kv" v-for="(e, i) in envEntries" :key="i">
          <input v-model="e[0]" placeholder="键" :disabled="readOnly" />
          <input v-model="e[1]" placeholder="值" :disabled="readOnly" />
          <button v-if="!readOnly" class="x" @click="envEntries.splice(i, 1)">×</button>
        </div>
        <button v-if="!readOnly" class="btn btn-ghost add-kv" @click="envEntries.push(['', ''])">+ 添加</button>
      </div>
    </template>

    <template v-else-if="form.transport === 'sse'">
      <div class="field">
        <label>url</label>
        <input v-model="form.url" :disabled="readOnly" />
      </div>
    </template>

    <template v-else-if="form.transport === 'http'">
      <div class="field">
        <label>url</label>
        <input v-model="form.url" :disabled="readOnly" />
      </div>
      <div class="field">
        <label>headers</label>
        <div class="kv" v-for="(e, i) in headersEntries" :key="i">
          <input v-model="e[0]" placeholder="键" :disabled="readOnly" />
          <input v-model="e[1]" placeholder="值" :disabled="readOnly" />
          <button v-if="!readOnly" class="x" @click="headersEntries.splice(i, 1)">×</button>
        </div>
        <button v-if="!readOnly" class="btn btn-ghost add-kv" @click="headersEntries.push(['', ''])">+ 添加</button>
      </div>
    </template>

    <div class="status-bar" v-if="!readOnly">
      <span class="dot" :class="`dot-${status}`" :title="errMsg"></span>
      <span class="status-text" v-if="status === 'unk'">未测试</span>
      <span class="status-text" v-else-if="status === 'spin'">握手中…</span>
      <span class="status-text" v-else-if="status === 'ok'">已连接 · {{ toolsCount }} 工具</span>
      <span class="status-text status-fail" v-else :title="errMsg">失败：{{ errMsg }}</span>
      <button class="btn test-conn" :disabled="status === 'spin'" @click="testConn">测试连接</button>
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
.mcp-editor { display: flex; flex-direction: column; padding: 16px; }
.ed-head { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--aide-surface-default); }
.ed-title { font-size: 14px; font-weight: 600; }
.src-badge { font-size: 10px; font-weight: 500; padding: 2px 7px; border-radius: 10px; }
.src-user { background: color-mix(in srgb, var(--aide-info) 14%, transparent); color: var(--aide-info); }
.src-project { background: color-mix(in srgb, var(--aide-success) 14%, transparent); color: var(--aide-success); }
.src-plugin { background: color-mix(in srgb, var(--aide-warning) 14%, transparent); color: var(--aide-warning); }
.src-builtin { background: var(--aide-surface-active); color: var(--aide-text-muted); }
.field { margin-bottom: 12px; }
.field label { display: block; font-size: 12px; color: var(--aide-text-secondary); margin-bottom: 5px; }
.field input, .field textarea {
  width: 100%; box-sizing: border-box; background: var(--aide-surface-default);
  border: 1px solid transparent; border-radius: var(--aide-radius-md);
  padding: 8px 10px; font-size: 13px; color: var(--aide-text-primary);
  outline: none; font-family: inherit;
}
.field input:focus, .field textarea:focus { border-color: var(--aide-accent); }
.field textarea { resize: vertical; min-height: 54px; font-family: ui-monospace, monospace; font-size: 12px; }
.field input:disabled { opacity: 0.7; }
.hint { font-size: 11px; color: var(--aide-text-muted); margin-left: 6px; }
.seg { display: inline-flex; background: var(--aide-bg-deep); border: 1px solid var(--aide-border); border-radius: var(--aide-radius-sm); padding: 2px; }
.seg button { font-size: 12px; padding: 5px 12px; border: none; background: transparent; color: var(--aide-text-secondary); cursor: pointer; border-radius: 4px; }
.seg button.on { background: var(--aide-accent); color: var(--aide-text-on-accent); font-weight: 600; }
.seg button:disabled { cursor: not-allowed; }
.kv { display: flex; gap: 8px; margin-bottom: 6px; }
.kv input { flex: 1; }
.kv .x { width: 22px; border: none; background: none; color: var(--aide-text-muted); cursor: pointer; font-size: 14px; }
.add-kv { font-size: 11px; margin-top: 4px; }
.status-bar { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--aide-radius-sm); background: var(--aide-bg-deep); border: 1px solid var(--aide-border); margin-top: 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.dot-unk { background: var(--aide-text-muted); opacity: 0.5; }
.dot-spin { border: 2px solid var(--aide-surface-active); border-top-color: var(--aide-warning); width: 12px; height: 12px; background: transparent; animation: sp 1s linear infinite; }
@keyframes sp { to { transform: rotate(360deg); } }
.dot-ok { background: var(--aide-success); box-shadow: 0 0 6px color-mix(in srgb, var(--aide-success) 50%, transparent); }
.dot-fail { background: var(--aide-danger); }
.status-text { font-size: 12px; color: var(--aide-text-secondary); }
.status-fail { color: var(--aide-danger); }
.ed-actions { display: flex; gap: 8px; align-items: center; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--aide-surface-default); }
.readonly-note { font-size: 12px; color: var(--aide-text-muted); font-style: italic; margin-top: 14px; }
.btn { font-size: 12px; padding: 6px 11px; border-radius: var(--aide-radius-sm); border: 1px solid var(--aide-border); background: var(--aide-surface-default); color: var(--aide-text-secondary); cursor: pointer; }
.btn:disabled { opacity: 0.6; cursor: default; }
.btn-accent { background: var(--aide-accent); color: var(--aide-text-on-accent); border-color: var(--aide-accent); font-weight: 600; }
.btn-ghost { background: transparent; }
</style>