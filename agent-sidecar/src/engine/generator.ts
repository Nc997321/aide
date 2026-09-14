import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export class MessageQueue {
  private queue: SDKUserMessage[] = [];
  private resolveNext: (() => void) | null = null;
  private closed = false;
  /** 迭代器代际：retireIterators() 自增即作废此前建立的全部迭代器。 */
  private epoch = 0;

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

  /**
   * 作废此刻已存在的全部迭代器：它们被唤醒后直接退场，不再从队列取消息。
   *
   * 一轮 query 异常终止（错误终态 / SDK 抛错）时，它的输入迭代器没人收尾——真
   * SDK 的输入泵保着一个 pending next()，而 abort/close 都不会替它 return()，
   * 于是它挂在 resolveNext 上成了孤儿。换轮方 startLoop 还要 await 装配
   * （新迭代器尚未建立），此时 pushUserMessage 已把消息落进共享队列 → 唤醒的
   * 是孤儿 → 消息被它 shift 走，新 query 的输入流永远空着：CLI 干等 stdin、
   * 一条事件都不发，UI 定格「正在思考」（2026-09-14 余额不足 402 事故）。
   * 所以换轮方必须在本轮迭代器建立之前同步调用本方法（见 session-worker
   * startLoop 轮首与 catch 的 promote 前）。
   */
  retireIterators(): void {
    this.epoch += 1;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    const myEpoch = this.epoch;
    while (true) {
      // 已被换轮作废 → 退场；队列里的消息留给本轮的迭代器，不替它消费。
      if (myEpoch !== this.epoch) return;
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
