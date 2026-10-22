import { describe, it, expect } from "vitest";
import {
  DEFAULT_MAX_SHOWS,
  DISMISSED_SHOWS,
  TIPS,
  isTipActive,
  nextThinkingTip,
  slotTip,
  tipSegments,
  type TipState,
  type UsageTip,
} from "./usageTips";

const fresh: TipState = { shown: {}, used: [] };

const pool: UsageTip[] = [
  { id: "a", slot: "thinking", text: "A", retiredBy: "btw" },
  { id: "b", slot: "thinking", text: "B" },
  { id: "c", slot: "thinking", text: "C", maxShows: 1 },
  { id: "x", slot: "busy-typing", text: "X", retiredBy: "btw" },
];

describe("usageTips", () => {
  it("id 唯一（计数按 id 记，撞 id 会让两条共用退役进度）", () => {
    const ids = TIPS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("时机提示：看满次数或用过对应功能即退役", () => {
    const a = pool[0];
    expect(isTipActive(a, fresh)).toBe(true);
    expect(isTipActive(a, { shown: { a: DEFAULT_MAX_SHOWS }, used: [] })).toBe(false);
    expect(isTipActive(a, { shown: {}, used: ["btw"] })).toBe(false);
    expect(isTipActive(pool[2], { shown: { c: 1 }, used: [] })).toBe(false);
  });

  const rotate = (state: TipState, n: number) => {
    const seen: string[] = [];
    let cur: string | null = null;
    for (let i = 0; i < n; i++) {
      const t = nextThinkingTip(state, cur, pool);
      if (!t) break;
      seen.push(t.id);
      cur = t.id;
      state = { ...state, shown: { ...state.shown, [t.id]: (state.shown[t.id] ?? 0) + 1 } };
    }
    return seen;
  };

  it("新用户按表序出场，之后挑出场最少的——计数自增即自然轮转", () => {
    expect(rotate(fresh, 6)).toEqual(["a", "b", "c", "a", "b", "c"]);
  });

  it("思考轮播永不用完：看满次数（含 maxShows）照样轮", () => {
    const state: TipState = { shown: { a: 50, b: 50, c: 50 }, used: [] };
    expect(rotate(state, 3)).toEqual(["a", "b", "c"]);
  });

  it("用过的功能降频而不消失：其它条出两次它出一次", () => {
    const seen = rotate({ shown: {}, used: ["btw"] }, 30);
    const count = (id: string) => seen.filter((x) => x === id).length;
    expect(count("a")).toBeGreaterThan(0);
    expect(count("a")).toBeLessThan(count("b"));
  });

  it("点过「知道了」的不再出；只剩一条时允许连着出", () => {
    const state: TipState = { shown: { b: DISMISSED_SHOWS, c: DISMISSED_SHOWS }, used: ["btw"] };
    expect(nextThinkingTip(state, "a", pool)?.id).toBe("a");
    expect(nextThinkingTip({ ...state, shown: { ...state.shown, a: DISMISSED_SHOWS } }, null, pool)).toBeNull();
  });

  it("时机提示按 slot 取在役的第一条", () => {
    expect(slotTip("busy-typing", fresh, pool)?.id).toBe("x");
    expect(slotTip("busy-typing", { shown: {}, used: ["btw"] }, pool)).toBeNull();
    expect(slotTip("context-high", fresh, pool)).toBeNull();
  });

  it("反引号段切成行内代码", () => {
    expect(tipSegments("用 `/btw` 不打断")).toEqual([
      { code: false, text: "用 " },
      { code: true, text: "/btw" },
      { code: false, text: " 不打断" },
    ]);
    expect(tipSegments("`Ctrl+N` 新建会话")).toEqual([
      { code: true, text: "Ctrl+N" },
      { code: false, text: " 新建会话" },
    ]);
  });
});
