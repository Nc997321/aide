<script setup lang="ts">
import { ref, computed, reactive, watch } from "vue";
import type { PermissionRequest } from "@/types/chat";
import type { PermissionRuleDraft, PermissionScope } from "@/types/permissions";
import { deriveRememberRule, describeRememberRule } from "@/utils/permissionRuleDerivation";
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
  /** 「允许并记住」要落到的作用域（由 ChatPanel 按 scope 可用性解析后传入）。
   *  为 null 表示无可持久化作用域可用——不显示「记住」按钮。
   *  仅对工具调用请求有意义（计划批准 / 澄清提问不是工具调用）。 */
  rememberScope?: PermissionScope | null;
  /** 当前权限模式（ChatPanel 的 selectedPermissionMode）。编辑工具在非编辑模式下
   *  把「允许并记住」换成「进入编辑模式」——对不了解规则机制的用户，逐条点允许/
   *  记住都不解渴，切模式才是"之后别再问"的那个选项（对齐 CLI 的 "allow all
   *  edits this session"）。可能为空串（模式清单还没就位），按"显示"处理。 */
  currentMode?: string;
}>();

const emit = defineEmits<{
  respond: [
    id: string,
    approved: boolean,
    answers?: Record<string, string>,
    nextMode?: string,
    /** 仅「允许并记住」按钮带：本次放行 + 把这条 allow 规则持久化到指定作用域。
     *  ChatPanel 收到后先调 permissionsApi.create 落盘（Rust 广播新快照给 sidecar），
     *  再走正常 approve。纯前端字段，不进 SidecarCommand 协议。 */
    persistRule?: { scope: PermissionScope; rule: PermissionRuleDraft },
  ];
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
 *  {id, name, input} / (id, approved, answers?, nextMode?) 的通用形状。 */
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

/** 折叠态：计划批准 / 澄清提问弹窗较高，与顶部 TaskListPanel 一同挤压时会把消息区
 *  夹到几乎不可见（perm-dock max-height 45vh）。右上角折叠按钮把正文收起、只留头部
 *  条，把高度还给 .chat-messages（flex:1 自动回收），用户回看上文后再展开决定。
 *  仅 plan / question 给按钮——工具调用弹窗本就矮（输入封顶 128px），折叠省不了多少。
 *  组件常驻挂载（外层 v-if 在内层 .perm-dock），collapsed 会跨请求残留，故新请求到达
 *  时复位为展开，否则下一条计划会被默认收起、用户看不到新内容。 */
const collapsed = ref(false);
function toggleCollapse() {
  collapsed.value = !collapsed.value;
}
watch(
  () => props.permission?.id,
  () => {
    collapsed.value = false;
  },
);

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
  emit("respond", props.permission.id, true, answers);
}

// ── 「允许并记住」：把这次工具调用就地推导成一条 allow 规则 ──
// 推导规则按工具分（Bash→命令前缀、文件工具→所在文件夹、WebFetch→完整 URL、
// 其它→工具级），推不出来（空命令 / 空路径）或没有可持久化作用域时不显示按钮。
const rememberDraft = computed<PermissionRuleDraft | null>(() =>
  props.permission ? deriveRememberRule(props.permission.name, props.permission.input) : null,
);

// ── 「进入编辑模式」：编辑类工具的"一劳永逸"选项 ──
// 手动模式下编辑会一直弹窗；对不熟悉规则机制的用户，「允许并记住」（记一条文件夹
// 规则）不如直接切到编辑模式解渴。已在编辑/自动/最高权限模式时弹窗本就不该为
// 编辑出现（出现了说明是 ask 规则等例外），此时藏起本按钮、露出「允许并记住」。
const EDIT_TOOL_NAMES = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const canEnterEditMode = computed(
  () =>
    !!props.permission &&
    EDIT_TOOL_NAMES.has(props.permission.name) &&
    !["acceptEdits", "auto", "bypassPermissions"].includes(props.currentMode ?? ""),
);

const canRemember = computed(
  () =>
    !isPlanApproval.value &&
    !isQuestion.value &&
    !canEnterEditMode.value &&
    !!rememberDraft.value &&
    !!props.rememberScope,
);
const rememberDescription = computed(() => {
  if (!rememberDraft.value || !props.rememberScope) return "";
  return describeRememberRule(rememberDraft.value, props.rememberScope);
});
function emitAllowAndRemember() {
  if (!props.permission || !rememberDraft.value || !props.rememberScope) return;
  emit("respond", props.permission.id, true, undefined, undefined, {
    scope: props.rememberScope,
    rule: rememberDraft.value,
  });
}

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
        <button
          v-if="isPlanApproval || isQuestion"
          type="button"
          class="perm-collapse"
          :aria-expanded="collapsed ? 'false' : 'true'"
          :title="collapsed ? '展开' : '收起'"
          @click="toggleCollapse"
        >
          <span class="perm-collapse-caret">{{ collapsed ? "▴" : "▾" }}</span>
        </button>
      </div>
      <div class="perm-body" v-show="!collapsed">
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
      <!-- 「允许并记住」预览：点之前先让用户看清将记住什么、落到哪个作用域。
           只在工具调用且有可推导规则时出现（计划批准 / 澄清提问不显示）。 -->
      <div v-if="canRemember" class="perm-remember-hint">{{ rememberDescription }}</div>
      <!-- 「进入编辑模式」后果说明：不熟机制的用户需要知道点下去之后不再逐条弹。 -->
      <div v-if="canEnterEditMode" class="perm-remember-hint">
        本次放行，并切换到编辑模式——之后本会话所有文件编辑自动接受，不再逐条确认
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
          <button class="perm-btn perm-btn--ghost" data-action="deny" @click="emit('respond', permission.id, false)">
            {{ isPlanApproval ? "继续修改计划" : "拒绝" }}
          </button>
          <div class="perm-actions-primary">
            <template v-if="isPlanApproval">
              <button class="perm-btn perm-btn--outline" @click="emit('respond', permission.id, true, undefined, undefined)">
                批准，手动确认编辑
              </button>
              <button class="perm-btn perm-btn--outline" @click="emit('respond', permission.id, true, undefined, 'acceptEdits')">
                批准，自动接受编辑
              </button>
              <button class="perm-btn perm-btn--solid" @click="emit('respond', permission.id, true, undefined, 'auto')">
                批准，使用 Auto 模式
              </button>
            </template>
            <template v-else>
              <button
                v-if="canEnterEditMode"
                class="perm-btn perm-btn--outline"
                data-action="edit-mode"
                @click="emit('respond', permission.id, true, undefined, 'acceptEdits')"
              >
                进入编辑模式
              </button>
              <button
                v-if="canRemember"
                class="perm-btn perm-btn--outline"
                data-action="remember"
                @click="emitAllowAndRemember"
              >
                允许并记住
              </button>
              <button class="perm-btn perm-btn--solid" data-action="allow" @click="emit('respond', permission.id, true)">
                允许
              </button>
            </template>
          </div>
        </template>
      </div>
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
  overflow-x: hidden;
  margin: 8px 12px 10px;
  border: 1px solid color-mix(in srgb, var(--aide-warning) 25%, transparent);
  border-radius: var(--aide-radius-lg);
  background: linear-gradient(180deg, color-mix(in srgb, var(--aide-warning) 5%, transparent), var(--aide-bg-base));
  box-shadow: var(--aide-highlight-inset), 0 0 24px color-mix(in srgb, var(--aide-warning) 7%, transparent);
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
  font-family: var(--aide-font-mono);
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

/* 折叠按钮：头部最右的小 ghost 图标按钮，▾/▴ 三角 caret 对齐 BgTaskDock 的开合范式
   （全项目三角箭头统一 14px，不走 Icon 组件）。仅 plan / question 渲染。 */
.perm-collapse {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--aide-radius-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--aide-text-muted);
  cursor: pointer;
  transition: all var(--aide-ease-t);
  font-family: inherit;
}

.perm-collapse:hover {
  background: var(--aide-surface-default);
  color: var(--aide-text-primary);
  border-color: var(--aide-border);
}

.perm-collapse-caret {
  font-size: 14px;
  line-height: 1;
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
  font-family: var(--aide-font-mono);
  font-size: 11.5px;
  color: var(--aide-text-secondary);
  box-shadow: var(--aide-shadow-inset);
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
  font-family: 'Inter', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}

.perm-input-value {
  display: block;
  font-family: var(--aide-font-mono);
  font-size: 12px;
  color: var(--aide-text-primary);
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.5;
}

.perm-input-raw {
  margin: 0;
  font-family: var(--aide-font-mono);
  font-size: 12px;
  color: var(--aide-text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
}

/* 「允许并记住」预览行：点之前看清将记住什么。低调次要信息，不抢按钮视觉。 */
.perm-remember-hint {
  margin: 0 14px 2px;
  padding: 6px 10px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--aide-text-muted);
  background: color-mix(in srgb, var(--aide-accent) 5%, transparent);
  border-left: 2px solid color-mix(in srgb, var(--aide-accent) 35%, transparent);
  border-radius: 2px;
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
  border-color: var(--aide-border-strong);
  color: var(--aide-text-on-accent);
  font-weight: 600;
  box-shadow: var(--aide-accent-glow), var(--aide-highlight-inset);
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
  font-family: var(--aide-font-mono);
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
