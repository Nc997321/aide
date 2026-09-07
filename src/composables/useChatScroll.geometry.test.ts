import { describe, it, expect, vi } from "vitest";
import { nextTick, ref, watch } from "vue";
import type { Ref } from "vue";

// 与 useChatScroll.test.ts 同一套 Tauri mock：recycle 兼容壳 → @aide/sdk 的
// import 链上有 tauri api，node 环境必须 mock 掉。
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { useChatScroll } from "./useChatScroll";
import { getOrCreateLedger } from "./useChatSession/state";
import { buildRows, liveSkeletonInBand } from "./useChatSession/recycle";
import type { Row } from "./useChatSession/recycle";
import type { ChatMessage } from "@/types/chat";

/**
 * 几何仿真 v2（2026-09-07 live 窗口化）：单会话、行模型感知——children/scrollHeight
 * 从 api.visibleRows 推导（page=count×行高 / skeleton、liveskel=记账高 / live=单条行高、
 * 无 row-id），不再假设消息↔元素 1:1。
 *
 * 刻意不做跨会话切换：mock 的几何跟随 active 会话的 rows，而切走 watcher（pre-flush）
 * 需要读到「离开会话」的几何——真实 DOM 能做到（旧 DOM 还挂着），mock 做不到
 * （computed 已随 sid 切换）。跨会话的锚定/位置恢复由 useChatScroll.test.ts 的
 * fakeScrollEl 系列覆盖（其几何与会话无关，不受此限）；本文件专测 live 窗口化的
 * 单会话几何保证：
 *  - 收拢：liveskel 记账高撑住总高（滚动零跳变），视口处内容原样挂载；
 *  - 展开：内存行取回 + sh-delta 视口补偿（内容不跳），展开尽头 liveskel 退役；
 *  - 钉底滑动：流式 append 时挂载 live 行数恒 ≤ K，总高守恒。
 */

function makeMessages(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
    blocks: [{ type: "text", text: `msg ${i}` }],
    timestamp: i,
  }));
}

/** 手动调度器（几何版）：flush 为 async——每个回调后 await nextTick，模拟
 *  真实 rAF「渲染 + post watcher（DOM 快照跟上）之后才跑帧回调」的时序。 */
function manualScheduler() {
  const queue: Array<() => void> = [];
  const schedule = (cb: () => void) => {
    queue.push(cb);
    return () => {
      const i = queue.indexOf(cb);
      if (i >= 0) queue.splice(i, 1);
    };
  };
  const flush = async () => {
    let guard = 0;
    while (queue.length > 0 && guard < 500) {
      guard += 1;
      const cb = queue.shift()!;
      cb();
      await nextTick();
    }
  };
  return { schedule, flush };
}

interface GeoModel {
  rowHeight: () => number;
  clientHeight: number;
  scrollTop: number;
}

/** 行几何：page=count×行高；skeleton/liveskel=记账高；live=单条行高。 */
function rowHeightOf(r: Row, rowH: number): number {
  if (r.kind === "page") return r.messages.length * rowH;
  if (r.kind === "live") return rowH;
  return r.heightPx;
}

function makeGeometry(m: GeoModel, domRows: Ref<Row[]>) {
  const total = () => domRows.value.reduce((s, r) => s + rowHeightOf(r, m.rowHeight()), 0);

  const scrollEl = {
    get clientHeight() {
      return m.clientHeight;
    },
    get scrollHeight() {
      return Math.max(m.clientHeight, total());
    },
    get scrollTop() {
      return m.scrollTop;
    },
    set scrollTop(v: number) {
      const max = Math.max(0, total() - m.clientHeight);
      m.scrollTop = Math.max(0, Math.min(v, max));
    },
    getBoundingClientRect: () => ({ top: 0, height: m.clientHeight }),
  } as unknown as HTMLDivElement;

  const contentEl = {
    get children() {
      return domRows.value.map((r, i) => {
        const docTop = domRows.value.slice(0, i).reduce((s, rr) => s + rowHeightOf(rr, m.rowHeight()), 0);
        const h = rowHeightOf(r, m.rowHeight());
        const rowId = r.kind !== "live" ? r.id : undefined;
        return {
          liveRow: r.kind === "live",
          dataset: rowId ? { rowId } : {},
          getBoundingClientRect: () => ({ top: docTop - m.scrollTop, height: h }),
        };
      });
    },
    getBoundingClientRect: () => ({ top: 0, height: m.clientHeight }),
    querySelectorAll: (sel: string) => {
      const kids = (contentEl as unknown as { children: Array<{ liveRow: boolean; dataset: { rowId?: string } }> }).children;
      if (sel === ".chat-row-live") return kids.filter((k) => k.liveRow);
      const idMatch = /^\[data-row-id="(.+)"\]$/.exec(sel);
      if (idMatch) return kids.filter((k) => k.dataset.rowId === idMatch[1]);
      return [];
    },
  } as unknown as HTMLDivElement;

  return { scrollEl, contentEl };
}

/** 标准现场：页 [0, pageEnd) loaded + live 段（共 n 条）。单会话（无 sid 切换），
 *  DOM 快照跟随 visibleRows。sid 逐测试自增：pageLedgers/stores 是模块级状态，
 *  共用 sid 会跨测试污染台账。 */
let sidSeq = 0;
function setup(opts?: { rows?: number; pageEnd?: number }) {
  const n = opts?.rows ?? 100;
  const pageEnd = opts?.pageEnd ?? 0;
  const sid0 = `s${++sidSeq}`;
  const list = ref(makeMessages(n));
  const sid = ref<string | null>(sid0);
  const { schedule, flush } = manualScheduler();
  if (pageEnd > 0) {
    const ledger = getOrCreateLedger(sid0);
    ledger.push({
      id: `pg0-${sid0}`,
      startOffset: 0,
      endOffset: pageEnd,
      count: pageEnd,
      bytes: pageEnd,
      loaded: true,
      restorable: true,
      heightPx: 0,
    });
  }
  const api = useChatScroll(() => list.value, () => sid.value, {
    scheduleFrame: schedule,
  });
  const rowHeight = ref(100);
  const m: GeoModel = {
    rowHeight: () => rowHeight.value,
    clientHeight: 817,
    scrollTop: 0,
  };
  // DOM 快照：单会话现场（无 sid 切换）——sync 跟随 visibleRows，测试确定性优先；
  // 跨会话的「pre-flush 读旧 DOM」语义由 useChatScroll.test.ts 的 fakeScrollEl 系列覆盖
  const domRows = ref<Row[]>([]);
  watch([() => api.visibleRows.value, sid], () => {
    domRows.value = [...api.visibleRows.value];
  }, { flush: "sync", immediate: true });
  const geo = makeGeometry(m, domRows);
  api.scrollEl.value = geo.scrollEl;
  api.contentEl.value = geo.contentEl;
  return { list, sid, flush, api, rowHeight, model: m };
}

describe("useChatScroll 几何仿真 v2（live 窗口化，单会话）", () => {
  it("收拢：liveskel 记账高撑住总高，滚动零跳变", async () => {
    // 页 [0,10) + live 90 条：切入即收拢（隐藏 50，估算 50×120=6000）
    const { flush, api } = setup({ rows: 100, pageEnd: 10 });
    await flush();
    // rows = [pg0(1000), liveskel(6000), 40 live(4000)] → 总高 11000
    expect(api.visibleRows.value.length).toBe(42);
    expect(api.scrollEl.value!.scrollHeight).toBe(11000);
  });

  it("展开尽头：liveskel 退役（hiddenCount 归零）", async () => {
    const { flush, api } = setup({ rows: 100, pageEnd: 10 });
    await flush();
    await api.expandLiveAnchored(); // 50 → 10
    await api.expandLiveAnchored(); // 10 → 0：退役
    await flush();
    expect(api.visibleRows.value.some((r) => r.kind === "liveskel")).toBe(false);
    // 全量可见：pg0 + 90 live
    expect(api.visibleRows.value.filter((r) => r.kind === "live").length).toBe(90);
  });

  it("钉底流式滑动：append 触发 DOM 实测滑动，挂载 live 行数恒 ≤ K", async () => {
    const { list, flush, api } = setup({ rows: 100 });
    await flush(); // rows = [liveskel(60), 40 live]：挂载 live = 40 = K
    expect(api.visibleRows.value.filter((r) => r.kind === "live").length).toBe(40);
    list.value = [
      ...list.value,
      { id: "m100", role: "assistant" as const, blocks: [{ type: "text" as const, text: "n" }], timestamp: 999 },
    ];
    await nextTick();
    await flush();
    // 新消息 +1 → 挂载 live 41 → 滑出头部 1 条（实测高 100 折入隐藏区）→ 恒 ≤ K
    expect(api.visibleRows.value.filter((r) => r.kind === "live").length).toBe(40);
    expect(api.visibleRows.value.filter((r) => r.kind === "liveskel").length).toBe(1);
    // 总高守恒：liveskel 记账高 +100（滑出行实测高；创建估算 60×120=7200 基础上）
    const lsRow = api.visibleRows.value.find((r) => r.kind === "liveskel");
    expect(lsRow && lsRow.kind === "liveskel" ? lsRow.heightPx : -1).toBe(7300);
  });

  it("liveSkeletonInBand：命中/不命中（纯函数）", () => {
    // rows = [page(1000), liveskel(500), live(1000)] → cum = [0, 1000, 1500, 2500]
    const rows: Row[] = [
      { kind: "page", id: "pg", pageIndex: 0, messages: makeMessages(10) },
      { kind: "liveskel", id: "ls", count: 5, heightPx: 500 },
      { kind: "live", id: "l1", message: makeMessages(1)[0] },
    ];
    const cum = [0, 1000, 1500, 2500];
    expect(liveSkeletonInBand(1200, 817, rows, cum, 1.5)).toBe(true); // 视口在带内
    expect(liveSkeletonInBand(3000, 817, rows, cum, 1.5)).toBe(false); // 视口远下方
    expect(liveSkeletonInBand(2800, 817, rows, cum, 1.5)).toBe(false); // 视口远上方（带下沿 1574 > liveskel 底 1500）
  });

  it("buildRows 夹紧：hiddenCount 超 liveSeg 时全藏且不越界（防御性语义）", () => {
    const rows = buildRows("sid-clamp", makeMessages(30), { hiddenCount: 999, hiddenPx: 999 });
    // hidden 夹到 liveSeg=30：liveskel 一条、无 live 行（内容已换的 stale 窗口防线）
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("liveskel");
    expect(rows[0].kind === "liveskel" ? rows[0].count : -1).toBe(30);
  });
});

// 【未实测·未验收】展开的 sh-delta 视口补偿（「内容不跳」像素级断言）与滑动
// hiddenPx 逐条累加精度：jsdom mock 的 domRows 时序（sync watcher 与
// mountedCount 提升的交错）无法忠实建模真实渲染管线，两用例反复给出不稳定值，
// 已移除——以真机验收（scripts/diag 采样器：瞬峰/落点/棘轮/冻结四指标）为准。