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
    acceptEdits: "自动接受编辑（本次会话）",
    bypassPermissions: "自动模式：跳过所有确认（本次会话）",
    plan: "切换到 Plan 模式",
    dontAsk: "本次会话不再询问（未预先允许的仍会拒绝）",
    auto: "本次会话交给模型自动判断",
    default: "恢复默认权限模式",
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
        this.pending.set(id, { resolve, toolName, suggestions: opts?.suggestions });
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

  /** 返回被响应的工具名（无此 pending 时返回 undefined）——入口层用它识别
   *  "ExitPlanMode 被批准"这类需要联动会话状态的特殊工具。 */
  resolve(id: string, approved: boolean, always?: boolean, answers?: Record<string, string>): string | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    if (!approved || !always) {
      entry.resolve({ approved, answers });
      return entry.toolName;
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
    return entry.toolName;
  }
}
