import { describe, it, expect } from "vitest";
import { EFFORT_OPTIONS, effortLabel, normalizeEffortOption } from "./effort";

describe("EFFORT_OPTIONS", () => {
  it("三档制：low/high/max = 快速/思考/深度思考", () => {
    expect(EFFORT_OPTIONS).toEqual([
      { value: "low", label: "快速" },
      { value: "high", label: "思考" },
      { value: "max", label: "深度思考" },
    ]);
  });
});

describe("effortLabel", () => {
  it("三档制直映", () => {
    expect(effortLabel("low")).toBe("快速");
    expect(effortLabel("high")).toBe("思考");
    expect(effortLabel("max")).toBe("深度思考");
  });

  it("历史遗留档位归一到相邻档位（API 仍可能回报）", () => {
    expect(effortLabel("medium")).toBe("思考");
    expect(effortLabel("xhigh")).toBe("深度思考");
  });

  it("未知值原样大写返回（如 API 回报的新档位）", () => {
    expect(effortLabel("ultra")).toBe("ULTRA");
  });

  it("大小写不敏感", () => {
    expect(effortLabel("LOW")).toBe("快速");
    expect(effortLabel("XHigh")).toBe("深度思考");
  });
});

describe("normalizeEffortOption", () => {
  it("合法三档值直返", () => {
    expect(normalizeEffortOption("low")).toBe("low");
    expect(normalizeEffortOption("high")).toBe("high");
    expect(normalizeEffortOption("max")).toBe("max");
  });

  it("历史 medium→high、xhigh→max（保留深度意图）", () => {
    expect(normalizeEffortOption("medium")).toBe("high");
    expect(normalizeEffortOption("xhigh")).toBe("max");
  });

  it("非法/空值 → high（选择器没有默认档，默认就落思考）", () => {
    expect(normalizeEffortOption("")).toBe("high");
    expect(normalizeEffortOption(undefined)).toBe("high");
    expect(normalizeEffortOption(null)).toBe("high");
    expect(normalizeEffortOption("banana")).toBe("high");
  });

  it("空白与大写归一", () => {
    expect(normalizeEffortOption("  Max  ")).toBe("max");
    expect(normalizeEffortOption("MEDIUM")).toBe("high");
  });
});
