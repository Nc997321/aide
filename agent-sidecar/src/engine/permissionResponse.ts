// permission_response 线形状 → 规范决策（纯函数，无 IO、不依赖权限核心）。
//
// 为什么需要它：协议有两个形态——标签联合（官方推荐，headless 网关用）与扁平字段袋
// （桌面 Rust / 远程 / ohos 恒走这条，历史兼容）。而引擎只该有**一种**读法：归一成
// "决策对象"之后，session-worker 的命令分支与 permissions.ts 的应答点都只看决策的
// kind，不再各自解释字段组合（旧扁平形态下 engine 被迫写防御代码——「ignoring any
// stray answers」那类静默忽略，正是"组合合法性没人管"的代价）。
//
// 变体 ↔ 引擎能力**一一对应**（判据：两条变体落到同一段引擎代码即为过覆盖，引擎有
// 能力而线形状表达不出即为欠覆盖）：
//   approve    → resolve 放行（附随 nextMode / sessionRules，两者都只在放行路径生效）
//   answer     → 放行 + 作答重塑进 updatedInput（SDK 契约，仅 AskUserQuestion）
//   deny       → 拒绝 + 人工外框（YFe 有附言 / nhe 无附言）
//   unanswered → 拒绝 + 非人工外框（官方「无人工审批可用」模板）
// 故刻意**不设** skip：它与 deny 落到同一段代码（都是 resolve(approved:false)、无
// reason 时同一条 nhe STOP 外框），零能力差异——那是调用方 UI 的按钮文案，不进协议。
//
// 分层：本模块**不** import permissions.ts（拒绝文案与 SDK 决策在那边组装），只做
// 形状判定与词汇表；permissions.ts 反向 import 本模块的类型与映射（单向，无环）。
import type { PermissionResponseWire, PermissionRuleDraft } from "./types.js";

/** 问答类工具名（前端 packages/aide-sdk/src/utils/permissionShape.ts 的同名常量是
 *  弹窗形态判定的镜像，改名要一起改）。 */
export const QUESTION_TOOL_NAME = "AskUserQuestion";

/** 应答载荷——permission core 结算一条挂起请求所需的全部信息。 */
export interface PendingDecision {
  approved: boolean;
  answers?: Record<string, string>;
  /** 拒绝理由：人工拒绝 = 用户原话/转述；无人应答 = 调用方自己的说法。透传给
   *  SDK 的 deny message（由 permissions.ts 按 deniedBy 选外框包装）。 */
  message?: string;
  /** 拒绝来源：**缺席 = 人工语义**（人工点拒绝，以及 interrupt / abort / 连带放行
   *  等既有终结路径——它们都是"有人做了决定"）；`"unanswered"` = 无人应答，外框
   *  换官方「无人工审批可用」模板。仅 approved=false 时有意义。 */
  deniedBy?: "user" | "unanswered";
}

/** 规范决策：引擎内部唯一的 permission_response 语义。
 *
 *  四变体**直接复用线上形状**（`PermissionResponseWire`）——不另立一份同构声明，
 *  否则"线形状改了决策没改"这类漂移在运行时无声无息。
 *
 *  `compat_flat` 是扁平形态的承载臂——**逐字节保持 2026-09 之前的行为**：不做类别
 *  校验、approved 按 truthiness 判（桌面 stdin 无 schema 面，见 index.ts 直透
 *  handleCommand），answers 仅当挂起工具是 AskUserQuestion 时生效。 */
export type PermissionResponseDecision =
  | PermissionResponseWire
  | {
      kind: "compat_flat";
      approved: boolean;
      answers?: Record<string, string>;
      nextMode?: string;
      message?: string;
      sessionRules?: PermissionRuleDraft[];
    };

/** 边界输入：stdin 面没有 schema，字段类型不可信——逐个守卫后再用。
 *  允许任意其它键（session_id / id / 未来字段）在场：本函数只关心应答形状。 */
interface ResponseShaped {
  [key: string]: unknown;
  approved?: unknown;
  answers?: unknown;
  nextMode?: unknown;
  message?: unknown;
  sessionRules?: unknown;
  response?: unknown;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asRules(v: unknown): PermissionRuleDraft[] | undefined {
  return Array.isArray(v) ? (v as PermissionRuleDraft[]) : undefined;
}

/** 标签形态的四变体归一。kind 未知 → 不可判（调用方发非致命 error 帧并 fail-closed）。 */
function classifyWire(wire: Record<string, unknown>): ClassifyResult {
  switch (wire.kind) {
    case "approve": {
      const nextMode = asString(wire.nextMode);
      const sessionRules = asRules(wire.sessionRules);
      return {
        ok: true,
        decision: {
          kind: "approve",
          ...(nextMode !== undefined ? { nextMode } : {}),
          ...(sessionRules !== undefined ? { sessionRules } : {}),
        },
      };
    }
    case "answer": {
      const answers = asRecord(wire.answers);
      if (!answers) return { ok: false, reason: "answer 变体缺少 answers" };
      return { ok: true, decision: { kind: "answer", answers: answers as Record<string, string> } };
    }
    case "deny": {
      const message = asString(wire.message);
      return { ok: true, decision: { kind: "deny", ...(message !== undefined ? { message } : {}) } };
    }
    case "unanswered": {
      const reason = asString(wire.reason);
      return { ok: true, decision: { kind: "unanswered", ...(reason !== undefined ? { reason } : {}) } };
    }
    default:
      return { ok: false, reason: "未知的 response.kind" };
  }
}

type ClassifyResult =
  | { ok: true; decision: PermissionResponseDecision }
  | { ok: false; reason: string };

/** 线形状 → 规范决策。**不抛错**：不可判的形状返回 reason，由调用方发非致命 error
 *  帧并按拒绝 fail-closed 收尾——绝不把挂起请求悬死。
 *
 *  形态选择只看 `response` 是否在场（headless 的 zod 边界已强制"恰好一个在场"；
 *  stdin 面缺 schema，此处以 response 优先、缺席回落扁平形态）。 */
export function classifyPermissionResponse(cmd: ResponseShaped): ClassifyResult {
  const wire = asRecord(cmd.response);
  if (wire) return classifyWire(wire);

  // 扁平形态（桌面 Rust / 远程 / ohos）：字段原样透传，approved 按 truthiness 归一
  // （缺字段/非 boolean 的历史行为就是 false——逐字节保持）。
  const answers = asRecord(cmd.answers);
  const nextMode = asString(cmd.nextMode);
  const message = asString(cmd.message);
  const sessionRules = asRules(cmd.sessionRules);
  return {
    ok: true,
    decision: {
      kind: "compat_flat",
      approved: Boolean(cmd.approved),
      ...(answers ? { answers: answers as Record<string, string> } : {}),
      ...(nextMode !== undefined ? { nextMode } : {}),
      ...(message !== undefined ? { message } : {}),
      ...(sessionRules !== undefined ? { sessionRules } : {}),
    },
  };
}

/** 决策与挂起请求的类别是否匹配。返回判词 = 不匹配（调用方按 fail-closed 收尾）。
 *
 *  只校验**标签形态**：扁平形态一个字节的既有行为都不动（桌面误传 answers 给非问答
 *  工具的放行语义由 permissions.test.ts 钉住，见该用例）。 */
export function describeDecisionMismatch(
  decision: PermissionResponseDecision,
  toolName: string,
): string | null {
  const isQuestion = toolName === QUESTION_TOOL_NAME;
  if (decision.kind === "answer" && !isQuestion) {
    return `answer 变体只对 ${QUESTION_TOOL_NAME} 有效（本条挂起请求的工具是 ${toolName}）`;
  }
  if (decision.kind === "approve" && isQuestion) {
    return `${QUESTION_TOOL_NAME} 必须用 answer 变体应答（approve 不带作答）`;
  }
  return null;
}

/** 放行附随数据（模式迁移 + 会话级规则）：仅放行路径有值，其余臂 null。
 *  worker 的唯一读取点——避免在命令分支里对两种形态各写一遍。 */
export function approvedExtras(
  decision: PermissionResponseDecision,
): { nextMode?: string; sessionRules?: PermissionRuleDraft[] } | null {
  const approved = decision.kind === "approve" || (decision.kind === "compat_flat" && decision.approved);
  if (!approved) return null;
  const out: { nextMode?: string; sessionRules?: PermissionRuleDraft[] } = {};
  if (decision.kind === "compat_flat" || decision.kind === "approve") {
    if (decision.nextMode !== undefined) out.nextMode = decision.nextMode;
    if (decision.sessionRules !== undefined) out.sessionRules = decision.sessionRules;
  }
  return out;
}

/** 决策 → 应答载荷（permissions.ts 的唯一入参形状）。 */
export function toPendingDecision(decision: PermissionResponseDecision): PendingDecision {
  switch (decision.kind) {
    case "approve":
      return { approved: true };
    case "answer":
      return { approved: true, answers: decision.answers };
    case "deny":
      // deniedBy 缺席即人工语义——与 cancelAll / abort / 连带放行等既有终结路径
      // 同一种编码，不引入"显式 user"这第二种写法。
      return {
        approved: false,
        ...(decision.message ? { message: decision.message } : {}),
      };
    case "unanswered":
      return {
        approved: false,
        deniedBy: "unanswered",
        ...(decision.reason ? { message: decision.reason } : {}),
      };
    case "compat_flat":
      return {
        approved: decision.approved,
        ...(decision.answers ? { answers: decision.answers } : {}),
        ...(decision.message ? { message: decision.message } : {}),
      };
  }
}
