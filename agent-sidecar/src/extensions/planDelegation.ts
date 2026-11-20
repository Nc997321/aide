// 计划批准后的宿主策略：主会话只整理已有探索，复用 aide-sessions 派出执行会话。
// 不 fork 历史、不让主会话同时实现；引擎只接线，派发仍走原有 Host 管线。
import type { ChatEvent } from "../engine/types.js";
import type { SubsessionResponse } from "./subsessions.js";

export interface ExplorationHandoff {
  findings: string;
  files: string[];
  checks: string;
  open_questions: string;
}

export class PlanDelegation {
  private state: { plan: string; phase: "preparing" | "starting" | "spawned" | "failed" } | null = null;
  constructor(private readonly emit: (e: ChatEvent) => void) {}

  get active(): boolean { return this.state !== null; }

  begin(plan: string): string {
    this.state = { plan, phase: "preparing" };
    this.emit({ type: "plan_delegation", status: "preparing" });
    // 与 @aide/sdk/utils/toolDenial 的计划移交标记同步：实时和历史均不能显示成「拒绝计划」。
    return `[Aide plan delegation]\nThe user approved this exact plan for execution in ONE NEW Aide sub-session, not in this conversation. Stay in plan mode; prepare the handoff rather than implementing here.
Use your EXISTING conversation context to prepare a concise, self-contained handoff, then call mcp__aide-sessions__session_spawn once. Include task (goal, scope, constraints, acceptance criteria), title, and exploration: { findings, files, checks, open_questions }.
findings includes what you already learned, relevant symbols/line locations, important decisions and any existing working-tree changes; files lists known relevant paths; checks states commands/results ALREADY verified (or explicitly not run); open_questions separates unknowns from facts (or explicitly none). Never invent missing evidence. Include user constraints. Keep the handoff concise; do not copy the conversation, full files, raw tool output or credentials. Normally no further file reads or searches are needed to prepare this handoff; use your judgment if a specific gap needs checking. The approved plan will be attached automatically; do not repeat it in task.
The child starts with Auto permission mode and must reuse these findings, read only the code needed for accurate edits, implement, test and report. No broad rediscovery unless the user explicitly asks or a concrete gap/stale/conflicting fact requires targeted checking. After successful dispatch, briefly tell the user and end your turn; do not execute the plan yourself or poll. On dispatch failure, report the error and wait for the user; do not retry automatically or take over implementation.`;
  }

  /** 交接期间的新消息是补充/纠正，不能丢掉已批准的计划。失败后可由用户要求再试。 */
  noteUserMessage(): void {
    if (this.state?.phase === "spawned") {
      this.state = null; // 新的一轮可另派任务；界面继续观察已启动子会话的进度。
    } else if (this.state?.phase === "failed") {
      this.state.phase = "preparing";
      this.emit({ type: "plan_delegation", status: "preparing" });
    }
  }

  /** 用户打断正在进行的交接。 */
  clear(): void {
    if (!this.state) return;
    this.state = null;
    this.emit({ type: "plan_delegation", status: "cleared" });
  }

  /** 模型也可能没有派发就收轮：不要把顶部永远留在「正在整理交接」。 */
  turnEnded(): void {
    if (this.state?.phase !== "preparing") return;
    this.state.phase = "failed";
    this.emit({ type: "plan_delegation", status: "failed" });
    this.emit({ type: "notification", notification_type: "info", message: "计划交接尚未完成，未确认子会话开始执行；可补充指令继续交接。" });
  }

  async spawn(
    args: Record<string, unknown>,
    run: (args: Record<string, unknown>, permissionMode?: string) => Promise<SubsessionResponse>,
  ): Promise<SubsessionResponse> {
    const state = this.state;
    if (!state) return run(args);
    if (state.phase !== "preparing") return { ok: false, error: "计划已经派发或派发失败；请等待结果或用户的新指令，不要重复派发。" };
    const h = args.exploration as ExplorationHandoff | undefined;
    if (!h || ![h.findings, h.checks, h.open_questions].every(v => typeof v === "string" && v.trim()) ||
        !Array.isArray(h.files) || !h.files.every(v => typeof v === "string" && v.trim()) ||
        typeof args.task !== "string" || !args.task.trim()) {
      return { ok: false, error: "请使用已有上下文补全 task 与 exploration（findings、files、checks、open_questions），不要重新探索或虚构信息。尚未启动子会话。" };
    }
    state.phase = "starting"; // 同步抢占：并发的第二次调用不能重复启动。
    const task = `[Approved plan — execute in this sub-session]\n${state.plan}\n\n[Task and constraints]\n${args.task}

[Exploration already completed by the parent — reuse this evidence]
${h.findings}

[Known files and symbols]
${h.files.join("\n") || "No relevant files identified yet; report this gap before broad exploration."}

[Checks already performed]
${h.checks}

[Unresolved questions — not established facts]
${h.open_questions}

[Execution rules]
Start implementation using the approved plan and the supplied findings. Avoid repeating project scans, architecture discovery, file-location searches or completed experiments merely to rebuild context. Use your judgment: read current code needed for accurate edits and run relevant validation after changes. If a missing/stale/conflicting fact warrants more exploration, briefly explain why and focus on that gap; the user may also explicitly request new investigation. Follow applicable repository instructions. Reuse completed checks unless changes or other evidence justify repeating them.
Create/update your task list from the plan so the user can follow progress. Report changes, validation, remaining issues and evidence locations concisely. Do not send full files, raw logs or conversation transcripts back to the parent. Do not spawn further sub-sessions or subagents.`;
    let result: SubsessionResponse;
    try {
      // 用户点的是新子会话；模型和档位沿用父会话，不能被交接时的模型自行更换。
      const { model: _model, exploration: _exploration, ...rest } = args;
      result = await run({ ...rest, task, new: true }, "auto");
    } catch (e) {
      result = { ok: false, error: String(e) };
    }
    // 用户可能在启动期间中断/补充指令；不把过期的状态写回新的一次委派。
    if (this.state !== state) return result;
    const childId = result.ok && result.data?.started !== false && typeof result.data?.child_id === "string"
      ? result.data.child_id : undefined;
    state.phase = childId ? "spawned" : "failed";
    this.emit({ type: "plan_delegation", status: childId ? "spawned" : "failed", ...(childId ? { childId } : {}) });
    return result;
  }
}
