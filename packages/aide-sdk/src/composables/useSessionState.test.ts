import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useSessionState } from "./useSessionState";

describe("useSessionState dotTone 两轴投影", () => {
  const { state, setSessionState, setSessionHealth, removeSessionState, dotTone } =
    useSessionState();

  beforeEach(() => {
    for (const k of Object.keys(state)) removeSessionState(k);
  });

  it("无条目默认 stopped", () => {
    expect(dotTone("x")).toBe("stopped");
  });

  it("dead 优先级最高：stopped 压过任何 health", () => {
    setSessionState("x", "stopped");
    setSessionHealth("x", "warning");
    expect(dotTone("x")).toBe("stopped");
  });

  it("warning(红) 压过活跃度", () => {
    setSessionState("x", "waiting");
    setSessionHealth("x", "warning");
    expect(dotTone("x")).toBe("warning");
  });

  it("health ok 时投影回落到活跃度本身", () => {
    setSessionState("x", "running");
    expect(dotTone("x")).toBe("running");
    setSessionState("x", "waiting");
    expect(dotTone("x")).toBe("waiting");
    setSessionState("x", "attention");
    expect(dotTone("x")).toBe("attention");
  });
});

describe("useSessionState running 恒绿（stalled 软超时已撤，2026-09-11 用户定案）", () => {
  const { state, health, setSessionState, removeSessionState, dotTone } =
    useSessionState();

  beforeEach(() => {
    for (const k of Object.keys(state)) removeSessionState(k);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("running 长时间无任何事件也不变色（长工具调用不是卡住）", () => {
    setSessionState("x", "running");
    vi.advanceTimersByTime(10 * 60_000); // 10 分钟静默
    expect(health["x"]).toBeUndefined();
    expect(dotTone("x")).toBe("running");
  });

  it("卡死检测交回进程级通道：session_dead → stopped 灰点仍生效", () => {
    setSessionState("x", "running");
    setSessionState("x", "stopped"); // 看门狗判死路径
    expect(dotTone("x")).toBe("stopped");
  });
});
