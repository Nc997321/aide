import { describe, it, expect } from "vitest";
import { cssVarName } from "./apply";

describe("cssVarName", () => {
  it("camelCase → --aide-kebab", () => {
    expect(cssVarName("bgDeep")).toBe("--aide-bg-deep");
    expect(cssVarName("highlightInset")).toBe("--aide-highlight-inset");
    expect(cssVarName("easeT")).toBe("--aide-ease-t");
    expect(cssVarName("surfaceBlur")).toBe("--aide-surface-blur");
    expect(cssVarName("accent")).toBe("--aide-accent");
  });
});
