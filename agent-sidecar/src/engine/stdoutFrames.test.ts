import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ChatEvent } from "./types.js";

// 模块级状态（backpressured/droppedCount/fatal）跨用例必须隔离：每个用例
// vi.resetModules 后重新 import，拿到全新模块实例。
async function loadModule(): Promise<typeof import("./stdoutFrames.js")> {
  vi.resetModules();
  return await import("./stdoutFrames.js");
}

/** mock process.stdout：write 可控返回、once("drain") 记录处理器供手动触发。 */
function mockStdout(writeResult: (n: number) => boolean) {
  const writes: string[] = [];
  const drainHandlers: (() => void)[] = [];
  let call = 0;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return writeResult(call++);
  });
  vi.spyOn(process.stdout, "once").mockImplementation((event: unknown, cb: unknown) => {
    if (event === "drain" && typeof cb === "function") drainHandlers.push(cb as () => void);
    return process.stdout as never;
  });
  return {
    writes,
    drainNow: () => { for (const h of drainHandlers.splice(0)) h(); },
  };
}

const delta: ChatEvent = { type: "text_delta", delta: "x" };
const stop: ChatEvent = { type: "message_stop", stop_reason: "end_turn", total_cost_usd: null, usage: null };

describe("stdoutFrames", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("正常路径：帧原样透传，不进入背压态", async () => {
    const m = mockStdout(() => true);
    const { writeStdoutFrame, stdoutBackpressured, isDroppableEvent } = await loadModule();

    expect(isDroppableEvent(delta)).toBe(true);
    expect(isDroppableEvent(stop)).toBe(false);
    expect(isDroppableEvent({ type: "heartbeat" })).toBe(true);

    writeStdoutFrame(JSON.stringify(delta) + "\n", true);
    writeStdoutFrame(JSON.stringify(stop) + "\n", false);
    expect(m.writes).toEqual([JSON.stringify(delta) + "\n", JSON.stringify(stop) + "\n"]);
    expect(stdoutBackpressured()).toBe(false);
  });

  it("btw_answer 不是可丢弃事件——丢一条就少一个答案", async () => {
    const { isDroppableEvent } = await loadModule();
    const answer: ChatEvent = {
      type: "btw_answer",
      sessionId: "sess-1",
      question: "问一句",
      response: "答案",
    };
    expect(isDroppableEvent(answer)).toBe(false);
  });

  it("背压后：增量帧被丢弃（不写入），非增量帧照常写入（顺序保持）", async () => {
    const m = mockStdout((n) => n !== 0); // 第 0 次写返回 false → 进入背压
    const { writeStdoutFrame } = await loadModule();

    writeStdoutFrame(JSON.stringify(stop) + "\n", false); // 触发背压，本身已写入
    writeStdoutFrame(JSON.stringify(delta) + "\n", true); // 丢弃
    writeStdoutFrame(JSON.stringify(delta) + "\n", true); // 丢弃
    writeStdoutFrame(JSON.stringify(stop) + "\n", false); // 照常写入（Node 内部缓冲）

    expect(m.writes.length).toBe(2); // stop + stop，两个 delta 没进 stdout
    expect(m.writes[1]).toBe(JSON.stringify(stop) + "\n");
  });

  it("drain 恢复后：增量帧重新放行", async () => {
    const m = mockStdout((n) => n !== 0);
    const { writeStdoutFrame, stdoutBackpressured } = await loadModule();

    writeStdoutFrame(JSON.stringify(stop) + "\n", false);
    expect(stdoutBackpressured()).toBe(true);
    m.drainNow(); // 对端恢复读取
    expect(stdoutBackpressured()).toBe(false);

    writeStdoutFrame(JSON.stringify(delta) + "\n", true);
    expect(m.writes.length).toBe(2);
  });

  it("丢弃计数达阈值 → 通知回调触发一次（带会话上下文），计数清零后再累积", async () => {
    const m = mockStdout((n) => n !== 0);
    const { writeStdoutFrame, setStdoutBackpressureNotifier } = await loadModule();
    const notices: { message: string; sessionId: string | undefined }[] = [];
    setStdoutBackpressureNotifier((message, sessionId) => notices.push({ message, sessionId }));

    writeStdoutFrame(JSON.stringify(stop) + "\n", false, "sess-1"); // 进入背压
    for (let i = 0; i < 1000; i++) writeStdoutFrame(JSON.stringify(delta) + "\n", true, "sess-1");
    expect(notices.length).toBe(1);
    expect(notices[0].sessionId).toBe("sess-1");
    expect(notices[0].message).toContain("背压降级");

    // 计数已清零：再来一批重新累积（不重复通知直到再次满阈值）
    for (let i = 0; i < 999; i++) writeStdoutFrame(JSON.stringify(delta) + "\n", true);
    expect(notices.length).toBe(1);
    writeStdoutFrame(JSON.stringify(delta) + "\n", true);
    expect(notices.length).toBe(2);
  });

  it("背压超时（5s 无 drain）→ 熔断：发致命通知，此后一切输出静默丢弃", async () => {
    vi.useFakeTimers();
    const m = mockStdout(() => false);
    const { writeStdoutFrame, setStdoutBackpressureNotifier, stdoutFatal } = await loadModule();
    const notices: string[] = [];
    setStdoutBackpressureNotifier((message) => notices.push(message));

    writeStdoutFrame(JSON.stringify(stop) + "\n", false);
    expect(stdoutFatal()).toBe(false);

    vi.advanceTimersByTime(5_000);
    expect(stdoutFatal()).toBe(true);
    expect(notices.some((n) => n.includes("熔断"))).toBe(true);

    // 熔断后：增量与非增量都不再写入
    writeStdoutFrame(JSON.stringify(delta) + "\n", true);
    writeStdoutFrame(JSON.stringify(stop) + "\n", false);
    expect(m.writes.length).toBe(1); // 只有进入背压那一帧
  });

  it("超时前 drain 到达 → 定时器取消，不会熔断", async () => {
    vi.useFakeTimers();
    const m = mockStdout(() => false);
    const { writeStdoutFrame, stdoutFatal } = await loadModule();

    writeStdoutFrame(JSON.stringify(stop) + "\n", false);
    vi.advanceTimersByTime(4_000);
    m.drainNow();
    vi.advanceTimersByTime(10_000); // 超过熔断窗口，但 drain 已清除定时器
    expect(stdoutFatal()).toBe(false);
    writeStdoutFrame(JSON.stringify(delta) + "\n", true);
    expect(m.writes.length).toBe(2);
  });
});
