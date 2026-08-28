import type { ChatMessage, ContentBlock } from "@/types/chat";
import { estimateBlockBytes, computeStoreBytes, summarizeText } from "@/utils/messageBytes";
import type { SessionStore } from "./state";
import { releaseFarthestPages } from "./recycle";

/**
 * P0-3 store 内存兜底（估算字节超阈值降级大 block 为摘要）。
 * 终稿职责定位：滚动层（useChatScroll）只做「取回/锚定/置底」不管内存；
 *  store 层这里管内存——两阶段：
 *  ① 超阈值时从最早消息起降级大 block（保留消息结构）；
 *  ② 降完仍超（小 block 洞：全部块都 ≤16KB 时①落空）→ 调 recycle 释放热区外
 *     已加载页（页 = jsonl 字节区间，重取可完整恢复，含 tool_call.input）。
 */

/** store 估算字节阈值（UTF-16,length×2）：超出时从最早消息起降级大 block。
 *  2026-08-28 由 64MB 下调 32MB——页级回收（recycle）落地后单会话驻留有了
 *  硬天花板，evict 回归「页内大块」本职，阈值不必再给翻页驻留兜底。 */
const STORE_BYTES_THRESHOLD = 32 * 1024 * 1024;
/** 单 block 降级阈值：只降级超过此值的大 block（小 block 保留原文）。 */
const BLOCK_BYTES_THRESHOLD = 16 * 1024;
/** maybeEvict 节流间隔：全量重算 + 降级循环每会话至多一次/该间隔，流式热路径零 jank。 */
const EVICT_THROTTLE_MS = 500;
/** 节流表：WeakMap 按 store 对象——finalizeSession 换 key 不换对象节流自动保留，
 *  disposeSession 删 store 后条目随 GC 消失，__resetForTest 无需清理。 */
const lastEvictAt = new WeakMap<SessionStore, number>();
/** 可注入阈值（仅测试用 __setEvictThresholdsForTest 改 KB 级快测，__resetForTest 恢复默认）。 */
let evictThresholds = { storeBytes: STORE_BYTES_THRESHOLD, blockBytes: BLOCK_BYTES_THRESHOLD };

export function __setEvictThresholdsForTest(storeBytes: number, blockBytes: number): void {
  evictThresholds = { storeBytes, blockBytes };
}

/** 消息是否含未回填的 pending 块（tool_call/subagent）——淘汰跳过，避免回填找不到块。
 *  union 上直接 b.isPending 编译报错（TextBlock 等无该字段），用 in 窄化。 */
function hasPendingBlock(msg: ChatMessage): boolean {
  return msg.blocks.some((b) => "isPending" in b && b.isPending);
}

/** 降级一个 block 的大载荷为摘要占位，返回省下的估算字节（0 = 未降级/已降级）。
 *  策略：只降级超过块级阈值的大 block；tool_call 只降 result（input 永不降级，变更卡
 *  diff 重放依赖 input）；幂等（已 truncated 恒返回 0）。 */
function degradeBlock(block: ContentBlock): number {
  // 已降级块幂等返回 0（"truncated" in 窄化：ActionBlock 无该字段，走 in 判定）
  if ("truncated" in block && block.truncated) return 0;
  const before = estimateBlockBytes(block);
  const min = evictThresholds.blockBytes;
  switch (block.type) {
    case "text":
      if (before <= min) return 0;
      block.truncated = { kind: "text", originalBytes: before };
      block.text = summarizeText(block.text);
      break;
    case "thinking":
      if (before <= min) return 0;
      block.truncated = { kind: "thinking", originalBytes: before };
      block.text = summarizeText(block.text);
      break;
    case "tool_call": {
      // 只降级 result；input 永不降级（变更卡从 input+磁盘构建 diff，降级后仍可展开）
      if (typeof block.result !== "string" || block.result.length * 2 <= min) return 0;
      block.truncated = { kind: "tool_result", originalBytes: block.result.length * 2 };
      block.result = summarizeText(block.result);
      break;
    }
    case "image":
      if (before <= min) return 0;
      block.truncated = { kind: "image_data", originalBytes: before };
      block.data = "";
      break;
    case "subagent": {
      if (before <= min) return 0;
      block.truncated = { kind: "subagent_entries", originalBytes: before };
      block.entries = [];
      if (typeof block.result === "string") block.result = summarizeText(block.result);
      break;
    }
    case "action":
      return 0;
  }
  return before - estimateBlockBytes(block);
}

/** 节流 + 全量重算的淘汰入口：超 store 阈值时①从最早消息起降级大 block；
 *  ②仍超（全小 block 落空）则释放热区外已加载页（字节区间可重取，真删数据）。
 *  for..of 结构（无 while，死循环防护结构性）：全小 block 仍超阈值时①循环
 *  自然落空，交给②。跳过 streaming 消息与含 pending 块的消息（流式尾块/回填
 *  中的块永不被替换）。
 *  节流配额只在「实际降级/释放」时才占——未超阈值的早退不占配额，避免同 tick
 *  内先到的小事件（如 tool_use_start）把后到的大事件（tool_result）误节流。 */
export function maybeEvict(sid: string, store: SessionStore): void {
  const now = Date.now();
  if (now - (lastEvictAt.get(store) ?? 0) < EVICT_THROTTLE_MS) return;
  let bytes = computeStoreBytes(store);
  if (bytes <= evictThresholds.storeBytes) return; // 未超阈值：不降级，也不占节流配额
  // 阶段①：块级降级；只有实际降级了 block 才占节流配额——全 streaming/pending 跳过
  // 时不占（下次事件重试），避免「流式期 tool_result 超阈值但 streaming 跳过」把
  // 紧随的 message_stop（streaming 结束、本可降级）误节流。
  let degraded = false;
  for (const msg of store.messages) {
    if (bytes <= evictThresholds.storeBytes) break;
    if (msg.streaming || hasPendingBlock(msg)) continue;
    for (const block of msg.blocks) {
      if (bytes <= evictThresholds.storeBytes) break;
      const saved = degradeBlock(block);
      if (saved > 0) degraded = true;
      bytes -= saved;
    }
  }
  // 阶段②：小 block 洞兜底——①降完仍超阈值，说明占用大头是不可降级的小块/对象
  // 结构，按页释放（热区由滚动层 setViewportHot 上报，无上报时保最新 2 页）
  if (bytes > evictThresholds.storeBytes) {
    const released = releaseFarthestPages(sid, {
      budget: evictThresholds.storeBytes * 0.8,
      preserveNewest: 2,
    });
    if (released > 0) degraded = true;
  }
  if (degraded) lastEvictAt.set(store, now);
}
