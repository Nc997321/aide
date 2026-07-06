import type { ImageAttachment } from "./types.js";

export interface JumpRequest {
  prompt: string;
  images?: ImageAttachment[];
  permissionMode?: string;
}

/**
 * "插队"请求的持有者。忙碌时收到的插队消息不会像普通消息那样直接 `queue.push`
 * 进 SDK 的输入流（那样只会排在当前轮之后，等同于普通排队，起不到"插队"效果）——
 * 而是先存在这里，等 `ToolLifecycleTracker` 显示当前没有工具在跑的安全边界到了，
 * 由 index.ts 主循环真正调用 interrupt()，再用 `take()` 取出这条消息接上"下一轮"。
 */
export class JumpQueueController {
  private pending: JumpRequest | null = null;

  request(req: JumpRequest) {
    this.pending = req;
  }

  has(): boolean {
    return this.pending !== null;
  }

  /** 取出并清空当前记录的插队请求（无则返回 null）。 */
  take(): JumpRequest | null {
    const req = this.pending;
    this.pending = null;
    return req;
  }
}
