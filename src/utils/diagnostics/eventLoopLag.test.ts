import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  startLagSampler,
  stopLagSampler,
  drainMaxLag,
} from "./eventLoopLag";

describe("eventLoopLag 采样器", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now");
  });
  afterEach(() => {
    stopLagSampler();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("无漂移时 drain 为 0", () => {
    // 让 performance.now 精确按 100ms 递增（定时器理想节拍）
    let t = 0;
    vi.mocked(performance.now).mockImplementation(() => t);
    startLagSampler();
    vi.advanceTimersByTime(500);
    expect(drainMaxLag()).toBe(0);
  });

  it("捕获主线程占用造成的漂移并取周期内最大值", () => {
    let t = 0;
    vi.mocked(performance.now).mockImplementation(() => t);
    startLagSampler();
    // 第一个 tick 后主线程「卡」了 80ms——now 比 100ms 漂移 80
    vi.advanceTimersByTime(100); t += 100;
    t += 80; // 模拟 80ms 主线程占用，下一次回调时 now 已多 80
    vi.advanceTimersByTime(100); t += 100; // 触发回调，lag = (now - last - 100) = 80
    vi.advanceTimersByTime(100); t += 100;
    expect(drainMaxLag()).toBe(80);
  });

  it("drain 后清零", () => {
    let t = 0;
    vi.mocked(performance.now).mockImplementation(() => t);
    startLagSampler();
    vi.advanceTimersByTime(100); t += 100;
    t += 60;
    vi.advanceTimersByTime(100); t += 100;
    expect(drainMaxLag()).toBe(60);
    expect(drainMaxLag()).toBe(0);
  });

  it("start 幂等，stop 后再 drain 为 0", () => {
    let t = 0;
    vi.mocked(performance.now).mockImplementation(() => t);
    startLagSampler();
    startLagSampler(); // 不应启两个定时器
    vi.advanceTimersByTime(200); t += 200;
    stopLagSampler();
    expect(drainMaxLag()).toBe(0);
  });
});