import { describe, it, expect } from "vitest";
import { DAILY_DEFAULT_EFFORT, defaultEffortFor } from "./effortDefault";

describe("defaultEffortFor", () => {
  it("用户显式改过的档位最优先 —— 日常也压不过它", () => {
    expect(defaultEffortFor({ remembered: "max", daily: true, providerDefault: "high" })).toBe("max");
    expect(defaultEffortFor({ remembered: "high", daily: false, providerDefault: "low" })).toBe("high");
  });

  it("日常默认快速，且压过 provider 默认", () => {
    expect(defaultEffortFor({ remembered: null, daily: true, providerDefault: "max" })).toBe("low");
    expect(defaultEffortFor({ remembered: null, daily: true, providerDefault: "high" })).toBe("low");
  });

  it("工程沿用 provider 默认（现状不变）", () => {
    expect(defaultEffortFor({ remembered: null, daily: false, providerDefault: "max" })).toBe("max");
    expect(defaultEffortFor({ remembered: null, daily: false, providerDefault: "high" })).toBe("high");
  });

  it("记住的值走归一（历史 medium/xhigh 迁移到三档）", () => {
    expect(defaultEffortFor({ remembered: "xhigh", daily: true, providerDefault: "high" })).toBe("max");
    expect(defaultEffortFor({ remembered: "medium", daily: false, providerDefault: "high" })).toBe("high");
  });

  it("日常默认就是「快速」这一档（low），不是别的", () => {
    expect(DAILY_DEFAULT_EFFORT).toBe("low");
  });
});
