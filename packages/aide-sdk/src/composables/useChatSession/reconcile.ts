import type { ChatMessage, ContentBlock, ToolCallBlock } from "../../types/chat";

const sourceIndexes = new WeakMap<ChatMessage, { blocks: ContentBlock[]; count: number; index: Map<string, ContentBlock> }>();
function sourceIndex(message: ChatMessage): Map<string, ContentBlock> {
  let cache = sourceIndexes.get(message);
  if (!cache || cache.blocks !== message.blocks || cache.count > message.blocks.length) {
    cache = { blocks: message.blocks, count: 0, index: new Map() };
    sourceIndexes.set(message, cache);
  }
  for (; cache.count < message.blocks.length; cache.count++) {
    const block = message.blocks[cache.count];
    if (block.sourceId) cache.index.set(block.sourceId, block);
    if (block.type === "tool_call") cache.index.set(`tool:${block.id}`, block);
  }
  return cache.index;
}

export function historicalToolCall(messages: ChatMessage[], id: string): ToolCallBlock | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const block = sourceIndex(messages[i]).get(`tool:${id}`);
    if (block?.type === "tool_call") return block;
  }
}

/** Stream tail lookup is O(1) in the usual case, even in a turn with thousands of blocks. */
export function sourceMessage(messages: ChatMessage[], event: Record<string, unknown>): ChatMessage | undefined {
  if (typeof event.sourceId !== "string") return;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && sourceIndex(messages[i]).has(event.sourceId)) return messages[i];
  }
}

/** Identity comes from the producer, never from text or render-time random ids. */
function key(block: ContentBlock): string | undefined {
  return block.type === "tool_call" ? `tool:${block.id}` : block.sourceId;
}

/** Absolute offsets make a snapshot and any delayed/replayed delta idempotent.
 * Late subscribers may initially have only a suffix; the completed SDK block
 * (offset 0) fills the prefix without requiring a second rendering path. */
export function applySourceText(block: ContentBlock, text: string, start: number): void {
  if (block.type !== "text" && block.type !== "thinking") return;
  const oldStart = block.sourceStart ?? 0;
  const oldEnd = oldStart + block.text.length;
  const end = start + text.length;
  if (start <= oldStart && end >= oldStart) {
    block.text = text + (oldEnd > end ? block.text.slice(end - oldStart) : "");
    block.sourceStart = start;
  } else if (start <= oldEnd && end > oldEnd) {
    block.text += text.slice(oldEnd - start);
  }
}

export function appendSourceText(message: ChatMessage, type: "text" | "thinking", text: string, event: Record<string, unknown>): void {
  const sourceId = typeof event.sourceId === "string" ? event.sourceId : undefined;
  if (sourceId) {
    const block = sourceIndex(message).get(sourceId);
    const start = typeof event.sourceOffset === "number" ? event.sourceOffset : 0;
    if (!block) {
      message.blocks.push({ type, text, sourceId, sourceStart: start });
    } else applySourceText(block, text, start);
    return;
  }
  // Old producers have no source coordinates; keep their original append semantics.
  const last = message.blocks[message.blocks.length - 1];
  if (last?.type === type) last.text += text;
  else message.blocks.push({ type, text });
}

function mergeBlocks(history: ContentBlock[], live: ContentBlock[]): ContentBlock[] {
  const liveByKey = new Map(live.flatMap(b => key(b) ? [[key(b)!, b] as const] : []));
  const result: ContentBlock[] = [];
  let cursor = 0;
  for (const old of history) {
    const current = key(old) ? liveByKey.get(key(old)!) : undefined;
    if (!current) { result.push(old); continue; }
    const index = live.indexOf(current);
    // Preserve live-only blocks (e.g. subagents) in their original order.
    while (cursor < index) result.push(live[cursor++]);
    if ((old.type === "text" || old.type === "thinking") && current.type === old.type) {
      applySourceText(current, old.text, old.sourceStart ?? 0);
    } else if (old.type === "tool_call" && current.type === "tool_call" && current.isPending && old.result !== undefined) {
      current.result = old.result;
      current.isError = old.isError;
      current.isPending = false;
    }
    result.push(current); // keep the object registered for future tool_result updates
    cursor = Math.max(cursor, index + 1);
  }
  result.push(...live.slice(cursor));
  return result;
}

/** Snapshot prefix belongs to disk; from the first overlapping live turn onward
 * the mutable objects belong to the event stream. Return the disk-only count so
 * pagination never releases an assistant that is still receiving events. */
export function reconcileHistory(history: ChatMessage[], live: ChatMessage[]): { messages: ChatMessage[]; prefixCount: number } {
  if (!live.length) return { messages: history, prefixCount: history.length };
  const same = (old: ChatMessage, current: ChatMessage) => {
    if (old.role !== current.role) return false;
    if (old.id === current.id) return true;
    if (current.role === "user") return false;
    const keys = new Set(current.blocks.map(key).filter(Boolean));
    return old.blocks.some(b => keys.has(key(b)));
  };
  const result: ChatMessage[] = [];
  let prefixCount: number | undefined;
  let cursor = 0;
  let matchedUser = false;
  for (let liveIndex = 0; liveIndex < live.length; liveIndex++) {
    const message = live[liveIndex];
    let index = history.findIndex((m, i) => i >= cursor && same(m, message));
    if (message.role === "assistant") {
      if (index < 0) {
        // No shared blocks yet: after the same user, or a late subscription to
        // the latest assistant, both views still describe the same turn.
        if (matchedUser && history[cursor]?.role === "assistant") index = cursor;
        else if (liveIndex === 0 && history[history.length - 1]?.role === "assistant") index = history.length - 1;
      }
    }
    if (index >= 0) {
      result.push(...history.slice(cursor, index));
      cursor = index + 1;
      if (message.role === "assistant") message.blocks = mergeBlocks(history[index].blocks, message.blocks);
    } else {
      // A byte-limited snapshot may start halfway through a live turn, omitting
      // its user message. Align by the next source identity before inserting the
      // live prefix, rather than moving that user behind its own assistant.
      let nextAnchor = -1;
      for (const next of live.slice(liveIndex + 1)) {
        nextAnchor = history.findIndex((m, i) => i >= cursor && same(m, next));
        if (nextAnchor >= 0) break;
      }
      const end = nextAnchor < 0 ? history.length : nextAnchor;
      result.push(...history.slice(cursor, end));
      cursor = end;
    }
    prefixCount ??= result.length;
    result.push(message);
    matchedUser = message.role === "user" && index >= 0;
  }
  result.push(...history.slice(cursor));
  return { messages: result, prefixCount: prefixCount ?? result.length };
}
