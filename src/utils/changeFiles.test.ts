import { describe, it, expect } from "vitest";
import { mergeChangeFiles } from "./changeFiles";
import type { ChangeFile, ChangeRound } from "../types";

const f = (path: string, status: string, additions: number, deletions: number): ChangeFile => ({
  path,
  status,
  additions,
  deletions,
});

const r = (index: number, files: ChangeFile[]): ChangeRound => ({
  index,
  time: "10:00",
  files,
});

describe("mergeChangeFiles — 顶部统一树的输入（全会话累计）", () => {
  it("跨轮同路径合并一条：行数累加、状态取最新一轮", () => {
    const out = mergeChangeFiles([r(1, [f("a.ts", "A", 3, 0)]), r(2, [f("a.ts", "M", 2, 1)])]);
    expect(out).toEqual([f("a.ts", "M", 5, 1)]);
  });

  it("不同路径各自成条，互不干扰", () => {
    const out = mergeChangeFiles([r(1, [f("a.ts", "M", 1, 0)]), r(2, [f("b.ts", "A", 2, 0)])]);
    expect(out).toHaveLength(2);
  });

  it("空轮次 / 全空轮 → 空数组（顶部树整块不渲染）", () => {
    expect(mergeChangeFiles([])).toEqual([]);
    expect(mergeChangeFiles([r(1, [])])).toEqual([]);
  });

  it("不修改入参（合并结果是新对象，rounds 的 files 不被就地累加）", () => {
    const rounds = [r(1, [f("a.ts", "M", 1, 0)]), r(2, [f("a.ts", "M", 2, 0)])];
    mergeChangeFiles(rounds);
    expect(rounds[0].files[0].additions).toBe(1);
  });
});
