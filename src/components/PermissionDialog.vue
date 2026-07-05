<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import type { PermissionRequest } from "@/types/chat";
import { marked } from "@/utils/markdown";

interface QuestionOption {
  label: string;
  description: string;
}

interface QuestionSpec {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

const props = defineProps<{
  permission: PermissionRequest | null;
}>();

const emit = defineEmits<{
  respond: [id: string, approved: boolean, always?: boolean, answers?: Record<string, string>];
}>();

/** ExitPlanMode = plan 模式的出口确认：呈现的是"批准这份计划"而不是
 *  "允许一次工具调用"，计划正文按 Markdown 渲染，批准后 sidecar 自动切回默认模式。 */
const isPlanApproval = computed(() => props.permission?.name === "ExitPlanMode");

/** AskUserQuestion：Claude 提出的澄清问题——本质仍是一次 canUseTool 调用，但语义是
 *  "回答问题"而非"批准操作"，需要真正可选的问题/选项 UI，而不是通用允许/拒绝弹窗
 *  （此前的缺口：只给了允许/拒绝，用户从未被问到具体选项，模型收到"用户没有回答"）。
 *  这里只负责收集选择、打包成 answers；把 answers 重组进 SDK 要求的 updatedInput
 *  是 Claude 专属语义，留在 sidecar（agent-sidecar/src/permissions.ts）处理——和
 *  ExitPlanMode 一样，前端按工具名特判的只是"用哪种 UI 展示"，协议本身仍是
 *  {id, name, input} / (id, approved, always?, answers?) 的通用形状。 */
const isQuestion = computed(() => props.permission?.name === "AskUserQuestion");

const planHtml = computed(() => {
  if (!isPlanApproval.value) return "";
  const input = props.permission?.input as Record<string, unknown> | undefined;
  return marked.parse(String(input?.plan ?? "")) as string;
});

const questions = computed<QuestionSpec[]>(() => {
  if (!isQuestion.value) return [];
  const input = props.permission?.input as { questions?: QuestionSpec[] } | undefined;
  return input?.questions ?? [];
});

// 每题的选择状态：下标 -> 选中的 label 列表（单选最多 1 个，多选可多个）。
// 选"其他"时改用 freeText，两者互斥（选项 click 会清空 freeText 状态，反之亦然）。
const selections = reactive<Record<number, string[]>>({});
const freeText = reactive<Record<number, string>>({});
const useFreeText = reactive<Record<number, boolean>>({});

watch(
  questions,
  (qs) => {
    Object.keys(selections).forEach((k) => delete selections[Number(k)]);
    Object.keys(freeText).forEach((k) => delete freeText[Number(k)]);
    Object.keys(useFreeText).forEach((k) => delete useFreeText[Number(k)]);
    qs.forEach((_, i) => {
      selections[i] = [];
      freeText[i] = "";
      useFreeText[i] = false;
    });
  },
  { immediate: true },
);

function toggleOption(qi: number, label: string, multiSelect?: boolean) {
  useFreeText[qi] = false;
  const cur = selections[qi] ?? [];
  if (multiSelect) {
    selections[qi] = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
  } else {
    selections[qi] = [label];
  }
}

function selectFreeText(qi: number) {
  useFreeText[qi] = true;
  selections[qi] = [];
}

const canSubmitQuestions = computed(() =>
  questions.value.length > 0 &&
  questions.value.every((_, i) => (useFreeText[i] ? freeText[i]?.trim().length > 0 : (selections[i]?.length ?? 0) > 0)),
);

function submitAnswers() {
  if (!props.permission || !canSubmitQuestions.value) return;
  const answers: Record<string, string> = {};
  questions.value.forEach((q, i) => {
    answers[q.question] = useFreeText[i] ? freeText[i].trim() : selections[i].join(", ");
  });
  emit("respond", props.permission.id, true, undefined, answers);
}

/** "总是允许"按钮本身要不要用警示色——目前只有它会切到 bypassPermissions
 *  （本次会话跳过所有工具确认）这种最激进的模式时才标红，其余（addRules/
 *  acceptEdits 等）维持普通按钮观感，不过度报警。 */
const isAlwaysAllowDangerous = computed(() => (props.permission?.alwaysAllowLabel ?? "").startsWith("自动模式"));

const inputSummary = computed(() => {
  if (!props.permission) return "";
  const input = props.permission.input as Record<string, unknown>;
  if (props.permission.name === "Bash") return `命令：${input?.command ?? ""}`;
  if (["Write", "Edit"].includes(props.permission.name)) return `文件：${input?.file_path ?? ""}`;
  if (props.permission.name === "WebFetch") return `URL：${input?.url ?? ""}`;
  return JSON.stringify(input, null, 2).slice(0, 200);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="permission" class="perm-overlay">
      <div class="perm-dialog" :class="{ 'perm-dialog--plan': isPlanApproval, 'perm-dialog--question': isQuestion }">
        <h3 class="perm-title">
          <template v-if="isPlanApproval">批准执行计划？</template>
          <template v-else-if="isQuestion">Claude 有问题要问你</template>
          <template v-else>允许工具调用：<span class="perm-tool-name">{{ permission.name }}</span></template>
        </h3>
        <!-- 标注这次请求是主线程还是某个子代理发起的——没有它，子代理跑到一半突然
             弹出权限框，用户完全不知道是谁在问（子代理没有独立窗口，只有一张可折叠
             的进度卡片，很容易被当成"平白无故弹出来的"）。 -->
        <div v-if="permission.fromSubagent" class="perm-subagent-badge">
          🧩 来自子代理：{{ permission.fromSubagent.agentName }}
        </div>
        <!-- plan 来自本会话模型输出，信任边界与 ChatMessage 的 v-html="marked.parse(...)" 完全一致 -->
        <div v-if="isPlanApproval" class="perm-plan" v-html="planHtml" />
        <div v-else-if="isQuestion" class="perm-questions">
          <div v-for="(q, qi) in questions" :key="q.question" class="perm-question">
            <div class="perm-question-head">
              <span class="perm-question-chip">{{ q.header }}</span>
              <span class="perm-question-text">{{ q.question }}</span>
            </div>
            <div class="perm-options">
              <button
                v-for="opt in q.options"
                :key="opt.label"
                type="button"
                class="perm-option"
                :class="{ 'perm-option--selected': !useFreeText[qi] && selections[qi]?.includes(opt.label) }"
                @click="toggleOption(qi, opt.label, q.multiSelect)"
              >
                <div class="perm-option-label">{{ opt.label }}</div>
                <div class="perm-option-desc">{{ opt.description }}</div>
              </button>
              <button
                type="button"
                class="perm-option perm-option--other"
                :class="{ 'perm-option--selected': useFreeText[qi] }"
                @click="selectFreeText(qi)"
              >
                <div class="perm-option-label">其他…</div>
              </button>
            </div>
            <input
              v-if="useFreeText[qi]"
              v-model="freeText[qi]"
              type="text"
              class="perm-freetext"
              placeholder="输入你的回答"
            />
          </div>
        </div>
        <pre v-else class="perm-input">{{ inputSummary }}</pre>
        <div class="perm-actions">
          <template v-if="isQuestion">
            <button class="perm-btn perm-btn--deny" @click="emit('respond', permission.id, false)">跳过</button>
            <button
              class="perm-btn perm-btn--allow"
              :disabled="!canSubmitQuestions"
              @click="submitAnswers"
            >
              提交回答
            </button>
          </template>
          <template v-else>
            <button class="perm-btn perm-btn--deny" @click="emit('respond', permission.id, false)">
              {{ isPlanApproval ? "继续修改计划" : "拒绝" }}
            </button>
            <button
              v-if="!isPlanApproval"
              class="perm-btn perm-btn--always"
              :class="{ 'perm-btn--always-danger': isAlwaysAllowDangerous }"
              @click="emit('respond', permission.id, true, true)"
            >
              {{ permission.alwaysAllowLabel ?? "总是允许" }}
            </button>
            <button class="perm-btn perm-btn--allow" @click="emit('respond', permission.id, true)">
              {{ isPlanApproval ? "批准并开始执行" : "允许" }}
            </button>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.perm-overlay {
  position: fixed;
  inset: 0;
  z-index: 9000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--aide-bg-overlay);
}

.perm-dialog {
  width: 480px;
  border-radius: var(--aide-radius-md);
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border);
  box-shadow: var(--aide-shadow-lg);
  padding: 20px;
}

.perm-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--aide-text-primary);
  margin-bottom: 8px;
}

.perm-tool-name {
  color: var(--aide-accent);
}

.perm-subagent-badge {
  display: inline-block;
  font-size: 11px;
  color: var(--aide-text-muted);
  background: var(--aide-surface-default);
  border-radius: 999px;
  padding: 2px 10px;
  margin-bottom: 10px;
}

.perm-dialog--plan,
.perm-dialog--question {
  width: 640px;
  max-width: calc(100vw - 48px);
}

.perm-questions {
  max-height: 60vh;
  overflow: auto;
  margin-bottom: 16px;
}

.perm-question + .perm-question {
  margin-top: 18px;
  padding-top: 18px;
  border-top: 1px solid var(--aide-border);
}

.perm-question-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 10px;
}

.perm-question-chip {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--aide-surface-default);
  color: var(--aide-text-muted);
}

.perm-question-text {
  font-size: 13px;
  font-weight: 500;
  color: var(--aide-text-primary);
}

.perm-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.perm-option {
  text-align: left;
  border-radius: var(--aide-radius-sm);
  border: 1px solid var(--aide-border);
  background: var(--aide-bg-deep);
  padding: 8px 12px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.perm-option:hover {
  border-color: var(--aide-accent);
}

.perm-option--selected {
  border-color: var(--aide-accent);
  background: var(--aide-surface-hover);
}

.perm-option-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--aide-text-primary);
}

.perm-option-desc {
  font-size: 12px;
  color: var(--aide-text-muted);
  margin-top: 2px;
}

.perm-option--other .perm-option-label {
  font-weight: 400;
  color: var(--aide-text-secondary);
}

.perm-freetext {
  width: 100%;
  margin-top: 8px;
  border-radius: var(--aide-radius-sm);
  border: 1px solid var(--aide-border);
  background: var(--aide-bg-deep);
  color: var(--aide-text-primary);
  padding: 7px 10px;
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
}

.perm-freetext:focus {
  border-color: var(--aide-accent);
}

.perm-plan {
  max-height: 50vh;
  overflow: auto;
  border-radius: var(--aide-radius-sm);
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border);
  padding: 10px 14px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--aide-text-secondary);
  margin-bottom: 16px;
}

.perm-plan :deep(h1),
.perm-plan :deep(h2),
.perm-plan :deep(h3) {
  font-size: 13px;
  font-weight: 600;
  color: var(--aide-text-primary);
  margin: 10px 0 4px;
}

.perm-plan :deep(p),
.perm-plan :deep(ul),
.perm-plan :deep(ol) {
  margin: 4px 0;
}

.perm-plan :deep(ul),
.perm-plan :deep(ol) {
  padding-left: 18px;
}

.perm-plan :deep(code) {
  font-family: 'Cascadia Code', 'Consolas', monospace;
  font-size: 12px;
  background: var(--aide-surface-default);
  border-radius: 3px;
  padding: 0 4px;
}

.perm-plan :deep(pre) {
  background: var(--aide-surface-default);
  border-radius: var(--aide-radius-sm);
  padding: 8px 10px;
  overflow-x: auto;
  margin: 6px 0;
}

.perm-input {
  max-height: 128px;
  overflow: auto;
  border-radius: var(--aide-radius-sm);
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border);
  padding: 8px 12px;
  font-size: 12px;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  color: var(--aide-text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  margin-bottom: 16px;
}

.perm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.perm-btn {
  border-radius: var(--aide-radius-sm);
  border: none;
  padding: 6px 16px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}

.perm-btn--deny {
  background: var(--aide-surface-default);
  color: var(--aide-text-secondary);
}

.perm-btn--deny:hover {
  background: var(--aide-surface-hover);
}

.perm-btn--always {
  background: var(--aide-surface-default);
  color: var(--aide-text-secondary);
  border: 1px solid var(--aide-border);
}

.perm-btn--always:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}

/* 会切到 bypassPermissions（跳过所有确认）时标红，其余 addRules/acceptEdits
 * 等场景维持普通按钮观感，不过度报警。 */
.perm-btn--always-danger {
  border-color: var(--aide-danger);
  color: var(--aide-danger);
}

.perm-btn--always-danger:hover {
  background: color-mix(in srgb, var(--aide-danger) 12%, transparent);
  color: var(--aide-danger);
}

.perm-btn--allow {
  background: var(--aide-accent);
  color: var(--aide-text-on-accent);
  font-weight: 500;
}

.perm-btn--allow:hover {
  background: var(--aide-accent-hover);
}

.perm-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
