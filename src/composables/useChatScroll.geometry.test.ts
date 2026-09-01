import { describe, it, expect, vi } from "vitest";
import { nextTick, ref, type Ref } from "vue";

// 与 useChatScroll.test.ts 同一套 Tauri mock：recycle 兼容壳 → @aide/sdk 的
// import 链上有 tauri api，node 环境必须 mock 掉。
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { useChatScroll } from "./useChatScroll";
import type { ChatMessage } from "@/types/chat";

/**
 * 几何仿真：切回会话滚动位置的记忆与恢复（根因 + 修复验证）。
 *
 * 根因（2026-09-01 定位）：位置记忆曾是纯像素度量（distBottom）。长会话切走后，
 * 后台事件仍会触发 maybeEvict（events.ts:644，store>32MB）：①从最早消息降级
 * >16KB 大 block 为摘要（已渲染内容变矮）②释放热区外页成估算骨架——收缩集中
 * 在视口上方/下方改写总高 → 切回落点 = H_new - distBottom 系统性偏上，并被
 * 正反馈锁定（「每次切回固定在上方某一处」）。
 *
 * 修复：位置记忆升级为内容锚点（视口顶所在行 id + 行内偏移，见
 * useChatScroll.ts 的 ScrollMemory.anchor）。行身份跨降级/释放/取回稳定，
 * 落点对齐离开时刻看的内容行；live 段行无 data-row-id → 回退 distBottom。
 *
 * 仿真容器：scrollHeight = 全表行数 × 行高（行高可变 = 模拟 evict 收缩）、
 * scrollTop 写入带浏览器钳位语义；contentEl.children = 尾部窗口行（挂载 ramp
 * 逐帧增长），每行提供视口系 rect 与可选 data-row-id（withRowIds=false 模拟
 * live 行无 id 的兜底路径）。
 */

function makeMessages(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
    blocks: [{ type: "text", text: `msg ${i}` }],
    timestamp: i,
  }));
}

/** 手动调度器（同 useChatScroll.test.ts）：cb 入队等 flush。 */
function manualScheduler() {
  const queue: Array<() => void> = [];
  const schedule = (cb: () => void) => {
    queue.push(cb);
    return () => {
      const i = queue.indexOf(cb);
      if (i >= 0) queue.splice(i, 1);
    };
  };
  const flush = () => {
    while (queue.length > 0) queue.shift()!();
  };
  return { schedule, flush };
}

interface GeometryModel {
  totalRows: () => number;
  mountedRows: () => number;
  rowHeight: () => number;
  clientHeight: number;
  withRowIds: boolean;
  scrollTop: number;
}

/** 全表第 idx 行的文档位置（均匀行高模型）。 */
function rowDocTop(m: GeometryModel, idx: number): number {
  return idx * m.rowHeight();
}

function makeGeometry(m: GeometryModel) {
  const scrollEl = {
    get clientHeight() {
      return m.clientHeight;
    },
    get scrollHeight() {
      return Math.max(m.clientHeight, m.totalRows() * m.rowHeight());
    },
    get scrollTop() {
      return m.scrollTop;
    },
    set scrollTop(v: number) {
      const max = Math.max(0, this.scrollHeight - m.clientHeight);
      m.scrollTop = Math.max(0, Math.min(v, max));
    },
    // 视口系原点：容器 rect.top = 0
    getBoundingClientRect: () => ({ top: 0, height: m.clientHeight }),
  } as unknown as HTMLDivElement;

  const contentEl = {
    get children() {
      const mounted = m.mountedRows();
      const total = m.totalRows();
      const winStart = total - mounted;
      const arr: Array<Record<string, unknown>> = [];
      for (let i = 0; i < mounted; i++) {
        const fullIdx = winStart + i;
        const docTop = rowDocTop(m, fullIdx);
        arr.push({
          dataset: m.withRowIds ? { rowId: `m${fullIdx}` } : {},
          // 视口系 rect：文档位置 - 当前 scrollTop
          getBoundingClientRect: () => ({ top: docTop - m.scrollTop, height: m.rowHeight() }),
        });
      }
      return arr;
    },
  } as unknown as HTMLDivElement;

  return { scrollEl, contentEl };
}

/** 标准测试现场：N 行会话（行 id m0..mN-1），clientHeight 817，manualScheduler。 */
function setup(opts?: { rows?: number; withRowIds?: boolean }) {
  const n = opts?.rows ?? 100;
  const list = ref(makeMessages(n));
  const sid = ref<string | null>("s1");
  const { schedule, flush } = manualScheduler();
  const api = useChatScroll(() => list.value, () => sid.value, { scheduleFrame: schedule });
  const rowHeight = ref(100);
  const m: GeometryModel = {
    totalRows: () => n,
    mountedRows: () => api.visibleRows.value.length,
    rowHeight: () => rowHeight.value,
    clientHeight: 817,
    withRowIds: opts?.withRowIds ?? true,
    scrollTop: 0,
  };
  const geo = makeGeometry(m);
  api.scrollEl.value = geo.scrollEl;
  api.contentEl.value = geo.contentEl;
  return { list, sid, flush, api, rowHeight, model: m };
}

describe("useChatScroll 几何仿真：切回位置记忆（锚点修复）", () => {
  it("修复主断言：后台 evict 收缩后切回，落点对齐锚行新位置（内容不跳）", async () => {
    const { sid, flush, api, rowHeight } = setup();
    flush(); // 首开钉底 ramp 挂满：top = 10000-817
    // 用户上滚到 5000 = 第 50 行顶（锚行 m50，行内偏移 0）
    api.scrollEl.value!.scrollTop = 5000;
    sid.value = "s2"; // 切走：记录 { top:5000, distBottom:5000, anchor:m50+0 }
    await nextTick();
    // 后台 maybeEvict：大 block 降级 → 内容变矮（10000 → 7000，收缩 3000）
    rowHeight.value = 70;
    sid.value = "s1"; // 切回：锚行优先落位
    await nextTick();
    flush();
    // 锚行 m50 的新位置 = 50×70 = 3500：视口顶对齐离开时看的内容行。
    // （修复前 distBottom 公式落 7000-5000=2000，偏上整整 1500px = 下方收缩量）
    expect(api.scrollEl.value!.scrollTop).toBe(3500);
  });

  it("对照组：高度不变时精确恢复原像素位置", async () => {
    const { sid, flush, api } = setup();
    flush();
    api.scrollEl.value!.scrollTop = 5000;
    sid.value = "s2";
    await nextTick();
    sid.value = "s1";
    await nextTick();
    flush();
    expect(api.scrollEl.value!.scrollTop).toBe(5000);
  });

  it("兼容回退：锚行无 data-row-id（live 段行）时走 distBottom 兜底（现状行为保持）", async () => {
    const { sid, flush, api, rowHeight } = setup({ withRowIds: false });
    flush();
    api.scrollEl.value!.scrollTop = 5000;
    sid.value = "s2";
    await nextTick();
    rowHeight.value = 70;
    sid.value = "s1";
    await nextTick();
    flush();
    // 无锚可依：distBottom 公式 7000-5000=2000（live 段场景后台收缩小，失真有限）
    expect(api.scrollEl.value!.scrollTop).toBe(2000);
  });

  it("正反馈锁定消失：收缩后反复切换，落点稳定在锚行（不再逐轮漂移）", async () => {
    const { sid, flush, api, rowHeight } = setup();
    flush();
    api.scrollEl.value!.scrollTop = 5000;
    sid.value = "s2";
    await nextTick();
    rowHeight.value = 70;
    sid.value = "s1";
    await nextTick();
    flush();
    expect(api.scrollEl.value!.scrollTop).toBe(3500); // 对齐锚行 m50
    // 用户不动，再切走（此时记忆的是锚 m50 而非偏上的像素位置）再切回
    sid.value = "s2";
    await nextTick();
    sid.value = "s1";
    await nextTick();
    flush();
    expect(api.scrollEl.value!.scrollTop).toBe(3500); // 稳定，不再锁定漂移位置
  });

  it("渐进收缩：后台持续降级，落点逐轮跟随锚行新位置（内容始终对齐）", async () => {
    const { sid, flush, api, rowHeight } = setup();
    flush();
    api.scrollEl.value!.scrollTop = 5000;
    sid.value = "s2";
    await nextTick();
    rowHeight.value = 70; // 7000px：锚行新位置 3500
    sid.value = "s1";
    await nextTick();
    flush();
    expect(api.scrollEl.value!.scrollTop).toBe(3500);
    sid.value = "s2";
    await nextTick();
    rowHeight.value = 55; // 5500px：锚行新位置 2750
    sid.value = "s1";
    await nextTick();
    flush();
    expect(api.scrollEl.value!.scrollTop).toBe(2750);
    sid.value = "s2";
    await nextTick();
    rowHeight.value = 40; // 4000px：锚行新位置 2000（修复前会漂到 500/钳底）
    sid.value = "s1";
    await nextTick();
    flush();
    expect(api.scrollEl.value!.scrollTop).toBe(2000);
  });

  it("方向对照：贴底离开 + 后台 live 增长 → 仍贴底恢复（兜底路径不回归）", async () => {
    const { sid, flush, api, list, model } = setup({ withRowIds: false });
    flush();
    api.scrollEl.value!.scrollTop = 10000; // 贴底（视口顶行 = 尾部 live 行，无 id）
    expect(api.scrollEl.value!.scrollTop).toBe(10000 - 817);
    sid.value = "s2";
    await nextTick();
    // 后台流式增长 +30 条：仿真模型总数同步
    const grown = [...list.value, ...makeMessages(30).map((mm, i) => ({ ...mm, id: `live${i}` }))];
    list.value = grown;
    model.totalRows = () => 130;
    sid.value = "s1";
    await nextTick();
    flush();
    expect(api.scrollEl.value!.scrollTop).toBe(13000 - 817); // 贴新底
  });

  it("锚行中途偏移：视口顶落在行内非顶处，行内偏移参与落位", async () => {
    const { sid, flush, api, rowHeight } = setup();
    flush();
    api.scrollEl.value!.scrollTop = 5050; // m50 行内 50px 处（锚 m50，offset 50）
    sid.value = "s2";
    await nextTick();
    rowHeight.value = 70;
    sid.value = "s1";
    await nextTick();
    flush();
    // 锚行 m50 新顶 50×70=3500 + 行内偏移 50 = 3550（视口顶对齐离开时刻的精确内容位置）
    expect(api.scrollEl.value!.scrollTop).toBe(3550);
  });
});
