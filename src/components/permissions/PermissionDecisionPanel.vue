<script setup lang="ts">
import { ref, computed } from "vue";
import ThemedSelect from "@/components/ThemedSelect.vue";
import { permissionsApi } from "@/api/permissions";
import type { PermissionExplanationView, ChainStatus } from "@/types/permissions";

const TOOL_OPTIONS = ["Bash", "Read", "Write", "Edit", "WebFetch", "Grep", "Glob"]
  .map((t) => ({ value: t, label: t }));

const tool = ref("Bash");
const inputValue = ref("");
const loading = ref(false);
const result = ref<PermissionExplanationView | null>(null);
const error = ref<string | null>(null);

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]);
const inputPlaceholder = computed(() =>
  FILE_TOOLS.has(tool.value) ? "/path/to/file.txt" : "pnpm test",
);
const inputLabel = computed(() => (FILE_TOOLS.has(tool.value) ? "file_path" : "command"));

const STATUS_LABEL: Record<ChainStatus, string> = {
  selected: "选中",
  shadowed_by_specificity: "被更具体规则遮蔽",
  overridden_by_deny: "被拒绝规则覆盖",
  overridden_by_lower_scope: "被更高优先级作用域覆盖",
};

async function onExplain() {
  loading.value = true;
  error.value = null;
  result.value = null;
  try {
    const input = FILE_TOOLS.has(tool.value)
      ? { file_path: inputValue.value }
      : { command: inputValue.value };
    result.value = await permissionsApi.explain(tool.value, input);
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

const DECISION_LABEL: Record<string, string> = {
  allow: "允许",
  deny: "拒绝",
  ask: "询问",
  defer: "回退（无规则匹配）",
};
</script>

<template>
  <section class="decision-panel">
    <h3 class="panel-title">决策预演</h3>
    <p class="panel-hint">输入一次工具调用，查看当前策略会如何裁决（仅解释，不执行）。</p>
    <div class="field-row">
      <label class="field">
        <span class="field-label">工具</span>
        <ThemedSelect v-model="tool" :options="TOOL_OPTIONS" block />
      </label>
      <label class="field">
        <span class="field-label">{{ inputLabel }}</span>
        <input v-model="inputValue" class="text-input" :placeholder="inputPlaceholder" />
      </label>
    </div>
    <button class="btn-secondary" :disabled="loading" @click="onExplain">
      {{ loading ? "解释中…" : "解释" }}
    </button>

    <p v-if="error" class="form-error">{{ error }}</p>
    <div v-if="result" class="decision-result">
      <div class="final-decision" :class="result.finalDecision">
        最终裁决：{{ DECISION_LABEL[result.finalDecision] ?? result.finalDecision }}
      </div>
      <p v-if="result.reason" class="reason">{{ result.reason }}</p>
      <ul class="chain">
        <li
          v-for="(line, i) in result.chain"
          :key="i"
          class="chain-entry"
          :class="line.status"
        >
          <span class="chain-status">{{ STATUS_LABEL[line.status] }}</span>
          <span class="chain-rule">{{ line.ruleId }}</span>
          <span class="chain-scope">{{ line.scope }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.decision-panel {
  margin-top: 12px;
  padding: 12px;
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  background: var(--aide-bg-base);
  display: grid;
  /* 单列轨道必须 minmax(0,1fr)：否则 field-row 的 input 固有宽度会撑破轨道，
     把按钮等 stretch 子项一起顶出面板右缘（窄面板必现） */
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
}
.panel-title { margin: 0; font-size: 12.5px; font-weight: 600; color: var(--aide-text-primary); }
.panel-hint { margin: 0; color: var(--aide-text-muted); font-size: 11.5px; }
.field-row { display: grid; grid-template-columns: 108px minmax(0, 1fr); gap: 8px; }
.field { display: grid; gap: 4px; }
.field-label { font-size: 11px; color: var(--aide-text-secondary); }
.text-input {
  width: 100%;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  color: var(--aide-text-primary);
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  font-size: 11.5px;
}
.text-input:focus { outline: none; border-color: var(--aide-accent); }
.btn-secondary {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--aide-border);
  background: var(--aide-surface-default);
  color: var(--aide-text-secondary);
  border-radius: var(--aide-radius-sm);
  font-size: 11.5px;
  cursor: pointer;
}
.btn-secondary:disabled { opacity: 0.6; cursor: not-allowed; }
.form-error { color: var(--aide-danger); font-size: 12px; margin: 0; }
.decision-result { display: grid; gap: 8px; }
.final-decision { font-weight: 600; font-size: 13px; }
.final-decision.allow { color: var(--aide-success); }
.final-decision.deny { color: var(--aide-danger); }
.final-decision.ask { color: var(--aide-warning); }
.final-decision.defer { color: var(--aide-text-secondary); }
.reason { margin: 0; color: var(--aide-text-secondary); font-size: 12px; }
.chain { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.chain-entry {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr) auto;
  gap: 8px;
  padding: 5px 8px;
  border-radius: var(--aide-radius-sm);
  background: var(--aide-bg-deep);
  font-size: 10.5px;
  font-family: var(--aide-font-mono, monospace);
}
.chain-entry.overridden_by_deny { color: var(--aide-danger); }
.chain-entry.selected { color: var(--aide-success); }
.chain-entry.shadowed_by_specificity,
.chain-entry.overridden_by_lower_scope { color: var(--aide-text-muted); }
/* ruleId 是 36 位 UUID，窄面板下必须省略 */
.chain-rule {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chain-scope { color: var(--aide-text-muted); }
</style>