import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { UserMessageBlock } from "../engine/types.js";

/** 一条忙碌时发出、已交给 CLI 排队、还没被模型接入的消息。 */
export interface QueuedSend {
  /** 客户端生成的 id，同时是 SDK 消息 uuid——CLI 回显（replay）与撤回都按它对账。 */
  id: string;
  /** 提示条 / 气泡显示的原始输入（不是 @引用展开后的 prompt）。 */
  text: string;
  /** 发起方附带的渲染描述，接入时随 user_message 原样回灌。 */
  display?: UserMessageBlock[];
  /** 交给 CLI 的原消息：query 被拆掉时据此重新投递，排队的消息不能跟着进程一起丢。 */
  message: SDKUserMessage;
}

/**
 * 排队消息账本（与 Claude Code CLI 同一种排队）。
 *
 * 会话忙时用户发的消息**不打断当前回合**：直接带 `priority:"next"` 写进 CLI 的输入流，
 * 由 CLI 在两轮工具调用之间把它并进正在跑的回合；回合已经在写收尾回复时就排到回合
 * 结束后作为下一轮。消息什么时候真正被接入只有 CLI 知道——CLI 接入时按 uuid 回显
 * （`--replay-user-messages`），worker 在那一刻按 id 从这里取出、广播气泡。
 *
 * 账本里的就是「还能撤回」的：`cancelAsyncMessage(id)` 撤成 → 从这里删；撤不成 =
 * CLI 已接入，回显随后就到。
 */
export class QueuedSendLedger {
  private items = new Map<string, QueuedSend>();

  add(item: QueuedSend): void {
    this.items.set(item.id, item);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  /** 取出并删除（接入 / 撤回 都走这里）；没有则 undefined。 */
  take(id: string): QueuedSend | undefined {
    const item = this.items.get(id);
    this.items.delete(id);
    return item;
  }

  /** 取出并清空全部（按到达顺序）。 */
  takeAll(): QueuedSend[] {
    const all = [...this.items.values()];
    this.items.clear();
    return all;
  }

  /** 当前全部 id（按到达顺序）。 */
  ids(): string[] {
    return [...this.items.keys()];
  }

  get size(): number {
    return this.items.size;
  }
}
