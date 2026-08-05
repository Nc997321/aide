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
  it("切会话分帧挂载：先 6 条，ramp 跑完到 30，ramping 收尾 false", () => {
    const list = ref(makeMessages(100));
    const sid = ref<string | null>("s1");
    const { schedule } = syncScheduler();
    const { visibleMessages, ramping } = useChatScroll(
      () => list.value,
      () => sid.value,
      { scheduleFrame: schedule },
    );
    // 同步调度器下 ramp 在 immediate sessionId watcher 里一气跑完
    expect(visibleMessages.value.length).toBe(30);
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
    expect(visibleMessages.value.length).toBe(30);
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
    expect(hiddenCount.value).toBe(70); // 100 - 窗口 30
    scrollEl.value = fakeScrollEl({ scrollTop: 100, scrollHeight: 2000, clientHeight: 500 });
    await expandOlderAnchored();
    expect(ramping.value).toBe(false); // 用户接管，ramp 取消
    expect(hiddenCount.value).toBe(40); // 窗口 30→60
    expect(visibleMessages.value.length).toBe(60); // 渲染预算一并到顶
    flush(); // 队里残留的旧 ramp tick 已被 cancel 移除，flush 空跑不应改变状态
    expect(visibleMessages.value.length).toBe(60);
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
    expect(hiddenCount.value).toBe(70);
    scrollEl.value = fakeScrollEl({ scrollTop: 0, scrollHeight: 2000, clientHeight: 500 });
    onScroll();
    // ramping 期间自动扩窗分支被 !ramping 门拦住，窗口不动
    expect(hiddenCount.value).toBe(70);
  });
});