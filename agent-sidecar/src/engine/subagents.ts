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
  /** async 子代理的 .output 回放元数据：id → { agentId, outputFile }。
   *  launch-ack 时注册，task-notification 完成时清理。 */
  private asyncMeta = new Map<string, { agentId: string; outputFile: string }>();
  /** 本轮（一条 user 消息 → 一个 result 之间）派发的子代理调用数。handleToolUse 时累加，
   *  result 到达时由 mapper 调 consumeTurnSubagentCount() 读取并清零——result 时所有
   *  子代理都已 handleToolResult 从 active 移除，active.size 已为 0，无法据此判断
   *  "本轮是否派过子代理"，故单独维护这个计数器供用量归因（subagentTurn/subagentCount）。 */
  private turnDispatchCount = 0;
  /** tool_use_id → 嵌套深度。顶层（主线程派发）=1；嵌套（子代理派子代理）= 父 depth+1。
   *  深度来源是 sidechain 消息的 parent_tool_use_id 链（mapper 侧），不是 SubagentStart hook
   *  （后者不带父 agent_id，算不出精确深度）。顶层 entry 在 handleToolResult 时删除；
   *  嵌套 entry 随 SubagentTracker 实例 GC（per-session，bounded，不跨会话泄漏）。 */
  private depthByToolUseId = new Map<string, number>();

  static isSubagentTool(name: string): boolean {
    return SUBAGENT_TOOL_NAMES.has(name);
  }

  /** tool_use 到达时调用：agentName/description/prompt 从 input 里立即可得，不用等 tool_result。
   *  prompt 是主代理派发时塞进 Agent 工具 input 的完整任务描述（如 superpowers 的 implementer
   *  契约），非空才回——空字符串不进事件，前端不渲染派发指令区。 */
  handleToolUse(id: string, input: unknown): { agentName: string; description: string; prompt: string } {
    this.active.add(id);
    this.turnDispatchCount++;
    this.depthByToolUseId.set(id, 1); // 顶层子代理（主线程派发）深度 = 1
    const record = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const agentName = typeof record.subagent_type === "string" ? record.subagent_type : "agent";
    const description = typeof record.description === "string" ? record.description : "";
    const prompt = typeof record.prompt === "string" ? record.prompt : "";
    this.names.set(id, agentName);
    return { agentName, description, prompt };
  }

  /** 嵌套派发：子代理内部又调 Agent/Task 派子代理。parentId = sidechain 消息的
   *  parent_tool_use_id（即派发方那次 Agent tool_use 的 id），childId = 嵌套那次 Agent
   *  tool_use 的 id。返回嵌套深度（父 depth + 1；父未知时按 1 兜底，即视为 depth 2）。 */
  recordNestedSpawn(parentId: string, childId: string): number {
    const parentDepth = this.depthByToolUseId.get(parentId) ?? 1;
    const depth = parentDepth + 1;
    this.depthByToolUseId.set(childId, depth);
    return depth;
  }

  /** 返回 true 表示这个 tool_use_id 属于子代理调用，调用方应发 subagent_end 而非通用 tool_result。 */
  handleToolResult(id: string): boolean {
    this.modelReported.delete(id);
    this.names.delete(id);
    this.depthByToolUseId.delete(id); // 顶层 entry 清理；嵌套 entry 随实例 GC
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

  /** async launch-ack 时调用：记下 .output 路径，id 保持 active（不关）。 */
  registerAsync(id: string, agentId: string, outputFile: string): void {
    this.asyncMeta.set(id, { agentId, outputFile });
  }

  getAsyncOutputFile(id: string): string | undefined {
    return this.asyncMeta.get(id)?.outputFile;
  }

  /** 该 id 是否是 async（后台）子代理——已收到 launch-ack，tool_result 只是回执，
   *  终态只能靠结构化 task_notification 送到。前台子代理不走这条：它的 tool_result
   *  里才是真结果（两帧同刻到达，结构化先收会把结果降级成 summary）。 */
  isAsync(id: string): boolean {
    return this.asyncMeta.has(id);
  }

  /** task-notification 完成时调用：清 async 元数据 + 关 active（复用 handleToolResult）。 */
  handleAsyncResult(id: string): boolean {
    this.asyncMeta.delete(id);
    return this.handleToolResult(id);
  }

  /** result 到达时调用：返回本轮派发的子代理数并清零。mapper 据此填 TurnUsage.subagentTurn
   *  /subagentCount。多次调用只第一次有值（防御性——一轮只应有一个 result）。 */
  consumeTurnSubagentCount(): number {
    const n = this.turnDispatchCount;
    this.turnDispatchCount = 0;
    return n;
  }

  /** 会话终结（session_stop / claude.exe 死亡）兜底：进程没了，在跟踪的子代理再也
   *  等不到终态（异步子代理靠 structured task_notification 收尾）——返回其 id 列表
   *  并清空跟踪表，调用方按 id 补发终态事件，UI 不留僵尸「运行中」。
   *  事件构造不在这里（本类不碰 ChatEvent，同 handleToolResult 的边界）。幂等。 */
  drainActive(): string[] {
    const ids = [...this.active];
    this.active.clear();
    this.asyncMeta.clear();
    this.modelReported.clear();
    this.names.clear();
    this.depthByToolUseId.clear();
    return ids;
  }
}
