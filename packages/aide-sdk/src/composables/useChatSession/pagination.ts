import { api } from "../../api";
import { trail } from "../../utils/diagnostics/scrollTrail";
import type { LoadMessagesResult } from "../../types";
import type { ChatMessage } from "../../types/chat";
import { computeMessagesBytes } from "../../utils/messageBytes";
import { itemsToChatMessages } from "./transcriptMapping";
import { maybeEvict } from "./evict";
import {
  disposedSids,
  getOrCreateLedger,
  getStore,
  isPendingSession,
  pageLedgers,
  sessionPagination,
  stores,
  type PageEntry,
} from "./state";

/**
 * P1 双向分页（字节游标，2026-08-26 落地）+ 页台账（2026-08-28 回收半边重引入）：
 * - hydrate：只取尾部一页（打开不全量），并建页台账首条记录；
 * - 上滚到顶 → loadOlderPage 取更早一页 unshift 头部 + 游标前进 + 台账 unshift 新页；
 * - 回收由 recycle.ts 管（releasePage/restorePage 按台账字节区间确定性重放）；
 *   内存双保险：recycle 管「页级驻留上限」，evict 管「页内大 block 降级」。
 * 游标 = tailOffset（最老已加载页的页首字节）——内容必然前进不重复。
 */

/** hydrate / 上滚取回的页字节预算（UTF-8 行字节累计，后端 load_messages limit 语义；
 *  大 tool_result 占预算多则页内条数自适应收缩）。 */
const HYDRATE_PAGE_BYTES = 256 * 1024;

/** 一页响应 → 台账条目。endOffsetBytes 由后端返回（本次读取的排他末尾）——
 *  hydrate 走 offset=None 时前端自己不知道 file_len，必须从响应取。
 *  缺 endOffsetBytes（版本错配等防御场景）→ restorable=false 永不释放，
 *  bytes 用消息内容估算顶上（只喂预算判定，不参与重取）。 */
function pageEntryFrom(result: LoadMessagesResult, msgs: readonly ChatMessage[]): PageEntry {
  const restorable = typeof result.endOffsetBytes === "number";
  return {
    id: crypto.randomUUID(),
    startOffset: result.nextOffsetBytes,
    endOffset: restorable ? result.endOffsetBytes : result.nextOffsetBytes,
    count: msgs.length,
    bytes: restorable
      ? Math.max(1, result.endOffsetBytes - result.nextOffsetBytes)
      : Math.max(1, computeMessagesBytes(msgs)),
    loaded: true,
    restorable,
    heightPx: 0, // 未上过屏；首次释放时实测/估算回填
  };
}

/** 首屏加载：只取尾部一页（页 = 字节预算），建立 per-sid 游标与页台账。已有数据
 *  （活动会话/重开）走「游标缺失探测」分支：store 有数据但 sessionPagination 无
 *  记录时补一次最小页探测拿 tailOffset，恢复上滚取回；台账不补（live 段全量视为
 *  未分页，下次重开会话 hydrate 自然重建）。 */
export async function hydrate(sid: string): Promise<void> {
  // 重开 = 复活：清除销毁标记，后续事件正常入 store（getStore 重建为重开做准备）
  disposedSids.delete(sid);
  const store = getStore(sid);
  if (store.hydrated || store.messages.length > 0 || isPendingSession(sid)) {
    store.hydrated = true;
    if (store.messages.length > 0 && !sessionPagination.has(sid)) {
      try {
        const result = await api.loadMessages(sid, null, 1); // 最小页：只探游标（最新 1 条保底），消息丢弃不 unshift
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
    const result = await api.loadMessages(sid, null, HYDRATE_PAGE_BYTES);
    if (!result || !Array.isArray(result.messages)) {
      trail("pager", `hydrate ${sid.slice(0, 8)} EMPTY-RESULT`);
      // 响应形状异常（版本错配/网关裁剪）不是「真空会话」：回滚 hydrated 让
      // 重开重试，否则一次坏响应把会话永久钉死在空态（真空走下方正常路径，
      // msgs 为空数组时保持 hydrated 不重试）。
      store.hydrated = false;
      return;
    }
    // hydrate 期间可能已有实时消息进来：历史插到最前
    const msgs = itemsToChatMessages(result.messages);
    store.messages.unshift(...msgs);
    // 尾部页游标：nextOffsetBytes 0 = 无更早页，上滚「到此为止」
    sessionPagination.set(sid, { tailOffset: result.nextOffsetBytes });
    // 页台账首条 = 尾部页（live 段从此页之后开始累积）
    if (msgs.length > 0) {
      const ledger = getOrCreateLedger(sid);
      ledger.push(pageEntryFrom(result, msgs));
    }
    trail("pager", `hydrate ${sid.slice(0, 8)} n=${result.messages.length} tail=${result.nextOffsetBytes}`);
    maybeEvict(sid, store);
  } catch (e) {
    console.warn("Failed to load messages:", e);
    // 加载失败（断线/桌面忙）：回滚 hydrated，重开会话时重试——否则 PWA 这类
    // SPA 的模块级 store 里一次失败把会话永久钉死在「此会话暂无消息」
    // （hydrated=true 使 hydrate 的 skip 分支拦截一切后续加载）。
    store.hydrated = false;
    trail("pager", `hydrate ${sid.slice(0, 8)} FAILED ${String(e).slice(0, 80)}`);
  }
}

/** 取更早一页（limit = 字节预算），unshift 到消息头部 + 台账头部。返回实际取回
 *  条数（0 = 无更早页/失败）。游标前进 → 内容必然前进不重复。 */
export async function loadOlderPage(sid: string, limit: number): Promise<number> {
  const page = sessionPagination.get(sid);
  const store = stores[sid];
  if (!page || !store || page.tailOffset === 0) return 0;
  try {
    const result = await api.loadMessages(sid, page.tailOffset, limit);
    if (!result || !Array.isArray(result.messages)) {
      trail("pager", `load ${sid.slice(0, 8)} EMPTY-RESULT`);
      return 0;
    }
    const msgs = itemsToChatMessages(result.messages);
    store.messages.unshift(...msgs);
    page.tailOffset = result.nextOffsetBytes;
    // 台账头插新页：endOffset = 旧 tailOffset（= 读取末尾），与相邻页首尾相接
    if (msgs.length > 0) {
      getOrCreateLedger(sid).unshift(pageEntryFrom(result, msgs));
    }
    maybeEvict(sid, store);
    return result.messages.length;
  } catch (e) {
    console.warn("Failed to load older messages:", e);
    return 0;
  }
}

/** revertRound 截断 .jsonl 后调用：旧字节游标失效，清游标 + 页台账（骨架消失、
 *  已释放内容等下次 hydrate——与 revert 不动 store 的现状语义一致）。
 *  后端另有 clamp 兜底（双保险）。 */
export function resetPaginationForRevert(sid: string): void {
  sessionPagination.delete(sid);
  pageLedgers.delete(sid);
}

/** 磁盘上还有更早页可取（tailOffset > 0）——顶部入口与上滚取回的开关。 */
export function hasMoreOlder(sid: string): boolean {
  return (sessionPagination.get(sid)?.tailOffset ?? 0) > 0;
}
