import type { ContentBlock, ChatMessage } from "@/types/chat";

/** 摘要保留的头/尾字符数（超出则中段省略为占位文案）。 */
export const SUMMARY_HEAD = 200;
export const SUMMARY_TAIL = 200;

/** 估算一个 unknown 值的字节数（UTF-16 上界，length×2）。
 *  字符串走快速路径（避免 JSON.stringify 包裹引号的开销）；对象/数组才 stringify；
 *  input 是 unknown，防御 stringify 抛错（循环引用等）。 */
function safeJsonBytes(v: unknown): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === "string") return v.length * 2;
  try {
    return JSON.stringify(v).length * 2;
  } catch {
    return 0;
  }
}

/** 估算单个 block 的字节数（UTF-16 上界，length×2）。
 *  降级块无需特判——载荷已被替换（result→摘要、entries→[]、data→""），估算自然反映当前状态。 */
export function estimateBlockBytes(block: ContentBlock): number {
  switch (block.type) {
    case "text":
      return block.text.length * 2;
    case "thinking":
      return block.text.length * 2;
    case "tool_call":
      return safeJsonBytes(block.input) + (block.result ? block.result.length * 2 : 0);
    case "image":
      return block.data.length * 2;
    case "subagent": {
      let bytes = (block.prompt?.length ?? 0) * 2 + (block.result?.length ?? 0) * 2;
      for (const e of block.entries) {
        if (e.type === "text" || e.type === "thinking") {
          bytes += e.text.length * 2;
        } else {
          bytes += safeJsonBytes(e.input) + (e.result ? e.result.length * 2 : 0);
        }
      }
      return bytes;
    }
    case "action":
      return 0;
  }
}

/** 估算单条消息的字节数（窗口字节预算 / store 总量共用）。 */
export function estimateMessageBytes(msg: ChatMessage): number {
  let total = 0;
  for (const b of msg.blocks) total += estimateBlockBytes(b);
  return total;
}

/** 估算消息数组的总字节数（useChatScroll ramp 目标等数组场景）。 */
export function computeMessagesBytes(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageBytes(m);
  return total;
}

/** 估算整个 store 消息列表的字节数（全量重算，maybeEvict 节流调用）。 */
export function computeStoreBytes(store: { messages: ChatMessage[] }): number {
  return computeMessagesBytes(store.messages);
}

/** 首尾摘要：保留头尾各 SUMMARY_HEAD/TAIL 字，中间用省略标记衔接。
 *  短文本（≤ 头+尾）原样返回。文案风格对齐 fileMentions.ts 的「已截断」提示。 */
export function summarizeText(text: string): string {
  if (text.length <= SUMMARY_HEAD + SUMMARY_TAIL) return text;
  return `${text.slice(0, SUMMARY_HEAD)}\n\n…(内容已省略,原 ${text.length} 字)…\n\n${text.slice(-SUMMARY_TAIL)}`;
}

/** 降级占位文案：「内容已省略,原 N 字」（N = originalBytes/2 字符数）。 */
export function truncatedLabel(originalBytes: number): string {
  return `内容已省略,原 ${Math.round(originalBytes / 2)} 字`;
}