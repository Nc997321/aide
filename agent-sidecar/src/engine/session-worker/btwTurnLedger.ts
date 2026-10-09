// btw 侧问的「快照之后」补遗账本。
//
// 官方 side_question 通道的上下文是 CLI 在**上一次主线程回合收尾时**存下的
// cacheSafeParams 快照（CLI 0.3.252 的 sF()/$ln，只在回合收尾阶段写入），回合
// 进行中不刷新——主 agent 正在干活时问 btw，它看不到本轮的用户消息、工具调用和
// 结果，表现为「btw 一直停在之前」（smoke-btw-staleness.ts 实测，2026-10-09）。
// 通道只收 question/history，塞不进消息；所以本模块记下快照之后主线程发生的事，
// 提问时作为背景拼在问题前面（问题在请求末尾，不破坏前缀缓存）。
//
// 清账时机 = 回合**成功**收尾（快照在这一刻刷新）。打断/出错的回合 CLI 可能没刷新
// 快照，账留着，下一个成功回合再一并清。
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** 补遗总长上限（字符）：超出从最早的条目丢起，保留最新进展。 */
export const BTW_LEDGER_MAX_CHARS = 6000;
/** 单条工具输入 / 结果的截断长度。 */
const ITEM_MAX_CHARS = 400;

function clip(s: string, max = ITEM_MAX_CHARS): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

export class BtwTurnLedger {
  private entries: string[] = [];

  /** 用户消息进入主线程（含插队消息被接入时）。 */
  recordUser(text: string): void {
    const t = text.trim();
    if (t) this.entries.push(`User: ${clip(t, 1500)}`);
  }

  /** 主线程的 SDK 消息：assistant 文本 / 工具调用、工具结果；回合成功收尾时清账。
   *  子代理内部消息（parent_tool_use_id 非空）不记——主线程只看得到子代理的最终结果。 */
  recordSdkMessage(msg: SDKMessage): void {
    if (msg.type === "result") {
      if (msg.subtype === "success" && !msg.is_error) this.entries = [];
      return;
    }
    if (msg.type === "assistant" && !msg.parent_tool_use_id) {
      const blocks = msg.message?.content;
      if (!Array.isArray(blocks)) return;
      for (const b of blocks) {
        if (b.type === "text" && b.text.trim()) {
          this.entries.push(`Assistant: ${clip(b.text, 1000)}`);
        } else if (b.type === "tool_use") {
          this.entries.push(`Assistant called tool ${b.name}(${clip(JSON.stringify(b.input ?? {}))})`);
        }
      }
      return;
    }
    if (msg.type === "user" && !msg.parent_tool_use_id) {
      const content = msg.message?.content;
      if (!Array.isArray(content)) return;
      for (const b of content) {
        if (b && typeof b === "object" && b.type === "tool_result") {
          const body = clip(textOf(b.content)) || "(no text output)";
          this.entries.push(`Tool result${b.is_error ? " (error)" : ""}: ${body}`);
        }
      }
    }
  }

  /** 拼给侧问通道的问题：没有补遗时原样返回。 */
  augment(question: string): string {
    if (this.entries.length === 0) return question;
    const kept: string[] = [];
    let total = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (total + e.length > BTW_LEDGER_MAX_CHARS && kept.length > 0) break;
      kept.unshift(e);
      total += e.length;
    }
    const dropped = this.entries.length - kept.length;
    return [
      "[Background: the main conversation has progressed past the snapshot you were given. " +
        "In chronological order, this happened since then (the main agent's turn may still be in progress):]",
      ...(dropped > 0 ? [`(${dropped} earlier entries omitted)`] : []),
      ...kept,
      "[End of background. The user's side question follows.]",
      "",
      question,
    ].join("\n");
  }

  get size(): number {
    return this.entries.length;
  }
}
