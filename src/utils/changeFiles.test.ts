import { describe, it, expect } from "vitest";
import { asTouchedFile, mergeChangeFiles, roundRows } from "./changeFiles";
import type { ChangeFile, ChangeRound, TouchedFile } from "../types";

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

describe("roundRows / asTouchedFile — 轮内展示行的形状补齐", () => {
  it("内存轮有片段：原样用 touches（点开 = 本轮精确 diff）", () => {
    const touched: TouchedFile[] = [
      { path: "a.ts", status: "M", additions: 1, deletions: 1, segments: [{ oldText: "a", newText: "b", addCount: 1, delCount: 1 }] },
    ];
    expect(roundRows({ ...r(1, [f("a.ts", "M", 1, 1)]), touches: touched })).toBe(touched);
  });

  it("历史轮（磁盘加载，无 touches）：files 补齐空片段，走累计视图", () => {
    expect(roundRows(r(1, [f("a.ts", "M", 3, 2)]))).toEqual([
      { path: "a.ts", status: "M", additions: 3, deletions: 2, segments: [] },
    ]);
  });

  it("asTouchedFile 不修改原条目（落盘投影是共享对象）", () => {
    const file = f("a.ts", "M", 1, 0);
    asTouchedFile(file);
    expect(file).not.toHaveProperty("segments");
  });
});
