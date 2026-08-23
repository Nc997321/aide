import type { ChatEvent, ChatMessageItem, HistoryBlock } from "./types";

// 消息块——渲染层用的判别式联合（历史转换与流式事件共用）。
export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      input: unknown;
      result?: string;
      isError?: boolean;
      isPending?: boolean;
    }
  | { type: "subagent"; id: string; agentName: string; description: string; text: string }
  | { type: "image"; data: string; mediaType: string }
  | { type: "error"; text: string };

export interface Message {
  id: string;
  role: "user" | "assistant";
  blocks: Block[];
  timestamp: number;
  /** message_stop 后为 true（流式进行中为 false，UI 据此显示光标）。 */
  done: boolean;
  usage?: unknown;
  effort?: string;
}

/** 新会话 id：remote- 前缀（与桌面 bridge 无 session_id 时的生成约定一致）。 */
export function newSessionId(): string {
  return `remote-${crypto.randomUUID()}`;
}

/**
 * 事件 → 消息列表（纯函数，镜像桌面 useChatSession.ts 的处理逻辑）。
 * 只处理聊天渲染相关事件；未知事件忽略（协议可扩展）。
 */
export function applyEvent(messages: Message[], e: ChatEvent): Message[] {
  switch (e.type) {
    case "text_delta": {
      const msg = getOrCreateAssistant(messages);
      const last = msg.blocks[msg.blocks.length - 1];
      if (last?.type === "text") {
        last.text += e.delta;
      } else {
        msg.blocks.push({ type: "text", text: e.delta });
      }
      return messages;
    }
    case "thinking":
    case "thinking_delta": {
      // partial=on 走 thinking_delta 逐字增量（delta 字段），partial=off / 历史回放
      // 走 thinking 整块（text 字段）。按 type 判别取 text/delta 兼容两路。
      const chunk = e.type === "thinking" ? e.text : e.delta;
      const msg = getOrCreateAssistant(messages);
      const last = msg.blocks[msg.blocks.length - 1];
      if (last?.type === "thinking") {
        last.text += chunk;
      } else {
        msg.blocks.push({ type: "thinking", text: chunk });
      }
      return messages;
    }
    case "tool_use_start": {
      const msg = getOrCreateAssistant(messages);
      msg.blocks.push({
        type: "tool_call",
        id: e.id,
        name: e.name,
        input: e.input,
        isPending: true,
      });
      return messages;
    }
    case "tool_result": {
      const block = messages
        .flatMap((m) => m.blocks)
        .find((b): b is Extract<Block, { type: "tool_call" }> => b.type === "tool_call" && b.id === e.id);
      if (block) {
        block.result = e.content;
        block.isError = e.is_error;
        block.isPending = false;
      }
      return messages;
    }
    case "message_stop": {
      const last = messages[messages.length - 1];
      if (last?.role === "assistant") {
        last.done = true;
        if (e.usage) last.usage = e.usage;
        if (e.effort) last.effort = e.effort;
      }
      return messages;
    }
    case "subagent": {
      const msg = getOrCreateAssistant(messages);
      msg.blocks.push({
        type: "subagent",
        id: e.id,
        agentName: e.agentName,
        description: e.description,
        text: "",
      });
      return messages;
    }
    case "subagent_text_delta":
    case "subagent_thinking_delta": {
      const block = messages
        .flatMap((m) => m.blocks)
        .find((b): b is Extract<Block, { type: "subagent" }> => b.type === "subagent" && b.id === e.id);
      if (block) block.text += e.delta;
      return messages;
    }
    case "error": {
      const msg = getOrCreateAssistant(messages);
      msg.blocks.push({ type: "error", text: `Error: ${e.message}` });
      return messages;
    }
    case "image": {
      const msg = getOrCreateAssistant(messages);
      msg.blocks.push({ type: "image", data: e.data, mediaType: e.mediaType });
      return messages;
    }
    default:
      return messages;
  }
}

/** 历史消息（load_messages 结果）→ 渲染消息列表。 */
export function historyToMessages(items: ChatMessageItem[]): Message[] {
  return items.map((item) => ({
    id: crypto.randomUUID(),
    role: item.role === "user" ? "user" : "assistant",
    blocks: item.blocks.map(historyBlockToBlock),
    timestamp: item.timestamp,
    done: true,
  }));
}

function historyBlockToBlock(b: HistoryBlock): Block {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "thinking":
      return { type: "thinking", text: b.text };
    case "tool_call":
      return {
        type: "tool_call",
        id: b.id,
        name: b.name,
        input: b.input,
        ...(b.result != null ? { result: b.result } : {}),
        ...(b.isError != null ? { isError: b.isError } : {}),
        isPending: false,
      };
  }
}

function getOrCreateAssistant(messages: Message[]): Message {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") return last;
  const msg: Message = {
    id: crypto.randomUUID(),
    role: "assistant",
    blocks: [],
    timestamp: Date.now(),
    done: false,
  };
  messages.push(msg);
  return msg;
}
