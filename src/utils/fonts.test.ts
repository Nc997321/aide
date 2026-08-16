import { describe, it, expect } from "vitest";
import { MONO_FONT_STACK, resolveFontFamily, resolveScopedFontFamily } from "./fonts";

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

describe("resolveScopedFontFamily（编辑器/终端字体）", () => {
  const uiFont = "'Sarasa Mono SC', 'PingFang SC', 'Microsoft YaHei', monospace";
  it("新字段未设置（空）→ 回退界面字体", () => {
    expect(resolveScopedFontFamily(undefined, uiFont)).toBe(uiFont);
    expect(resolveScopedFontFamily(null, uiFont)).toBe(uiFont);
    expect(resolveScopedFontFamily("", uiFont)).toBe(uiFont);
  });
  it("界面字体也空 → 默认栈兜底", () => {
    expect(resolveScopedFontFamily(undefined, "")).toBe(MONO_FONT_STACK);
  });
  it("新字段已设置 → 用新字段", () => {
    const v = "'Consolas', 'PingFang SC', 'Microsoft YaHei', monospace";
    expect(resolveScopedFontFamily(v, uiFont)).toBe(v);
  });
  it("新字段是旧默认字面量 → 迁移到新默认", () => {
    expect(resolveScopedFontFamily("'Cascadia Code', 'Fira Code', 'Consolas', monospace", uiFont)).toBe(MONO_FONT_STACK);
  });
});
