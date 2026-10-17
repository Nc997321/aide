import { describe, expect, it } from "vitest";
import { autoGrowHeight } from "./useAutoGrow";

const limits = { lineHeight: 20, paddingY: 10, maxLines: 12, containerHeight: 2000, maxRatio: 0.4 };

describe("autoGrowHeight", () => {
  it("一行内容：高度即内容高度，不滚动", () => {
    expect(autoGrowHeight(30, limits)).toEqual({ height: 30, scroll: false });
  });

  it("超过 12 行：封顶在 12 行，内部滚动", () => {
    expect(autoGrowHeight(600, limits)).toEqual({ height: 250, scroll: true });
  });

  it("矮面板：按面板高度 40% 封顶", () => {
    expect(autoGrowHeight(600, { ...limits, containerHeight: 400 })).toEqual({ height: 160, scroll: true });
  });

  it("面板极矮也至少留一行", () => {
    expect(autoGrowHeight(600, { ...limits, containerHeight: 20 }).height).toBe(30);
  });
});
