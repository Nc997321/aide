import { describe, it, expect } from "vitest";
import { buildChangeTree } from "./changeTree";
import type { ChangeFile } from "../types";

function f(path: string, additions = 1, deletions = 0, status = "M"): ChangeFile {
  return { path, additions, deletions, status };
}

describe("buildChangeTree", () => {
  it("空列表 → 空树", () => {
    expect(buildChangeTree([])).toEqual([]);
  });

  it("根级文件 → 单文件节点", () => {
    const tree = buildChangeTree([f("README.md")]);
    expect(tree).toHaveLength(1);
    expect(tree[0].kind).toBe("file");
    if (tree[0].kind === "file") {
      expect(tree[0].name).toBe("README.md");
      expect(tree[0].file.path).toBe("README.md");
    }
  });

  it("嵌套路径建树，目录在前文件在后，各自按名排序", () => {
    const tree = buildChangeTree([f("zeta.ts"), f("src/b.ts"), f("src/a.ts"), f("lib/x.ts")]);
    expect(tree.map((n) => (n.kind === "dir" ? `d:${n.name}` : `f:${n.name}`))).toEqual([
      "d:lib",
      "d:src",
      "f:zeta.ts",
    ]);
    const src = tree[1];
    if (src.kind !== "dir") throw new Error("unreachable");
    expect(src.children.map((n) => (n.kind === "file" ? n.name : ""))).toEqual(["a.ts", "b.ts"]);
  });

  it("单链目录自动合并：a/b/c/file.rs → 一行目录 a/b/c + 文件", () => {
    const tree = buildChangeTree([f("a/b/c/file.rs")]);
    expect(tree).toHaveLength(1);
    const node = tree[0];
    expect(node.kind).toBe("dir");
    if (node.kind !== "dir") throw new Error("unreachable");
    expect(node.name).toBe("a/b/c");
    expect(node.path).toBe("a/b/c");
    expect(node.children).toHaveLength(1);
    expect(node.children[0].kind).toBe("file");
  });

  it("单链在分叉处停止合并：a/b/f1 + a/c/f2 → 目录 a/b 与 a/c 并列", () => {
    const tree = buildChangeTree([f("a/b/f1"), f("a/c/f2")]);
    expect(tree).toHaveLength(1);
    const a = tree[0];
    if (a.kind !== "dir") throw new Error("unreachable");
    expect(a.name).toBe("a");
    expect(a.children.map((n) => (n.kind === "dir" ? n.name : ""))).toEqual(["b", "c"]);
  });

  it("目录节点只带名称/路径/子节点（不做行数聚合统计）", () => {
    const tree = buildChangeTree([
      f("a/b/x.ts", 10, 2),
      f("a/c/y.ts", 3, 5),
      f("a/top.ts", 1, 1),
    ]);
    const a = tree[0];
    if (a.kind !== "dir") throw new Error("unreachable");
    expect(a.name).toBe("a");
    expect("additions" in a).toBe(false);
    expect("deletions" in a).toBe(false);
    expect(a.children).toHaveLength(3);
  });

  it("Windows 反斜杠路径兼容（分割用，file.path 原样保留）", () => {
    const tree = buildChangeTree([{ path: "src\\composables\\useX.ts", additions: 1, deletions: 0, status: "A" }]);
    expect(tree).toHaveLength(1);
    const d = tree[0];
    if (d.kind !== "dir") throw new Error("unreachable");
    expect(d.name).toBe("src/composables");
    expect(d.children[0].kind).toBe("file");
    if (d.children[0].kind === "file") {
      expect(d.children[0].file.path).toBe("src\\composables\\useX.ts");
    }
  });

  it("同名文件（不同目录）各自成节点，排序稳定", () => {
    const tree = buildChangeTree([f("mod/a.ts"), f("pkg/a.ts")]);
    const names = tree.map((n) => (n.kind === "dir" ? n.name : n.name));
    expect(names).toEqual(["mod", "pkg"]);
    for (const n of tree) {
      if (n.kind === "dir") {
        expect(n.children[0].kind).toBe("file");
        if (n.children[0].kind === "file") expect(n.children[0].file.path).toBe(`${n.name}/a.ts`);
      }
    }
  });
});
