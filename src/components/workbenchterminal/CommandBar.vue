<script setup lang="ts">
import { nextTick, onMounted, ref } from "vue";
import AInput from "../../ui/AInput.vue";
import { useWorkbenchTerminal } from "../../composables/useWorkbenchTerminal";

const props = defineProps<{
  sessionId: string;
  blockId: number;
  initialRequest: string;
  actionable: boolean;
}>();
const wb = useWorkbenchTerminal();
const input = ref<{ focus: () => void; select: () => void }>();
const command = ref("");
const draft = ref("");
const error = ref("");
const editing = ref(false);
const submitting = ref(false);
const phase = ref<"generating" | "review" | "submitted" | "rejected" | "failed">("generating");

onMounted(async () => {
  try {
    const result = await wb.suggestCommand(props.sessionId, props.initialRequest, props.blockId);
    if (phase.value !== "generating") return;
    if (!result) {
      error.value = "请补充要执行的操作或目标路径";
      phase.value = "failed";
      return;
    }
    command.value = result;
    phase.value = "review";
  } catch (e) {
    if (phase.value !== "generating") return;
    error.value = e instanceof Error ? e.message : String(e);
    phase.value = "failed";
  }
});

async function approve() {
  if (!props.actionable || submitting.value || phase.value !== "review") return;
  const value = (editing.value ? draft.value : command.value).trim();
  if (!value) return;
  submitting.value = true;
  error.value = "";
  try {
    await wb.executeSuggestion(props.sessionId, value, props.blockId);
    command.value = value;
    editing.value = false;
    phase.value = "submitted";
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    submitting.value = false;
  }
}

function modify() {
  draft.value = command.value;
  editing.value = true;
  nextTick(() => {
    input.value?.focus();
    input.value?.select();
  });
}

function reject() {
  if (!props.actionable || submitting.value) return;
  phase.value = "rejected";
  editing.value = false;
  wb.rejectSuggestion(props.sessionId, props.blockId);
}
</script>

<template>
  <section
    class="terminal-command-card"
    aria-label="命令预览"
    @mousedown.stop
    @click.stop
    @keydown.stop
  >
    <div class="terminal-command-row">
      <span v-if="error" class="terminal-command-error" role="alert" :title="error">{{ error }}</span>
      <span v-else class="terminal-command-status" role="status">
        <template v-if="phase === 'generating'">正在生成命令…</template>
        <template v-else-if="phase === 'submitted'">已提交</template>
        <template v-else-if="phase === 'rejected'">已拒绝</template>
        <template v-else-if="submitting">正在提交…</template>
        <template v-else-if="!actionable">已失效</template>
        <template v-else>执行此命令？</template>
      </span>
      <div v-if="actionable && (phase === 'generating' || phase === 'review')" class="terminal-command-actions">
        <button
          v-if="phase === 'review'"
          class="terminal-command-allow"
          type="button"
          :disabled="submitting || (editing && !draft.trim())"
          @click="approve"
        >允许</button>
        <button v-if="phase === 'review' && !editing" type="button" :disabled="submitting" @click="modify">修改</button>
        <button type="button" :disabled="submitting" @click="reject">拒绝</button>
      </div>
    </div>
    <form v-if="editing && (actionable || submitting)" class="terminal-command-edit" @submit.prevent="approve" @keydown.esc.prevent="editing = false">
      <AInput ref="input" v-model="draft" aria-label="修改命令" maxlength="8192" :disabled="submitting" />
    </form>
    <code v-else-if="command" class="terminal-command-preview">{{ command }}</code>
  </section>
</template>

<style scoped>
.terminal-command-card {
  box-sizing: border-box;
  width: calc(100% - 2 * var(--aide-space-unit));
  height: 100%;
  padding: var(--aide-space-unit) calc(2 * var(--aide-space-unit));
  overflow: hidden;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  color: var(--aide-text-primary);
  font: 12px/1.3 var(--aide-font-sans, sans-serif);
}
.terminal-command-row,
.terminal-command-actions {
  display: flex;
  align-items: center;
  gap: var(--aide-space-unit);
}
.terminal-command-row { min-height: calc(6 * var(--aide-space-unit)); }
.terminal-command-status,
.terminal-command-error {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.terminal-command-actions { flex: none; margin-left: auto; }
.terminal-command-actions button {
  padding: 0 var(--aide-space-unit);
  color: var(--aide-text-primary);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  line-height: 1.6;
}
.terminal-command-actions button:hover { background: var(--aide-surface-default); }
.terminal-command-actions button:disabled { opacity: 0.5; }
.terminal-command-actions .terminal-command-allow {
  background: var(--aide-control-selected-bg);
  color: var(--aide-control-selected-text);
}
.terminal-command-preview,
.terminal-command-edit {
  display: block;
  margin-top: var(--aide-space-unit);
}
.terminal-command-preview {
  overflow: auto hidden;
  padding: var(--aide-space-unit);
  border-radius: var(--aide-radius-sm);
  background: var(--aide-bg-deep);
  white-space: pre;
  scrollbar-width: thin;
  user-select: text;
}
.terminal-command-edit :deep(input) {
  padding: var(--aide-space-unit);
  font-family: monospace;
}
.terminal-command-error { color: var(--aide-danger); }
</style>
