import { describe, it, expect } from "vitest";
import { diffNotice, MAX_DIFF_SIZE } from "./diffNotice";
import type { DiffPair } from "../types";

const pair = (over: Partial<DiffPair> = {}): DiffPair => ({
  oldText: "a\n",
  newText: "b\n",
  oldLabel: "HEAD",
  newLabel: "当前",
  status: "modified",
  isBinary: false,
  eolOnly: false,
  tooBig: false,
  ...over,
});

describe("diffNotice（diff 视图的不渲染判定）", () => {
  it("正常 pair：null（照常渲染）", () => {
    expect(diffNotice(pair())).toBeNull();
  });

  it("仅行尾不同：说法里带上旧侧标签", () => {
    expect(diffNotice(pair({ eolOnly: true }))).toBe("内容与 HEAD 无差异（仅行尾不同）");
  });

  it("二进制：明说无法对比", () => {
    expect(diffNotice(pair({ isBinary: true }))).toBe("二进制文件无法对比");
  });

  it("标记 tooBig 或任一超过 1MB：都走「文件过大」", () => {
    expect(diffNotice(pair({ tooBig: true }))).toContain("文件过大");
    expect(diffNotice(pair({ newText: "x".repeat(MAX_DIFF_SIZE + 1) }))).toContain("文件过大");
  });
});
