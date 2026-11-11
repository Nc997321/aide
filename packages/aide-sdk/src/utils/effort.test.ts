import { describe, it, expect } from "vitest";
import { EFFORT_OPTIONS, effortLabel, normalizeEffortOption } from "./effort";

describe("EFFORT_OPTIONS", () => {
  it("四档制：low/medium/high/max = 快速/均衡/进阶/极致", () => {
    expect(EFFORT_OPTIONS).toEqual([
      { value: "low", label: "快速" },
      { value: "medium", label: "均衡" },
      { value: "high", label: "进阶" },
      { value: "max", label: "极致" },
    ]);
  });
});

describe("effortLabel", () => {
  it("四档制直映", () => {
    expect(effortLabel("low")).toBe("快速");
    expect(effortLabel("medium")).toBe("均衡");
    expect(effortLabel("high")).toBe("进阶");
    expect(effortLabel("max")).toBe("极致");
  });

  it("历史遗留 xhigh 归一到极致（API 仍可能回报）", () => {
    expect(effortLabel("xhigh")).toBe("极致");
  });

  it("未知值原样大写返回（如 API 回报的新档位）", () => {
    expect(effortLabel("ultra")).toBe("ULTRA");
  });

  it("大小写不敏感", () => {
    expect(effortLabel("LOW")).toBe("快速");
    expect(effortLabel("MEDIUM")).toBe("均衡");
    expect(effortLabel("XHigh")).toBe("极致");
  });
});

describe("normalizeEffortOption", () => {
  it("合法四档值直返", () => {
    expect(normalizeEffortOption("low")).toBe("low");
    expect(normalizeEffortOption("medium")).toBe("medium");
    expect(normalizeEffortOption("high")).toBe("high");
    expect(normalizeEffortOption("max")).toBe("max");
  });

  it("历史 xhigh→max（保留深度意图）", () => {
    expect(normalizeEffortOption("xhigh")).toBe("max");
  });

  it("非法/空值 → high（选择器没有默认档，默认就落进阶）", () => {
    expect(normalizeEffortOption("")).toBe("high");
    expect(normalizeEffortOption(undefined)).toBe("high");
    expect(normalizeEffortOption(null)).toBe("high");
    expect(normalizeEffortOption("banana")).toBe("high");
  });

  it("空白与大写归一", () => {
    expect(normalizeEffortOption("  Max  ")).toBe("max");
    expect(normalizeEffortOption("  MEDIUM  ")).toBe("medium");
  });
});
