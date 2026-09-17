import { describe, it, expect, vi } from "vitest";
import { nextTick, ref } from "vue";
import type { Ref } from "vue";

// 页级回收测试要碰 pageLedgers/stores（state.ts 模块级 identity 会 listen）——
// 与 useChatSession 系列测试同一套 Tauri mock。
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { useChatScroll } from "./useChatScroll";
import { getOrCreateLedger } from "./useChatSession/state";
import type { ChatMessage } from "@/types/chat";

function makeMessages(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
    blocks: [{ type: "text", text: `msg ${i}` }],
    timestamp: i,
  }));
}

/** 同步调度器：scheduleFrame 立即执行 cb（钉底/落位在 setup 内一气跑完），cancel 为空操作。 */
function syncScheduler() {
  const schedule = (cb: () => void) => {
    cb();
    return () => {};
  };
  return { schedule };
}

/** 手动调度器：cb 入队等 flush / step，cancel 计数 + 从队列移除。用于测在途落位被取消、
 *  以及「双帧落位」两帧之间的中途扰动。 */
function manualScheduler() {
  const queue: Array<() => void> = [];
  let cancelCount = 0;
  const schedule = (cb: () => void) => {
    queue.push(cb);
    return () => {
      cancelCount += 1;
      const i = queue.indexOf(cb);
      if (i >= 0) queue.splice(i, 1);
    };
  };
  const flush = () => {
    while (queue.length > 0) queue.shift()!();
  };
  /** 只跑一帧（落位两帧之间插入扰动）。空队列即前置条件不成立——显式抛错，别静默跳过。 */
  const step = () => {
    const cb = queue.shift();
    if (!cb) throw new Error("测试前置失败：帧队列为空（本应有一帧在途）");
    cb();
  };
  return { schedule, flush, step, cancelCount: () => cancelCount };
}

/** 极简滚动元素桩：只够 onScroll / expandOlderAnchored 读写 scrollTop/scrollHeight/clientHeight。 */
function fakeScrollEl(opts: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
  return opts as unknown as HTMLDivElement;
}

describe("useChatScroll", () => {
  it("P1 异步取回更早页后锚定：unshift 后全量可见、视觉位置保持", async () => {
    const list = ref(makeMessages(100));
    // 独立 sid：本用例会写 pageLedgers（模块级），避免污染同文件其他 "s1" 用例
    const sid = ref<string | null>("s-p1");
    // manualScheduler：unshift 触发 onNewContent 的置底只入队不执行，
    // 否则 syncScheduler 会把 scrollTop 钉到 scrollHeight、误触「加载期间用户滚动」
    // 放弃补偿（真实浏览器里 rAF 异步 + 上滚时 autoScroll=false 置底 no-op，无此问题）
    const { schedule } = manualScheduler();
    const { scrollEl, expandOlderAnchored, rows } = useChatScroll(
      () => list.value,
      () => sid.value,
      {
        scheduleFrame: schedule,
        pagination: fakePagination({
          hasMore: () => true,
          loadOlder: async () => {
            // 生产语义（pagination.ts loadOlderPage）：unshift 的同时必建台账页
            list.value.unshift(...makeMessages(30));
            getOrCreateLedger("s-p1").unshift({
              id: "pg-older", startOffset: 0, endOffset: 30, count: 30, bytes: 30,
              loaded: true, restorable: true, heightPx: 0,
            });
            return 30;
          },
        }),
      },
    );
    scrollEl.value = fakeScrollEl({ scrollTop: 100, scrollHeight: 2000, clientHeight: 500 });
    await expandOlderAnchored();
    // live 窗口化（2026-09-07）：100 条会话在切入时收拢（隐藏 60）；loadOlder 建
    // 台账页（prepend 只移 liveStart，窗口锚定内容不动）→ 行模型 = pg(30) + liveskel(60)
    // + 40 尾窗 = 42：新加载的页可见、旧隐藏前缀内容不变
    // （一次性挂载下 rows 就是行模型的全部——取回后的新页不需要「挂载到顶」这一步）
    expect(rows.value.length).toBe(42);
    expect(scrollEl.value.scrollTop).toBe(100);
  });

  it("切入一次性挂载：rows 同一个 tick 内就是窗口全量（41 = liveskel + 40 尾窗）", () => {
    const list = ref(makeMessages(100));
    const sid = ref<string | null>("s1");
    const { schedule } = syncScheduler();
    const { rows, landing } = useChatScroll(
      () => list.value,
      () => sid.value,
      { scheduleFrame: schedule },
    );
    // 旧模型：首帧只挂 6 行、逐帧递增到全量（ramping 期间是「挂载在途」）。
    // 拆 ramp 后 rows 是「窗口的函数」——setup 返回时（没有任何 await/flush）就已经
    // 是全量，没有「跑到一半」的中间态：挂载量不再由帧循环决定。
    // live 窗口化：切入即收拢（隐藏 60）→ rows = liveskel + 40 尾窗 = 41
    expect(rows.value.length).toBe(41);
    // 原 `ramping 收尾 false` 的替代：底部分支（首开无记忆）走 scrollToBottom 通道，
    // 不进入双帧落位——landing 全程 false（锚定路径的 landing true→false 见切回系列用例）
    expect(landing.value).toBe(false);
  });

  it("短会话（8 条）：一次性全量挂载；未超窗不收拢，也没有落位残留", () => {
    const list = ref(makeMessages(8));
    const sid = ref<string | null>("s1");
    const { schedule } = syncScheduler();
    const { rows, landing } = useChatScroll(
      () => list.value,
      () => sid.value,
      { scheduleFrame: schedule },
    );
    // 8 ≤ LIVE_TAIL_ROWS(40)：收拢窗口不成立 → 8 条全挂。
    // 原「ramp 到全可见即停，不无限循环」测的是帧循环的收敛性——帧循环已不存在，
    // 这条断言改为锁定「不建窗口、行数=消息数」这个一次性挂载的终态。
    expect(rows.value.length).toBe(8);
    expect(rows.value.some((r) => r.kind === "liveskel")).toBe(false);
    expect(landing.value).toBe(false);
  });

  it("空会话不落位；hydrate（messages 0→N）后一次性挂载窗口全量 + 钉底", async () => {
    const list = ref<ChatMessage[]>([]);
    const sid = ref<string | null>("s1");
    const { schedule } = syncScheduler();
    const { scrollEl, rows, landing } = useChatScroll(
      () => list.value,
      () => sid.value,
      { scheduleFrame: schedule },
    );
    expect(rows.value.length).toBe(0);
    expect(landing.value).toBe(false);
    // 切进来时容器已在（真实组件里 scrollEl 由模板 ref 提供）——hydrate 后那次钉底
    // 写入要落在真实元素上，才谈得上「位置正确」
    scrollEl.value = fakeScrollEl({ scrollTop: 0, scrollHeight: 1817, clientHeight: 817 });
    // hydrate：整份历史一次性灌入
    list.value = makeMessages(50);
    await nextTick(); // pre-flush length watcher 消费 landPending
    // live 窗口化：灌入后 liveSeg 50 > K → 收拢（隐藏 10）→ rows = liveskel + 40 尾窗
    expect(rows.value.length).toBe(41);
    // 挂起的落点策略：无位置记忆 → 钉底跟随（pin 为 null 时走 scrollToBottom，
    // 不进入双帧落位——所以 landing 不会被置起）
    expect(scrollEl.value!.scrollTop).toBe(1817);
    expect(landing.value).toBe(false);
  });

  it("快速连切会话：前一个在途落位被取消（cancel 被调 + landing 收尾 false）", async () => {
    const list = ref(makeMessages(100));
    const sid = ref<string | null>("s1");
    const { schedule, flush, cancelCount } = manualScheduler();
    const { scrollEl, rows, landing } = useChatScroll(
      () => list.value,
      () => sid.value,
      { scheduleFrame: schedule },
    );
    flush(); // 首开的钉底帧先跑掉（它一直挂着 scrollQueued，会把后续钉底全部吞掉）
    // 让 s1 留下位置记忆（切走那一刻读旧 DOM 现场）
    scrollEl.value = fakeScrollEl({ scrollTop: 500, scrollHeight: 1817, clientHeight: 817 });
    sid.value = "s2";
    await nextTick();
    flush(); // s2 首开钉底
    // 切回 s1：一次性挂载 + 双帧落位（两帧都排在队里，未 flush）
    sid.value = "s1";
    await nextTick();
    expect(landing.value).toBe(true); // 落位在途
    expect(rows.value.length).toBe(41); // 挂载不分片：切回瞬间就是窗口全量
    // 赶紧切到 s3：在途落位必须被取消——否则那两帧会醒来把 scrollTop 写回 s1 的锚位，
    // 在新会话上落一个别人的位置（原 cancelRamp 的同一保护，换到 landing 上）
    sid.value = "s3";
    await nextTick();
    expect(cancelCount()).toBeGreaterThanOrEqual(1);
    expect(landing.value).toBe(false);
    // s1 的落位两帧已在上一步被 cancel 出队；此刻队里只剩 s3 自己的钉底帧
    // （无记忆 → bottom 通道）——跑完它 landing 仍应为 false（落位没有被复活）
    flush();
    expect(landing.value).toBe(false);
  });

  it("hero（sessionId=null）：不落位、不建 live 窗口", async () => {
    const list = ref<ChatMessage[]>([]);
    const sid = ref<string | null>(null);
    const { schedule } = syncScheduler();
    const { rows, landing } = useChatScroll(
      () => list.value,
      () => sid.value,
      { scheduleFrame: schedule },
    );
    expect(rows.value.length).toBe(0);
    expect(landing.value).toBe(false);
    // 即便后续 messages 到了，sid 仍为 null：landPending 未被置位 → 不落位；
    // 窗口按 sid 存（slideLiveWindowToTail 在 !newId 时已 return）→ 也不建窗口
    list.value = makeMessages(50);
    await nextTick();
    expect(landing.value).toBe(false);
    expect(rows.value.filter((r) => r.kind === "liveskel").length).toBe(0);
  });

  it("用户上滚（onScroll 上滚分支）：接管——脱离跟随；挂载量不再是可变的量", async () => {
    const list = ref(makeMessages(100));
    const sid = ref<string | null>("s1");
    const { schedule } = manualScheduler();
    const { scrollEl, rows, landing, onScroll, newWhileAway } = useChatScroll(
      () => list.value,
      () => sid.value,
      { scheduleFrame: schedule },
    );
    // 首开无记忆：走钉底跟随（scrollToBottom）——落位状态从未被置起。
    // 旧模型这里是 ramp 在途（ramping=true）等用户上滚取消；新模型底部分支没有
    // 「在途挂载」可取消（在途落位被接管取消的断言见「快速连切」用例）。
    expect(landing.value).toBe(false);
    // 基线：第一次 onScroll 只建立 prevScrollTop（-1 初值不判上滚）
    scrollEl.value = fakeScrollEl({ scrollTop: 900, scrollHeight: 1817, clientHeight: 817 });
    onScroll();
    expect(landing.value).toBe(false);
    // 用户上滚 900→700：接管通道 userTookScroll = landCancel（此刻无在途帧，状态不变）
    // + autoScroll=false。跟随态没有对外 ref，用两个可观测后果断言：
    scrollEl.value = fakeScrollEl({ scrollTop: 700, scrollHeight: 1817, clientHeight: 817 });
    onScroll();
    // ① 挂载量与接管无关：rows 还是窗口全量（旧模型「接管 = 数据全量挂载、
    //    防中间段缺失」这件事本身消失了——行集只由窗口/预算决定）
    expect(rows.value.length).toBe(41);
    // ② 跟随真的脱开了：离开期间来新消息只点亮「回到底部」小点，不把视口拖回底部
    pushMessage(list);
    await nextTick();
    expect(newWhileAway.value).toBe(true);
    expect(scrollEl.value!.scrollTop).toBe(700);
  });

  it("切走再切回：一次性挂载 + 双帧落位，收尾后恢复离开时的滚动位置（不钉底）", async () => {
    const list = ref(makeMessages(100));
    const sid = ref<string | null>("s1");
    const { schedule, flush } = manualScheduler();
    const { scrollEl, rows, landing } = useChatScroll(
      () => list.value,
      () => sid.value,
      { scheduleFrame: schedule },
    );
    flush(); // 首开钉底帧先跑掉（清掉 scrollQueued，否则后续钉底全部早退）
    // s1 滚动到中间位置（用户离开现场）
    scrollEl.value = fakeScrollEl({ scrollTop: 500, scrollHeight: 1817, clientHeight: 817 });
    // 切走（真实用户操作有间隔，watch 分两批触发）：记录 s1 位置（top=500, distBottom=1317）
    sid.value = "s2";
    await nextTick();
    flush(); // s2 首开钉底：底部分支统一走 scrollToBottom 的 rAF（原同步写已收敛进这条通道）
    expect(scrollEl.value!.scrollTop).toBe(1817);
    // 切回：一次性挂载——行集只由窗口决定，不再有「首帧只挂 6 行」的分片
    sid.value = "s1";
    await nextTick();
    // live 窗口化：liveskel（隐藏 60 的唯一高度代表）+ 40 尾窗，切入瞬间就全在
    expect(rows.value.length).toBe(41);
    expect(landing.value).toBe(true); // 双帧落位在途
    // anchor 落位不写旧 DOM（2026-09-01 修复）：watch pre-flush 时 DOM 还是 s2 的，
    // 写入既无意义又会把接管基线锚到旧值——切回瞬间 scrollTop 保持残留（1817），
    // 落位交给 rAF 首帧（新 DOM）
    expect(scrollEl.value!.scrollTop).toBe(1817);
    flush(); // 双帧落位：两次 landAnchored 复量复落
    expect(scrollEl.value!.scrollTop).toBe(500); // 恢复离开时的位置，而不是被拖回底部
    expect(landing.value).toBe(false);
  });

  it("落位期间 onScroll 回波不被当成「用户上滚」：落位不被取消（防落点自毁）", async () => {
    const list = ref(makeMessages(100));
    const sid = ref<string | null>("s1");
    const { schedule, flush } = manualScheduler();
    const { scrollEl, landing, onScroll } = useChatScroll(
      () => list.value,
      () => sid.value,
      { scheduleFrame: schedule },
    );
    flush();
    scrollEl.value = fakeScrollEl({ scrollTop: 500, scrollHeight: 1817, clientHeight: 817 });
    sid.value = "s2";
    await nextTick();
    flush(); // s2 钉底 → 1817
    sid.value = "s1"; // 切回：双帧落位（在队未跑）
    await nextTick();
    // 基线：第一次 onScroll 只建立 prevScrollTop
    onScroll();
    // 模拟落位写入造成的 scrollTop 回落（钳底 → 锚点落位的过程形态）：落位期间不能被
    // 当成用户上滚接管——否则 landCancel 会把两帧作废，刚落好的视口又被打回残留位置
    // （旧模型同一保护还兼着「防 ramp 自毁成全量挂载」，全量挂载这件事本身已不存在）
    scrollEl.value = fakeScrollEl({ scrollTop: 300, scrollHeight: 1817, clientHeight: 817 });
    onScroll();
    expect(landing.value).toBe(true); // 落位未被取消
    flush();
    // 双帧照常把视口落到锚位：回波只被忽略、不被采纳（若被误判成接管，
    // 两帧已作废，scrollTop 会停在 300）
    expect(scrollEl.value!.scrollTop).toBe(500);
    expect(landing.value).toBe(false);
  });

  it("落位两帧之间 scrollTop 被第三方移走：第二帧复量复落（落点仍到锚位）", async () => {
    const list = ref(makeMessages(100));
    const sid = ref<string | null>("s1");
    const { schedule, flush, step } = manualScheduler();
    const { scrollEl, rows, landing } = useChatScroll(
      () => list.value,
      () => sid.value,
      { scheduleFrame: schedule },
    );
    flush();
    scrollEl.value = fakeScrollEl({ scrollTop: 500, scrollHeight: 1817, clientHeight: 817 });
    sid.value = "s2";
    await nextTick();
    flush();
    sid.value = "s1"; // 切回：双帧落位（两帧都在队里）
    await nextTick();
    expect(landing.value).toBe(true);
    step(); // 只跑第一帧
    expect(scrollEl.value!.scrollTop).toBe(500);
    // 第三方（滚条拖动 / 别的程序化写入）在两帧之间把 scrollTop 移走：
    // 旧模型按「落点偏差 > 4px」判定用户接管、取消 ramp 全量挂载（RAMP_ANCHOR_TOLERANCE_PX
    // 已随 ramp 一起删除）；新模型第二帧无条件复量复落——落点以锚位为准，中途扰动
    // 不带偏最终位置。用户接管的独立通道仍在：onWheel / jumpToBottom（直调 landCancel）
    // 与落位不在途时的 onScroll 上滚分支。
    scrollEl.value!.scrollTop = 100;
    flush(); // 第二帧
    expect(scrollEl.value!.scrollTop).toBe(500);
    expect(landing.value).toBe(false); // 落位正常收尾
    expect(rows.value.length).toBe(41); // 行集不受落位过程影响（无「取消 → 全量」分支）
  });

  it("切回（messages 未就绪）：hydrate 到齐后按锚定策略落位（双帧），位置=离底距离锚定", async () => {
    const list = ref(makeMessages(100));
    const sid = ref<string | null>("s1");
    const { schedule, flush } = manualScheduler();
    const { scrollEl, rows, landing } = useChatScroll(
      () => list.value,
      () => sid.value,
      { scheduleFrame: schedule },
    );
    flush();
    scrollEl.value = fakeScrollEl({ scrollTop: 500, scrollHeight: 1817, clientHeight: 817 });
    sid.value = "s2"; // 先建立 s1 的位置记忆
    await nextTick();
    flush(); // s2 钉底 → 1817
    // 模拟「切回时会话消息清空（重开/hydrate 未完）」：切回时走 landPending 挂起，
    // 落点策略应为 anchor（不再 hydrate 后钉底把位置冲掉）
    list.value = [];
    sid.value = "s1";
    await nextTick();
    expect(landing.value).toBe(false); // messages 空：落位挂起未启动
    list.value = makeMessages(100); // hydrate 到齐（0→N）
    await nextTick(); // length watcher 触发锚定落位（两帧入队）
    expect(landing.value).toBe(true);
    // anchor 落位不写旧 DOM（2026-09-01 修复）：落位在 rAF 首帧（新 DOM）
    expect(scrollEl.value!.scrollTop).toBe(1817); // 切回瞬间保持残留（s2 钉底值）
    flush();
    expect(scrollEl.value!.scrollTop).toBe(500); // 首帧按 distBottom 锚定
    // live 窗口化：hydrate 到齐后补收拢（隐藏 60）→ rows = liveskel + 40 尾窗
    expect(rows.value.length).toBe(41);
    expect(landing.value).toBe(false);
  });

  it("首次打开（无位置记忆）：钉底跟随；不进入落位状态（无锚可落）", () => {
    const list = ref(makeMessages(100));
    const sid = ref<string | null>("s1");
    const { schedule, flush } = manualScheduler();
    const { scrollEl, rows, landing } = useChatScroll(
      () => list.value,
      () => sid.value,
      { scheduleFrame: schedule },
    );
    // 无记忆 → 钉底跟随：底部分支走 scrollToBottom 的 rAF 节流通道，不进入双帧落位
    // （原底部分支的同步写与分帧挂载都已收敛掉）——landing 全程 false
    expect(landing.value).toBe(false);
    scrollEl.value = fakeScrollEl({ scrollTop: 0, scrollHeight: 1817, clientHeight: 817 });
    flush(); // 钉底帧落地：写 scrollHeight
    expect(scrollEl.value!.scrollTop).toBe(1817);
    // 一次性挂载：不等任何帧，rows 在 setup 返回时就是窗口全量（41 = liveskel + 40 尾窗）
    expect(rows.value.length).toBe(41);
    expect(landing.value).toBe(false);
  });

  it("落位期间 expandOlderAnchored 被 landing 门拦住；落位结束后可触发", async () => {
    const list = ref(makeMessages(100));
    const sid = ref<string | null>("s1");
    const loadOlder = vi.fn(async () => 0);
    const { schedule, flush } = manualScheduler();
    const { scrollEl, landing, expandOlderAnchored } = useChatScroll(
      () => list.value,
      () => sid.value,
      {
        scheduleFrame: schedule,
        // 必须带 pagination：expandOlderAnchored 首行 hasMore() 早退就摸不到 landing 门
        pagination: fakePagination({ hasMore: () => true, loadOlder }),
      },
    );
    flush();
    scrollEl.value = fakeScrollEl({ scrollTop: 500, scrollHeight: 1817, clientHeight: 817 });
    sid.value = "s2";
    await nextTick();
    flush();
    sid.value = "s1"; // 切回：一次性挂载 + 双帧落位（在队未跑）
    await nextTick();
    expect(landing.value).toBe(true);
    // 落位两帧内不许结构性操作：取回会 splice messages，落位中途行模型一变，
    // 锚定/窗口全失真（旧模型这里是「用户接管 → cancelRamp → 全量挂载」，
    // 现在反过来——结构操作给两帧落位让路，门只是让路、不是禁用）
    scrollEl.value = fakeScrollEl({ scrollTop: 100, scrollHeight: 2000, clientHeight: 500 });
    await expandOlderAnchored();
    expect(loadOlder).not.toHaveBeenCalled();
    expect(landing.value).toBe(true); // 落位没被结构操作打断
    flush(); // 落位跑完（收尾 false）
    expect(landing.value).toBe(false);
    // 落位结束后：同一条调用能正常触发取回
    await expandOlderAnchored();
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  it("onScroll 在 landing 期间不触发取回；落位结束后恢复触发", async () => {
    const list = ref(makeMessages(100));
    const sid = ref<string | null>("s1");
    const loadOlder = vi.fn(async () => 0);
    const { schedule, flush } = manualScheduler();
    const { scrollEl, landing, onScroll } = useChatScroll(
      () => list.value,
      () => sid.value,
      {
        scheduleFrame: schedule,
        pagination: { hasMore: () => true, loadOlder },
      },
    );
    flush();
    scrollEl.value = fakeScrollEl({ scrollTop: 500, scrollHeight: 1817, clientHeight: 817 });
    sid.value = "s2";
    await nextTick();
    flush();
    sid.value = "s1"; // 切回：双帧落位在途
    await nextTick();
    expect(landing.value).toBe(true);
    // 落位期间滚到顶部触发带：自动取回分支被 !landing 门拦住（取回的 splice 会把
    // 落位中途的行模型换掉，落点随即失真）
    scrollEl.value = fakeScrollEl({ scrollTop: 0, scrollHeight: 2000, clientHeight: 500 });
    onScroll();
    expect(loadOlder).not.toHaveBeenCalled();
    flush(); // 落位跑完
    expect(landing.value).toBe(false);
    // 落位结束后：同一条 onScroll 能正常触发取回（门只是让路）
    scrollEl.value = fakeScrollEl({ scrollTop: 0, scrollHeight: 2000, clientHeight: 500 });
    onScroll();
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  it("落位期间 expandLiveAnchored 被 landing 门拦住；落位结束后可展开", async () => {
    const list = ref(makeMessages(100));
    const sid = ref<string | null>("s1");
    const { schedule, flush } = manualScheduler();
    const { scrollEl, rows, landing, expandLiveAnchored } = useChatScroll(
      () => list.value,
      () => sid.value,
      { scheduleFrame: schedule },
    );
    flush();
    scrollEl.value = fakeScrollEl({ scrollTop: 500, scrollHeight: 1817, clientHeight: 817 });
    sid.value = "s2";
    await nextTick();
    flush();
    sid.value = "s1"; // 切回：一次性挂载窗口全量（liveskel 隐藏 60）+ 双帧落位在途
    await nextTick();
    expect(landing.value).toBe(true);
    const hiddenCountOf = () => {
      const ls = rows.value.find((r) => r.kind === "liveskel");
      return ls && ls.kind === "liveskel" ? ls.count : -1;
    };
    expect(hiddenCountOf()).toBe(60);
    // 落位两帧内不展开 liveskel：展开会改行集（隐藏前缀变可见行）→ 落位中途行模型一变，
    // 锚定位置就落不准（原 ramp 期间展开语义的落点保留，门从 ramping 换成 landing）
    scrollEl.value = fakeScrollEl({ scrollTop: 100, scrollHeight: 8000, clientHeight: 817 });
    await expandLiveAnchored();
    expect(landing.value).toBe(true); // 落位没被打断
    expect(hiddenCountOf()).toBe(60); // 隐藏前缀一条没动
    flush(); // 落位跑完
    expect(landing.value).toBe(false);
    // 落位结束后：同一条调用能正常展开一个 chunk（60 → 20，步长 = LIVE_TAIL_ROWS 40）
    await expandLiveAnchored();
    expect(hiddenCountOf()).toBe(20);
  });

  // ── 跟随态锁存：按滚动方向区分用户手势与置底回波（根因见 useChatScroll.onScroll 注释）──
  let msgSeq = 0;
  function pushMessage(list: Ref<ChatMessage[]>) {
    msgSeq += 1;
    list.value = [
      ...list.value,
      { id: `x${msgSeq}`, role: "assistant", blocks: [{ type: "text", text: "n" }], timestamp: 1000 + msgSeq },
    ];
  }

  /** 钉底基线：20 条 + 同步调度器（切入的钉底/落位帧在 setup 内跑完）+ 钉在底部的假滚动元素 */
  function setupPinned() {
    const list = ref(makeMessages(20));
    const sid = ref<string | null>("s1");
    const { schedule } = syncScheduler();
    const api = useChatScroll(
      () => list.value,
      () => sid.value,
      { scheduleFrame: schedule },
    );
    // scrollTop=1000, scrollHeight=1817, clientHeight=817 → dist=0（钉底）
    const el = fakeScrollEl({ scrollTop: 1000, scrollHeight: 1817, clientHeight: 817 });
    api.scrollEl.value = el;
    api.onScroll(); // 基线事件，建立 prevScrollTop=1000
    return { list, el, ...api };
  }

  it("置底回波不脱扣：置底写入与 scroll 事件派发之间内容继续长高（变更卡 +440 场景）", async () => {
    const { list, el, onScroll, newWhileAway } = setupPinned();

    // 新消息触发置底写入（同步调度器立即执行 rAF 回调）
    pushMessage(list);
    await nextTick();
    expect(el.scrollTop).toBe(1817);

    // 写入与 scroll 事件派发之间内容又长高 440px（Write 变更卡落定）——回波事件：
    // scrollTop 不小于上一事件位置（1817 > 1000），dist=440 ≥ 48 也不得脱扣
    el.scrollHeight = 2257;
    onScroll();

    // 跟随仍活着：再来一条消息继续置底
    pushMessage(list);
    await nextTick();
    expect(el.scrollTop).toBe(2257);
    expect(newWhileAway.value).toBe(false);
  });

  it("真实上滚脱扣、滚回底部恢复跟随", async () => {
    const { list, el, onScroll, newWhileAway } = setupPinned();

    // 用户上滚 400px：scrollTop 减小 + dist≥48 → 脱扣
    el.scrollTop = 600;
    onScroll();
    pushMessage(list);
    await nextTick();
    expect(el.scrollTop).toBe(600); // 不再置底
    expect(newWhileAway.value).toBe(true); // 离开期间来新消息点亮小点

    // 滚回底部（dist=0）→ 恢复跟随
    el.scrollTop = 1000;
    onScroll();
    pushMessage(list);
    await nextTick();
    expect(el.scrollTop).toBe(1817);
    expect(newWhileAway.value).toBe(false);
  });

  it("上滚 48px 宽限内不脱扣", async () => {
    const { list, el, onScroll } = setupPinned();

    el.scrollTop = 975; // 上滚 25px，dist=25 < 48
    onScroll();
    pushMessage(list);
    await nextTick();
    expect(el.scrollTop).toBe(1817); // 跟随仍在，置底生效
  });

  // ── P1 双向分页：取回锚定 / 放弃锚定 / 在途自动续取 ──

  function fakePagination(overrides: Partial<NonNullable<Parameters<typeof useChatScroll>[2]["pagination"]>> = {}) {
    return {
      hasMore: () => false,
      loadOlder: async () => 0,
      ...overrides,
    };
  }


  it("P1 取回期间用户滚动则放弃锚定（不拉回）", async () => {
    const list = ref(makeMessages(30));
    const sid = ref<string | null>("s1");
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // manualScheduler：unshift 后 onNewContent 置底只入队不执行，否则 sync 下会把
    // scrollTop 钉到 scrollHeight，覆盖用户滚到的 500（真实浏览器 rAF 异步，无此问题）
    const { schedule } = manualScheduler();
    const { scrollEl, expandOlderAnchored } = useChatScroll(
      () => list.value,
      () => sid.value,
      {
        scheduleFrame: schedule,
        pagination: fakePagination({
          hasMore: () => true,
          loadOlder: async () => {
            await gate;
            list.value.unshift(...makeMessages(20));
            return 20;
          },
        }),
      },
    );
    scrollEl.value = fakeScrollEl({ scrollTop: 100, scrollHeight: 2000, clientHeight: 500 });
    const p = expandOlderAnchored();
    scrollEl.value.scrollTop = 500; // 取回期间用户滚走
    release!();
    await p;
    expect(scrollEl.value.scrollTop).toBe(500); // 未被拉回 100+Δ
  });

  it("P1 取回在途时顶部滚动 → 完成后自动续取（连翻不中断）", async () => {
    const list = ref(makeMessages(15));
    const sid = ref<string | null>("s1");
    let hasMore = true;
    let loadCalls = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { schedule, flush } = manualScheduler();
    const { scrollEl, onScroll } = useChatScroll(
      () => list.value,
      () => sid.value,
      {
        scheduleFrame: schedule,
        pagination: fakePagination({
          hasMore: () => hasMore,
          loadOlder: async () => {
            loadCalls += 1;
            if (loadCalls >= 2) hasMore = false;
            await gate; // 取回在途：等测试放行
            list.value.unshift(
              ...Array.from({ length: 30 }, (_, i) => ({
                id: `old${loadCalls}-${i}`,
                role: "assistant" as const,
                blocks: [{ type: "text" as const, text: `old ${loadCalls}-${i}` }],
                timestamp: 0,
              })),
            );
            return 30;
          },
        }),
      },
    );
    flush(); // setup 排的钉底帧先跑掉（清掉 scrollQueued，避免后续置底全部早退）
    scrollEl.value = fakeScrollEl({ scrollTop: 0, scrollHeight: 2000, clientHeight: 500 });
    onScroll(); // 触发第一次取回（在途）
    await Promise.resolve();
    // 取回在途时用户继续在顶部滚 → 标记 pending（不被防重入吞掉）
    scrollEl.value = fakeScrollEl({ scrollTop: 0, scrollHeight: 2000, clientHeight: 500 });
    onScroll();
    await Promise.resolve();
    expect(loadCalls).toBe(1); // 在途不双触发
    // 放行：第一次取回完成后自动续取第二次（topPending 消费）
    release!();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(loadCalls).toBe(2);
  });

  it("页释放/取回不误亮「新消息」圆点；live 段新增才亮", async () => {
    // 页级回收会 splice messages（释放变少/取回变多）——onNewContent 必须 watch
    // live 段长度而非 messages.length，否则取回被误报成新消息（亮圆点）。
    const { getStore, getOrCreateLedger, resetAllState } = await import("./useChatSession/state");
    const { releasePage } = await import("./useChatSession/recycle");
    resetAllState();
    const store = getStore("s1");
    const ledger = getOrCreateLedger("s1");
    ledger.push({ id: "pg0", startOffset: 0, endOffset: 100, count: 2, bytes: 100, loaded: true, restorable: true, heightPx: 0 });
    const msgs = makeMessages(3);
    store.messages.push(msgs[0], msgs[1]); // 页 0 的 2 条
    store.messages.push(msgs[2]); // live 段 1 条
    const sid = ref<string | null>("s1");
    const { schedule } = syncScheduler();
    const api = useChatScroll(() => store.messages, () => sid.value, { scheduleFrame: schedule });
    const el = fakeScrollEl({ scrollTop: 1000, scrollHeight: 1817, clientHeight: 817 });
    api.scrollEl.value = el;
    api.onScroll(); // 基线（prevScrollTop 建立）
    el.scrollTop = 600; // 用户上滚脱扣 → autoScroll=false
    api.onScroll();
    // 释放页 0：messages 3→1，但 live 计数不变（1）→ 圆点不亮
    releasePage("s1", 0, 500);
    await nextTick();
    expect(api.newWhileAway.value).toBe(false);
    // live 段新增 1 条（真实新消息）→ 圆点亮
    store.messages.push({ id: "new-live", role: "assistant", blocks: [{ type: "text", text: "n" }], timestamp: 9 });
    await nextTick();
    expect(api.newWhileAway.value).toBe(true);
  });

  it("切入收紧：超预算会话切进来时远端页变骨架行（挂载量由热区页决定）", async () => {
    // 拆 ramp 后的挂载量由两处结构性窗口决定，其中一处就是「切入收紧」
    // （tightenResidentPages，在建行之前的 watch(sessionId) pre-flush 里调）。
    // 本用例锁的是这条通路的效果：超预算会话切进来时 rows 里已经是骨架而不是
    // 「全量挂载后再回收」。
    const { getStore, getOrCreateLedger, resetAllState } = await import("./useChatSession/state");
    resetAllState();
    // 独立 sid：本用例直接写模块级台账/store，避免污染同文件其他用例；同时避开
    // recycle.ts 的模块级 viewportHot（resetAllState 不清它），否则「无锚」会被
    // 别处上报的视口页取代，「保留最新 2 页」这条兜底就测不到
    const sid0 = "s-tight";
    const store = getStore(sid0);
    const ledger = getOrCreateLedger(sid0);
    const MB = 1024 * 1024;
    for (let i = 0; i < 4; i++) {
      ledger.push({
        id: `pg${i}`, startOffset: i * MB, endOffset: (i + 1) * MB, count: 1, bytes: MB,
        loaded: true, restorable: true, heightPx: 0,
      });
      store.messages.push({ id: `p${i}`, role: "assistant", blocks: [{ type: "text", text: `p${i}` }], timestamp: i });
    }
    const sid = ref<string | null>(sid0);
    const { schedule } = syncScheduler();
    const { rows } = useChatScroll(() => store.messages, () => sid.value, { scheduleFrame: schedule });
    // 4 页 × 1MB = 4MB > RECYCLE_BYTES_BUDGET(2MB) ⇒ 切入即收紧。无位置记忆（无锚行）
    // → 热区页算不出，回退「保留最新 2 页」：最老的两页释放成骨架
    expect(rows.value.map((r) => r.kind)).toEqual(["skeleton", "skeleton", "page", "page"]);
    expect(ledger.filter((p) => p.loaded).length).toBe(2);
    // 骨架保留条数（估算高由 recycle 记账，落点不依赖它——见 tightenResidentPages 注释）
    expect(rows.value[0].kind === "skeleton" && rows.value[0].count).toBe(1);
    // 释放后 store.messages 只剩驻留页（live 段为空，不产生尾窗行）
    expect(store.messages.length).toBe(2);
  });

  it("P1 连续上滚翻页：onScroll 到顶驱动 loadOlder 循环直到磁盘取完", async () => {
    // 模拟预览打开长会话：store 尾部 15 条（hydrate 页）+ 磁盘还有更早内容
    const list = ref(makeMessages(15));
    const sid = ref<string | null>("s1");
    let hasMore = true;
    let olderRounds = 0;
    const { schedule, flush } = manualScheduler();
    const { scrollEl, onScroll } = useChatScroll(
      () => list.value,
      () => sid.value,
      {
        scheduleFrame: schedule,
        pagination: fakePagination({
          hasMore: () => hasMore,
          loadOlder: async () => {
            olderRounds += 1;
            list.value.unshift(
              ...Array.from({ length: 30 }, (_, i) => ({
                id: `old${olderRounds}-${i}`,
                role: "assistant" as const,
                blocks: [{ type: "text" as const, text: `old ${olderRounds}-${i}` }],
                timestamp: 0,
              })),
            );
            if (olderRounds >= 5) hasMore = false; // 第 5 页后磁盘取完
            return 30;
          },
        }),
      },
    );
    flush(); // setup 排的钉底帧先跑掉（清掉 scrollQueued）
    scrollEl.value = fakeScrollEl({ scrollTop: 0, scrollHeight: 2000, clientHeight: 500 });
    // 滚到顶触发取回：取回后补偿（scrollTop 离开顶部），再滚回顶部再取……
    let guard = 0;
    while (hasMore && guard++ < 20) {
      onScroll();
      for (let i = 0; i < 8; i++) await Promise.resolve();
      // 模拟用户再次滚到顶（补偿把 scrollTop 移开顶部）
      scrollEl.value = fakeScrollEl({ scrollTop: 0, scrollHeight: 2000 + guard, clientHeight: 500 });
    }
    // 磁盘取完（5 页 = 150 条）→ 早期内容全部进入 store（无台账路径，不触发回收）
    expect(olderRounds).toBe(5);
    expect(list.value.length).toBe(15 + 150);
  });
});
