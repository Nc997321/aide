<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import type { PermissionRequest } from "@/types/chat";
import { marked } from "@/utils/markdown";
import Icon from "./Icon.vue";

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
  /** 挂起的权限请求总数（含当前显示的这条）。模型并行调用多个工具时会同时
   *  发来多条请求，弹窗按队列逐条确认——大于 1 时提示用户后面还排着几条，
   *  避免"确认完一条又弹一条"显得像 bug。 */
  queueCount?: number;
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

/** 三种确认口吻用同一枚"火漆印"图钉，用图形区分种类：工具调用=锁、
 *  计划批准=清单、澄清提问=问号——不按具体工具名再细分图标，换新工具/
 *  第三方 provider 接入时也不用维护一张图标映射表。 */
const kind = computed<"plan" | "question" | "tool">(() =>
  isPlanApproval.value ? "plan" : isQuestion.value ? "question" : "tool",
);

const eyebrowLabel = computed(() => {
  if (kind.value === "plan") return "计划待批准";
  if (kind.value === "question") return "需要澄清";
  return "工具调用请求";
});

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
 *  acceptEdits 等）维持普通按钮观感，不过度报警。按 sidecar 给 bypassPermissions
 *  的 alwaysAllowLabel 前缀「跳过所有确认」判定（auto 模式走分类器、不在此列）。 */
const isAlwaysAllowDangerous = computed(() => (props.permission?.alwaysAllowLabel ?? "").startsWith("跳过所有确认"));

/** sidecar 送来的 alwaysAllowLabel 常带一段括注的生效范围，例如
 *  "自动接受编辑（本次会话）"——原来整句塞进一个按钮，中文括号会在任意
 *  宽度截断处折行，观感很差。这里按"主文案 +（范围说明）"拆成两行，
 *  拆不出括注（如默认的"总是允许"）就只显示主文案。 */
const alwaysSplit = computed(() => {
  const label = props.permission?.alwaysAllowLabel ?? "总是允许";
  const m = label.match(/^(.*)（(.+)）$/);
  return m ? { main: m[1], caption: m[2] } : { main: label, caption: null as string | null };
});

interface InputRow {
  label: string;
  value: string;
}

/** 常见工具的输入拆成"标签 + 值"两列（值用等宽字体单独一行展示，长命令/
 *  长路径不再和标签挤在同一行文本里）；认不出的工具名退回原始 JSON。 */
const inputRows = computed<InputRow[] | null>(() => {
  if (!props.permission) return null;
  const input = props.permission.input as Record<string, unknown>;
  const name = props.permission.name;
  if (name === "Bash") return [{ label: "命令", value: String(input?.command ?? "") }];
  if (name === "Write" || name === "Edit") return [{ label: "文件", value: String(input?.file_path ?? "") }];
  if (name === "WebFetch") return [{ label: "URL", value: String(input?.url ?? "") }];
  return null;
});

const inputJson = computed(() => {
  if (!props.permission || inputRows.value) return "";
  return JSON.stringify(props.permission.input, null, 2).slice(0, 200);
});
</script>

<template>
  <div v-if="permission" class="perm-dock">
    <div class="perm-dialog">
      <div class="perm-head">
        <span class="perm-seal" :class="`perm-seal--${kind}`" aria-hidden="true">
          <svg v-if="kind === 'tool'" width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" stroke="currentColor" stroke-width="1.3" />
            <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
          <svg v-else-if="kind === 'plan'" width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M3 4.5h10M3 8h10M3 11.5h6.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
          <span v-else class="perm-seal-glyph">?</span>
        </span>
        <div class="perm-head-text">
          <span class="perm-eyebrow">{{ eyebrowLabel }}</span>
          <span class="perm-title-main">
            <template v-if="isPlanApproval">批准执行这份计划？</template>
            <template v-else-if="isQuestion">Claude 有问题要问你</template>
            <template v-else><code class="perm-tool-chip">{{ permission.name }}</code></template>
          </span>
        </div>
        <span v-if="(queueCount ?? 0) > 1" class="perm-queue-badge">还有 {{ (queueCount ?? 0) - 1 }} 条待确认</span>
      </div>
      <!-- 标注这次请求是主线程还是某个子代理发起的——没有它，子代理跑到一半突然
           弹出权限框，用户完全不知道是谁在问（子代理没有独立窗口，只有一张可折叠
           的进度卡片，很容易被当成"平白无故弹出来的"）。 -->
      <!-- 来自子代理：方括号与 SubagentCallBlock 节点同形——消息流里见过这个括号，
           这里就懂「这条权限来自那条括号子线程」，跨表面呼应，不靠拼图块 emoji 暗示。 -->
      <div v-if="permission.fromSubagent" class="perm-subagent-badge">
        <Icon class="perm-subagent-bracket" name="bracket" :size="13" :stroke-width="1.6" /> 来自子代理：{{ permission.fromSubagent.agentName }}
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
      <div v-else class="perm-input">
        <div v-if="inputRows" class="perm-input-rows">
          <div v-for="row in inputRows" :key="row.label" class="perm-input-row">
            <span class="perm-input-label">{{ row.label }}</span>
            <code class="perm-input-value">{{ row.value }}</code>
          </div>
        </div>
        <pre v-else class="perm-input-raw">{{ inputJson }}</pre>
      </div>
      <div class="perm-actions">
        <template v-if="isQuestion">
          <button class="perm-btn perm-btn--ghost" @click="emit('respond', permission.id, false)">跳过</button>
          <button
            class="perm-btn perm-btn--solid"
            :disabled="!canSubmitQuestions"
            @click="submitAnswers"
          >
            提交回答
          </button>
        </template>
        <template v-else>
          <button class="perm-btn perm-btn--ghost" @click="emit('respond', permission.id, false)">
            {{ isPlanApproval ? "继续修改计划" : "拒绝" }}
          </button>
          <div class="perm-actions-primary">
            <button
              v-if="!isPlanApproval"
              class="perm-btn perm-btn--outline"
              :class="{ 'perm-btn--outline-danger': isAlwaysAllowDangerous }"
              @click="emit('respond', permission.id, true, true)"
            >
              <span class="perm-btn-main">{{ alwaysSplit.main }}</span>
              <span v-if="alwaysSplit.caption" class="perm-btn-caption">{{ alwaysSplit.caption }}</span>
            </button>
            <button class="perm-btn perm-btn--solid" @click="emit('respond', permission.id, true)">
              {{ isPlanApproval ? "批准并开始执行" : "允许" }}
            </button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 权限请求：GALLERY .perm — warning 渐变氛围框 + 图标盘 + mono 命令井 + 按钮行 */
.perm-dock {
  flex-shrink: 0;
  max-height: 45vh;
  overflow-y: auto;
  margin: 8px 12px 10px;
  border: 1px solid color-mix(in srgb, var(--aide-warning) 25%, transparent);
  border-radius: var(--aide-radius-lg);
  background: linear-gradient(180deg, color-mix(in srgb, var(--aide-warning) 5%, transparent), var(--aide-bg-base));
  box-shadow: var(--aide-highlight-inset), 0 0 24px color-mix(in srgb, var(--aide-warning) 7%, transparent);
  overflow: hidden;
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
}

@media (prefers-reduced-motion: no-preference) {
  .perm-dock {
    animation: perm-rise 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
}

@keyframes perm-rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.perm-dialog {
  padding: 0;
}

.perm-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
}

/* 图标盘：GALLERY .perm-ico */
.perm-seal {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--aide-warning) 15%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-warning) 35%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--aide-warning);
  font-size: 13px;
}

.perm-seal svg {
  color: var(--aide-warning);
}

.perm-seal-glyph {
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
}

.perm-head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.perm-eyebrow {
  font-size: 11px;
  color: var(--aide-text-muted);
}

.perm-title-main {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--aide-text-primary);
  line-height: 1.4;
}

.perm-tool-chip {
  display: inline-block;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--aide-warning);
  background: color-mix(in srgb, var(--aide-warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--aide-warning) 25%, transparent);
  border-radius: var(--aide-radius-sm);
  padding: 1px 7px;
}

.perm-queue-badge {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 500;
  color: var(--aide-text-muted);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  padding: 1px 6px;
  white-space: nowrap;
}

.perm-subagent-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--aide-text-muted);
  background: color-mix(in srgb, var(--aide-warning) 5%, transparent);
  border-radius: 999px;
  padding: 2px 10px;
  margin: 0 14px 10px;
}

.perm-subagent-bracket {
  color: var(--aide-warning);
}

/* mono 命令井：GALLERY .perm-cmd */
.perm-input {
  margin: 0 14px 12px;
  padding: 10px 12px;
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-sm);
  font-family: 'Cascadia Code', 'Consolas', monospace;
  font-size: 11.5px;
  color: var(--aide-text-secondary);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, .3);
  max-height: 128px;
  overflow: auto;
}

.perm-input-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.perm-input-row + .perm-input-row {
  padding-top: 8px;
  border-top: 1px solid var(--aide-border-subtle, var(--aide-border));
}

.perm-input-label {
  display: block;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--aide-text-muted);
  margin-bottom: 3px;
  font-family: 'Inter', 'Noto Sans SC', sans-serif;
}

.perm-input-value {
  display: block;
  font-size: 12px;
  color: var(--aide-text-primary);
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.5;
}

.perm-input-raw {
  margin: 0;
  font-size: 12px;
  color: var(--aide-text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
}

.perm-plan {
  margin: 0 14px 12px;
  padding: 10px 14px;
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-sm);
  font-size: 13px;
  line-height: 1.6;
  color: var(--aide-text-secondary);
  max-height: 200px;
  overflow: auto;
}

.perm-questions {
  margin: 0 14px 12px;
}

.perm-question + .perm-question {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid color-mix(in srgb, var(--aide-warning) 15%, transparent);
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
  background: color-mix(in srgb, var(--aide-warning) 10%, transparent);
  color: var(--aide-warning);
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
  transition: all var(--aide-ease-t);
}

.perm-option:hover {
  border-color: var(--aide-warning);
  background: color-mix(in srgb, var(--aide-warning) 5%, transparent);
}

.perm-option--selected {
  border-color: var(--aide-warning);
  background: color-mix(in srgb, var(--aide-warning) 8%, transparent);
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
  border-color: var(--aide-warning);
}

/* 按钮行：GALLERY .perm-foot */
.perm-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 14px;
}

.perm-actions-primary {
  display: flex;
  align-items: center;
  gap: 8px;
}

.perm-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border-radius: var(--aide-radius-md);
  border: 1px solid var(--aide-border);
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
  font-size: 12.5px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  box-shadow: var(--aide-highlight-inset), var(--aide-shadow-sm);
  transition: all var(--aide-ease-t);
  padding: 7px 15px;
}

.perm-btn:hover:not(:disabled) {
  background: var(--aide-surface-hover);
  border-color: var(--aide-border-strong);
  transform: translateY(-1px);
}

.perm-btn--ghost {
  background: transparent;
  border-color: transparent;
  color: var(--aide-text-secondary);
  box-shadow: none;
}

.perm-btn--ghost:hover:not(:disabled) {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
  transform: translateY(-1px);
}

.perm-btn--outline {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 5px 14px;
  border-color: var(--aide-border);
  background: transparent;
  color: var(--aide-text-secondary);
}

.perm-btn--outline:hover:not(:disabled) {
  border-color: var(--aide-warning);
  color: var(--aide-text-primary);
  transform: translateY(-1px);
}

.perm-btn-main {
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.3;
}

.perm-btn-caption {
  font-size: 10px;
  color: var(--aide-text-muted);
  line-height: 1.2;
}

.perm-btn--outline-danger {
  border-color: color-mix(in srgb, var(--aide-danger) 35%, transparent);
  color: var(--aide-danger);
}

.perm-btn--outline-danger .perm-btn-caption {
  color: var(--aide-danger);
  opacity: 0.75;
}

.perm-btn--outline-danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--aide-danger) 12%, transparent);
  color: var(--aide-danger);
  transform: translateY(-1px);
}

.perm-btn--solid {
  background: var(--aide-accent-gradient);
  border-color: rgba(255, 255, 255, .22);
  color: var(--aide-text-on-accent);
  font-weight: 600;
  box-shadow: var(--aide-accent-glow), inset 0 1px 0 rgba(255, 255, 255, .32);
}

.perm-btn--solid:hover:not(:disabled) {
  filter: brightness(1.07);
  transform: translateY(-1px);
}

.perm-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  transform: none !important;
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
</style>
