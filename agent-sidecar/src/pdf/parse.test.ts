import { describe, it, expect } from "vitest";
import { layoutPage, parsePagesSpec, classifyPdfError } from "./parse.js";
import { PDF_MAX_PAGES_PER_READ } from "./constants.js";

/** 构造 TextItemLike：str + x/y 坐标（PDF y 从下往上，y 大者在上） */
function item(str: string, x: number, y: number, w = str.length * 5): unknown {
  return { str, transform: [1, 0, 0, 1, x, y], width: w, height: 10 };
}

describe("layoutPage", () => {
  it("sorts lines top-to-bottom (PDF y is bottom-up), items left-to-right within a line", () => {
    const items = [
      item("bottom", 0, 10),
      item("top", 10, 100),
      item("middle", 0, 50),
      item("B", 30, 100),
      item("A", 0, 100),
    ];
    expect(layoutPage(items)).toBe("A top B\nmiddle\nbottom");
  });

  it("filters empty items", () => {
    expect(layoutPage([item("", 0, 100), item("   ", 0, 50), item("x", 0, 10)])).toBe("x");
  });

  it("inserts a space when x gap exceeds PDF_COLUMN_GAP (table columns)", () => {
    // 同一行：第一项宽 20（x=0..20），第二项 x=30 → 间隙 10 > 4 → 插空格
    const items = [item("col1", 0, 100, 20), item("col2", 30, 100, 20)];
    expect(layoutPage(items)).toBe("col1 col2");
  });

  it("does not insert a space for small gaps (continuous text)", () => {
    const items = [item("你好", 0, 100, 40), item("世界", 42, 100, 40)];
    expect(layoutPage(items)).toBe("你好世界");
  });

  it("treats items within y tolerance as the same line", () => {
    const items = [item("a", 0, 100), item("b", 10, 99.5)];
    expect(layoutPage(items)).toBe("a b");
  });
});

describe("parsePagesSpec", () => {
  it("single page", () => {
    expect(parsePagesSpec("3", 10)).toEqual({ ok: true, pages: [3] });
  });

  it("range", () => {
    expect(parsePagesSpec("1-5", 10)).toEqual({ ok: true, pages: [1, 2, 3, 4, 5] });
  });

  it("comma list with mixed ranges", () => {
    expect(parsePagesSpec("1,3,5-7", 10)).toEqual({ ok: true, pages: [1, 3, 5, 6, 7] });
  });

  it("trims whitespace", () => {
    expect(parsePagesSpec(" 2 , 4-5 ", 10)).toEqual({ ok: true, pages: [2, 4, 5] });
  });

  it("rejects out-of-range", () => {
    expect(parsePagesSpec("11", 10).ok).toBe(false);
    expect(parsePagesSpec("0", 10).ok).toBe(false);
    expect(parsePagesSpec("5-3", 10).ok).toBe(false);
  });

  it("rejects invalid format", () => {
    expect(parsePagesSpec("abc", 10).ok).toBe(false);
    expect(parsePagesSpec("1-", 10).ok).toBe(false);
    expect(parsePagesSpec("", 10).ok).toBe(false);
  });

  it("rejects too many pages", () => {
    const spec = `1-${PDF_MAX_PAGES_PER_READ + 1}`;
    expect(parsePagesSpec(spec, PDF_MAX_PAGES_PER_READ + 5).ok).toBe(false);
  });
});

describe("classifyPdfError", () => {
  it("password message → encrypted", () => {
    expect(classifyPdfError(new Error("Invalid password"))).toMatchObject({ reason: "encrypted" });
  });

  it("invalid pdf message → not_pdf", () => {
    expect(classifyPdfError(new Error("Invalid PDF structure"))).toMatchObject({ reason: "not_pdf" });
    expect(classifyPdfError(new Error("not a pdf"))).toMatchObject({ reason: "not_pdf" });
  });

  it("anything else → unknown", () => {
    expect(classifyPdfError(new Error("boom"))).toMatchObject({ reason: "unknown", detail: "boom" });
    expect(classifyPdfError("string error")).toMatchObject({ reason: "unknown" });
  });
});
