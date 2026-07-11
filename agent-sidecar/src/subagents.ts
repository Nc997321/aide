const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task"]); // CC v2.1.63 把 Task 改名成 Agent，两个都认

/** 跟踪 Claude Agent SDK 的子代理调用（Agent/Task 工具），对外只暴露 provider-agnostic 的
 *  agentName/description/是否仍在跟踪中——mapper 层据此生成 subagent_start/subagent_end 事件。 */
export class SubagentTracker {
  private active = new Set<string>();
  /** 已经报过 model 的 id 集合——同一个子代理调用只带一次 model 字段，避免每步重复发送。 */
  private modelReported = new Set<string>();
  /** id（这次 Agent/Task tool_use 的 id）→ agentName——权限弹窗要标注"这是哪个子代理
   *  在问"时，靠 canUseTool 回调收到的 agentID 反查这里，拿到人看得懂的名字。 */
  private names = new Map<string, string>();

  static isSubagentTool(name: string): boolean {
    return SUBAGENT_TOOL_NAMES.has(name);
  }

  /** tool_use 到达时调用：agentName/description/prompt 从 input 里立即可得，不用等 tool_result。
   *  prompt 是主代理派发时塞进 Agent 工具 input 的完整任务描述（如 superpowers 的 implementer
   *  契约），非空才回——空字符串不进事件，前端不渲染派发指令区。 */
  handleToolUse(id: string, input: unknown): { agentName: string; description: string; prompt: string } {
    this.active.add(id);
    const record = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const agentName = typeof record.subagent_type === "string" ? record.subagent_type : "agent";
    const description = typeof record.description === "string" ? record.description : "";
    const prompt = typeof record.prompt === "string" ? record.prompt : "";
    this.names.set(id, agentName);
    return { agentName, description, prompt };
  }

  /** 返回 true 表示这个 tool_use_id 属于子代理调用，调用方应发 subagent_end 而非通用 tool_result。 */
  handleToolResult(id: string): boolean {
    this.modelReported.delete(id);
    this.names.delete(id);
    return this.active.delete(id);
  }

  /** 按 id 查子代理名字——canUseTool 回调收到的 `agentID`（子代理内部工具请求权限时
   *  SDK 附带的标识）借此翻成人看得懂的 agentName。查不到（id 不认识/子代理已结束）
   *  时返回 undefined，调用方自己兜底成通用文案，不假设这个 id 一定认识。 */
  getAgentName(id: string): string | undefined {
    return this.names.get(id);
  }

  /** 某个 parent_tool_use_id 当前是否对应一个仍在运行的子代理调用——子代理内部
   *  消息（mapper.ts 里带 parent_tool_use_id 的那些）据此过滤掉不认识的 id（防御性，
   *  正常情况下 SDK 给的 parent_tool_use_id 必然对应一个我们正追踪着的调用）。 */
  isActive(id: string): boolean {
    return this.active.has(id);
  }

  /** 子代理内部第一条可采信 assistant 消息的 model 只报一次：调用方应先确认这条
   *  消息确实可采信（如 isAdoptableAssistantModel），再调用本方法申领"上报名额"——
   *  返回 true 才把 model 字段带上，避免占位符/错误回声消耗掉唯一一次上报机会。 */
  claimModelReport(id: string): boolean {
    if (!this.active.has(id) || this.modelReported.has(id)) return false;
    this.modelReported.add(id);
    return true;
  }
}
