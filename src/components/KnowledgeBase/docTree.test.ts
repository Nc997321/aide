// 扁平文档列表 → 树（纯函数，不依赖 Vue）。
//
// 本模块是这份「树」的唯一算法产地：侧栏渲染、折叠、删除确认、搜索跳转全从这里取数。
// 各算各的迟早漂移——侧栏缩进看着是 4 篇，弹窗却说「将连带删除 2 篇」。
import { describe, it, expect } from "vitest";
import { buildTree, flatten, ancestorIds, depthOf, subtreeSize } from "./docTree";
import type { KbDocumentSummary } from "./kbClient";

/** 造摘要：本模块只关心 id / parentId / kind / title，其余字段给足类型即可。 */
function doc(
  id: string,
  parentId: string | null = null,
  kind: "doc" | "folder" = "doc",
): KbDocumentSummary {
  return {
    id,
    parentId,
    kind,
    slug: id,
    title: id,
    versionNo: kind === "folder" ? 0 : 1,
    status: "draft",
    updatedAt: "2026-09-18T00:00:00Z",
  };
}

const folder = (id: string, parentId: string | null = null) => doc(id, parentId, "folder");

describe("buildTree", () => {
  it("父在列表里就挂进去，层级正确", () => {
    const tree = buildTree([folder("f"), doc("a", "f"), doc("b", "a")]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.doc.id).toBe("f");
    expect(tree[0]!.children[0]!.doc.id).toBe("a");
    expect(tree[0]!.children[0]!.children[0]!.doc.id).toBe("b");
  });

  it("父不在列表里（父不可读 / 已删）→ 提升为根，绝不能消失", () => {
    const tree = buildTree([doc("a", "看不见的父")]);
    expect(tree.map((n) => n.doc.id)).toEqual(["a"]);
  });

  it("父子成环 → 不死循环，节点不丢也不重复", () => {
    const tree = buildTree([doc("a", "b"), doc("b", "a")]);
    const seen = new Set<string>();
    const walk = (ns: typeof tree): void => {
      for (const n of ns) {
        expect(seen.has(n.doc.id)).toBe(false); // 每个节点最多出现一次
        seen.add(n.doc.id);
        walk(n.children);
      }
    };
    walk(tree);
    expect(seen.size).toBe(2);
  });

  it("指向自己的节点当孤儿处理，不会挂死", () => {
    const tree = buildTree([doc("a", "a")]);
    expect(tree.map((n) => n.doc.id)).toEqual(["a"]);
  });

  it("同级排序：文件夹优先，其余按名称", () => {
    const tree = buildTree([doc("z", null), folder("a"), doc("a", null), folder("z")]);
    // title 就是 id，所以名称序 = a < z
    expect(tree.map((n) => n.doc.id)).toEqual(["a", "z", "a", "z"]);
    expect(tree.map((n) => n.isFolder)).toEqual([true, true, false, false]);
  });

  it("kind 缺省按文档处理（老数据 / 老服务端）", () => {
    const bare = {
      id: "x",
      parentId: null,
      slug: "x",
      title: "x",
      versionNo: 1,
      status: "draft",
      updatedAt: "",
    };
    expect(buildTree([bare])[0]!.isFolder).toBe(false);
  });
});

describe("flatten", () => {
  const tree = buildTree([folder("f"), doc("a", "f"), folder("g", "f"), doc("b", "g")]);

  it("默认全展开，深度递增；同级内文件夹排在文档之前", () => {
    // f 的子节点是 g（文件夹）与 a（文档）→ g 在前，而深度优先会先把 g 那一支走完
    expect(flatten(tree, new Set()).map((r) => [r.doc.id, r.depth])).toEqual([
      ["f", 0],
      ["g", 1],
      ["b", 2],
      ["a", 1],
    ]);
  });

  it("折叠父节点 → 整棵子树不产出", () => {
    expect(flatten(tree, new Set(["f"])).map((r) => r.doc.id)).toEqual(["f"]);
  });

  it("折叠只影响自己那一支", () => {
    expect(flatten(tree, new Set(["g"])).map((r) => r.doc.id)).toEqual(["f", "g", "a"]);
  });

  it("hasChildren 反映的是有没有子节点，与折叠状态无关", () => {
    const rows = flatten(tree, new Set());
    expect(rows.find((r) => r.doc.id === "a")?.hasChildren).toBe(false);
    expect(rows.find((r) => r.doc.id === "f")?.hasChildren).toBe(true);
  });
});

describe("ancestorIds", () => {
  it("从最近的父开始列到根", () => {
    const docs = [folder("f"), folder("g", "f"), doc("b", "g")];
    expect(ancestorIds(docs, "b")).toEqual(["g", "f"]);
  });

  it("根节点没有祖先", () => {
    expect(ancestorIds([doc("a")], "a")).toEqual([]);
  });

  it("成环时原地停下（数据畸形也不能挂住 UI）", () => {
    expect(ancestorIds([doc("a", "b"), doc("b", "a")], "a")).toEqual(["b"]);
  });
});

describe("depthOf", () => {
  it("顶层 0，逐层 +1", () => {
    const docs = [folder("a"), doc("b", "a"), doc("c", "b")];
    expect(depthOf(docs)).toEqual({ a: 0, b: 1, c: 2 });
  });

  it("不再封顶——超过 3 层继续往右推（本版来了真正的树）", () => {
    const docs = [folder("a"), folder("b", "a"), folder("c", "b"), folder("d", "c"), doc("e", "d")];
    expect(depthOf(docs)).toEqual({ a: 0, b: 1, c: 2, d: 3, e: 4 });
  });

  it("父不在列表里（孤儿）按顶层算，不抛", () => {
    expect(depthOf([doc("a", "缺")])).toEqual({ a: 0 });
  });
});

describe("subtreeSize", () => {
  it("叶子（没有子节点）= 1，即它自己", () => {
    expect(subtreeSize([doc("a")], "a")).toBe(1);
  });

  it("整棵子树：父 + 2 子 + 1 孙 = 4", () => {
    const docs = [doc("p"), doc("c1", "p"), doc("c2", "p"), doc("g", "c1")];
    expect(subtreeSize(docs, "p")).toBe(4);
  });

  it("文件夹连同里面的东西一起算（删除确认弹窗要的数）", () => {
    const docs = [folder("f"), doc("a", "f"), folder("g", "f"), doc("b", "g")];
    expect(subtreeSize(docs, "f")).toBe(4);
    expect(subtreeSize(docs, "g")).toBe(2);
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
