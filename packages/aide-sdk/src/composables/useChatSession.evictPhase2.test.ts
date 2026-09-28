import { beforeEach, describe, it, expect, vi } from "vitest";

/**
 * evict 阶段②：预算尺度不变量 + 它能做什么、不能做什么。
 *
 * 背景（2026-09-28 取证）：阶段② 曾把**预算**表达成 store 尺度
 * （`STORE_BYTES_THRESHOLD × 0.8` ≈ 25.6MB），却拿它去比**页**尺度的量
 * （`loadedPagesBytes`，由 recycle 维持在 ≤ RECYCLE_BYTES_BUDGET = 2MB）。
 * 2MB 永远不大于 25.6MB ⇒ `releaseFarthestPages` 的循环体一次都不进，恒返回 0
 * —— 一段永不生效的死代码。现预算改为 RECYCLE_BYTES_BUDGET（同尺度）。
 *
 * 本文件用**真实生产常量**（不 __setEvictThresholdsForTest 缩小阈值——缩小会破坏
 * 「store 阈值 vs 页上界」的比值本身，而那正是被钉的东西）。
 *
 * 同时钉住阶段②**做不到**的事：它压不回 live 段的字节（live 永不进页），所以
 * 全小块的会话超阈值后依然超阈值——这个洞是有意留着的结构问题，别被"有阶段②"
 * 误导成已解决。
 */

const spy = vi.hoisted(() => ({ calls: [] as Array<{ budget: number; released: number }> }));

vi.mock("./useChatSession/recycle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./useChatSession/recycle")>();
  return {
    ...actual,
    // 只记录「阶段② 传了什么预算、放出几页」，行为原样转发
    releaseFarthestPages: (...args: Parameters<typeof actual.releaseFarthestPages>) => {
      const released = actual.releaseFarthestPages(...args);
      spy.calls.push({ budget: args[1].budget, released });
      return released;
    },
  };
});

import { maybeEvict } from "./useChatSession/evict";
import {
  loadedPagesBytes,
  releaseFarthestPages,
  RECYCLE_BYTES_BUDGET,
} from "./useChatSession/recycle";
import { getOrCreateLedger, getStore, type PageEntry } from "./useChatSession/state";
import { computeStoreBytes } from "../utils/messageBytes";
import type { ChatMessage } from "../types/chat";

/** 与 pagination 的页预算同量级（HYDRATE_PAGE_BYTES / DEFAULT_PAGE_BYTES）。 */
const PAGE_BYTES = 256 * 1024;
/** stage 阈值来自 evict.ts 的 STORE_BYTES_THRESHOLD（未导出，这里按事实写死并断言）。 */
const STORE_THRESHOLD = 32 * 1024 * 1024;
/** 块阈值 16384：块字节必须 ≤ 它才落进"阶段① 够不着"的洞。 */
const NON_DEGRADABLE_CHARS = 8100; // 16200 字节 < 16384

function makePage(id: string): PageEntry {
  return {
    id,
    startOffset: 0,
    endOffset: PAGE_BYTES,
    count: 10,
    bytes: PAGE_BYTES,
    loaded: true,
    restorable: true,
    heightPx: 0,
  };
}

/** 装满 loaded 页的台账（返回页数），用于让 loadedPagesBytes 到达给定量级。 */
function seedLedger(sid: string, pages: number): void {
  getStore(sid); // releasePage 需要 stores[sid] 存在
  const ledger = getOrCreateLedger(sid);
  for (let i = 0; i < pages; i++) ledger.push(makePage(`${sid}-p${i}`));
}

/** 造 n 条「每条只有一个不可降级小块」的消息——阶段① 对它们一个都降不了。
 *  text 复用同一字符串引用：记账累加的是 length，共用引用让用例内存/耗时可控，
 *  而驱动分支的正是记账值（computeStoreBytes）。 */
function fillSmallBlocks(sid: string, n: number): void {
  const store = getStore(sid);
  const text = "x".repeat(NON_DEGRADABLE_CHARS);
  const msgs: ChatMessage[] = Array.from({ length: n }, (_, i) => ({
    id: `${sid}-m${i}`,
    role: "assistant",
    blocks: [{ type: "text", text }],
    timestamp: 0,
  }));
  store.messages.push(...msgs);
}

describe("evict 阶段② 取证：预算尺度错位导致恒不触发", () => {
  beforeEach(() => {
    spy.calls.length = 0; // 同文件内跨用例共用，逐条清
  });

  it("控制组：同一个函数、给 recycle 的预算（2MB）时，页超上界就会被释放", () => {
    const sid = "ctl-release";
    seedLedger(sid, 10); // 2.5MB > 2MB 上界
    expect(loadedPagesBytes(sid)).toBeGreaterThan(RECYCLE_BYTES_BUDGET);

    const released = releaseFarthestPages(sid, { budget: RECYCLE_BYTES_BUDGET });

    // 函数与台账构造都没问题——释放机制本身是好的
    expect(released).toBeGreaterThan(0);
  });

  it("控制组：超阈值但有大 block 时，阶段① 就够用，阶段② 根本不进（两阶段的分工）", () => {
    const sid = "ctl-bigblock";
    const store = getStore(sid);
    const big = "z".repeat(1_000_000); // 2MB 记账 > 16KB ⇒ 可降级
    for (let i = 0; i < 40; i++) {
      store.messages.push({
        id: `${sid}-big${i}`,
        role: "assistant",
        blocks: [{ type: "text", text: big }],
        timestamp: 0,
      });
    }
    expect(computeStoreBytes(store)).toBeGreaterThan(STORE_THRESHOLD);

    maybeEvict(sid, store);

    const truncated = store.messages.flatMap((m) => m.blocks).filter((b) => "truncated" in b && b.truncated);
    expect(truncated.length).toBeGreaterThan(0); // 阶段① 真降级了
    expect(spy.calls).toHaveLength(0); // 降够阈值 ⇒ 阶段② 未触发
  });

  it("页超上界（无滚动事件因而没人压）时，阶段② 会把它压回上界", () => {
    const sid = "trim";
    seedLedger(sid, 10); // 2.5MB > 2MB 上界
    fillSmallBlocks(sid, 2200); // 2200 × 16200B ≈ 35.6MB（阶段① 一个都降不了）
    const store = getStore(sid);
    expect(computeStoreBytes(store)).toBeGreaterThan(STORE_THRESHOLD); // 前置条件
    expect(loadedPagesBytes(sid)).toBeGreaterThan(RECYCLE_BYTES_BUDGET);

    maybeEvict(sid, store);

    expect(spy.calls).toHaveLength(1);
    const { budget, released } = spy.calls[0];

    // ← 不变量：喂给页尺度释放的预算不许超过页上界
    //   （回归到 storeBytes 派生值就会立刻挂在这条上）
    expect(budget).toBeLessThanOrEqual(RECYCLE_BYTES_BUDGET);
    // ← 真放了页，不再是死代码
    expect(released).toBeGreaterThan(0);
  });

  it("但阶段② 解不了「小 block 洞」：页压回上界后 store 依然超阈值（live 段够不到）", () => {
    const sid = "hole";
    seedLedger(sid, 10);
    fillSmallBlocks(sid, 2200);
    const store = getStore(sid);

    maybeEvict(sid, store);

    // 页那一刀确实落了（上一条已钉），但相对 32MB 只是零头：
    // live 段的消息永不进页 ⇒ 没有字节出口。这个缺口是有意留着的（见 evict.ts 文件头）。
    expect(spy.calls[0].released).toBeGreaterThan(0);
    expect(loadedPagesBytes(sid)).toBeLessThanOrEqual(RECYCLE_BYTES_BUDGET);
    expect(computeStoreBytes(store)).toBeGreaterThan(STORE_THRESHOLD);
  });
});
