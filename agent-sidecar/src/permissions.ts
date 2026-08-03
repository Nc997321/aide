import { randomUUID } from "node:crypto";
import type { ChatEvent } from "./types.js";
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
  resolve: (decision: { approved: boolean; answers?: Record<string, string> }) => void;
  toolName: string;
  /** Notify the frontend to dismiss this request (interrupt / cancel). */
  emitCancelled: () => void;
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
  ): Promise<{ approved: boolean; updatedInput?: Record<string, unknown> }> {
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
    const decision = await new Promise<{ approved: boolean; answers?: Record<string, string> }>(
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
      return { approved: false };
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
        return { behavior: "deny" as const, message: "用户拒绝" };
      }
      return {
        behavior: "allow" as const,
        ...(result.updatedInput ? { updatedInput: result.updatedInput } : {}),
      };
    };
  }

  /** Settle a pending request (returns undefined when no matching pending id).
   *  The controller uses the returned `toolName` to detect ExitPlanMode /
   *  EnterPlanMode and apply the follow-up mode change. */
  resolve(
    id: string,
    approved: boolean,
    answers?: Record<string, string>,
  ): ResolveOutcome | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    entry.resolve({ approved, answers });
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
   *  made them moot — e.g. entering acceptEdits with several Edits queued in
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