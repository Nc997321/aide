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

  it("stalled(橙) 压过活跃度、但低于 warning", () => {
    setSessionState("x", "running");
    setSessionHealth("x", "stalled");
    expect(dotTone("x")).toBe("stalled");
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

describe("useSessionState 软超时(stalled)", () => {
  const { state, health, setSessionState, armStalled, removeSessionState, dotTone } =
    useSessionState();

  beforeEach(() => {
    for (const k of Object.keys(state)) removeSessionState(k);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("running 且连续 90s 无事件 → 判 stalled", () => {
    setSessionState("x", "running");
    armStalled("x");
    vi.advanceTimersByTime(90_000);
    expect(health["x"]).toBe("stalled");
    expect(dotTone("x")).toBe("stalled");
  });

  it("阈值内再次 armStalled(有事件到达)重置计时 → 不判 stalled", () => {
    setSessionState("x", "running");
    armStalled("x");
    vi.advanceTimersByTime(60_000);
    armStalled("x"); // 事件到达，重置
    vi.advanceTimersByTime(60_000); // 距上次仅 60s < 90s
    expect(health["x"]).toBeUndefined();
  });

  it("进入 attention(权限弹窗)暂停软超时 → 不误判卡住", () => {
    setSessionState("x", "running");
    armStalled("x");
    setSessionState("x", "attention"); // setSessionState 对非 running 清定时器
    vi.advanceTimersByTime(90_000);
    expect(health["x"]).toBeUndefined();
  });
});
