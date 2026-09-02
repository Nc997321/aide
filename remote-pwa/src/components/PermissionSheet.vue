<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import type { PermissionRequest } from "@aide/sdk/types/chat";
import {
  PLAN_TOOL_NAME,
  QUESTION_TOOL_NAME,
  judgePermissionKind,
  parseQuestions,
  toggleQuestionSelection,
  canSubmitQuestions as questionsAnswered,
  packQuestionAnswers,
  canEnterEditMode as editModeOfferable,
  permissionSummaryLine,
  permissionInputJson,
  type PermissionKind,
  type QuestionSpec,
} from "@aide/sdk/utils/permissionShape";
import { renderMarkdown } from "@aide/sdk/utils/markdown";

/**
 * 权限确认弹窗（远程版）：对齐桌面 PermissionDialog 的远程可用子集——
 * 工具调用（允许/拒绝+理由/进入编辑模式）、澄清提问（AskUserQuestion 选项
 * 作答）、计划批准（ExitPlanMode markdown 渲染）。形态判定/答案打包等纯逻辑
 * 走 SDK 的 permissionShape（与桌面共用），数据通道走 SDK 的 respondPermission
 * （answers/nextMode/reason 参数已封装）。
 *
 * 与桌面的能力差异（协议边界，非本组件缺陷）：
 *  - 「允许并记住」不渲染——permissionsApi（get_permission_settings /
 *    create_permission_rules）不在远程 RPC 白名单（src-tauri/src/remote/rpc.rs），
 *    持久化规则只能回桌面操作；
 *  - 会话级文件规则（sessionRules）不推导——deriveSessionFileRules 在桌面
 *    src/utils，不在 SDK；PWA 的「允许」语义 = 仅本次放行。
 */

const props = defineProps<{
  permission: PermissionRequest | null;
  /** 挂起的权限请求总数（含当前这条）——并行工具调用会排队，逐条确认。 */
  queueCount?: number;
  /** 当前权限模式（chat.currentPermissionMode）：编辑工具在非编辑模式下把
   *  「允许」旁加一枚「进入编辑模式」——切模式比逐条允许更解渴。空串（清单
   *  未就位）按"显示"处理（对齐桌面）。 */
  currentMode?: string;
}>();

const emit = defineEmits<{
  /** 形态与桌面 PermissionDialog 的 respond 对齐；ChatView 桥接到
   *  chat.respondPermission（reason → 协议 message）。 */
  respond: [
    id: string,
    approved: boolean,
    answers?: Record<string, string>,
    nextMode?: string,
    reason?: string,
  ];
}>();

// ── 形态判定（按工具名特判的只是"用哪种 UI 展示"，协议仍是通用形状；
//    判定/解析/打包的纯逻辑在 @aide/sdk/utils/permissionShape，与桌面共用）──

/** ExitPlanMode = plan 模式出口确认：呈现"批准这份计划"，批准后切回默认模式。 */
const isPlanApproval = computed(() => props.permission?.name === PLAN_TOOL_NAME);

/** AskUserQuestion = 模型提出的澄清问题：选项作答打包成 answers。 */
const isQuestion = computed(() => props.permission?.name === QUESTION_TOOL_NAME);

const kind = computed<PermissionKind>(() => judgePermissionKind(props.permission?.name));

const eyebrowLabel = computed(() => {
  if (kind.value === "plan") return "计划待批准";
  if (kind.value === "question") return "需要澄清";
  return "工具调用请求";
});

// ── 拒绝理由（形态 A）：点「拒绝」→ 按钮行替换为理由输入；空理由 = 普通拒绝 ──
// 仅 tool / plan 渲染入口（question 的「跳过」不带理由）。

const denyOpen = ref(false);
const denyReason = ref("");

function openDeny() {
  denyOpen.value = true;
}

function closeDeny() {
  denyOpen.value = false;
  denyReason.value = "";
}

function submitDeny() {
  const p = props.permission;
  if (!p) return;
  const reason = denyReason.value.trim() || undefined;
  emit("respond", p.id, false, undefined, undefined, reason);
  closeDeny();
}

// ── 计划正文（markdown 渲染，与消息区同一渲染管线）──

const planHtml = computed(() => {
  if (!isPlanApproval.value) return "";
  const input = props.permission?.input as Record<string, unknown> | undefined;
  return renderMarkdown(String(input?.plan ?? ""));
});

// ── AskUserQuestion：选项收集（镜像桌面 PermissionDialog 的选择状态机）──

const questions = computed<QuestionSpec[]>(() =>
  isQuestion.value ? parseQuestions(props.permission?.input) : [],
);

/** 每题选择状态：下标 → 选中的 label 列表（单选最多 1，多选可多个）。
 *  选「其他」改用 freeText，两者互斥。 */
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
  selections[qi] = toggleQuestionSelection(selections[qi] ?? [], label, multiSelect);
}

function selectFreeText(qi: number) {
  useFreeText[qi] = true;
  selections[qi] = [];
}

const canSubmitQuestions = computed(() =>
  questionsAnswered(questions.value, selections, freeText, useFreeText),
);

function submitAnswers() {
  const p = props.permission;
  if (!p || !canSubmitQuestions.value) return;
  emit("respond", p.id, true, packQuestionAnswers(questions.value, selections, freeText, useFreeText));
}

// ── 「进入编辑模式」：编辑类工具的一劳永逸选项（nextMode 通道；
//    工具名单与模式判定在 @aide/sdk/utils/permissionShape）──

const canEnterEditMode = computed(
  () => kind.value === "tool" && editModeOfferable(props.permission?.name, props.currentMode),
);

// ── 工具输入展示：语义摘要一行（SDK 按字段优先级提取）+ 完整 JSON 折叠 ──

const summaryLine = computed(() => permissionSummaryLine(props.permission?.input));

// ── 新请求到达：复位本地态（选择/理由不跨请求残留）──

watch(
  () => props.permission?.id,
  () => {
    denyOpen.value = false;
    denyReason.value = "";
  },
);
</script>

<template>
  <div v-if="permission" class="pm-mask">
    <div class="pm-sheet">
      <div class="pm-head">
        <div class="pm-eyebrow">{{ eyebrowLabel }}</div>
        <div class="pm-tool-row">
          <span class="pm-tool">{{ permission.name }}</span>
          <span v-if="permission.fromSubagent" class="pm-sub">来自子代理 {{ permission.fromSubagent.agentName }}</span>
        </div>
        <div v-if="(queueCount ?? 0) > 1" class="pm-queue">还有 {{ (queueCount ?? 0) - 1 }} 条待确认</div>
      </div>

      <!-- 工具调用：摘要 + JSON 折叠 -->
      <template v-if="kind === 'tool'">
        <div v-if="summaryLine" class="pm-summary">{{ summaryLine }}</div>
        <details v-if="permission.input != null" class="pm-json">
          <summary>查看完整输入</summary>
          <pre>{{ permissionInputJson(permission.input) }}</pre>
        </details>
      </template>

      <!-- 计划批准：markdown 正文 -->
      <div v-else-if="kind === 'plan'" class="pm-plan" v-html="planHtml"></div>

      <!-- 澄清提问：逐题选项 -->
      <div v-else class="pm-qs">
        <div v-for="(q, qi) in questions" :key="qi" class="pm-q">
          <div class="pm-q-head">
            <b>{{ q.header }}</b>
            <small v-if="q.multiSelect">可多选</small>
          </div>
          <div class="pm-q-question">{{ q.question }}</div>
          <button
            v-for="opt in q.options"
            :key="opt.label"
            type="button"
            class="pm-opt"
            :class="{ on: (selections[qi] ?? []).includes(opt.label) }"
            @click="toggleOption(qi, opt.label, q.multiSelect)"
          >
            <span class="pm-opt-label">{{ opt.label }}</span>
            <span v-if="opt.description" class="pm-opt-desc">{{ opt.description }}</span>
          </button>
          <button type="button" class="pm-opt pm-opt-free" :class="{ on: useFreeText[qi] }" @click="selectFreeText(qi)">
            <span class="pm-opt-label">其他</span>
            <span class="pm-opt-desc">自由输入</span>
          </button>
          <input
            v-if="useFreeText[qi]"
            v-model="freeText[qi]"
            class="pm-free-input"
            type="text"
            placeholder="输入你的回答…"
          />
        </div>
      </div>

      <!-- 按钮区 -->
      <div v-if="denyOpen" class="pm-deny-form">
        <input
          v-model="denyReason"
          class="pm-deny-input"
          type="text"
          :placeholder="kind === 'plan' ? '告诉它计划哪里需要调整（可留空）…' : '告诉它为什么拒绝（可留空）…'"
          @keydown.enter.prevent="submitDeny"
          @keydown.esc.prevent="closeDeny"
        />
        <div class="pm-deny-actions">
          <button type="button" class="pm-btn pm-btn-ghost" @click="closeDeny">返回</button>
          <button type="button" class="pm-btn pm-btn-deny" @click="submitDeny">确认拒绝</button>
        </div>
      </div>
      <div v-else class="pm-actions">
        <template v-if="kind === 'question'">
          <button type="button" class="pm-btn pm-btn-ghost" @click="emit('respond', permission.id, false)">跳过</button>
          <button type="button" class="pm-btn pm-btn-allow" :disabled="!canSubmitQuestions" @click="submitAnswers">提交回答</button>
        </template>
        <template v-else>
          <button type="button" class="pm-btn pm-btn-deny" @click="openDeny">
            {{ kind === "plan" ? "继续修改计划" : "拒绝" }}
          </button>
          <button
            v-if="canEnterEditMode"
            type="button"
            class="pm-btn pm-btn-editmode"
            @click="emit('respond', permission.id, true, undefined, 'acceptEdits')"
          >
            进入编辑模式
          </button>
          <button
            type="button"
            class="pm-btn pm-btn-allow"
            @click="emit('respond', permission.id, true, undefined, kind === 'plan' ? 'auto' : undefined)"
          >
            {{ kind === "plan" ? "批准并执行" : "允许" }}
          </button>
        </template>
      </div>
    </div>
  </div>
</template>
