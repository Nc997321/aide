const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task"]); // CC v2.1.63 把 Task 改名成 Agent，两个都认

/** 跟踪 Claude Agent SDK 的子代理调用（Agent/Task 工具），对外只暴露 provider-agnostic 的
 *  agentName/description/是否仍在跟踪中——mapper 层据此生成 subagent_start/subagent_end 事件。 */
export class SubagentTracker {
  private active = new Set<string>();

  static isSubagentTool(name: string): boolean {
    return SUBAGENT_TOOL_NAMES.has(name);
  }

  /** tool_use 到达时调用：agentName/description 从 input 里立即可得，不用等 tool_result。 */
  handleToolUse(id: string, input: unknown): { agentName: string; description: string } {
    this.active.add(id);
    const record = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const agentName = typeof record.subagent_type === "string" ? record.subagent_type : "agent";
    const description = typeof record.description === "string" ? record.description : "";
    return { agentName, description };
  }

  /** 返回 true 表示这个 tool_use_id 属于子代理调用，调用方应发 subagent_end 而非通用 tool_result。 */
  handleToolResult(id: string): boolean {
    return this.active.delete(id);
  }
}
