/**
 * 追踪当前有多少个工具调用"已经发出去、结果还没回来"。
 *
 * 存在的唯一目的：给"插队"功能判断安全边界——只有这个数字归零的瞬间（当前这一步
 * 指令刚好跑完，模型还没来得及开始下一步）才允许真正 interrupt() 打断这一轮，
 * 否则会腰斩一个正在执行的工具（可能是还在跑的 bash 命令、还没写完的文件），
 * 也就是丢弃本轮已经产出的内容。子代理（Task/Agent 工具）当成一次普通工具调用
 * 计数——子代理内部再怎么跑，对主线程而言就是"一步指令没结束"，语义上一致，
 * 不需要特殊处理。
 */
export class ToolLifecycleTracker {
  private inFlight = new Set<string>();

  onToolUse(id: string) {
    this.inFlight.add(id);
  }

  onToolResult(id: string) {
    this.inFlight.delete(id);
  }

  isIdle(): boolean {
    return this.inFlight.size === 0;
  }

  /** 清空账本。必须在每轮结束（result）和中断/出错后调用：一轮被 interrupt
   *  腰斩时，在飞工具的 tool_result 永远不会到达，不清空的话账本永不归零，
   *  之后所有"插队"的安全边界判断恒为 false，插队静默失效。 */
  reset() {
    this.inFlight.clear();
  }
}
