import { invoke } from "@tauri-apps/api/core";
import { trail } from "@/utils/diagnostics/scrollTrail";
import type { ChatMessage, TextBlock, ThinkingBlock, ToolCallBlock } from "@/types/chat";
import type { ChatMessageItem, HistoryBlock, LoadMessagesResult } from "@/types";
import { splitMentionSections } from "@/utils/fileMentions";
import { maybeEvict } from "./evict";
import { disposedSids, getStore, isPendingSession, sessionPagination, stores } from "./state";

/**
 * P1 双向分页（最简单形态，2026-08-26 定稿）：
 * - hydrate：只取尾部一页（打开不全量）；
 * - 上滚到顶部触发带 → loadOlderPage 取更早一页 unshift 头部 + 游标前进；
 * - 不回收、无页记录、无恢复——内存由 evict（大 block 降级，64MB 阈值）兜底，
 *   DOM 由逐页加载自然控制（翻多少渲染多少）。
 * 游标 = tailOffset（一个数字）——内容必然前进不重复。
 */

/** hydrate / 上滚取回的页字节预算（UTF-8 行字节累计，后端 load_messages limit 语义；
 *  大 tool_result 占预算多则页内条数自适应收缩）。 */
const HYDRATE_PAGE_BYTES = 256 * 1024;

/** load_messages 返回的 ChatMessageItem[] → 前端 ChatMessage[]（历史 block 转换 +
 *  mention 段拆分）。消息 id 每次重新生成（crypto.randomUUID）。 */
export function itemsToChatMessages(items: ChatMessageItem[]): ChatMessage[] {
  return items.map((item) => ({
    id: crypto.randomUUID(),
    role: (item.role === "claude" ? "assistant" : item.role) as "user" | "assistant",
    blocks: item.blocks.flatMap((b) => historyBlockToContentBlocks(b, item.role === "user")),
    timestamp: item.timestamp,
  }));
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

/** 首屏加载：只取尾部一页（页 = 字节预算），建立 per-sid 游标。已有数据
 *  （活动会话/重开）走「游标缺失探测」分支：store 有数据但 sessionPagination 无
 *  记录时补一次最小页探测拿 tailOffset，恢复上滚取回。 */
export async function hydrate(sid: string): Promise<void> {
  // 重开 = 复活：清除销毁标记，后续事件正常入 store（getStore 重建为重开做准备）
  disposedSids.delete(sid);
  const store = getStore(sid);
  if (store.hydrated || store.messages.length > 0 || isPendingSession(sid)) {
    store.hydrated = true;
    if (store.messages.length > 0 && !sessionPagination.has(sid)) {
      try {
        const result = await invoke<LoadMessagesResult>("load_messages", {
          sessionId: sid,
          offsetBytes: null,
          limit: 1, // 最小页：只探游标（最新 1 条保底），消息丢弃不 unshift
        });
        if (result && Array.isArray(result.messages)) {
          sessionPagination.set(sid, { tailOffset: result.nextOffsetBytes });
          trail("pager", `probe ${sid.slice(0, 8)} tail=${result.nextOffsetBytes}`);
        } else {
          trail("pager", `probe ${sid.slice(0, 8)} EMPTY-RESULT`);
        }
      } catch (e) {
        console.warn("Failed to probe pagination cursor:", e);
        trail("pager", `probe ${sid.slice(0, 8)} FAILED ${String(e).slice(0, 80)}`);
      }
    } else {
      trail("pager", `skip ${sid.slice(0, 8)} n=${store.messages.length} pag=${sessionPagination.has(sid)}`);
    }
    return;
  }
  store.hydrated = true;
  try {
    const result = await invoke<LoadMessagesResult>("load_messages", {
      sessionId: sid,
      offsetBytes: null,
      limit: HYDRATE_PAGE_BYTES,
    });
    if (!result || !Array.isArray(result.messages)) {
      trail("pager", `hydrate ${sid.slice(0, 8)} EMPTY-RESULT`);
      return;
    }
    // hydrate 期间可能已有实时消息进来：历史插到最前
    store.messages.unshift(...itemsToChatMessages(result.messages));
    // 尾部页游标：nextOffsetBytes 0 = 无更早页，上滚「到此为止」
    sessionPagination.set(sid, { tailOffset: result.nextOffsetBytes });
    trail("pager", `hydrate ${sid.slice(0, 8)} n=${result.messages.length} tail=${result.nextOffsetBytes}`);
    maybeEvict(store);
  } catch (e) {
    console.warn("Failed to load messages:", e);
  }
}

/** 取更早一页（limit = 字节预算），unshift 到消息头部。返回实际取回条数
 *  （0 = 无更早页/失败）。游标前进 → 内容必然前进不重复。 */
export async function loadOlderPage(sid: string, limit: number): Promise<number> {
  const page = sessionPagination.get(sid);
  const store = stores[sid];
  if (!page || !store || page.tailOffset === 0) return 0;
  try {
    const result = await invoke<LoadMessagesResult>("load_messages", {
      sessionId: sid,
      offsetBytes: page.tailOffset,
      limit,
    });
    if (!result || !Array.isArray(result.messages)) {
      trail("pager", `load ${sid.slice(0, 8)} EMPTY-RESULT`);
      return 0;
    }
    store.messages.unshift(...itemsToChatMessages(result.messages));
    page.tailOffset = result.nextOffsetBytes;
    maybeEvict(store);
    return result.messages.length;
  } catch (e) {
    console.warn("Failed to load older messages:", e);
    return 0;
  }
}

/** revertRound 截断 .jsonl 后调用：旧字节游标已失效，清空（hasMore 归 false，
 *  下次切换会话 hydrate 重新建立）。后端另有 clamp 兜底（双保险）。 */
export function resetPaginationForRevert(sid: string): void {
  sessionPagination.delete(sid);
}

/** 磁盘上还有更早页可取（tailOffset > 0）——顶部入口与上滚取回的开关。 */
export function hasMoreOlder(sid: string): boolean {
  return (sessionPagination.get(sid)?.tailOffset ?? 0) > 0;
}
