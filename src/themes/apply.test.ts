import { describe, it, expect } from "vitest";
import { cssVarName } from "./apply";

describe("cssVarName", () => {
  it("camelCase → --aide-kebab", () => {
    expect(cssVarName("bgDeep")).toBe("--aide-bg-deep");
    expect(cssVarName("highlightInset")).toBe("--aide-highlight-inset");
    expect(cssVarName("easeT")).toBe("--aide-ease-t");
    expect(cssVarName("surfaceBlur")).toBe("--aide-surface-blur");
    expect(cssVarName("accent")).toBe("--aide-accent");
    // 用量分段色板（chart1~5 数字无驼峰边界不插横线；chartFallback 正常 kebab）
    expect(cssVarName("chart1")).toBe("--aide-chart1");
    expect(cssVarName("chart4")).toBe("--aide-chart4");
    expect(cssVarName("chartFallback")).toBe("--aide-chart-fallback");
  });
});
