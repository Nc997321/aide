import { describe, it, expect } from "vitest";
import { nextTick, ref } from "vue";
import type { Ref } from "vue";
import { useChatScroll } from "./useChatScroll";
import type { ChatMessage } from "@/types/chat";

function makeMessages(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
    blocks: [{ type: "text", text: `msg ${i}` }],
    timestamp: i,
  }));
}

/** 同步调度器：scheduleFrame 立即执行 cb（ramp 在 setup 内一气跑完），cancel 为空操作。 */
function syncScheduler() {
  const schedule = (cb: () => void) => {
    cb();
    return () => {};
  };
  return { schedule };
}

/** 手动调度器：cb 入队等 flush，cancel 计数 + 从队列移除。用于测取消 / ramping 中途状态。 */
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
  return { schedule, flush, cancelCount: () => cancelCount };
}

/** 极简滚动元素桩：只够 onScroll / expandOlderAnchored 读写 scrollTop/scrollHeight/clientHeight。 */
function fakeScrollEl(opts: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
  return opts as unknown as HTMLDivElement;
}

describe("useChatScroll", () => {
  it("切会话分帧挂载：先 6 条，ramp 跑完到 15，ramping 收尾 false", () => {
    const list = ref(makeMessages(100));
    const sid = ref<string | null>("s1");
    const { schedule } = syncScheduler();
    const { visibleMessages, ramping } = useChatScroll(
      () => list.value,
      () => sid.value,
      { scheduleFrame: schedule },
    );
    // 同步调度器下 ramp 在 immediate sessionId watcher 里一气跑完
    expect(visibleMessages.value.length).toBe(15);
    expect(ramping.value).toBe(false);
  });

  it("短会话（8 条）：ramp 到全可见即停，不无限循环", () => {
    const list = ref(makeMessages(8));
    const sid = ref<string | null>("s1");
    const { schedule } = syncScheduler();
    const { visibleMessages, ramping } = useChatScroll(
      () => list.value,
      () => sid.value,
      { scheduleFrame: schedule },
    );
    expect(visibleMessages.value.length).toBe(8);
    expect(ramping.value).toBe(false);
  });

  it("空会话不 ramp；hydrate（messages 0→N）后 rampPending 触发 ramp", async () => {
    const list = ref<ChatMessage[]>([]);
    const sid = ref<string | null>("s1");
    const { schedule } = syncScheduler();
    const { visibleMessages, ramping } = useChatScroll(
      () => list.value,
      () => sid.value,
      { scheduleFrame: schedule },
    );
    expect(visibleMessages.value.length).toBe(0);
    expect(ramping.value).toBe(false);
    // hydrate：整份历史一次性灌入
    list.value = makeMessages(50);
    await nextTick(); // pre-flush length watcher 触发 startRamp
    expect(visibleMessages.value.length).toBe(15);
    expect(ramping.value).toBe(false);
  });

  it("快速连切会话：前一个 ramp 被取消（cancel 被调）", async () => {
    const list = ref(makeMessages(100));
    const sid = ref<string | null>("s1");
    const { schedule, flush, cancelCount } = manualScheduler();
    const { ramping } = useChatScroll(
      () => list.value,
      () => sid.value,
      { scheduleFrame: schedule },
    );
    // immediate watcher 已为 s1 起了 ramp（tick 在队，未 flush）
    expect(ramping.value).toBe(true);
    sid.value = "s2";
    await nextTick(); // sessionId watcher：cancelRamp（取消旧 tick）+ startRamp（新 tick）
    expect(cancelCount()).toBeGreaterThanOrEqual(1);
    flush(); // 跑完 s2 的 ramp
    expect(ramping.value).toBe(false);
  });

  it("hero（sessionId=null）：不 ramp", async () => {
    const list = ref<ChatMessage[]>([]);
    const sid = ref<string | null>(null);
    const { schedule } = syncScheduler();
    const { visibleMessages, ramping } = useChatScroll(
      () => list.value,
      () => sid.value,
      { scheduleFrame: schedule },
    );
    expect(visibleMessages.value.length).toBe(0);
    expect(ramping.value).toBe(false);
    // 即便后续 messages 到了，sid 仍为 null 也不 ramp（rampPending 未被置位）
    list.value = makeMessages(50);
    await nextTick();
    expect(ramping.value).toBe(false);
  });

  it("ramp 期间用户上滚 expandOlderAnchored：取消 ramp、不回缩、渲染预算到顶", async () => {
    const list = ref(makeMessages(100));
    const sid = ref<string | null>("s1");
    const { schedule, flush } = manualScheduler();
    const { scrollEl, visibleMessages, hiddenCount, ramping, expandOlderAnchored } = useChatScroll(
      () => list.value,
      () => sid.value,
      { scheduleFrame: schedule },
    );
    expect(ramping.value).toBe(true); // ramp 中（tick 在队未 flush）
    expect(hiddenCount.value).toBe(85); // 100 - 窗口 15
    scrollEl.value = fakeScrollEl({ scrollTop: 100, scrollHeight: 2000, clientHeight: 500 });
    await expandOlderAnchored();
    expect(ramping.value).toBe(false); // 用户接管，ramp 取消
    expect(hiddenCount.value).toBe(70); // 窗口 15→30
    expect(visibleMessages.value.length).toBe(30); // 渲染预算一并到顶
    flush(); // 队里残留的旧 ramp tick 已被 cancel 移除，flush 空跑不应改变状态
    expect(visibleMessages.value.length).toBe(30);
  });

  it("onScroll 在 ramping 时不触发扩窗（hiddenCount 不变）", () => {
    const list = ref(makeMessages(100));
    const sid = ref<string | null>("s1");
    const { schedule } = manualScheduler();
    const { scrollEl, hiddenCount, ramping, onScroll } = useChatScroll(
      () => list.value,
      () => sid.value,
      { scheduleFrame: schedule },
    );
    expect(ramping.value).toBe(true);
    expect(hiddenCount.value).toBe(85);
    scrollEl.value = fakeScrollEl({ scrollTop: 0, scrollHeight: 2000, clientHeight: 500 });
    onScroll();
    // ramping 期间自动扩窗分支被 !ramping 门拦住，窗口不动
    expect(hiddenCount.value).toBe(85);
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

  /** 钉底基线：20 条 + 同步调度器（ramp 在 setup 内跑完）+ 钉在底部的假滚动元素 */
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
});