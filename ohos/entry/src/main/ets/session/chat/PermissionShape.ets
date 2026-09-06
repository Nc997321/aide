/**
 * 权限请求的展示形态判定（UI 无关纯逻辑）。
 *
 * 过筛自 packages/aide-sdk/src/utils/permissionShape.ts：协议本身是通用的
 * {id, name, input} / (id, approved, answers?, nextMode?, message?) 形状，前端
 * 按工具名特判的只是「用哪种 UI 展示」。桌面 PermissionDialog 与远程 PWA
 * PermissionSheet 共用上游这份模块；ohos 端的 PermissionSheet（chat/ 组件）
 * 同样只消费这里的判定/解析/打包，不自带语义。
 * 未过筛（协议边界/随 UI 扩容）：「允许并记住」规则推导（permissionRuleDerivation
 * / deriveSessionFileRules 在桌面 src/utils，不在 SDK）、permissionInputRows
 * （桌面两列表格专用；ohos 沿用摘要 + JSON 兜底展示）、「进入自动模式」
 * （canEnterAutoMode；自动模式入口 UI 定稿后再接入）。
 */
import { str, bool } from './ChatWire';

/** ExitPlanMode：plan 模式的出口确认——呈现的是「批准这份计划」而非「允许一次
 *  工具调用」，计划正文按 Markdown 渲染，批准后 sidecar 自动切模式。 */
export const PLAN_TOOL_NAME: string = 'ExitPlanMode';

/** AskUserQuestion：模型提出的澄清问题——本质仍是一次 canUseTool 调用，但语义
 *  是「回答问题」而非「批准操作」，需要真正可选的问题/选项 UI。 */
export const QUESTION_TOOL_NAME: string = 'AskUserQuestion';

/** 工具名 → 弹窗形态。 */
export type PermissionKind = 'plan' | 'question' | 'tool';

export function judgePermissionKind(name: string): PermissionKind {
  if (name === PLAN_TOOL_NAME) {
    return 'plan';
  }
  if (name === QUESTION_TOOL_NAME) {
    return 'question';
  }
  return 'tool';
}

// ── ExitPlanMode：计划正文 ──

/** 计划正文（input.plan 字符串；形状不对 → 空串，正文区退占位提示）。 */
export function planText(input: Object): string {
  if (typeof input !== 'object' || Array.isArray(input)) {
    return '';
  }
  const rec: Record<string, Object> = input as Record<string, Object>;
  const v: Object | undefined = rec['plan'];
  return v !== undefined && typeof v === 'string' ? v as string : '';
}

// ── AskUserQuestion：问题规约与答案打包 ──

/** 选项（上游 QuestionOption；description 上游可缺省，这里拍平为零串）。 */
export interface QuestionOption {
  label: string;
  description: string;
}

/** 单个问题（上游 QuestionSpec；multiSelect 上游可缺省，这里拍平为 false）。 */
export interface QuestionSpec {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/**
 * 从权限请求 input（JSON 值域）解析问题列表；形状不对（缺 questions / 非数组）
 * 返回 []，弹窗退空态、提交门关死（对照上游 parseQuestions 的容错语义）。
 */
export function parseQuestions(input: Object): QuestionSpec[] {
  if (typeof input !== 'object' || Array.isArray(input)) {
    return [];
  }
  const rec: Record<string, Object> = input as Record<string, Object>;
  const raw: Object | undefined = rec['questions'];
  if (raw === undefined || !Array.isArray(raw)) {
    return [];
  }
  const items: Object[] = raw as Object[];
  const specs: QuestionSpec[] = [];
  for (let i = 0; i < items.length; i++) {
    const item: Object = items[i];
    if (typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const q: Record<string, Object> = item as Record<string, Object>;
    const spec: QuestionSpec = {
      question: str(q, 'question'),
      header: str(q, 'header'),
      multiSelect: bool(q, 'multiSelect'),
      options: parseOptions(q['options'])
    };
    specs.push(spec);
  }
  return specs;
}

function parseOptions(raw: Object | undefined): QuestionOption[] {
  if (raw === undefined || !Array.isArray(raw)) {
    return [];
  }
  const items: Object[] = raw as Object[];
  const out: QuestionOption[] = [];
  for (let i = 0; i < items.length; i++) {
    const item: Object = items[i];
    if (typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const o: Record<string, Object> = item as Record<string, Object>;
    const opt: QuestionOption = { label: str(o, 'label'), description: str(o, 'description') };
    if (opt.label !== '') {
      out.push(opt);
    }
  }
  return out;
}

/**
 * 选项点击的纯选择切换：单选覆盖、多选增删；与自由文本的互斥清空由持有
 * 选择状态的 PermissionRequest 负责（对照上游 toggleQuestionSelection）。
 */
export function toggleQuestionSelection(current: string[], label: string, multiSelect: boolean): string[] {
  if (multiSelect) {
    return current.includes(label) ? current.filter((l: string) => l !== label) : current.concat([label]);
  }
  return [label];
}

/**
 * 全部问题已作答（选项至少选一个 / 自由文本非空白）；零问题返回 false
 * （提交门关死，只剩跳过）。selections/freeText/useFreeText 与
 * PermissionRequest 上的作答草稿同形：下标 → 选中的 label 列表 / 自由
 * 文本 / 是否走自由文本（与选项选择互斥）。
 */
export function canSubmitQuestions(
  questions: QuestionSpec[],
  selections: string[][],
  freeText: string[],
  useFreeText: boolean[]
): boolean {
  if (questions.length === 0) {
    return false;
  }
  for (let i = 0; i < questions.length; i++) {
    if (useFreeText[i]) {
      const t: string | undefined = freeText[i];
      if (t === undefined || t.trim() === '') {
        return false;
      }
    } else {
      const sel: string[] | undefined = selections[i];
      if (sel === undefined || sel.length === 0) {
        return false;
      }
    }
  }
  return true;
}

/**
 * 打包 answers：question 文本 → 选中的 label 列表 join ", "（多选）/ 自由
 * 文本 trim。仅在 canSubmitQuestions 通过后调用（对照上游 packQuestionAnswers）。
 */
export function packQuestionAnswers(
  questions: QuestionSpec[],
  selections: string[][],
  freeText: string[],
  useFreeText: boolean[]
): Record<string, string> {
  const answers: Record<string, string> = {};
  for (let i = 0; i < questions.length; i++) {
    const sel: string[] | undefined = selections[i];
    const text: string | undefined = freeText[i];
    answers[questions[i].question] = useFreeText[i]
      ? (text !== undefined ? text : '').trim()
      : (sel !== undefined ? sel : []).join(', ');
  }
  return answers;
}
