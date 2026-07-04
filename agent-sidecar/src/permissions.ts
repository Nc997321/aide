import { randomUUID } from "node:crypto";
import type { ChatEvent } from "./types.js";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

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

export class PermissionManager {
  private pending = new Map<string, PendingEntry>();

  makeCallback(emit: (e: ChatEvent) => void) {
    return async (
      toolName: string,
      input: unknown,
      opts?: { signal?: AbortSignal; suggestions?: PermissionUpdate[] },
    ) => {
      const id = randomUUID();
      emit({ type: "permission_request", id, name: toolName, input });
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
