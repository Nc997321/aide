import type { ImageAttachment, UserMessageBlock } from "./types.js";

export interface JumpRequest {
  prompt: string;
  images?: ImageAttachment[];
  // 发起方附带的渲染描述，promote 时随 user_message 事件原样回灌。
  display?: UserMessageBlock[];
  // 刻意不带 permissionMode：插队只发生在进程存活（轮次进行中）时，此时权限模式
  // 一律走 set_permission_mode 实时通道。若在此快照，promote 时会拿入队时的旧值
  // 把用户刚切的新模式回退掉（2026-08-02 实锤：切编辑模式后旧 Edit 弹窗不消）。
}

/**
 * "插队"请求的持有者（多槽 FIFO）。忙碌时收到的插队消息不会像普通消息那样直接
 * `queue.push` 进 SDK 的输入流（那样只会排在当前轮之后，起不到"插队"效果）——
 * 而是先存在这里，等 `ToolLifecycleTracker` 显示当前没有工具在跑的安全边界到了，
 * 由 session-worker 主循环真正调用 interrupt()，再用 `takeAll()` 取出全部消息
 * 逐条接上后续轮次。
 *
 * 必须多槽：单槽覆盖会让忙碌时连发的第二条插队消息顶掉第一条（静默丢消息）。
 * 逐条 push 而不合并：/compact 这类斜杠命令作为独立用户消息才能被 CLI 正确执行。
 */
export class JumpQueueController {
  private pending: JumpRequest[] = [];

  request(req: JumpRequest) {
    this.pending.push(req);
  }

  has(): boolean {
    return this.pending.length > 0;
  }

  /** 取出并清空全部插队请求（按到达顺序）；无则返回空数组。 */
  takeAll(): JumpRequest[] {
    const reqs = this.pending;
    this.pending = [];
    return reqs;
  }

  /** 丢弃全部插队请求（用户主动打断：待插队消息一并作废）。 */
  clear() {
    this.pending = [];
  }
}
