import { describe, expect, it } from "vitest";
import { joinLines, mergeLineRects } from "./layoutRects";

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

describe("joinLines（把行距造成的缝接上）", () => {
  it("相邻两行之间的缝被合上：上一行向下延伸到下一行的顶边", () => {
    const out = joinLines([
      { x: 0, y: 0, w: 100, h: 22 },
      { x: 0, y: 25, w: 100, h: 22 },
      { x: 0, y: 50, w: 60, h: 22 },
    ]);
    expect(out.map((r) => r.h)).toEqual([25, 25, 22]);
    expect(out[0]!.y + out[0]!.h).toBe(out[1]!.y);
  });

  it("缝太大（不是行距，比如两个不相连的段落）不接", () => {
    const out = joinLines([{ x: 0, y: 0, w: 100, h: 22 }, { x: 0, y: 120, w: 100, h: 22 }]);
    expect(out[0]!.h).toBe(22);
  });

  it("上下重叠（缝为负）与空输入不动；不改入参", () => {
    const input = [{ x: 0, y: 0, w: 10, h: 30 }, { x: 0, y: 20, w: 10, h: 10 }];
    expect(joinLines(input)[0]!.h).toBe(30);
    expect(joinLines([])).toEqual([]);
    expect(input[0]!.h).toBe(30);
  });
});
