// @vitest-environment node
import { describe, it, expect } from "vitest";
import { diffLines, ReadBaselines, renderSinceLast } from "./readDiff.js";

describe("diffLines", () => {
  it("只报变了的行，保持顺序", () => {
    const d = diffLines("a\nb\nc\nd", "a\nB\nc\nd\ne")!;
    expect(d.lines).toEqual(["+ B", "- b", "+ e"]);
    expect(d).toMatchObject({ added: 2, removed: 1 });
  });

  it("中间段过大 → null（不做 n·m 的表）", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n");
    expect(diffLines(a, b)).toBeNull();
  });
});

describe("renderSinceLast", () => {
  it("三种情形各自可辨：无底稿给全量 / 没变化 / 变化行", () => {
    expect(renderSinceLast(undefined, "x", "FULL")).toContain("no earlier browser_read");
    expect(renderSinceLast(undefined, "x", "FULL")).toContain("FULL");
    expect(renderSinceLast("x", "x", "FULL")).toContain("No changes");
    const s = renderSinceLast("| 待发布 |", "| 已发布 |", "FULL");
    expect(s).toContain("- | 待发布 |");
    expect(s).toContain("+ | 已发布 |");
    expect(s).not.toContain("FULL");
  });
});

describe("ReadBaselines", () => {
  it("include_hidden 两种口径各记各的", () => {
    const b = new ReadBaselines();
    b.set("v1", false, "R");
    b.set("v1", true, "H");
    expect(b.get("v1", false)).toBe("R");
    expect(b.get("v1", true)).toBe("H");
  });

  it("有上限，淘汰最久没更新的", () => {
    const b = new ReadBaselines();
    for (let i = 0; i < 40; i++) b.set(`v${i}`, false, String(i));
    expect(b.get("v0", false)).toBeUndefined();
    expect(b.get("v39", false)).toBe("39");
  });
});
