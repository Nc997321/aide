import { describe, expect, it } from "vitest";
import { mergeLineRects } from "./layoutRects";

describe("mergeLineRects", () => {
  it("同一行被加粗/链接切开的碎片并成一条", () => {
    const out = mergeLineRects([
      { x: 0, y: 10, w: 50, h: 20 },
      { x: 50, y: 11, w: 30, h: 19 },
      { x: 80, y: 10, w: 40, h: 20 },
    ]);
    expect(out).toEqual([{ x: 0, y: 10, w: 120, h: 20 }]);
  });

  it("不同行各自一条，按从上到下排序", () => {
    const out = mergeLineRects([
      { x: 0, y: 40, w: 100, h: 20 },
      { x: 0, y: 10, w: 100, h: 20 },
    ]);
    expect(out.map((r) => r.y)).toEqual([10, 40]);
  });

  it("同一行但中间隔着一大段空白（不相接）不合并", () => {
    expect(mergeLineRects([{ x: 0, y: 0, w: 20, h: 20 }, { x: 200, y: 0, w: 20, h: 20 }])).toHaveLength(2);
  });

  it("空输入 → 空数组；不改入参", () => {
    expect(mergeLineRects([])).toEqual([]);
    const input = [{ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }];
    mergeLineRects(input);
    expect(input).toEqual([{ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }]);
  });
});
