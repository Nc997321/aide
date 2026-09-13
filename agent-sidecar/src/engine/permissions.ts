import { randomUUID } from "node:crypto";
import type { ChatEvent } from "./types.js";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { SubagentTracker } from "./subagents.js";

/** Context passed to `PermissionManager.request` — the optional abort signal
 *  (from the SDK canUseTool path) and the subagent attribution id. */
export interface PermissionRequestContext {
  signal?: AbortSignal;
  agentID?: string;
}

/** Resolve outcome — the controller uses `toolName` to detect ExitPlanMode /
 *  EnterPlanMode and apply the follow-up permission-mode change. The old
 *  `appliedMode` (from the removed "always allow" → SDK setMode path) is gone. */
export interface ResolveOutcome {
  toolName: string;
}

interface PendingEntry {
  resolve: (decision: {
    approved: boolean;
    answers?: Record<string, string>;
    /** 拒绝理由（用户输入）：作为 user feedback 交给 CLI，由官方模板包装后
     *  反馈给模型（见 makeCallback 的 deny 分支）。 */
    message?: string;
  }) => void;
  toolName: string;
  /** Notify every connected client to dismiss this request. Fired on all
   *  terminal paths (settled by anyone, aborted, interrupt, bulk-approve). */
  emitCancelled: () => void;
}

// ---- deny 文案：官方外框（SDK 通道契约） ------------------------------------
// SDK 通道里 canUseTool/hook 的 deny message 会被 CLI **原样**塞进 tool_result
// 正文并标 toolDenialKind:"permission-rule"（2026-09-08 运行时实证 + 反汇编：
// 带 YFe 模板的 cancelAndAbort 是终端交互 UI 的路径，SDK 宿主不走）。因此外框
// （"这是拒绝、工具未执行、用户说了什么"）必须由宿主自己写——官方文档的 deny
// 示例（「建议替代方案」一节）也是自带外框的。
// 模板原文取自 claude.exe（YFe/nhe/hRe，@279529599 起）。
//
// 读取方：packages/aide-sdk/src/utils/toolDenial.ts 的 parseToolDenial 按这两个
// 前缀反解「是否拒绝 + 拒绝理由」，前端据此渲染拒绝态。**改这里的外框必须同步
// 那边的前缀**，否则 UI 静默退化成普通报错（不崩、只是认不出来）。
const DENY_BASE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";
const DENY_POLICY_BASE =
  "Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). Try a different approach or report the limitation to complete your task.";

/** 人工拒绝（用户在弹窗点了拒绝）。有附言 → YFe 形态；无附言 → nhe 形态。 */
export function userDenyMessage(feedback?: string): string {
  const f = feedback?.trim();
  return f
    ? `${DENY_BASE} To tell you how to proceed, the user said:\n${f}`
    : `${DENY_BASE} STOP what you are doing and wait for the user to tell you how to proceed.`;
}

/** 策略/规则拒绝（非人工）。外框用 hRe（"Try a different approach"），理由追加在后。 */
export function policyDenyMessage(reason?: string): string {
  return reason ? `${DENY_POLICY_BASE}\n\n${reason}` : DENY_POLICY_BASE;
}

/**
 * Reusable, provider-agnostic confirmation queue.
 *
 * This is ONLY reached when the Aide policy hook asks (a policy rule matched
 * with effect `ask`) — the policy hook in `session-worker.ts` is the
 * authoritative PreToolUse layer; on no-match it returns {} (lets the CLI
 * proceed), on allow/deny it decides directly. Here we just run the human
 * confirmation flow: emit a `permission_request`, await `resolve()`, and (for
 * AskUserQuestion) reshape the answers into `updatedInput`.
 *
 * No `PermissionUpdate`, `updatedPermissions`, `always`, or SDK `suggestions`
 * — Aide owns rule persistence; the SDK settings persistence path is gone.
 */
export class PermissionManager {
  private pending = new Map<string, PendingEntry>();

  /** Emit a `permission_request` and wait for `resolve()`. Returns
   *  `{ approved, updatedInput? }`. `updatedInput` is set only for
   *  AskUserQuestion (answers reshaped per the SDK contract). */
  async request(
    toolName: string,
    input: unknown,
    context: PermissionRequestContext,
    emit: (e: ChatEvent) => void,
    subagents?: SubagentTracker,
  ): Promise<{ approved: boolean; updatedInput?: Record<string, unknown>; message?: string }> {
    // Signal already aborted before the callback fired (interrupt/tool race):
    // addEventListener on an already-aborted signal won't fire, so check first.
    if (context.signal?.aborted) {
      return { approved: false };
    }
    const id = randomUUID();
    const fromSubagent = context.agentID
      ? { id: context.agentID, agentName: subagents?.getAgentName(context.agentID) ?? "子代理" }
      : undefined;
    emit({
      type: "permission_request",
      id,
      name: toolName,
      input,
      ...(fromSubagent ? { fromSubagent } : {}),
    });
    const decision = await new Promise<{
      approved: boolean;
      answers?: Record<string, string>;
      message?: string;
    }>(
      (resolve) => {
        this.pending.set(id, {
          resolve,
          toolName,
          emitCancelled: () => emit({ type: "permission_cancelled", id }),
        });
        context.signal?.addEventListener(
          "abort",
          () => {
            if (this.pending.delete(id)) {
              emit({ type: "permission_cancelled", id });
              resolve({ approved: false });
            }
          },
          { once: true },
        );
      },
    );
    if (!decision.approved) {
      // 拒绝理由：仅 deny 路径有意义（用户输入），作为 user feedback 交给 CLI。
      return { approved: false, ...(decision.message ? { message: decision.message } : {}) };
    }
    // AskUserQuestion: SDK requires the answers reshaped into updatedInput
    // ({questions, answers}) — the one divergence from plain tool approval,
    // which just passes input through. Sidecar-only; Rust/Vue only carry the
    // opaque answers string map.
    const updatedInput: Record<string, unknown> =
      toolName === "AskUserQuestion" && decision.answers
        ? {
            questions: (input as { questions?: unknown } | undefined)?.questions,
            answers: decision.answers,
          }
        : (input as Record<string, unknown>);
    return { approved: true, updatedInput };
  }

  /** SDK `canUseTool` adapter: delegates to `request` and returns the SDK
   *  `behavior: "allow" | "deny"` shape. The `suggestions` opt (formerly used
   *  for "always allow") is ignored — Aide rules persist via the settings UI. */
  makeCallback(emit: (e: ChatEvent) => void, subagents?: SubagentTracker) {
    return async (
      toolName: string,
      input: unknown,
      opts?: { signal?: AbortSignal; suggestions?: unknown; agentID?: string },
    ) => {
      const result = await this.request(
        toolName,
        input,
        { signal: opts?.signal, agentID: opts?.agentID },
        emit,
        subagents,
      );
      if (!result.approved) {
        // 人工拒绝：官方外框 + 用户附言（见文件顶部的 userDenyMessage 注释）。
        // decisionClassification 如实上报「人工拒绝」——SDK 宿主弹窗后按文档要求
        // 设置，CLI 不再保守推断（sdk.d.ts PermissionDecisionClassification）。
        return {
          behavior: "deny" as const,
          message: userDenyMessage(result.message),
          decisionClassification: "user_reject" as const,
        };
      }
      return {
        behavior: "allow" as const,
        ...(result.updatedInput ? { updatedInput: result.updatedInput } : {}),
      };
    };
  }

  /** Settle a pending request (returns undefined when no matching pending id).
   *  The controller uses the returned `toolName` to detect ExitPlanMode /
   *  EnterPlanMode and apply the follow-up mode change.
   *
   *  无论谁做的决策都广播 `permission_cancelled`：命令通道（本机点击 / 远程 RPC）
   *  和事件通道是两条独立的管道，而 UI 状态只认事件通道。本机点击时前端在 invoke
   *  之前就已乐观出队（`useChatSession.ts`），但**远程客户端**的决策只走命令通道
   *  到达这里，桌面前端没有任何本地对账动作——不广播，桌面弹窗就永久挂着（用户
   *  再点一次还会 resolve 成 undefined，静默无反应）。前端把该事件读成「从队列
   *  移除」，所以对本机决策重放一次是幂等的 no-op。 */
  resolve(
    id: string,
    approved: boolean,
    answers?: Record<string, string>,
    /** 拒绝理由：透传给 SDK 的 deny message（仅 approved=false 时生效）。 */
    message?: string,
  ): ResolveOutcome | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    // 先撤 UI 再放行工具：事件同步发出，工具续跑是微任务，弹窗不会盖在已执行的
    // 工具结果上。pending 已删，后续 abort 的 delete 返回 false，不会重复广播。
    entry.emitCancelled();
    entry.resolve({ approved, answers, message });
    return { toolName: entry.toolName };
  }

  /** Abort every pending request (interrupt / session stop). Resolves each with
   *  `approved: false` and notifies the frontend to dismiss the dialogs. */
  cancelAll(): void {
    for (const [, entry] of [...this.pending]) {
      entry.resolve({ approved: false });
      entry.emitCancelled();
    }
    this.pending.clear();
  }

  /** Approve every pending request whose tool is in `toolNames` (a mode switch
   *  made them moot — e.g. entering auto with several Edits queued in
   *  parallel). Resolves each approved and dismisses its frontend dialog via
   *  the same permission_cancelled event (frontend only reads it as "remove
   *  from queue"). Returns how many were settled. */
  approveMatching(toolNames: ReadonlySet<string>): number {
    let settled = 0;
    for (const [id, entry] of [...this.pending]) {
      if (!toolNames.has(entry.toolName)) continue;
      this.pending.delete(id);
      entry.resolve({ approved: true });
      entry.emitCancelled();
      settled++;
    }
    return settled;
  }
}
/** 无人应答支线的 canUseTool 守卫（session-worker.makeCanUseToolCallback 迁出，
 *  拆分批 3，纯移动）：btw/automation 命中一律 deny，否则委托人工确认回调。
 *  这是 Aide 人工确认的**唯一**应答点：策略裁决为 ask 时 policy hook 只回
 *  `permissionDecision:"ask"`，由 CLI 转到这里弹窗等用户。CLI 拿到这里的 deny
 *  会用官方模板包装拒绝结果。 */
export function makeGuardedCanUseTool(deps: {
  permissionCallback: CanUseTool;
  isBtw: () => boolean;
  isAutomation: () => boolean;
}): CanUseTool {
  return async (toolName, input, opts) => {
    // btw 支线没有权限弹窗通路(permission_request 会被前端 btw 路由吞掉,
    // 干等 resolve → 永久挂起):落到这里的一律 deny。
    // 注：allowDangerouslySkipPermissions 只让 CLI 跳过**规则层**的询问——
    // hook 不表态（{} 或 defer）时工具被静默放行、这里确实不会被调用
    // (2026-08-09 实测,btw 任务支线的 ipconfig 就是这么漏过去的,所以
    // taskTools 白名单外的命令必须在 hook 里 deny)。但 hook 显式返回
    // permissionDecision:"ask" 时,该决策会作为预置决策绕过规则层直接进
    // 权限流水线,这里**会**被调用。
    if (deps.isBtw()) {
      return {
        behavior: "deny" as const,
        message: "btw 支线无人应答权限请求(仅策略白名单内操作可用)",
      };
    }
    // 自动化运行同理无人应答：policy hook 已对白名单内操作 allow、其余 deny，
    // 能落到这里的都是 hook 未覆盖的边角——一律 deny（绝不 defer 等弹窗）。
    if (deps.isAutomation()) {
      return {
        behavior: "deny" as const,
        message: "自动化运行无人值守(仅白名单内工具可用)",
      };
    }
    return deps.permissionCallback(toolName, input, opts);
  };
}
