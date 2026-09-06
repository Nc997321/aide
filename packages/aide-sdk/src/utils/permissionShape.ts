/** 权限请求的展示形态判定（UI 无关纯逻辑）。
 *
 * 协议本身是通用的 {id, name, input} / (id, approved, answers?, nextMode?) 形状，
 * 前端按工具名特判的只是"用哪种 UI 展示"（把 answers 重组进 updatedInput 的
 * Claude 专属语义在 sidecar 的 permissions 层处理）。本模块沉淀桌面
 * PermissionDialog 与远程 PWA PermissionSheet 共用的判定、解析与打包逻辑——
 * 两个壳各自处理交互/样式，这里不碰 Vue 响应式（选择状态由调用方持有，
 * 函数式进出）。
 *
 * 刻意留在本层之外的能力（各壳自行决定要不要）：
 *  - 「允许并记住」规则推导（deriveRememberRule / filterRememberableDrafts，
 *    桌面 src/utils/permissionRuleDerivation）；
 *  - 会话级文件规则（deriveSessionFileRules，同上）；
 *  - 发送前确认（__sendConfirm__ 桌面本地合成请求，PWA 无此变体）。 */

/** ExitPlanMode：plan 模式的出口确认——呈现的是"批准这份计划"而非"允许一次
 *  工具调用"，计划正文按 Markdown 渲染，批准后 sidecar 自动切回默认模式。 */
export const PLAN_TOOL_NAME = "ExitPlanMode";

/** AskUserQuestion：模型提出的澄清问题——本质仍是一次 canUseTool 调用，但语义
 *  是"回答问题"而非"批准操作"，需要真正可选的问题/选项 UI。 */
export const QUESTION_TOOL_NAME = "AskUserQuestion";

export type PermissionKind = "plan" | "question" | "tool";

/** 工具名 → 弹窗形态。桌面另有本地合成的 __sendConfirm__（confirm）变体，
 *  由调用方在调本函数前自行特判——它不是 sidecar 协议的一部分。 */
export function judgePermissionKind(name: string | undefined | null): PermissionKind {
  if (name === PLAN_TOOL_NAME) return "plan";
  if (name === QUESTION_TOOL_NAME) return "question";
  return "tool";
}

// ── AskUserQuestion：问题规约与答案打包 ──

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionSpec {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

/** 从权限请求 input 解析问题列表；形状不对（缺 questions / 非数组）返回 []，
 *  弹窗退空态、提交门关死。 */
export function parseQuestions(input: unknown): QuestionSpec[] {
  const r = input as { questions?: QuestionSpec[] } | undefined | null;
  return Array.isArray(r?.questions) ? r!.questions! : [];
}

/** 选项点击的纯选择切换：单选覆盖、多选增删；与自由文本的互斥清空由调用方
 *  负责（它持有 useFreeText 状态）。 */
export function toggleQuestionSelection(
  current: readonly string[],
  label: string,
  multiSelect?: boolean,
): string[] {
  if (multiSelect) {
    return current.includes(label) ? current.filter((l) => l !== label) : [...current, label];
  }
  return [label];
}

/** 全部问题已作答（选项至少选一个 / 自由文本非空白）；零问题返回 false。
 *  selections / freeText / useFreeText 的形状与两个壳的选择状态机一致：
 *  下标 → 选中的 label 列表 / 自由文本 / 是否走自由文本（与选项选择互斥）。 */
export function canSubmitQuestions(
  questions: QuestionSpec[],
  selections: Record<number, string[]>,
  freeText: Record<number, string>,
  useFreeText: Record<number, boolean>,
): boolean {
  return (
    questions.length > 0 &&
    questions.every((_, i) =>
      useFreeText[i]
        ? (freeText[i]?.trim().length ?? 0) > 0
        : (selections[i]?.length ?? 0) > 0,
    )
  );
}

/** 打包 answers：question 文本 → 选中的 label 列表 join ", "（多选）/ 自由文本
 *  trim。仅在 canSubmitQuestions 通过后调用（freeText[i] 由该门保证非空白）。 */
export function packQuestionAnswers(
  questions: QuestionSpec[],
  selections: Record<number, string[]>,
  freeText: Record<number, string>,
  useFreeText: Record<number, boolean>,
): Record<string, string> {
  const answers: Record<string, string> = {};
  questions.forEach((q, i) => {
    answers[q.question] = useFreeText[i]
      ? freeText[i].trim()
      : (selections[i] ?? []).join(", ");
  });
  return answers;
}

// ── 「进入自动模式」：编辑类工具的一劳永逸选项 ──

/** 会改文件的内置工具：手动模式下逐条弹窗最烦，切 auto 一次解渴
 *  （aide 不提供 acceptEdits——编辑的「不再逐条问」由 auto 承担）。 */
export const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function isEditToolName(name: string | undefined | null): boolean {
  return !!name && EDIT_TOOL_NAMES.has(name);
}

/** 编辑工具 + 当前不在自动/最高权限模式 → 显示「进入自动模式」（切过去后编辑
 *  不再逐条询问）。已在自动/最高权限模式时弹窗本就不该为编辑出现（出现了说明是
 *  ask 规则等例外），此时该选项隐藏、露出「允许并记住」。模式空串（清单未就位）
 *  按手动模式处理。 */
export function canEnterAutoMode(
  name: string | undefined | null,
  currentMode: string | undefined,
): boolean {
  return isEditToolName(name) && !["auto", "bypassPermissions"].includes(currentMode ?? "");
}

// ── 工具输入展示 ──

export interface PermissionInputRow {
  label: string;
  value: string;
}

/** 常见工具的输入拆成"标签 + 值"两列（桌面 PermissionDialog 用）；认不出的
 *  工具名返回 null，调用方退回原始 JSON 展示。 */
export function permissionInputRows(name: string, input: unknown): PermissionInputRow[] | null {
  const r = input as Record<string, unknown> | undefined | null;
  if (name === "Bash") return [{ label: "命令", value: String(r?.command ?? "") }];
  if (name === "Write" || name === "Edit") return [{ label: "文件", value: String(r?.file_path ?? "") }];
  if (name === "WebFetch") return [{ label: "URL", value: String(r?.url ?? "") }];
  return null;
}

/** 摘要字段优先级：命中第一个非空 string 字段就返回。 */
const SUMMARY_FIELDS = ["command", "file_path", "pattern", "path", "url"] as const;

/** 任意工具输入按字段优先级提取一行摘要（PWA PermissionSheet 用）；提取不到
 *  返回 ""（调用方不渲染摘要行）。超长截断加省略号。 */
export function permissionSummaryLine(input: unknown, maxLen = 120): string {
  if (input && typeof input === "object") {
    const r = input as Record<string, unknown>; // JSON 边界：sidecar 透传的工具输入
    for (const k of SUMMARY_FIELDS) {
      const v = r[k];
      if (typeof v === "string" && v) {
        return v.length > maxLen ? v.slice(0, maxLen) + "…" : v;
      }
    }
  }
  return "";
}

/** 输入 → JSON 文本兜底：string 直返，序列化异常退 String()。截断是 UI 决策
 *  （桌面弹窗防溢出截 200、PWA details 折叠不截），由调用方自理。 */
export function permissionInputJson(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}
