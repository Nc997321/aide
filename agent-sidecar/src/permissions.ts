import { randomUUID } from "node:crypto";
import type { ChatEvent } from "./types.js";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

interface Decision {
  approved: boolean;
  /** 只在 approved && always 时有值：附加到 PermissionResult 上让 SDK 落盘持久化。 */
  updatedPermissions?: PermissionUpdate[];
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
      return {
        behavior: "allow" as const,
        updatedInput: input as Record<string, unknown>,
        ...(decision.updatedPermissions ? { updatedPermissions: decision.updatedPermissions } : {}),
      };
    };
  }

  resolve(id: string, approved: boolean, always?: boolean) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (!approved || !always) {
      entry.resolve({ approved });
      return;
    }
    const updatedPermissions: PermissionUpdate[] = entry.suggestions?.length
      ? entry.suggestions
      : [{
          type: "addRules",
          rules: [{ toolName: entry.toolName }],
          behavior: "allow",
          destination: "projectSettings",
        }];
    entry.resolve({ approved, updatedPermissions });
  }
}
