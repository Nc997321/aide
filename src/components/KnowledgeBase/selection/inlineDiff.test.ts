import { describe, expect, it } from "vitest";
import { inlineDiff } from "./inlineDiff";

describe("inlineDiff", () => {
  it("只标出中间不同的一截", () => {
    expect(inlineDiff("发布帐号统一使用", "发布账号统一使用")).toEqual({ same1: "发布", del: "帐", ins: "账", same2: "号统一使用" });
  });
  it("完全相同：删增都为空", () => {
    const d = inlineDiff("abc", "abc");
    expect([d.del, d.ins]).toEqual(["", ""]);
    expect(d.same1 + d.same2).toBe("abc");
  });
  it("纯插入 / 纯删除（前后缀不重叠）", () => {
    expect(inlineDiff("ab", "aXb")).toEqual({ same1: "a", del: "", ins: "X", same2: "b" });
    expect(inlineDiff("aXb", "ab")).toEqual({ same1: "a", del: "X", ins: "", same2: "b" });
  });
  it("全换：前后缀为空", () => {
    expect(inlineDiff("甲", "乙")).toEqual({ same1: "", del: "甲", ins: "乙", same2: "" });
  });
});
