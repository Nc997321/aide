import { describe, expect, it } from "vitest";
import { barSegments, formatCount, roundStats } from "./turnChangeStats";
import type { ChangeFile } from "@/types";

const f = (path: string, status: string, additions: number, deletions: number): ChangeFile => ({
  path, status, additions, deletions,
});

describe("roundStats — 一轮的规模", () => {
  it("文件数 + 逐文件累加的行数", () => {
    expect(roundStats([f("a.ts", "M", 200, 1), f("b.ts", "A", 3, 1)])).toEqual({
      files: 2, additions: 203, deletions: 2,
    });
  });

  it("空轮 → 全 0（卡片据此整卡不渲染）", () => {
    expect(roundStats([])).toEqual({ files: 0, additions: 0, deletions: 0 });
  });

  it("纯新增轮：deletions 为 0，不做任何补位", () => {
    expect(roundStats([f("a.ts", "A", 64, 0)])).toEqual({ files: 1, additions: 64, deletions: 0 });
  });
});

describe("formatCount — 千分位仅 ≥4 位时出现", () => {
  it("三位数不加分隔", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
  });

  it("四位数起加逗号", () => {
    expect(formatCount(1000)).toBe("1,000");
    expect(formatCount(1240)).toBe("1,240");
  });

  it("大数按三位分段", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
  });
});

describe("barSegments — 长度恒定，只表达增删比例", () => {
  it("两段都非零 → 绿红各一段，flex 取原始行数（不是百分比）", () => {
    expect(barSegments(roundStats([f("a.ts", "M", 203, 2)]))).toEqual([
      { kind: "add", flex: 203 },
      { kind: "del", flex: 2 },
    ]);
  });

  it("纯新增轮 → 只有绿段（不产生空红段）", () => {
    expect(barSegments({ files: 1, additions: 64, deletions: 0 })).toEqual([{ kind: "add", flex: 64 }]);
  });

  it("纯删除轮 → 只有红段", () => {
    expect(barSegments({ files: 1, additions: 0, deletions: 5 })).toEqual([{ kind: "del", flex: 5 }]);
  });

  it("全零（改了文件但 0 行）→ 无分段，只剩轨道", () => {
    expect(barSegments({ files: 1, additions: 0, deletions: 0 })).toEqual([]);
  });
});
