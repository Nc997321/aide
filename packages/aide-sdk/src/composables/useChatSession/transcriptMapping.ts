import type { ChatMessage, TextBlock, ThinkingBlock, ToolCallBlock } from "../../types/chat";
import type { ChatMessageItem, HistoryBlock } from "../../types";
import { splitMentionSections } from "../../utils/fileMentions";
import { annotateReadRelay } from "../../utils/lspRelay";

/**
 * transcript 映射（纯函数层）：Rust 侧重建的历史 block → 前端渲染用 ContentBlock。
 * 从 pagination.ts 抽出，供分页加载与页级回收（recycle 取回重放）共用——
 * 两侧必须走同一映射，否则取回的消息形状与首次加载不一致（渲染/回填分叉）。
 */

/** load_messages 返回的 ChatMessageItem[] → 前端 ChatMessage[]（历史 block 转换 +
 *  mention 段拆分 + Read 接力标注）。消息 id 每次重新生成（crypto.randomUUID）。 */
export function itemsToChatMessages(items: ChatMessageItem[]): ChatMessage[] {
  const messages = items.map((item) => ({
    id: crypto.randomUUID(),
    role: (item.role === "claude" ? "assistant" : item.role) as "user" | "assistant",
    blocks: item.blocks.flatMap((b) => historyBlockToContentBlocks(b, item.role === "user")),
    timestamp: item.timestamp,
  }));
  // F 方案（Read 接力显示）：历史消息就地标注 assistant Read 的接力结论，与实时
  // 路径（events.ts tool_use_start）共用同一判定核心。lspRelay 不落盘，每次加载
  // 重新推导——两条路径永不分叉。
  annotateReadRelay(messages);
  return messages;
}

/** Rust 侧重建的历史 block → 前端渲染用的 ContentBlock。tool_call 历史消息永远是
 *  "已完成"状态（isPending: false）——它来自一份早就落盘的 transcript，不会再有
 *  新的 tool_result 追上来。
 *
 *  user 文本块要额外拆引用段：transcript 落盘的用户消息是 sendText（原文 +
 *  @mention 展开的文件内容，见 fileMentions.ts），不拆的话整个文件原文会灌进
 *  用户气泡。拆回「原文 text 块 + N 个 Read 附件卡片」，与直发路径
 *  （dispatchSend 里 mentions.resolved 的渲染）保持同一形状。 */
function historyBlockToContentBlocks(
  block: HistoryBlock,
  isUser: boolean,
): (TextBlock | ThinkingBlock | ToolCallBlock)[] {
  if (block.type === "tool_call") {
    return [{
      type: "tool_call",
      id: block.id,
      name: block.name,
      input: block.input,
      result: block.result ?? undefined,
      isError: block.isError ?? undefined,
      isPending: false,
    }];
  }
  if (block.type === "thinking") {
    // 历史思考块：text 空（provider display=omitted）时 Rust 侧照常保留维持顺序，
    // 前端按非空才发——空的不进 blocks，避免空思考区。
    return block.text ? [{ type: "thinking", text: block.text }] : [];
  }
  if (!isUser) return [{ type: "text", text: block.text }];
  const { displayText, sections } = splitMentionSections(block.text);
  return [
    ...(displayText ? [{ type: "text" as const, text: displayText }] : []),
    ...sections.map((s): ToolCallBlock => ({
      type: "tool_call",
      id: crypto.randomUUID(),
      name: "Read",
      input: { file_path: s.path },
      result: s.content,
      isError: false,
      isPending: false,
    })),
  ];
}
