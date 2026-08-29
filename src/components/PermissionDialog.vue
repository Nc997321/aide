<script setup lang="ts">
import { ref, computed, reactive, watch, nextTick, onMounted, onUnmounted } from "vue";
import type { PermissionRequest } from "@/types/chat";
import type { PermissionRule, PermissionRuleDraft, PermissionScope } from "@/types/permissions";
import {
  deriveRememberRule,
  deriveSessionFileRules,
  describeRuleMatcher,
  hasUnquotedShellControl,
  stripTrailingNumericArg,
} from "@/utils/permissionRuleDerivation";
import { marked } from "@/utils/markdown";
import { useModal } from "@/composables/useModal";
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
  /** 当前生效的权限规则（ChatPanel 拉取的快照）。「允许并记住」推导链式命令时
   *  需要知道哪些段已被现有规则覆盖，才能记住真正缺的段（而不是第一段的冗余规则）。
   *  未提供时退化为旧行为（首个控制符处截断）。 */
  rememberRules?: PermissionRule[] | null;
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
    /** 仅「允许并记住」按钮带：本次放行 + 把这组 allow 规则持久化到指定作用域
     *  （Bash 链式命令一次记住多段时是多条）。ChatPanel 收到后先调
     *  permissionsApi.createMany 落盘（Rust 一次原子写 + 一次广播），再走正常
     *  approve。纯前端字段，不进 SidecarCommand 协议。 */
    persistRule?: { scope: PermissionScope; rules: PermissionRuleDraft[] },
    /** 拒绝理由：仅 approved=false 且用户输入时带。全链路透传到 SDK 的 deny message，
     *  作为工具错误反馈给模型——模型按理由直接调整，不用再追问一轮。 */
    reason?: string,
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

/** 发送前确认（变体 C）：本地合成的「确认请求」，复用本组件的 AskUserQuestion 视觉
 *  语言（问号火漆印 + 「需要确认」eyebrow + 问题 chip），但用信息卡 + 取消/继续发送
 *  二按钮（非选项卡）。name 用 "__sendConfirm__" 标记区分于真实 sidecar 权限请求；
 *  input 形状 { title, chip, question, info, confirmLabel } 全前端字段，不进 sidecar
 *  协议。ChatPanel 在 performSend 检测到 provider/模型与会话上次不同（fork/冷缓存）
 *  时构造此请求并接管 respond：approved→发送，!approved→取消并保留输入。 */
const isConfirm = computed(() => props.permission?.name === "__sendConfirm__");
const confirmInput = computed<{
  title: string;
  chip: string;
  question: string;
  info: string;
  confirmLabel: string;
} | null>(() =>
  isConfirm.value
    ? (props.permission?.input as { title: string; chip: string; question: string; info: string; confirmLabel: string })
    : null,
);

/** 三种确认口吻用同一枚"火漆印"图钉，用图形区分种类：工具调用=锁、
 *  计划批准=清单、澄清提问/发送确认=问号——不按具体工具名再细分图标，换新工具/
 *  第三方 provider 接入时也不用维护一张图标映射表。 */
const kind = computed<"plan" | "question" | "tool" | "confirm">(() =>
  isConfirm.value
    ? "confirm"
    : isPlanApproval.value
      ? "plan"
      : isQuestion.value
        ? "question"
        : "tool",
);

const eyebrowLabel = computed(() => {
  if (kind.value === "confirm") return "需要确认";
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

/** 拒绝理由输入（形态 A）：点「拒绝/继续修改计划」→ 按钮行整体替换为理由输入 +
 *  提交/返回；Enter 提交、Esc 返回按钮态。空理由提交 = 普通拒绝（reason 传 undefined）。
 *  仅 tool / plan 渲染入口（question 的「跳过」/ confirm 的「取消」不带理由）。 */
const denyOpen = ref(false);
const denyReason = ref("");
const denyInputRef = ref<HTMLInputElement | null>(null);
function openDeny() {
  denyOpen.value = true;
  // 键盘流（Esc 打开理由输入）要求立刻可输入；鼠标流同样省一次点击。
  nextTick(() => denyInputRef.value?.focus());
}
function closeDeny() {
  denyOpen.value = false;
  denyReason.value = "";
}
function submitDeny() {
  if (!props.permission) return;
  const reason = denyReason.value.trim() || undefined;
  emit("respond", props.permission.id, false, undefined, undefined, undefined, reason);
  // 组件常驻挂载，提交后复位本地状态（防下一条请求残留输入/展开态）
  denyOpen.value = false;
  denyReason.value = "";
}

/** 文本输入框的 Enter 收口：输入法组合中的 Enter 是「确认候选字」而非提交意图——
 *  isComposing 时让路，防中文选词误提交（deny 理由 / 提问自由文本共用）。 */
function onTextInputEnter(e: KeyboardEvent, action: () => void) {
  if (e.isComposing) return;
  action();
}

// ── 键盘确认：Enter = 主按钮（允许/批准 Auto/提交回答/继续发送），Esc = 负面出口 ──
// 挂 window bubble 相（事件链最后一站）。与上游消费者的协作约定：凡吃掉 Esc/Enter
// 的（App capture 的 workbench Esc、palette/settings/modal 的 Esc）都必须
// preventDefault——这里见 defaultPrevented 一律让路，一次按键只产生一个效果。
const { visible: modalVisible } = useModal();

/** 遮罩根类名登记处：这些覆盖层开着时按键属于遮罩，不穿透到权限弹窗（覆盖层都
 *  v-if 控制，DOM 存在 = 开着）。新增全屏遮罩组件时把根类名加进来。
 *  workbench-overlay 不在此列：它不是模态、常驻 DOM，其 Esc 收起由 App 的
 *  capture handler 消费并 preventDefault，走 defaultPrevented 守卫。 */
const OVERLAY_SELECTOR = [
  ".settings-overlay",
  ".a-palette-overlay",
  ".onboarding-overlay",
  ".of-overlay",
  ".rw-overlay",
  ".trust-overlay",
  ".fr-overlay",
  ".picker-overlay",
  ".pb-overlay",
].join(", ");

/** 焦点在文本输入类元素上：按键归输入框（聊天输入发送 / deny 理由 / 提问自由
 *  文本 / xterm helper / palette 输入等，各有自己的 Enter/Esc 语义）。 */
function isTextEntryTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    !!t.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')
  );
}

/** 焦点在按钮/链接上：Enter 的原生行为就是触发该控件（焦点在「允许」上按 Enter
 *  = 点击允许），组件再 emit 一次会双发，让路给原生 click。 */
function isActionTarget(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && !!t.closest('button, a[href], [role="button"]');
}

/** 遮罩层开着 = 按键属于遮罩：全局 modal（useModal 单例状态）+ 各覆盖层 DOM。 */
function isOverlayBlocked(): boolean {
  return modalVisible.value || !!document.querySelector(OVERLAY_SELECTOR);
}

/** 多窗格各挂一个 PermissionDialog：两个会话同时待确认时 Enter 会双批——只允许
 *  「全场唯一待确认弹窗」响应键盘，并存时强制用鼠标（安全缺省，鼠标意图无歧义）。 */
function isSolePendingDialog(): boolean {
  return document.querySelectorAll(".perm-dock").length === 1;
}

function onDialogKeydown(e: KeyboardEvent) {
  if (!props.permission || e.isComposing || e.repeat) return;
  if (e.defaultPrevented || isOverlayBlocked() || !isSolePendingDialog()) return;
  if (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
  if (e.key === "Enter") onEnterKey(e);
  else if (e.key === "Escape") onEscapeKey(e);
}

function onEnterKey(e: KeyboardEvent) {
  if (isTextEntryTarget(e.target) || isActionTarget(e.target)) return;
  e.preventDefault();
  if (denyOpen.value) submitDeny();
  else primaryAction();
}

function onEscapeKey(e: KeyboardEvent) {
  if (isTextEntryTarget(e.target)) return;
  e.preventDefault();
  if (denyOpen.value) closeDeny();
  else negativeAction();
}

/** Enter 的主动作按弹窗形态分发：确认 = 继续发送、计划 = 批准 Auto（solid 主按钮）、
 *  提问 = 提交回答（内部有 canSubmitQuestions 门，未答完无效果）、工具 = 允许。 */
function primaryAction() {
  const p = props.permission;
  // 不可达：调用方 onDialogKeydown 已用 !props.permission 守门——防御臂，防未来
  // 新增调用点绕过守卫。
  if (!p) return;
  if (isConfirm.value) emit("respond", p.id, true);
  else if (isPlanApproval.value) emit("respond", p.id, true, undefined, "auto");
  else if (isQuestion.value) submitAnswers();
  else emit("respond", p.id, true);
}

/** Esc 的负面出口：确认/提问 = 直接取消/跳过（不带理由，对齐按钮语义）；工具/计划
 *  = 展开理由输入（空理由提交 = 普通拒绝），与点「拒绝」同一条路径。 */
function negativeAction() {
  const p = props.permission;
  // 不可达：调用方 onDialogKeydown 已用 !props.permission 守门——防御臂，防未来
  // 新增调用点绕过守卫。
  if (!p) return;
  if (isConfirm.value || isQuestion.value) emit("respond", p.id, false);
  else openDeny();
}

onMounted(() => window.addEventListener("keydown", onDialogKeydown));
onUnmounted(() => window.removeEventListener("keydown", onDialogKeydown));

watch(
  () => props.permission?.id,
  () => {
    collapsed.value = false;
    denyOpen.value = false;
    denyReason.value = "";
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

// ── 「允许并记住」：把这次工具调用就地推导成一组 allow 规则 ──
// 推导规则按工具分（Bash→命令前缀、文件工具→所在文件夹、WebFetch→完整 URL、
// 其它→工具级）；Bash 链式命令对每个未覆盖段各推一条，一次记住整链。推不出
// 来（空命令 / 空路径）或没有可持久化作用域时不显示按钮。
const rememberDrafts = computed<PermissionRuleDraft[]>(() =>
  props.permission
    ? deriveRememberRule(props.permission.name, props.permission.input, props.rememberRules ?? [])
    : [],
);

/** Bash prefix 规则的 matcher value（可编辑的规则值）；其它 matcher 只读。 */
function bashPrefixValue(d: PermissionRuleDraft): string | null {
  return d.matcher.kind === "bash" && d.matcher.mode === "prefix" && d.matcher.value !== undefined
    ? d.matcher.value
    : null;
}

/** 每条规则的可编辑值：初始 = 推导值，用户可改。
 *  同步源是 rememberDrafts 而不是 permission id：rememberRules 由 ChatPanel
 *  异步拉取（弹窗先以空规则渲染全部段，规则到达后已覆盖段被过滤、行收缩）——
 *  只盯 id 的话，规则到达触发的行变化不会重同步，输入框残留旧行的值（rm 行
 *  显示 cd 的规则值，提交即写错规则）。rememberDrafts 不依赖 editableValues，
 *  用户编辑不会触发本回调，无回写循环。 */
const editableValues = reactive<string[]>([]);
watch(
  rememberDrafts,
  (drafts) => {
    editableValues.splice(
      0,
      editableValues.length,
      ...drafts.map((d) => bashPrefixValue(d) ?? ""),
    );
  },
  { immediate: true },
);

/** 行级校验：空值 / 含未引用 shell 控制符（allow 前缀在策略引擎里永不命中）。 */
const editableInvalid = computed<Array<string | null>>(() =>
  rememberDrafts.value.map((d, i) => {
    if (bashPrefixValue(d) === null) return null;
    const v = editableValues[i] ?? "";
    if (!v.trim()) return "规则值不能为空";
    if (hasUnquotedShellControl(v)) return "含未引用 shell 控制符（|;&>< 等）——允许规则永不命中";
    return null;
  }),
);
const rememberValid = computed(() => editableInvalid.value.every((e) => e === null));

/** 数字参数透明化：末尾是 `-8` / `-n 8` / `--lines=8` 形态时提示「仅匹配字面
 *  参数」并提供「改为记住去掉数字的版本」快捷切换。裸数字（vitest 过滤器 2）
 *  不提示——那可能是语义本身，留给用户手动编辑。 */
const simplifiedValues = computed<Array<string | null>>(() =>
  rememberDrafts.value.map((_, i) => stripTrailingNumericArg(editableValues[i] ?? "")),
);
function applySimplified(i: number) {
  const s = simplifiedValues.value[i];
  if (s !== null) editableValues[i] = s;
}

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
    rememberDrafts.value.length > 0 &&
    !!props.rememberScope,
);

// ── 会话级规则提示：文件工具弹窗里点「允许」会推导一条精确文件规则（本会话内
// 同文件不再询问，换文件仍确认）——「允许」按钮的 tooltip 让用户知道普通允许
// ≠ 只放行这一次。与「允许并记住」（持久化文件夹规则）互补：允许=单文件、记住=目录级。
const isFileTool = computed(
  () => !!props.permission && EDIT_TOOL_NAMES.has(props.permission.name),
);
const sessionDrafts = computed<PermissionRuleDraft[]>(() =>
  props.permission ? deriveSessionFileRules(props.permission.name, props.permission.input) : [],
);
/** 仅文件工具且有可推导会话规则时给出 tooltip 文本（空串时 v-tooltip 不显示）。 */
const allowTooltip = computed(() =>
  isFileTool.value && sessionDrafts.value.length > 0 ? "该文件本次会话不再询问" : "",
);
/** 非 Bash 规则（文件夹 / URL / 工具级）的只读描述行：这条规则匹配什么。
 *  作用域不在预览区展示——点完 toast 会确认落点，设置面板可查看。 */
function ruleStaticDescription(d: PermissionRuleDraft): string {
  return describeRuleMatcher(d);
}
function emitAllowAndRemember() {
  if (!props.permission || !props.rememberScope || !rememberValid.value) return;
  const rules = rememberDrafts.value.map((d, i) => {
    if (bashPrefixValue(d) === null) return d;
    return { ...d, matcher: { ...d.matcher, value: (editableValues[i] ?? "").trim() } };
  });
  emit("respond", props.permission.id, true, undefined, undefined, {
    scope: props.rememberScope,
    rules,
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
            <template v-if="isConfirm">{{ confirmInput?.title }}</template>
            <template v-else-if="isPlanApproval">批准执行这份计划？</template>
            <template v-else-if="isQuestion">Claude 有问题要问你</template>
            <template v-else><code class="perm-tool-chip">{{ permission.name }}</code></template>
          </span>
        </div>
        <span v-if="(queueCount ?? 0) > 1" class="perm-queue-badge">还有 {{ (queueCount ?? 0) - 1 }} 条待确认</span>
        <button
          v-if="isPlanApproval || isQuestion || isConfirm"
          type="button"
          class="perm-collapse"
          :aria-expanded="collapsed ? 'false' : 'true'"
          v-tooltip="collapsed ? '展开' : '收起'"
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
            @keydown.enter="onTextInputEnter($event, submitAnswers)"
          />
        </div>
      </div>
      <!-- 发送前确认（变体 C）：问题 chip + 一段说明信息卡，无选项卡。 -->
      <div v-else-if="isConfirm" class="perm-questions">
        <div class="perm-question">
          <div class="perm-question-head">
            <span class="perm-question-chip">{{ confirmInput?.chip }}</span>
            <span class="perm-question-text">{{ confirmInput?.question }}</span>
          </div>
          <div class="perm-info">{{ confirmInput?.info }}</div>
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
      <!-- 「允许并记住」预览：点之前先让用户看清将记住什么（落到哪个作用域
           由点击后的 toast 确认，不在此占一行）。
           只在工具调用且有可推导规则时出现（计划批准 / 澄清提问不显示）。
           链式命令一次记住多段时逐条列出；Bash prefix 值可直接编辑（参数
           透明化的兜底），末尾数字参数（tail -8 形态）另给「去掉数字」快捷
           切换。非 Bash 规则只读展示。 -->
      <div v-if="canRemember" class="perm-remember">
        <div
          v-for="(d, i) in rememberDrafts"
          :key="i"
          class="perm-remember-rule"
          :class="{ 'perm-remember-rule--invalid': editableInvalid[i] }"
        >
          <template v-if="bashPrefixValue(d) !== null">
            <div class="perm-remember-rule-row">
              <span class="perm-remember-idx">{{ i + 1 }}</span>
              <input
                v-model="editableValues[i]"
                class="perm-remember-value"
                spellcheck="false"
                aria-label="规则值"
              />
            </div>
            <div v-if="simplifiedValues[i]" class="perm-remember-note">
              仅匹配字面参数（其他值如 {{ editableValues[i] }} 变体会继续询问）
              <button type="button" class="perm-remember-simplify" @click="applySimplified(i)">
                改为记住 {{ simplifiedValues[i] }}
              </button>
            </div>
            <div v-if="editableInvalid[i]" class="perm-remember-error">{{ editableInvalid[i] }}</div>
          </template>
          <div v-else class="perm-remember-rule-row">
            <span class="perm-remember-idx">{{ i + 1 }}</span>
            <code class="perm-remember-static">{{ ruleStaticDescription(d) }}</code>
          </div>
        </div>
      </div>
      <div class="perm-actions">
        <template v-if="isQuestion">
          <button class="perm-btn perm-btn--ghost" @click="emit('respond', permission.id, false)">
            跳过
            <span class="perm-btn-key">Esc</span>
          </button>
          <button
            class="perm-btn perm-btn--solid"
            :disabled="!canSubmitQuestions"
            @click="submitAnswers"
          >
            提交回答
            <span class="perm-btn-key">Enter</span>
          </button>
        </template>
        <template v-else-if="isConfirm">
          <button class="perm-btn perm-btn--ghost" @click="emit('respond', permission.id, false)">
            取消
            <span class="perm-btn-key">Esc</span>
          </button>
          <div class="perm-actions-primary">
            <button class="perm-btn perm-btn--solid" @click="emit('respond', permission.id, true)">
              {{ confirmInput?.confirmLabel }}
              <span class="perm-btn-key">Enter</span>
            </button>
          </div>
        </template>
        <template v-else>
          <template v-if="denyOpen">
            <div class="perm-deny-row">
              <input
                ref="denyInputRef"
                v-model="denyReason"
                class="perm-deny-input"
                placeholder="拒绝理由（可选）——告诉模型该怎么改"
                spellcheck="false"
                data-action="deny-reason"
                @keydown.enter="onTextInputEnter($event, submitDeny)"
                @keydown.escape="closeDeny"
              />
            </div>
            <button class="perm-btn perm-btn--outline perm-btn--outline-danger" data-action="deny-submit" @click="submitDeny">
              提交拒绝
              <span class="perm-btn-key">Enter</span>
            </button>
            <button class="perm-btn perm-btn--ghost" data-action="deny-back" @click="closeDeny">
              返回
              <span class="perm-btn-key">Esc</span>
            </button>
          </template>
          <template v-else>
            <button class="perm-btn perm-btn--ghost" data-action="deny" @click="openDeny">
              {{ isPlanApproval ? "继续修改计划" : "拒绝" }}
              <span class="perm-btn-key">Esc</span>
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
                  <span class="perm-btn-key">Enter</span>
                </button>
              </template>
              <template v-else>
                <button
                  v-if="canEnterEditMode"
                  class="perm-btn perm-btn--outline"
                  data-action="edit-mode"
                  v-tooltip="'本会话所有文件编辑自动接受'"
                  @click="emit('respond', permission.id, true, undefined, 'acceptEdits')"
                >
                  进入编辑模式
                </button>
                <button
                  v-if="canRemember"
                  class="perm-btn perm-btn--outline"
                  data-action="remember"
                  :disabled="!rememberValid"
                  @click="emitAllowAndRemember"
                >
                  允许并记住
                </button>
                <button
                  class="perm-btn perm-btn--solid"
                  data-action="allow"
                  v-tooltip="allowTooltip"
                  @click="emit('respond', permission.id, true)"
                >
                  允许
                  <span class="perm-btn-key">Enter</span>
                </button>
              </template>
            </div>
          </template>
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

/* 「允许并记住」预览区：描述行 + 每条规则的编辑行/提示行。低调次要信息，
   不抢按钮视觉；编辑行是「规则值透明化」的载体——参数怎么记、记多宽，点
   按钮之前全部可见可改。 */
.perm-remember {
  margin: 0 14px 2px;
}

.perm-remember-rule {
  margin-top: 6px;
  padding: 6px 10px;
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-sm);
  background: var(--aide-bg-deep);
}

.perm-remember-rule--invalid {
  border-color: color-mix(in srgb, var(--aide-danger) 45%, transparent);
}

.perm-remember-rule-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.perm-remember-idx {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 600;
  color: var(--aide-accent);
  background: color-mix(in srgb, var(--aide-accent) 10%, transparent);
}

.perm-remember-value {
  flex: 1;
  min-width: 0;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: var(--aide-text-primary);
  font-family: var(--aide-font-mono);
  font-size: 12px;
  line-height: 1.4;
  padding: 1px 4px;
  outline: none;
}

.perm-remember-value:focus {
  border-color: var(--aide-border-strong);
  background: var(--aide-surface-default);
}

.perm-remember-static {
  font-family: var(--aide-font-mono);
  font-size: 11.5px;
  color: var(--aide-text-secondary);
}

.perm-remember-note {
  margin-top: 4px;
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--aide-warning);
}

.perm-remember-simplify {
  margin-left: 4px;
  border: 1px solid color-mix(in srgb, var(--aide-warning) 30%, transparent);
  border-radius: 3px;
  background: color-mix(in srgb, var(--aide-warning) 8%, transparent);
  color: var(--aide-warning);
  font-size: 10.5px;
  font-family: var(--aide-font-mono);
  padding: 1px 6px;
  cursor: pointer;
}

.perm-remember-simplify:hover {
  background: color-mix(in srgb, var(--aide-warning) 15%, transparent);
}

.perm-remember-error {
  margin-top: 4px;
  font-size: 10.5px;
  color: var(--aide-danger);
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

/* 发送前确认（变体 C）的信息卡：问题下方一段冷缓存/fork 说明。 */
.perm-info {
  font-size: 12px;
  line-height: 1.55;
  color: var(--aide-text-secondary);
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-sm);
  padding: 9px 12px;
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

/* 拒绝理由输入：形态 A 的输入框（复用 freetext 质感，危险色描边示意「拒绝」路径）。
   .perm-actions 是 flex 行，输入框整行占位后按钮自然换到下一行右对齐。 */
.perm-deny-row {
  flex: 1;
  min-width: 0;
}

.perm-deny-input {
  width: 100%;
  box-sizing: border-box;
  border-radius: var(--aide-radius-sm);
  border: 1px solid color-mix(in srgb, var(--aide-danger) 45%, transparent);
  background: var(--aide-bg-deep);
  color: var(--aide-text-primary);
  padding: 7px 10px;
  font-size: 12.5px;
  outline: none;
}

.perm-deny-input:focus {
  border-color: var(--aide-danger);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--aide-danger) 18%, transparent);
}

/* 按钮行：GALLERY .perm-foot */
.perm-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 14px;
  /* 拒绝理由输入态：输入框 flex:1 占满整行，按钮换到下一行右对齐 */
  flex-wrap: wrap;
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

/* 按键提示 chip：挂在按钮文本右侧的小标记（Enter/Esc）。currentColor 继承各按钮
   配色、opacity 压成次要信息；不需要 pointer-events 处理——子元素点击原生冒泡到
   button 触发，chip 不挡交互。 */
.perm-btn-key {
  font-size: 9.5px;
  font-weight: 500;
  line-height: 1;
  padding: 2.5px 5px;
  border-radius: 4px;
  border: 1px solid currentColor;
  opacity: 0.55;
}

/* outline-danger（提交拒绝）继承 outline 的 column 布局——那是为 main+caption 双行
   设计的；它只有单行文本 + 提示 chip，切回 row 与其它按钮的视觉对齐一致。 */
.perm-btn--outline-danger {
  flex-direction: row;
  align-items: center;
  gap: 7px;
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
