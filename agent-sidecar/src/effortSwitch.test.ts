import { describe, it, expect, vi } from "vitest";
import { applyEffortSwitch, normalizeEffort, type EffortSettable } from "./effortSwitch.js";
import type { ChatEvent } from "./types.js";

function setup(currentEffort = "high", query: EffortSettable | null = null, effort = "max") {
  const events: ChatEvent[] = [];
  const committed: string[] = [];
  applyEffortSwitch({
    effort,
    query,
    currentEffort,
    emit: (e) => events.push(e),
    commit: (v) => committed.push(v),
  });
  return { events, committed };
}

/** 等 applyFlagSettings 的 .then/.catch 微任务链跑完。 */
const flush = () => new Promise((r) => setImmediate(r));

describe("normalizeEffort", () => {
  it("大小写不敏感，五档全认", () => {
    expect(normalizeEffort("LOW")).toBe("low");
    expect(normalizeEffort("Medium")).toBe("medium");
    expect(normalizeEffort("high")).toBe("high");
    expect(normalizeEffort("xhigh")).toBe("xhigh");
    expect(normalizeEffort("MAX")).toBe("max");
  });
  it("非法/空值归一为 ''", () => {
    expect(normalizeEffort("")).toBe("");
    expect(normalizeEffort(undefined)).toBe("");
    expect(normalizeEffort("turbo")).toBe("");
  });
});

describe("applyEffortSwitch", () => {
  it("query 未起：本地落账 + 广播同步选择器（无 error）", () => {
    const { events, committed } = setup("high", null);
    expect(committed).toEqual(["max"]);
    expect(events).toEqual([{ type: "effort_changed", effort: "max" }]);
  });

  it("切换成功：坐实 + effort_changed(新值)，max 原样传给 applyFlagSettings", async () => {
    const applyFlagSettings = vi.fn(() => Promise.resolve());
    const { events, committed } = setup("high", { applyFlagSettings });
    expect(applyFlagSettings).toHaveBeenCalledWith({ effortLevel: "max" });
    await flush();
    expect(committed).toEqual(["max"]);
    expect(events).toEqual([{ type: "effort_changed", effort: "max" }]);
  });

  it("切快速(low)：applyFlagSettings 只传 effortLevel，不联动思考", async () => {
    const applyFlagSettings = vi.fn(() => Promise.resolve());
    const { events, committed } = setup("high", { applyFlagSettings }, "low");
    expect(applyFlagSettings).toHaveBeenCalledWith({ effortLevel: "low" });
    await flush();
    expect(committed).toEqual(["low"]);
    expect(events).toEqual([{ type: "effort_changed", effort: "low" }]);
  });

  it("切换失败（CLI 驳回）：不坐实、effort_changed(旧值 + error) 回滚", async () => {
    const applyFlagSettings = vi.fn(() => Promise.reject(new Error("invalid effortLevel")));
    const { events, committed } = setup("high", { applyFlagSettings });
    await flush();
    expect(committed).toEqual([]);
    expect(events).toEqual([
      { type: "effort_changed", effort: "high", error: "invalid effortLevel" },
    ]);
  });

  it("同值/非法值守卫：不坐实、不广播", () => {
    const applyFlagSettings = vi.fn(() => Promise.resolve());
    const events: ChatEvent[] = [];
    const commit = vi.fn();
    const base = {
      query: { applyFlagSettings } as EffortSettable,
      emit: (e: ChatEvent) => events.push(e),
      commit,
    };
    applyEffortSwitch({ ...base, effort: "high", currentEffort: "high" });
    applyEffortSwitch({ ...base, effort: "turbo", currentEffort: "high" });
    applyEffortSwitch({ ...base, effort: "", currentEffort: "high" });
    expect(applyFlagSettings).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("大写输入规范化后生效（exit env 是 LOW/MAX 风格）", async () => {
    const applyFlagSettings = vi.fn(() => Promise.resolve());
    const { events, committed } = setup("high", { applyFlagSettings }, "XHIGH");
    await flush();
    expect(applyFlagSettings).toHaveBeenCalledWith({ effortLevel: "xhigh" });
    expect(committed).toEqual(["xhigh"]);
    expect(events).toEqual([{ type: "effort_changed", effort: "xhigh" }]);
  });
});
