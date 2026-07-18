import { describe, it, expect } from "vitest";
import { MONO_FONT_STACK, resolveFontFamily } from "./fonts";

describe("resolveFontFamily", () => {
  it("未设置 → 新默认 JetBrains Mono 栈", () => {
    expect(resolveFontFamily(undefined)).toBe(MONO_FONT_STACK);
    expect(resolveFontFamily(null)).toBe(MONO_FONT_STACK);
  });
  it("存量旧默认字面量 → 迁移到新默认", () => {
    expect(resolveFontFamily("'Cascadia Code', 'Fira Code', 'Consolas', monospace")).toBe(MONO_FONT_STACK);
  });
  it("用户自定义 → 保留", () => {
    expect(resolveFontFamily("'Fira Code', monospace")).toBe("'Fira Code', monospace");
  });
});
