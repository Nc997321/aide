import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export class MessageQueue {
  private queue: SDKUserMessage[] = [];
  private resolveNext: (() => void) | null = null;
  private closed = false;

  push(msg: SDKUserMessage) {
    this.queue.push(msg);
    this.resolveNext?.();
    this.resolveNext = null;
  }

  /** 待发送用户消息数（测试/UI 查询用，避免外部摸私有字段）。 */
  get size(): number {
    return this.queue.length;
  }

  close() {
    this.closed = true;
    this.resolveNext?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      if (this.queue.length > 0) {
        // 上面 length > 0 保证 shift() 非空——契约注释，勿删 !。
        yield this.queue.shift()!;
      } else if (this.closed) {
        return;
      } else {
        await new Promise<void>((resolve) => { this.resolveNext = resolve; });
      }
    }
  }
}
