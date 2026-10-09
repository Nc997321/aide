import { api } from "../../api";
import type { ChatMessage } from "../../types/chat";
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
 *  占位（内联 heightPx 撑高度）；liveskel=live 段隐藏前缀占位（显示层窗口化，
 *  见 buildRows 的 live 参数）；live=页边界之后的流式段（逐条）。 */
export type Row =
  | { kind: "page"; id: string; pageIndex: number; messages: ChatMessage[] }
  | { kind: "skeleton"; id: string; pageIndex: number; count: number; heightPx: number }
  | { kind: "liveskel"; id: string; count: number; heightPx: number }
  | { kind: "live"; id: string; message: ChatMessage };

/** live 段常驻尾窗行数：钉底滑动/无几何收拢/展开步长共用的窗口粒度。
 *  DOM 里的 live 行数恒 ≤ K（外加阅读展开的增量，切走即收拢回窗）。 */
export const LIVE_TAIL_ROWS = 40;

/** live 段窗口状态（显示层所有，滚动层持有并传入 buildRows）。hiddenCount 是
 *  live 段的相对量（隐藏前缀条数），页释放/取回只移动 liveStart、不动它——
 *  窗口锚定的是内容，无须跨层平移；唯一要跟的是无台账 prepend（上翻把更早
 *  消息并进 live 段，滚动层按取回条数显式 +count）。 */
export interface LiveWindowState {
  /** 隐藏前缀条数（live 段头部起的隐藏行数）。 */
  hiddenCount: number;
  /** 隐藏前缀的总高（px）——收拢时实测、滑动时逐条累加真实行高、无 DOM 时
   *  按条数 × ESTIMATE 兜底；liveskel 行高直接取它（总高守恒 → 滚动零跳变）。 */
  hiddenPx: number;
}

/** 无 DOM 可测时的单条消息估算高度（聊天气泡含 padding/代码块，取偏保守值——
 *  误差在下次实测时自校正，只影响从未上过屏的后台会话骨架）。 */
export const ESTIMATE_MESSAGE_HEIGHT_PX = 120;
/** 已加载页总字节预算（jsonl UTF-8 字节，≈内存代理）：超出才释放热区外页。
 *
 * 16MB → 2MB（2026-09-17）：16MB 比本机最大会话（14.19MB 实测）还大 ⇒ **回收
 * 从未触发过**——「页级回收」是一道永不落下的闸，长会话等于全量驻留。
 * 2MB ≈ 8 页 × 256KB：视口页 ±1 恒驻（3 页），余量留给连续翻页，同时把单会话
 * 驻留量钉在 ~2MB jsonl 量级（渲染块数/节点数随字节走，见 freeze-1789629633117）。 */
export const RECYCLE_BYTES_BUDGET = 2 * 1024 * 1024;
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
    const result = await api.loadMessages(sid, page.endOffset, Math.max(1, page.bytes));
    if (!result || !Array.isArray(result.messages) || result.messages.length === 0) {
      ledger.splice(pageIndex, 1);
      return 0;
    }
    const msgs = itemsToChatMessages(result.messages);
    // 原位在 await 之后现算——间隙里可能有别的页被释放/新页被 unshift，索引随取随新
    store.messages.splice(insertionIndex(ledger, pageIndex), 0, ...msgs);
    page.count = msgs.length; // 预算边界允许条数漂移，以实际为准
    page.loaded = true;
    return msgs.length;
  } catch (e) {
    console.warn("Failed to restore page:", e);
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

/** 收紧某会话的驻留页到预算内：热区（视口页 ±HOT_ZONE_RADIUS）留载，其余释放成骨架。
 *
 * 切走（budget 0，见 useChatScroll.collapseAndTightenForSwitchAway）与**切入**共用；
 * 切入那一次必须在**建行/渲染之前**调用（watch(sessionId) pre-flush），否则整会话先
 * 挂载一遍再回收——等于没省（2026-09-17 拆 ramp 时明确：挂载量由本函数 + 预算兜底，
 * 不再靠逐帧切片）。
 *
 * `anchorRowId` = 切回落点所在行 id：用它反查热区页比推算视口可靠——切入时 DOM 还是
 * 上一个会话的，量不出新会话的视口。热区页算不出（无锚/无记忆）则回退保留最新 2 页。
 * 无 DOM 时骨架高走估算：落点补偿量的是锚行在真实 DOM 里的位置（useChatScroll.
 * landAnchored），不受估算误差影响。返回释放页数。 */
export function tightenResidentPages(
  sid: string,
  opts: { budget: number; anchorRowId?: string },
): number {
  const ledger = pageLedgers.get(sid);
  if (!ledger || ledger.length === 0) return 0;
  // 锚行 id = 页台账条目 id（page 行与 skeleton 行同 id），直接反查页索引——
  // 不必建行也不必视口推算（切入时量不到新会话的视口）。
  const hot = opts.anchorRowId ? ledger.findIndex((p) => p.id === opts.anchorRowId) : -1;
  return releaseFarthestPages(sid, {
    budget: opts.budget,
    hotPageIndex: hot >= 0 ? hot : undefined,
  });
}

/** liveskel 行的稳定 id（跨 recompute 不变，v-for key / 高度表 / 锚定都靠它）。 */
export function liveSkeletonId(sid: string): string {
  return `liveskel:${sid}`;
}

/** 隐藏区高度（夹紧后）：陈旧窗口大于现存 live 段时 count 被夹到 liveSeg，高度必须
 *  按 **px/条比守恒** 同比例收缩——否则占位行声明「我代表 N 条」却撑旧窗口全高，
 *  内容虚高（真机实测 store.messages=10 条 / scrollHeight=81784px；切会话时容器高
 *  在 66↔559 抖动，ResizeObserver 每帧读 scrollHeight 强制全量布局 → 冻结）。
 *  未夹紧（hidden === hiddenCount）时原样返回实测高。`hiddenCount > 0` 由调用方守卫。
 *  「按 px/条比例折算」也是 slideLiveWindowToTail 过藏分支声明过的同一规则。 */
function scaleHiddenPx(live: LiveWindowState, hidden: number): number {
  return hidden < live.hiddenCount ? (live.hiddenPx * hidden) / live.hiddenCount : live.hiddenPx;
}

/** live 段行构建（ledger 与 no-ledger 两路共用）：隐藏前缀（live 头部 hiddenCount
 *  条）→ 一条 liveskel 占位 + 尾窗 live 行。hiddenCount 只做几何夹紧
 *  （[0, liveSeg]）——收拢/滑动/展开全是滚动层策略（见 useChatScroll），本函数
 *  对政策无感知：传入什么 hiddenCount 就表达什么窗口。 */
function appendLiveWindowRows(
  rows: Row[],
  sid: string,
  messages: readonly ChatMessage[],
  liveStart: number,
  live: LiveWindowState | null | undefined,
): void {
  const len = messages.length;
  const liveSeg = len - liveStart;
  if (!live || live.hiddenPx <= 0 || live.hiddenCount <= 0) {
    for (let i = liveStart; i < len; i++) {
      rows.push({ kind: "live", id: messages[i].id, message: messages[i] });
    }
    return;
  }
  const hidden = Math.min(Math.max(live.hiddenCount, 0), liveSeg);
  if (hidden > 0) {
    rows.push({
      kind: "liveskel",
      id: liveSkeletonId(sid),
      count: hidden,
      heightPx: Math.max(1, Math.round(scaleHiddenPx(live, hidden))),
    });
  }
  for (let i = liveStart + hidden; i < len; i++) {
    rows.push({ kind: "live", id: messages[i].id, message: messages[i] });
  }
}

/** 台账+消息数组 → 渲染行。纯函数（ChatPanel computed 里调用）：
 *  无台账/空台账 = 全 live（未分页会话的兼容路径——游标探测分支、纯流式新会话）。
 *  live 窗口（可选）把 live 段切成「隐藏前缀 liveskel + 常驻尾窗」——显示层
 *  窗口化，store.messages 不动（切长会话尖峰修复，见 plans/2026-09-07-live-window-recycle）。 */
export function buildRows(
  sid: string,
  messages: readonly ChatMessage[],
  live?: LiveWindowState | null,
): Row[] {
  const ledger = pageLedgers.get(sid);
  if (!ledger || ledger.length === 0) {
    const rows: Row[] = [];
    appendLiveWindowRows(rows, sid, messages, 0, live ?? null);
    return rows;
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
  appendLiveWindowRows(rows, sid, messages, cursor, live ?? null);
  return rows;
}

/** 累积高度表（每行的顶偏移）：骨架/liveskel 用记账高度，其余用实测/估算。 */
export function buildCumulative(rows: readonly Row[], heights: ReadonlyMap<string, number>): number[] {
  const cum: number[] = new Array(rows.length + 1);
  cum[0] = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const collapsed = r.kind === "skeleton" || r.kind === "liveskel";
    const h = heights.get(r.id) ?? (collapsed ? r.heightPx : ESTIMATE_MESSAGE_HEIGHT_PX);
    cum[i + 1] = cum[i] + h;
  }
  return cum;
}

/** 视口热区页索引（二分行累积表）：视口顶所在页；落在 live 段/liveskel 时取**它上方
 *  最近的页**（live 段恒在所有页之后，即末页）；无页返回 -1。
 *
 *  ⚠️ 不能对 live 段返回 -1（2026-10-09 现场：阅读最新一轮时页/live 交界处整屏闪白、
 *  滚轮被带走）。-1 → 调用方不报热区 → releaseFarthestPages 回落到**陈旧**的
 *  viewportHot（上次在页区阅读时的页）→ 紧贴视口上方的末页被释放成骨架 → 同一次
 *  结算的 prefetch 立刻把它取回 → 取回收尾再排结算 → 再释放……每 ~200ms 一轮的
 *  释放/取回振荡，视口压在交界处时看到的就是整屏虚线骨架与正文交替闪。 */
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
  for (let i = Math.min(rowIdx, rows.length - 1); i >= 0; i--) {
    const row = rows[i];
    if (row.kind === "page" || row.kind === "skeleton") return row.pageIndex;
  }
  return -1;
}

/** liveskel 是否进入预取边距带（视口 ±margin×屏高）——进入即应展开
 *  （与 findRestorableSkeleton 的页骨架带判定同构，两者互斥命中时 liveskel
 *  优先：它是从 live 尾窗往上读历史的必经门）。纯函数。 */
export function liveSkeletonInBand(
  scrollTop: number,
  clientHeight: number,
  rows: readonly Row[],
  cum: readonly number[],
  margin = 1.5,
): boolean {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.kind !== "liveskel") continue;
    const top = cum[i];
    const bottom = cum[i + 1];
    return !(bottom < scrollTop - clientHeight * margin || top > scrollTop + clientHeight * (1 + margin));
  }
  return false;
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
