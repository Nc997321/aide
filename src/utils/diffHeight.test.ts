import { describe, expect, it } from "vitest";
import { estimateDiffHeight } from "./diffHeight";
import { makePair } from "./changeCard";

/** n 行文本（内容不重要，只看行数） */
function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `l${i}`).join("\n");
}

describe("estimateDiffHeight", () => {
  it("矮片段取 120 下限（工具栏 + 内边距仍放得下）", () => {
    expect(estimateDiffHeight(makePair("a", "b", "modified"), 13)).toBe(120);
  });

  it("按较多一侧的行数线性增长（每行 = round(字号 × 1.6)）", () => {
    // 13 × 1.6 = 20.8 → 21；38(工具栏) + 10 × 21 + 16(内边距)
    expect(estimateDiffHeight(makePair(lines(10), "b", "modified"), 13)).toBe(38 + 210 + 16);
    // old/new 取行数大的一侧：新内容更长时不能被旧内容低估
    expect(estimateDiffHeight(makePair("b", lines(10), "modified"), 13)).toBe(38 + 210 + 16);
  });

  it("超高封顶 480（再高靠容器内滚）", () => {
    expect(estimateDiffHeight(makePair(lines(500), lines(500), "modified"), 13)).toBe(480);
  });
});
