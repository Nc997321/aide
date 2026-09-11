import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TailPool } from "./tailPool.js";
import type { ChatEvent } from "./types.js";

/** 桩 tail：记录 tick/stop 次数。 */
function stubTail() {
  return { tick: vi.fn(async () => {}), stop: vi.fn() };
}
type StubTail = ReturnType<typeof stubTail>;

const emit: (e: ChatEvent) => void = () => {};

describe("TailPool", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("start 建 tail 并起定时器；tick 随 600ms 轮询驱动", async () => {
    const made: StubTail[] = [];
    const pool = new TailPool<StubTail>(() => {
      const t = stubTail();
      made.push(t);
      return t;
    });
    pool.start("a", "/f/a", emit);
    expect(made).toHaveLength(1);
    vi.advanceTimersByTime(600);
    await Promise.resolve();
    expect(made[0].tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(600);
    await Promise.resolve();
    expect(made[0].tick).toHaveBeenCalledTimes(2);
  });

  it("start 幂等：同 id 重复启动不重建", () => {
    const factory = vi.fn(() => stubTail());
    const pool = new TailPool<StubTail>(factory);
    pool.start("a", "/f/a", emit);
    pool.start("a", "/f/a", emit);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("tick 抛错不传染：单条失败其它照跑，下轮重试（fire-and-forget catch）", async () => {
    const bad = { tick: vi.fn(async () => { throw new Error("EPIPE"); }), stop: vi.fn() };
    const good = stubTail();
    let n = 0;
    const pool = new TailPool<StubTail>(() => (n++ === 0 ? (bad as unknown as StubTail) : good));
    pool.start("bad", "/f/b", emit);
    pool.start("good", "/f/g", emit);
    vi.advanceTimersByTime(600);
    await vi.waitFor(() => expect(good.tick).toHaveBeenCalled());
    expect(bad.tick).toHaveBeenCalledTimes(1); // 抛错被吞，不炸定时器
  });

  it("stop 缺省收尾 = t.stop()；空池清定时器", () => {
    const t = stubTail();
    const pool = new TailPool<StubTail>(() => t);
    pool.start("a", "/f/a", emit);
    pool.stop("a");
    expect(t.stop).toHaveBeenCalled();
    pool.stop("ghost"); // 不存在：no-op 不炸
    // 定时器已清：推进不再 tick（t 已被摘，stop 过）
    const ticksBefore = t.tick.mock.calls.length;
    vi.advanceTimersByTime(1200);
    expect(t.tick).toHaveBeenCalledTimes(ticksBefore);
  });

  it("stop 注入 removeTail（bgTask finalFlush 语义）：走钩子而非直接 stop", () => {
    const t = stubTail();
    const removeTail = vi.fn();
    const pool = new TailPool<StubTail>(() => t, removeTail);
    pool.start("a", "/f/a", emit);
    pool.stop("a");
    expect(removeTail).toHaveBeenCalledWith(t);
    expect(t.stop).not.toHaveBeenCalled(); // 收尾方式由钩子独占
  });

  it("stopAll：全部直接 stop（不走 removeTail）并清池清定时器", () => {
    const a = stubTail();
    const b = stubTail();
    const removeTail = vi.fn();
    let n = 0;
    const pool = new TailPool<StubTail>(() => (n++ === 0 ? a : b), removeTail);
    pool.start("a", "/f/a", emit);
    pool.start("b", "/f/b", emit);
    pool.stopAll();
    expect(a.stop).toHaveBeenCalled();
    expect(b.stop).toHaveBeenCalled();
    expect(removeTail).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1200);
    expect(a.tick).not.toHaveBeenCalled();
  });

  it("非空池 stop 不清定时器：其余 tail 继续轮询", async () => {
    const a = stubTail();
    const b = stubTail();
    let n = 0;
    const pool = new TailPool<StubTail>(() => (n++ === 0 ? a : b));
    pool.start("a", "/f/a", emit);
    pool.start("b", "/f/b", emit);
    pool.stop("a");
    vi.advanceTimersByTime(600);
    await Promise.resolve();
    expect(b.tick).toHaveBeenCalledTimes(1);
  });
});
