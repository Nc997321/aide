/**
 * 测试假 socket（WsLike 最小实现）：记录出站、按需注入入站事件。
 *
 * - close() 同步触发 onclose——detach() 先拆 handler 再 close，因此废弃后的
 *   close 天然静默，与真 ws-ohos 的异步 close 相比反而更能压出时序边界；
 * - emit* 全部同步派发，测试不需要等待真实网络事件循环。
 */
import type { WsCloseEvent, WsErrorEvent, WsLike, WsMessageEvent, WsOpenEvent } from '../../../main/ets/sdk/link/types';

export class FakeWs implements WsLike {
  readyState: number = 0; // 0 = CONNECTING（构造即有 attempt 观察）
  sent: string[] = [];
  onopen: ((ev: WsOpenEvent) => void) | null = null;
  onmessage: ((ev: WsMessageEvent) => void) | null = null;
  onclose: ((ev: WsCloseEvent) => void) | null = null;
  onerror: ((ev: WsErrorEvent) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3; // CLOSED
    if (this.onclose !== null) {
      this.onclose({ code: 1000, reason: '' });
    }
  }

  emitOpen(): void {
    this.readyState = 1; // OPEN
    if (this.onopen !== null) {
      this.onopen({});
    }
  }

  emitText(data: string): void {
    if (this.onmessage !== null) {
      this.onmessage({ data: data });
    }
  }

  emitClose(code: number): void {
    this.readyState = 3;
    if (this.onclose !== null) {
      this.onclose({ code: code, reason: '' });
    }
  }

  /** 出站流里是否出现过某子串（帧字段序是三端契约，检查用完整片段）。 */
  hasSent(sub: string): boolean {
    for (const s of this.sent) {
      if (s.includes(sub)) {
        return true;
      }
    }
    return false;
  }
}
