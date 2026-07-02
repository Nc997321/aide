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

  close() {
    this.closed = true;
    this.resolveNext?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.closed) {
        return;
      } else {
        await new Promise<void>((resolve) => { this.resolveNext = resolve; });
      }
    }
  }
}
