import { describe, it, expect } from "vitest";
import { ToolLifecycleTracker } from "./toolLifecycle.js";

describe("ToolLifecycleTracker", () => {
  it("tool_use 入账、tool_result 销账，全部归零才算空闲", () => {
    const t = new ToolLifecycleTracker();
    expect(t.isIdle()).toBe(true);

    t.onToolUse("t1");
    t.onToolUse("t2");
    expect(t.isIdle()).toBe(false);

    t.onToolResult("t1");
    expect(t.isIdle()).toBe(false);
    t.onToolResult("t2");
    expect(t.isIdle()).toBe(true);
  });

  it("reset 清空在飞账本——中断腰斩后 tool_result 永不到达，不清空会让插队安全边界永久失效（回归）", () => {
    const t = new ToolLifecycleTracker();
    t.onToolUse("t1");
    t.onToolUse("t2");
    // 模拟这一轮被 interrupt：t1/t2 的 tool_result 永远不会来
    t.reset();
    expect(t.isIdle()).toBe(true);
  });
});
