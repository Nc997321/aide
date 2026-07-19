import { randomUUID } from "node:crypto";
import type { ChatEvent } from "./types.js";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import type { SubagentTracker } from "./subagents.js";

interface Decision {
  approved: boolean;
  /** 只在 approved && always 时有值：附加到 PermissionResult 上让 SDK 落盘持久化。 */
  updatedPermissions?: PermissionUpdate[];
  /** 仅 AskUserQuestion：问题文本 → 用户选中的答案（多选已 join，或自由文本）。
   *  批准时据此重组 updatedInput，而不是像其他工具那样原样透传 input。 */
  answers?: Record<string, string>;
}

interface PendingEntry {
  resolve: (decision: Decision) => void;
  toolName: string;
  /** SDK 按这次具体调用生成的规则建议（Bash 按命令前缀、Read 按目录等），
   *  比"整个工具名"更精细——"总是允许"时原样带回去，让 SDK 自己写持久化规则。 */
  suggestions?: PermissionUpdate[];
  /** 通知前端把这条请求从队列里撤下（被"总是允许"连带放行/中断取消时）。
   *  持有闭包而不是 emit 本身：emit 只在 makeCallback 作用域里可用。 */
  emitCancelled: () => void;
}

/** "总是允许"的结算结果——入口层（index.ts）据此联动会话状态：
 *  appliedMode 非空表示 SDK 已通过 updatedPermissions 切换了权限模式，
 *  sidecar 需要对齐本地账本并广播，否则前端的模式按钮永远不会自动变。 */
export interface ResolveOutcome {
  toolName: string;
  appliedMode?: string;
}

/**
 * "总是允许"按钮的文案要如实反映点下去之后会发生什么，而不是一律显示同一句
 * "总是允许"——SDK 的 suggestions 里如果带一条 `setMode`（比如 Edit 工具常见的
 * "本次会话自动接受编辑"），这就不是"给这个工具加一条持久化规则"，而是"整个会话
 * 切到另一种权限模式"（`destination: 'session'`，关掉会话/换会话就恢复默认，不
 * 落盘）——两者后果差异很大，用户理应在点按钮前就知道，而不是点完才发现。
 * 没有 setMode 建议时退回通用"总是允许"文案（addRules/目录规则等场景）。
 */
function describeAlwaysAllow(suggestions?: PermissionUpdate[]): string | undefined {
  if (!suggestions?.length) return undefined;
  const modeUpdate = suggestions.find(
    (s): s is Extract<PermissionUpdate, { type: "setMode" }> => s.type === "setMode",
  );
  if (!modeUpdate) return "总是允许";
  const modeLabels: Record<string, string> = {
    acceptEdits: "编辑模式（本次会话）",
    bypassPermissions: "最高权限（本次会话）",
    plan: "切换到计划模式",
    dontAsk: "本次会话不再询问（未预先允许的仍会拒绝）",
    auto: "自动模式（本次会话）",
    default: "恢复手动模式",
  };
  return modeLabels[modeUpdate.mode] ?? `切换权限模式：${modeUpdate.mode}（本次会话）`;
}

export class PermissionManager {
  private pending = new Map<string, PendingEntry>();

  /** subagents 可选：用来把 canUseTool 收到的 agentID（子代理内部工具请求权限时
   *  SDK 附带的标识）翻成人看得懂的 agentName，让权限弹窗标注"这是哪个子代理在问"
   *  而不是让用户在毫无上下文的情况下面对一个突然弹出的框。不传时该功能静默关闭
   *  （fromSubagent 字段永不出现），不影响原有批准/拒绝流程。 */
  makeCallback(emit: (e: ChatEvent) => void, subagents?: SubagentTracker) {
    return async (
      toolName: string,
      input: unknown,
      opts?: { signal?: AbortSignal; suggestions?: PermissionUpdate[]; agentID?: string },
    ) => {
      // 信号在回调发生前就已中止（中断和工具调用赛跑的窄窗口）：addEventListener
      // 对已 aborted 的信号不会再触发，直接挂 Promise 会永久悬置——上来先查一次。
      if (opts?.signal?.aborted) {
        return { behavior: "deny" as const, message: "已中断" };
      }
      const id = randomUUID();
      // agentID 仅在这次请求确实来自子代理内部时才有值（SDK 语义）；查不到名字
      // （id 对不上/子代理已经结束）时兜底成通用"子代理"，而不是隐藏这个信息。
      const fromSubagent = opts?.agentID
        ? { id: opts.agentID, agentName: subagents?.getAgentName(opts.agentID) ?? "子代理" }
        : undefined;
      emit({
        type: "permission_request",
        id,
        name: toolName,
        input,
        alwaysAllowLabel: describeAlwaysAllow(opts?.suggestions),
        ...(fromSubagent ? { fromSubagent } : {}),
      });
      const decision = await new Promise<Decision>((resolve) => {
        this.pending.set(id, {
          resolve,
          toolName,
          suggestions: opts?.suggestions,
          emitCancelled: () => emit({ type: "permission_cancelled", id }),
        });
        // 中断（interrupt）会 abort signal：视为拒绝并通知前端关掉对话框
        opts?.signal?.addEventListener(
          "abort",
          () => {
            if (this.pending.delete(id)) {
              emit({ type: "permission_cancelled", id });
              resolve({ approved: false });
            }
          },
          { once: true },
        );
      });
      if (!decision.approved) {
        return { behavior: "deny" as const, message: "用户拒绝" };
      }
      // AskUserQuestion：SDK 要求把答案重组进 updatedInput（{questions, answers}），
      // 不能像其他工具那样原样透传 input——这是它与普通工具批准语义唯一的分歧点，
      // 只在这里（sidecar 内）体现，Rust/前端全程只搬运不透明的 answers 字符串映射。
      const updatedInput: Record<string, unknown> =
        toolName === "AskUserQuestion" && decision.answers
          ? { questions: (input as { questions?: unknown } | undefined)?.questions, answers: decision.answers }
          : (input as Record<string, unknown>);
      return {
        behavior: "allow" as const,
        updatedInput,
        ...(decision.updatedPermissions ? { updatedPermissions: decision.updatedPermissions } : {}),
      };
    };
  }

  /** 结算一次权限响应（无此 pending 时返回 undefined）——入口层用返回值识别
   *  "ExitPlanMode 被批准"和"总是允许切换了权限模式"这类需要联动会话状态的情况。 */
  resolve(id: string, approved: boolean, always?: boolean, answers?: Record<string, string>): ResolveOutcome | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    if (!approved || !always) {
      entry.resolve({ approved, answers });
      return { toolName: entry.toolName };
    }
    const updatedPermissions: PermissionUpdate[] = entry.suggestions?.length
      ? entry.suggestions
      : [{
          type: "addRules",
          rules: [{ toolName: entry.toolName }],
          behavior: "allow",
          destination: "projectSettings",
        }];
    entry.resolve({ approved, updatedPermissions, answers });
    const appliedMode = updatedPermissions.find(
      (u): u is Extract<PermissionUpdate, { type: "setMode" }> => u.type === "setMode",
    )?.mode;
    this.autoApproveCovered(entry.toolName, updatedPermissions, appliedMode);
    return { toolName: entry.toolName, ...(appliedMode ? { appliedMode } : {}) };
  }

  /** "总是允许"后连带放行队列里已被新授权**定义上必然覆盖**的挂起请求——
   *  SDK 对已发出的 canUseTool 不会用新规则重新评估，不放行就得用户逐条再点。
   *  只处理两种能静态断定覆盖关系的情况：
   *  - 切到 bypassPermissions（会话级跳过一切确认）→ 放行全部；
   *  - 落盘了裸工具名 allow 规则（无 ruleContent 限定）→ 放行同名工具。
   *  带 ruleContent（按目录/命令前缀等）的规则不放行：匹配语义在 CLI 内部，
   *  这里重新实现一遍容易放宽授权，宁可让用户多确认一次。 */
  private autoApproveCovered(toolName: string, updates: PermissionUpdate[], appliedMode?: string) {
    const coversAll = appliedMode === "bypassPermissions";
    const coversSameTool = updates.some(
      (u) =>
        u.type === "addRules" &&
        u.behavior === "allow" &&
        u.rules.some((r) => r.toolName === toolName && !r.ruleContent),
    );
    if (!coversAll && !coversSameTool) return;
    for (const [pid, p] of [...this.pending]) {
      if (!coversAll && p.toolName !== toolName) continue;
      this.pending.delete(pid);
      // 不重复携带 updatedPermissions——规则/模式已随首条响应生效
      p.resolve({ approved: true });
      p.emitCancelled();
    }
  }
}
