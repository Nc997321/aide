<script setup lang="ts">
import { computed, ref } from "vue";
import { api, type HandoffTarget, type SessionHandoff, type SessionContinued } from "@aide/sdk/api";
import { sessionIdentityStore } from "@aide/sdk/composables/sessionIdentity";
import { useProviders } from "@aide/sdk/composables/useProviders";
import { useSessionWorkspaces } from "@aide/sdk/composables/useSessionWorkspaces";
import { isDailyKey } from "@aide/sdk/utils/dailyWorkspace";
import { normalizeEffortOption } from "@aide/sdk/utils/effort";
import { defaultEffortFor } from "./ChatPanel/effortDefault";

const props = defineProps<{ sourceId: string; sourceTitle: string }>();
const emit = defineEmits<{ submit: [value: SessionContinued]; cancel: [] }>();
const focus = ref("");
const draft = ref<SessionHandoff | null>(null);
const summary = ref("");
const busy = ref(false);
const error = ref("");
const { activeProvider, activeProviderId } = useProviders();
// 与空白新会话同源：只读当前全局供应商的模型列表，不恢复源会话身份。
const target = computed<HandoffTarget>(() => ({
  provider: activeProviderId.value,
  model: sessionIdentityStore.activeProviderModels()[0]?.value ?? "",
  effort: defaultEffortFor({ remembered: null,
    daily: isDailyKey(useSessionWorkspaces().workspaceOf(props.sourceId)?.wsKey ?? ""),
    providerDefault: normalizeEffortOption(activeProvider.value.effortLevel) }),
}));
async function generate() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    draft.value = await api.prepareSessionHandoff(props.sourceId, focus.value, { ...target.value });
    summary.value = draft.value.summary;
  } catch (e) { error.value = String(e); }
  finally { busy.value = false; }
}
async function continueSession() {
  if (!draft.value || busy.value || !summary.value.trim()) return;
  busy.value = true;
  error.value = "";
  try { emit("submit", await api.continueSessionHandoff(draft.value.id, summary.value, { ...target.value })); }
  catch (e) { error.value = String(e); }
  finally { busy.value = false; }
}
</script>

<template>
  <div class="handoff">
    <p>接续自「{{ sourceTitle }}」。新会话只带交接摘要，历史细节可按需查阅。</p>
    <p class="hint">当前新会话配置：{{ activeProvider.name }} / {{ target.model || '供应商默认模型' }}。生成摘要和创建会话分别使用点击时的当前配置。</p>
    <template v-if="!draft">
      <label for="handoff-focus">下一阶段主要做什么（可选）</label>
      <textarea id="handoff-focus" v-model="focus" rows="3" maxlength="2000" :disabled="busy" placeholder="例如：继续完成测试，重点保留之前的设计约束" />
      <p class="hint">生成摘要会将文字记录交给当前选定的供应商，产生一次或多次模型调用费用。图片和子代理内部过程不在交接范围内，旧会话保持原样。</p>
    </template>
    <template v-else>
      <label for="handoff-summary">交接摘要（可编辑）</label>
      <textarea id="handoff-summary" v-model="summary" rows="16" maxlength="12000" :disabled="busy" />
      <p class="hint">{{ summary.length }} / 12000 字 · 摘要基于生成开始时的记录，之后的新消息不包含在内。沿用源工作区；供应商、模型和档位按普通新会话选择，临时授权不继承。新会话先确认交接，等待你的下一条指示。</p>
    </template>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="busy" role="status">{{ draft ? '正在创建新会话…' : '正在整理完整文字快照，长会话可能需要几分钟…' }}</p>
    <footer>
      <button type="button" :disabled="busy" @click="emit('cancel')">取消</button>
      <button v-if="!draft" type="button" :disabled="busy" @click="generate">生成交接摘要</button>
      <button v-else type="button" :disabled="busy || !summary.trim()" @click="continueSession">接续到新会话</button>
    </footer>
  </div>
</template>

<style scoped>
.handoff { display: flex; flex-direction: column; gap: calc(var(--aide-space-unit) * 3); color: var(--aide-text-primary); }
p { margin: 0; }
.hint { color: var(--aide-text-muted); font-size: 12px; }
textarea { width: 100%; resize: vertical; padding: calc(var(--aide-space-unit) * 3); color: var(--aide-text-primary); background: var(--aide-bg-base); border: 1px solid var(--aide-border); border-radius: var(--aide-radius-md); font: inherit; }
.error { color: var(--aide-danger); white-space: pre-wrap; }
footer { display: flex; justify-content: flex-end; gap: calc(var(--aide-space-unit) * 2); }
button { padding: calc(var(--aide-space-unit) * 2) calc(var(--aide-space-unit) * 3); background: var(--aide-surface-hover); color: var(--aide-text-primary); border: 1px solid var(--aide-border); border-radius: var(--aide-radius-md); cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
</style>
