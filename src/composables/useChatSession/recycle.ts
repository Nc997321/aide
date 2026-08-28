import { invoke } from "@tauri-apps/api/core";
import { trail } from "@/utils/diagnostics/scrollTrail";
import type { ChatMessage } from "@/types/chat";
import type { LoadMessagesResult } from "@/types";
import { itemsToChatMessages } from "./transcriptMapping";
import { pageLedgers, stores, type PageEntry } from "./state";

/**
 * P1 回收半边（2026-08-28 重引入，设计稿 2026-08-25 §10 ⑦/⑨/⑩）：单会话内存硬天花板。
 *
 * 为什么需要：P1 双向分页落地时砍成了「只加载不回收」——上滚到底 = jsonl 全量驻留
 * + 全量 DOM；evict 只降级 >16KB 大 block（小 block 多的会话等于无上限），64MB
 * 估算阈值 × 对象/reactive 账外倍率，单会话真实堆可顶到数百 MB（freeze-1787901573714
 * 实测 1.08GB → GC 死亡螺旋）。
 *
 * 模型：store.messages = Σ(loaded 页消息按页序) + live 段（页边界由磁盘 offset 决定，
 * 流式新消息永不入页）。释放 = splice 出页消息 + 骨架占位（实测高度撑住，总高不变、
 * 滚动零跳变）；取回 = load_messages(offset=endOffset, limit=bytes) 确定性重放同一
 * 字节区间（jsonl 追加写不影响旧 offset）后 splice 回原位——原位只累加「前面 loaded
 * 页的 count」，与中间隔着几个骨架无关。
 *
 * 分层：本模块只管数据（台账/messages/invoke），DOM 测量与滚动补偿在 useChatScroll——
 * heightPx 由调用方实测注入，无 DOM（后台会话/ramp 中）退化为估算。
 */

/** 渲染行模型：ChatPanel 的 v-for 单元。page=已加载页（消息组）；skeleton=已释放页
 *  占位（内联 heightPx 撑高度）；live=页边界之后的流式段（逐条）。 */
export type Row =
  | { kind: "page"; id: string; pageIndex: number; messages: ChatMessage[] }
  | { kind: "skeleton"; id: string; pageIndex: number; count: number; heightPx: number }
  | { kind: "live"; id: string; message: ChatMessage };

/** 无 DOM 可测时的单条消息估算高度（聊天气泡含 padding/代码块，取偏保守值——
 *  误差在下次实测时自校正，只影响从未上过屏的后台会话骨架）。 */
const ESTIMATE_MESSAGE_HEIGHT_PX = 120;
/** 已加载页总字节预算（jsonl UTF-8 字节，≈内存代理）：超出才释放热区外页。 */
export const RECYCLE_BYTES_BUDGET = 16 * 1024 * 1024;
/** 热区半径：视口所在页 ±K 页不释放。 */
const HOT_ZONE_RADIUS = 1;

/** 视口热区上报（滚动层持续写入；evict 二阶段无 DOM 上下文时据此避让）。 */
const viewportHot = new Map<string, number>();
export function setViewportHot(sid: string, pageIndex: number): void {
  viewportHot.set(sid, pageIndex);
}

/** 页级 mutate 互斥（restore 有 await 间隙；release 同步无间隙不用占）：
 *  restore 进行中拒绝第二个 restore/release-after-await 交错改 messages。 */
const mutating = new Set<string>();
export function isRecycleMutating(sid: string): boolean {
  return mutating.has(sid);
}

/** 页在 store.messages 中的起始下标 = 前面 loaded 页 count 之和（live 段在所有页之后）。 */
export function insertionIndex(ledger: readonly PageEntry[], pageIndex: number): number {
  let idx = 0;
  for (let i = 0; i < pageIndex; i++) {
    if (ledger[i].loaded) idx += ledger[i].count;
  }
  return idx;
}

/** 已加载页的总字节（预算判定用）。 */
export function loadedPagesBytes(sid: string): number {
  const ledger = pageLedgers.get(sid);
  if (!ledger) return 0;
  let sum = 0;
  for (const p of ledger) if (p.loaded) sum += p.bytes;
  return sum;
}

/** live 段消息数（= messages 总数 - 已加载页驻留数）。useChatScroll 的
 *  onNewContent 必须 watch 它而不是 messages.length——释放(变少)/取回(变多)
 *  都会动 messages.length，watch 它会把「骨架取回」误报成「新消息」亮圆点。 */
export function liveMessageCount(sid: string, messagesLength: number): number {
  const ledger = pageLedgers.get(sid);
  if (!ledger || ledger.length === 0) return messagesLength;
  let loaded = 0;
  for (const p of ledger) if (p.loaded) loaded += p.count;
  return messagesLength - loaded;
}

/** 估算页高：优先用其他页的实测均值（count 加权），无实测样本时用默认单条高。 */
function estimatePageHeight(ledger: readonly PageEntry[], page: PageEntry): number {
  let totalH = 0;
  let totalN = 0;
  for (const p of ledger) {
    if (p !== page && p.heightPx > 0 && p.count > 0) {
      totalH += p.heightPx;
      totalN += p.count;
    }
  }
  const avg = totalN > 0 ? totalH / totalN : ESTIMATE_MESSAGE_HEIGHT_PX;
  return Math.max(48, Math.round(avg * page.count));
}

/** 释放一页：splice 出消息 + loaded=false + 记高度。同步无间隙（调用方先测高再调）。
 *  返回释放的消息数（0 = 页不存在/已释放/不可重取/会话已收口）。 */
export function releasePage(sid: string, pageIndex: number, heightPx?: number): number {
  const ledger = pageLedgers.get(sid);
  const store = stores[sid];
  const page = ledger?.[pageIndex];
  if (!ledger || !store || !page || !page.loaded || page.restorable === false) return 0;
  const idx = insertionIndex(ledger, pageIndex);
  page.heightPx = heightPx && heightPx > 0 ? heightPx : estimatePageHeight(ledger, page);
  store.messages.splice(idx, page.count);
  page.loaded = false;
  trail("recycle", `release ${sid.slice(0, 8)} p=${pageIndex} n=${page.count} h=${Math.round(page.heightPx)}`);
  return page.count;
}

/** 取回一页：按 (endOffset, bytes) 确定性重放字节区间 → splice 回原位。
 *  返回实际取回条数；0 条 = jsonl 已被截断（revertRound clamp）→ 骨架连台账一起丢，
 *  不可恢复的内容与「revert 后 store 不动」的现状语义一致（等下次 hydrate 重建）。 */
export async function restorePage(sid: string, pageIndex: number): Promise<number> {
  const ledger = pageLedgers.get(sid);
  const store = stores[sid];
  const page = ledger?.[pageIndex];
  if (!ledger || !store || !page || page.loaded || page.restorable === false || mutating.has(sid)) return 0;
  mutating.add(sid);
  try {
    const result = await invoke<LoadMessagesResult>("load_messages", {
      sessionId: sid,
      offsetBytes: page.endOffset,
      limit: Math.max(1, page.bytes),
    });
    if (!result || !Array.isArray(result.messages) || result.messages.length === 0) {
      ledger.splice(pageIndex, 1);
      trail("recycle", `restore ${sid.slice(0, 8)} p=${pageIndex} EMPTY → drop skeleton`);
      return 0;
    }
    const msgs = itemsToChatMessages(result.messages);
    // 原位在 await 之后现算——间隙里可能有别的页被释放/新页被 unshift，索引随取随新
    store.messages.splice(insertionIndex(ledger, pageIndex), 0, ...msgs);
    page.count = msgs.length; // 预算边界允许条数漂移，以实际为准
    page.loaded = true;
    trail("recycle", `restore ${sid.slice(0, 8)} p=${pageIndex} n=${msgs.length}`);
    return msgs.length;
  } catch (e) {
    console.warn("Failed to restore page:", e);
    trail("recycle", `restore ${sid.slice(0, 8)} p=${pageIndex} FAILED ${String(e).slice(0, 80)}`);
    return 0;
  } finally {
    mutating.delete(sid);
  }
}

/** 热区外释放：从旧到新释放 loaded 页，直到已加载字节 ≤ budget。
 *  hotPageIndex 缺省时保留最新 preserveNewest 页（evict 二阶段无视口上下文）。
 *  live 段永不释放（流式写入目标）。返回释放页数。 */
export function releaseFarthestPages(
  sid: string,
  opts: { budget: number; hotPageIndex?: number; preserveNewest?: number },
  measure?: (pageIndex: number) => number | undefined,
): number {
  const ledger = pageLedgers.get(sid);
  if (!ledger || ledger.length === 0) return 0;
  const hot = opts.hotPageIndex ?? viewportHot.get(sid);
  const preserveNewest = opts.preserveNewest ?? 2;
  let bytes = loadedPagesBytes(sid);
  let released = 0;
  for (let i = 0; i < ledger.length && bytes > opts.budget; i++) {
    const p = ledger[i];
    if (!p.loaded) continue;
    // 热区豁免：视口 ±K 页
    if (hot !== undefined && Math.abs(i - hot) <= HOT_ZONE_RADIUS) continue;
    // 尾部豁免：无 hot 上下文时保留最新 N 页（evict 路径兜底语义）
    if (hot === undefined && i >= ledger.length - preserveNewest) continue;
    const n = releasePage(sid, i, measure?.(i));
    if (n > 0) {
      bytes -= p.bytes;
      released++;
    }
  }
  return released;
}

/** 台账+消息数组 → 渲染行。纯函数（ChatPanel computed 里调用）：
 *  无台账/空台账 = 全 live（未分页会话的兼容路径——游标探测分支、纯流式新会话）。 */
export function buildRows(sid: string, messages: readonly ChatMessage[]): Row[] {
  const ledger = pageLedgers.get(sid);
  if (!ledger || ledger.length === 0) {
    return messages.map((m) => ({ kind: "live", id: m.id, message: m }));
  }
  const rows: Row[] = [];
  let cursor = 0;
  for (let i = 0; i < ledger.length; i++) {
    const p = ledger[i];
    if (p.loaded) {
      rows.push({
        kind: "page",
        id: p.id,
        pageIndex: i,
        messages: messages.slice(cursor, cursor + p.count) as ChatMessage[],
      });
      cursor += p.count;
    } else {
      rows.push({ kind: "skeleton", id: p.id, pageIndex: i, count: p.count, heightPx: p.heightPx });
    }
  }
  for (; cursor < messages.length; cursor++) {
    rows.push({ kind: "live", id: messages[cursor].id, message: messages[cursor] });
  }
  return rows;
}

/** 累积高度表（每行的顶偏移）：骨架用记账高度，其余用实测/估算。 */
export function buildCumulative(rows: readonly Row[], heights: ReadonlyMap<string, number>): number[] {
  const cum: number[] = new Array(rows.length + 1);
  cum[0] = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const h = heights.get(r.id) ?? (r.kind === "skeleton" ? r.heightPx : ESTIMATE_MESSAGE_HEIGHT_PX);
    cum[i + 1] = cum[i] + h;
  }
  return cum;
}

/** 视口顶所在行的页索引（二分行累积表）；落在 live 段/无页时返回 -1。 */
export function findViewportPageIndex(scrollTop: number, rows: readonly Row[], cum: readonly number[]): number {
  let lo = 0;
  let hi = rows.length - 1;
  let rowIdx = rows.length; // 默认：滚过了所有行
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= scrollTop) {
      rowIdx = mid; // 候选：顶在中点行之下的最近行
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const row = rows[rowIdx];
  return row && row.kind !== "live" ? row.pageIndex : -1;
}

/** 距视口最近的待取回骨架页索引（prefetch 边距 = ±margin×视口高）；无则 -1。 */
export function findRestorableSkeleton(
  scrollTop: number,
  clientHeight: number,
  rows: readonly Row[],
  cum: readonly number[],
  margin = 1.5,
): number {
  const top = scrollTop - clientHeight * margin;
  const bottom = scrollTop + clientHeight * (1 + margin);
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.kind !== "skeleton") continue;
    const rTop = cum[i];
    const rBottom = cum[i + 1];
    if (rBottom < top || rTop > bottom) continue;
    const dist = rTop < scrollTop ? scrollTop - rBottom : rTop - (scrollTop + clientHeight);
    if (dist < bestDist) {
      bestDist = dist;
      best = r.pageIndex;
    }
  }
  return best;
}

/** 取回后的 scrollTop 补偿（纯函数）：rowTopBefore = 页顶相对视口顶的原位置
 *  （cumBefore[行号] - scrollTop，可负=页在视口上方）；取回后把页顶放回同一
 *  相对位置——骨架在视口上方时内容把视口往下推、骑跨时保持页顶不动，两情形统一。 */
export function computeRestoreScrollTop(
  cumBefore: readonly number[],
  cumAfter: readonly number[],
  rowIndex: number,
  scrollTop: number,
): number {
  const rowTopBefore = cumBefore[rowIndex] - scrollTop;
  return cumAfter[rowIndex] - rowTopBefore;
}
