import { describe, expect, it, vi } from "vitest";
import { IdleSleep, idleSleepMs, SUBSESSION_IDLE_SLEEP_MS } from "./idleSleep.js";

function harness(busy: () => string | null) {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const sleep = vi.fn();
  const s = new IdleSleep({
    busyReason: busy,
    sleep,
    delayMs: 1000,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      (t as { cleared: boolean }).cleared = true;
    },
  });
  const fireLast = () => {
    const t = timers[timers.length - 1];
    if (!t.cleared) t.fn();
  };
  return { s, sleep, timers, fireLast };
}

describe("子会话空闲休眠", () => {
  it("到点没活就睡", () => {
    const h = harness(() => null);
    h.s.arm();
    h.fireLast();
    expect(h.sleep).toHaveBeenCalledOnce();
    expect(h.s.armed).toBe(false);
  });

  it("新消息进来就不睡了", () => {
    const h = harness(() => null);
    h.s.arm();
    h.s.cancel();
    h.fireLast();
    expect(h.sleep).not.toHaveBeenCalled();
  });

  it("到点还有活（后台命令 / 等批准 / 值守…）就不睡，过一个周期再看", () => {
    let reason: string | null = "bg_task";
    const h = harness(() => reason);
    h.s.arm();
    h.fireLast();
    expect(h.sleep).not.toHaveBeenCalled();
    expect(h.s.armed).toBe(true);
    reason = null;
    h.fireLast();
    expect(h.sleep).toHaveBeenCalledOnce();
  });

  it("Host 叫它现在睡：没活才睡", () => {
    let reason: string | null = "permission";
    const h = harness(() => reason);
    expect(h.s.tryNow()).toBe(false);
    reason = null;
    expect(h.s.tryNow()).toBe(true);
    expect(h.sleep).toHaveBeenCalledOnce();
  });

  it("时限可由环境变量覆盖，0 = 不休眠，非法值回落默认", () => {
    expect(idleSleepMs({})).toBe(SUBSESSION_IDLE_SLEEP_MS);
    expect(idleSleepMs({ AIDE_SUBSESSION_IDLE_SLEEP_MS: "5000" })).toBe(5000);
    expect(idleSleepMs({ AIDE_SUBSESSION_IDLE_SLEEP_MS: "abc" })).toBe(SUBSESSION_IDLE_SLEEP_MS);
    const h = new IdleSleep({ busyReason: () => null, sleep: vi.fn(), delayMs: 0 });
    h.arm();
    expect(h.armed).toBe(false);
  });
});
