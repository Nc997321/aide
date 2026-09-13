// 扁平文档列表 → 树查询（纯函数）。
//
// 侧栏缩进（depthOf）与删除确认弹窗（subtreeSize）共用本模块：同一个「这棵树长什么样」
// 的问题若在两处各算一遍，迟早会漂移——侧栏缩进显示 3 篇、弹窗说「将连带删除 2 篇」。
import { describe, it, expect } from "vitest";
import { depthOf, subtreeSize } from "./docTree";
import type { KbDocumentSummary } from "./kbClient";

/** 造摘要：本模块只关心 id / parentId，其余字段给足类型即可。 */
function doc(id: string, parentId: string | null = null): KbDocumentSummary {
  return {
    id,
    parentId,
    slug: id,
    title: id,
    versionNo: 1,
    status: "draft",
    updatedAt: "2026-09-13T00:00:00Z",
  };
}

describe("depthOf", () => {
  it("顶层 0，逐层 +1", () => {
    const docs = [doc("a"), doc("b", "a"), doc("c", "b")];
    expect(depthOf(docs)).toEqual({ a: 0, b: 1, c: 2 });
  });

  it("超过 3 层按 3 封顶（长链不再往右推）", () => {
    const docs = [doc("a"), doc("b", "a"), doc("c", "b"), doc("d", "c"), doc("e", "d")];
    expect(depthOf(docs)).toEqual({ a: 0, b: 1, c: 2, d: 3, e: 3 });
  });

  it("父不在列表里（孤儿）按顶层算，不抛", () => {
    expect(depthOf([doc("a", "缺")])).toEqual({ a: 0 });
  });
});

describe("subtreeSize", () => {
  it("叶子（没有子文档）= 1，即它自己", () => {
    expect(subtreeSize([doc("a")], "a")).toBe(1);
  });

  it("整棵子树：父 + 2 子 + 1 孙 = 4", () => {
    const docs = [doc("p"), doc("c1", "p"), doc("c2", "p"), doc("g", "c1")];
    expect(subtreeSize(docs, "p")).toBe(4);
  });

  it("只数自己这一支，兄弟子树不计入", () => {
    const docs = [doc("p"), doc("c1", "p"), doc("c2", "p"), doc("g", "c1")];
    expect(subtreeSize(docs, "c1")).toBe(2);
    expect(subtreeSize(docs, "c2")).toBe(1);
  });

  it("id 不在列表里 → 0（列表是当前空间的视图，可能已不含它）", () => {
    expect(subtreeSize([doc("a")], "不在")).toBe(0);
  });

  it("父子成环也不死循环（数据畸形时宁可少数，不能挂住 UI）", () => {
    expect(subtreeSize([doc("a", "b"), doc("b", "a")], "a")).toBe(2);
  });
});
