import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Tauri mocks（复用 pagination.test.ts 模式）──
const invokeMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { getStore, getOrCreateLedger, pageLedgers, resetAllState, type PageEntry } from "./useChatSession/state";
import {
  buildCumulative,
  buildRows,
  computeRestoreScrollTop,
  findRestorableSkeleton,
  findViewportPageIndex,
  insertionIndex,
  isRecycleMutating,
  liveMessageCount,
  loadedPagesBytes,
  releaseFarthestPages,
  releasePage,
  restorePage,
  setViewportHot,
  tightenResidentPages,
  type Row,
} from "./useChatSession/recycle";
import type { ChatMessage } from "../types/chat";

function makeMsg(text: string): ChatMessage {
  return { id: crypto.randomUUID(), role: "assistant", blocks: [{ type: "text", text }], timestamp: 0 };
}

/** 取 liveskel 行（不存在即测试前置失败——不要静默断言 undefined）。 */
function liveskelOf(rows: readonly Row[]): Extract<Row, { kind: "liveskel" }> {
  const hit = rows.find((r): r is Extract<Row, { kind: "liveskel" }> => r.kind === "liveskel");
  if (!hit) throw new Error("测试前置失败：rows 里没有 liveskel 行");
  return hit;
}

/** 造一页台账条目（默认 loaded + restorable）。 */
function makePage(overrides: Partial<PageEntry> = {}): PageEntry {
  return {
    id: crypto.randomUUID(),
    startOffset: 0,
    endOffset: 100,
    count: 2,
    bytes: 100,
    loaded: true,
    restorable: true,
    heightPx: 0,
    ...overrides,
  };
}

/** 建一个会话：store 里按台账塞满 loaded 页的消息 + live 段。返回 store。 */
function setupSession(sid: string, pages: PageEntry[], liveCount: number) {
  const store = getStore(sid);
  const ledger = getOrCreateLedger(sid);
  ledger.push(...pages);
  for (let pi = 0; pi < pages.length; pi++) {
    const p = pages[pi];
    if (p.loaded) {
      for (let i = 0; i < p.count; i++) store.messages.push(makeMsg(`p${pi}-${i}`));
    }
  }
  for (let i = 0; i < liveCount; i++) store.messages.push(makeMsg(`live-${i}`));
  return store;
}

function pageResult(prefix: string, n: number, nextOffsetBytes = 0, endOffsetBytes = 100) {
  return {
    messages: Array.from({ length: n }, (_, i) => ({
      role: "assistant",
      timestamp: i,
      blocks: [{ type: "text" as const, text: `${prefix}-${i}` }],
    })),
    nextOffsetBytes,
    endOffsetBytes,
  };
}

describe("useChatSession/recycle 页级回收", () => {
  beforeEach(() => {
    resetAllState();
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
  });

  it("无台账 → buildRows 全 live（兼容路径）", () => {
    const store = getStore("s1");
    store.messages.push(makeMsg("a"), makeMsg("b"));
    const rows = buildRows("s1", store.messages);
    expect(rows.map((r) => r.kind)).toEqual(["live", "live"]);
  });

  it("buildRows：loaded 页 → page 行（消息分组），释放后 → skeleton 行", () => {
    const store = setupSession("s1", [makePage({ count: 2 }), makePage({ count: 3 })], 1);
    let rows = buildRows("s1", store.messages);
    expect(rows.map((r) => r.kind)).toEqual(["page", "page", "live"]);
    expect(rows[0].kind === "page" && rows[0].messages.length).toBe(2);
    expect(rows[1].kind === "page" && rows[1].messages.length).toBe(3);

    releasePage("s1", 0, 500);
    rows = buildRows("s1", store.messages);
    expect(rows.map((r) => r.kind)).toEqual(["skeleton", "page", "live"]);
    expect(rows[0].kind === "skeleton" && rows[0].heightPx).toBe(500);
    // 第 2 页的消息内容不被释放波及
    expect(rows[1].kind === "page" && (rows[1].messages[0].blocks[0] as { text: string }).text).toBe("p1-0");
  });

  it("live 窗口过藏：hiddenCount 被夹紧时 heightPx 必须按 px/条比同比例收缩", () => {
    const store = getStore("s1");
    for (let i = 0; i < 10; i++) store.messages.push(makeMsg(`live-${i}`));
    // 陈旧窗口（dispose 后同 sid 重开、旧窗口大于现存 live 段的残留量级）：
    // 683 条 × 120px 估算高。live 段只剩 10 条 → count 必然被夹到 10。
    const stale = { hiddenCount: 683, hiddenPx: 683 * 120 };
    const skel = liveskelOf(buildRows("s1", store.messages, stale));

    expect(skel.count).toBe(10); // 夹到 live 段长度
    // 几何必须跟着一起收缩，否则占位行会声明「我代表 10 条」却撑 81960px 的虚高高度
    // （真机实测：store.messages=10 条、内容高 81784px，切会话时容器高度 66↔559 抖动）。
    const perMessage = stale.hiddenPx / stale.hiddenCount; // 120 px/条
    expect(skel.heightPx).toBe(Math.round(10 * perMessage));
  });

  it("释放 splice 原位公式：释放第 0、2 页后，store 只剩第 1 页 + live", () => {
    const store = setupSession(
      "s1",
      [makePage({ count: 2 }), makePage({ count: 1 }), makePage({ count: 3 })],
      2,
    );
    releasePage("s1", 0, 100);
    releasePage("s1", 2, 100);
    expect(store.messages.map((m) => (m.blocks[0] as { text: string }).text)).toEqual([
      "p1-0",
      "live-0",
      "live-1",
    ]);
    expect(liveMessageCount("s1", store.messages.length)).toBe(2);
  });

  it("取回中间页：splice 回原位，前后页内容不错位", async () => {
    const store = setupSession(
      "s1",
      [makePage({ count: 2 }), makePage({ count: 1 }), makePage({ count: 3 })],
      1,
    );
    releasePage("s1", 0, 100);
    releasePage("s1", 2, 100);
    // 取回第 0 页（台账 0 号位，骨架）
    invokeMock.mockResolvedValueOnce(pageResult("p0-new", 2));
    const n = await restorePage("s1", 0);
    expect(n).toBe(2);
    expect(store.messages.map((m) => (m.blocks[0] as { text: string }).text)).toEqual([
      "p0-new-0",
      "p0-new-1",
      "p1-0",
      "live-0",
    ]);
    // 台账 count 按实际返回数更新
    const ledger = pageLedgers.get("s1")!;
    expect(ledger[0].loaded).toBe(true);
    expect(ledger[0].count).toBe(2);
    // 重取调用参数 = 页的字节区间
    expect(invokeMock).toHaveBeenCalledWith("load_messages", {
      sessionId: "s1",
      offsetBytes: ledger[0].endOffset,
      limit: ledger[0].bytes,
    });
  });

  it("取回返回 0 条（revert 截断 clamp）→ 骨架连台账条目一起丢", async () => {
    const store = setupSession("s1", [makePage({ count: 2 }), makePage({ count: 1 })], 1);
    releasePage("s1", 0, 100);
    invokeMock.mockResolvedValueOnce({ messages: [], nextOffsetBytes: 0, endOffsetBytes: 0 });
    const n = await restorePage("s1", 0);
    expect(n).toBe(0);
    expect(pageLedgers.get("s1")!.length).toBe(1); // 骨架页被丢
    expect(buildRows("s1", store.messages).map((r) => r.kind)).toEqual(["page", "live"]);
  });

  it("取回互斥：在途时再取同会话返回 0", async () => {
    setupSession("s1", [makePage({ count: 1 }), makePage({ count: 1 })], 0);
    releasePage("s1", 0, 100);
    releasePage("s1", 1, 100);
    let releaseGate: (() => void) | null = null;
    invokeMock.mockImplementationOnce(() => new Promise((r) => { releaseGate = () => r(pageResult("p0", 1)); }));
    const p1 = restorePage("s1", 0);
    expect(isRecycleMutating("s1")).toBe(true);
    // 在途期间第二次取回被拒
    expect(await restorePage("s1", 1)).toBe(0);
    releaseGate!();
    expect(await p1).toBe(1);
    expect(isRecycleMutating("s1")).toBe(false);
  });

  it("restorable=false 的页不释放不取回", async () => {
    setupSession("s1", [makePage({ count: 2, restorable: false })], 1);
    expect(releasePage("s1", 0, 100)).toBe(0);
    expect(pageLedgers.get("s1")![0].loaded).toBe(true);
    expect(await restorePage("s1", 0)).toBe(0);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("releaseFarthestPages：超预算从旧到新释放，热区 ±1 豁免", () => {
    // 4 页 × 100B，预算 150B → 释放到 ≤150B（保留热区）
    setupSession(
      "s1",
      [
        makePage({ count: 1, bytes: 100 }),
        makePage({ count: 1, bytes: 100 }),
        makePage({ count: 1, bytes: 100 }),
        makePage({ count: 1, bytes: 100 }),
      ],
      0,
    );
    setViewportHot("s1", 2); // 视口在第 2 页 → 热区 [1,2,3]
    const released = releaseFarthestPages("s1", { budget: 150, hotPageIndex: 2 });
    expect(released).toBe(1); // 只有第 0 页可放
    const ledger = pageLedgers.get("s1")!;
    expect(ledger.map((p) => p.loaded)).toEqual([false, true, true, true]);
  });

  it("releaseFarthestPages：无热区上报时保留最新 N 页（evict 兜底语义）", () => {
    setupSession(
      "s1",
      [
        makePage({ count: 1, bytes: 100 }),
        makePage({ count: 1, bytes: 100 }),
        makePage({ count: 1, bytes: 100 }),
      ],
      0,
    );
    const released = releaseFarthestPages("s1", { budget: 50, preserveNewest: 2 });
    expect(released).toBe(1); // 最老页释放，最新 2 页豁免
    expect(pageLedgers.get("s1")!.map((p) => p.loaded)).toEqual([false, true, true]);
  });

  // ── 切入收紧（tightenResidentPages，2026-09-17 拆 ramp）──
  // 拆掉分帧挂载后，挂载量由「切入收紧 + 停驻结算」两处结构性窗口决定：切入那次必须
  // 在**建行之前**（useChatScroll 的 watch(sessionId) pre-flush）把远端页放掉，否则
  // 整会话先挂一遍再回收——等于没省。

  /** 4 页 × 1MB 的长会话现场：预算 2MB 下必须收得动（16MB 旧预算比会话还大 ⇒ 永不触发）。
   *  sid 逐用例错开：recycle.ts 的 viewportHot 是模块级 Map 且 resetAllState 不清它，
   *  共用 sid 会读到别处 setViewportHot 留下的热区页（→ hot 分支取代「保留最新 2 页」）。 */
  function setupMbPages(sid: string, n: number) {
    const MB = 1024 * 1024;
    const pages = Array.from({ length: n }, (_, i) =>
      makePage({ id: `pg${i}`, count: 1, bytes: MB, startOffset: i * MB, endOffset: (i + 1) * MB }),
    );
    return setupSession(sid, pages, 0);
  }

  it("tightenResidentPages：无锚行回退保留最新 2 页，更老的释放成骨架行", () => {
    const sid = "s-tight-anchorless";
    const store = setupMbPages(sid, 4);
    // 切入时还量不到新会话的视口（DOM 还是上一个会话的）且无位置记忆 → 无锚行
    const released = tightenResidentPages(sid, { budget: 2 * 1024 * 1024 });
    expect(released).toBe(2); // 4MB → 2MB：只放得动最老两页（最新 2 页豁免）
    expect(pageLedgers.get(sid)!.map((p) => p.loaded)).toEqual([false, false, true, true]);
    // 行模型随之立刻是骨架分布（不是「先全量挂载再回收」）
    expect(buildRows(sid, store.messages).map((r) => r.kind)).toEqual([
      "skeleton",
      "skeleton",
      "page",
      "page",
    ]);
  });

  it("tightenResidentPages：anchorRowId 反查热区页，±1 页豁免", () => {
    const sid = "s-tight-anchored";
    setupMbPages(sid, 4);
    // 切回落点所在行（锚行 id = 台账条目 id）= 第 1 页 → 热区 [0,2] 全豁免，
    // 预算内只剩第 3 页可放（放完 3MB 仍超 2MB，但已无可放页）
    const released = tightenResidentPages(sid, { budget: 2 * 1024 * 1024, anchorRowId: "pg1" });
    expect(released).toBe(1);
    expect(pageLedgers.get(sid)!.map((p) => p.loaded)).toEqual([true, true, true, false]);
  });

  it("tightenResidentPages：预算内不动结构；未知锚行 id 回退保留最新 2 页", () => {
    const sid = "s-tight-unknown-anchor";
    const store = setupMbPages(sid, 4);
    // 预算内的会话：一条也不放（收紧是「超了才收」，不是每次切入都清一遍）
    expect(tightenResidentPages(sid, { budget: 8 * 1024 * 1024 })).toBe(0);
    expect(pageLedgers.get(sid)!.filter((p) => p.loaded).length).toBe(4);
    // 锚行 id 对不上任何台账条目（页被丢/会话已换）→ 与无锚同路径
    expect(tightenResidentPages(sid, { budget: 2 * 1024 * 1024, anchorRowId: "pg-gone" })).toBe(2);
    expect(buildRows(sid, store.messages).map((r) => r.kind)).toEqual([
      "skeleton",
      "skeleton",
      "page",
      "page",
    ]);
  });

  it("预算 2MB：14MB 级长会话切进来也收得动（回归：16MB 预算比会话还大 ⇒ 回收从未触发）", () => {
    const sid = "s-tight-longsession";
    setupMbPages(sid, 14);
    expect(loadedPagesBytes(sid)).toBe(14 * 1024 * 1024);
    const released = tightenResidentPages(sid, { budget: 2 * 1024 * 1024 });
    // 释放到预算内（最老页起一个个放，直到 ≤2MB）
    expect(released).toBe(12);
    expect(loadedPagesBytes(sid)).toBe(2 * 1024 * 1024);
  });

  it("loadedPagesBytes / liveMessageCount 账本", () => {
    const store = setupSession("s1", [makePage({ count: 2, bytes: 300 }), makePage({ count: 1, bytes: 200 })], 3);
    expect(loadedPagesBytes("s1")).toBe(500);
    expect(liveMessageCount("s1", store.messages.length)).toBe(3);
    releasePage("s1", 0, 100);
    expect(loadedPagesBytes("s1")).toBe(200);
    expect(liveMessageCount("s1", store.messages.length)).toBe(3); // 释放不动 live 计数
  });

  it("无实测高度时估算页高（count × 其他页实测均值）", () => {
    setupSession("s1", [makePage({ count: 2 }), makePage({ count: 4 })], 0);
    releasePage("s1", 1, 800); // 第 1 页实测 800（4 条 → 均值 200/条）
    releasePage("s1", 0); // 无注入高 → 估算 2 × 200
    const ledger = pageLedgers.get("s1")!;
    expect(ledger[1].heightPx).toBe(800);
    expect(ledger[0].heightPx).toBe(400);
  });

  // ── 纯函数：定位与补偿 ──

  it("findViewportPageIndex：按累积高度定位视口顶所在页，live 段返回 -1", () => {
    const store = setupSession("s1", [makePage({ count: 1 }), makePage({ count: 1 })], 2);
    const rows = buildRows("s1", store.messages);
    // rows = [page0, page1, live, live]；注入高度：page0=100, page1=200, live 各 50
    const heights = new Map<string, number>([
      [rows[0].id, 100],
      [rows[1].id, 200],
      [rows[2].id, 50],
      [rows[3].id, 50],
    ]);
    const cum = buildCumulative(rows, heights); // [0,100,300,350,400]
    expect(findViewportPageIndex(0, rows, cum)).toBe(0);
    expect(findViewportPageIndex(99, rows, cum)).toBe(0);
    expect(findViewportPageIndex(100, rows, cum)).toBe(1);
    expect(findViewportPageIndex(299, rows, cum)).toBe(1);
    expect(findViewportPageIndex(300, rows, cum)).toBe(-1); // live 段
    expect(findViewportPageIndex(399, rows, cum)).toBe(-1);
  });

  it("findRestorableSkeleton：prefetch 边距内最近骨架，边距外不取", () => {
    const store = setupSession(
      "s1",
      [makePage({ count: 1 }), makePage({ count: 1 }), makePage({ count: 1 })],
      0,
    );
    releasePage("s1", 0, 100);
    releasePage("s1", 2, 200);
    const rows = buildRows("s1", store.messages);
    const cum = buildCumulative(rows, new Map()); // 骨架用记账高：100 / page1 默认估算 / 200
    // 视口 [300, 800)，边距 1.5×500=750 → 扫描带 [-450, 1550)：两骨架都在带内，取更近的
    const idx = findRestorableSkeleton(300, 500, rows, cum, 1.5);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(rows[0].kind === "skeleton" && rows[0].pageIndex).toBe(0);
    // 远到扫描带之外 → -1
    expect(findRestorableSkeleton(100000, 500, rows, cum, 1.5)).toBe(-1);
  });

  it("computeRestoreScrollTop：骨架在视口上方（负偏移）与骑跨（正偏移）两情形", () => {
    // 取回前：行 2 是骨架（cum [0,100,300,400]），scrollTop=250 → 骨架顶相对视口 = 300-250=+50
    const cumBefore = [0, 100, 300, 400];
    // 取回后：骨架(高100)被真实页(高250)替换（cum [0,100,550,650]）
    const cumAfter = [0, 100, 550, 650];
    // 骑跨/在视口内：行顶保持在视口 +50 处
    expect(computeRestoreScrollTop(cumBefore, cumAfter, 2, 250)).toBe(550 - 50);
    // 骨架在视口上方：scrollTop=350（骨架顶相对 = 300-350 = -50）→ 取回后顶仍在 -50
    expect(computeRestoreScrollTop(cumBefore, cumAfter, 2, 350)).toBe(550 + 50);
  });

  it("insertionIndex：只累加前面 loaded 页", () => {
    setupSession("s1", [makePage({ count: 2 }), makePage({ count: 3 }), makePage({ count: 1 })], 5);
    const ledger = pageLedgers.get("s1")!;
    expect(insertionIndex(ledger, 0)).toBe(0);
    expect(insertionIndex(ledger, 3)).toBe(6); // 2+3+1
    releasePage("s1", 0, 100);
    expect(insertionIndex(ledger, 2)).toBe(3); // 第 0 页已释放不算 → 3
  });
});
