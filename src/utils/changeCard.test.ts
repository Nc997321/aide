import { describe, expect, it } from "vitest";
import { buildChangeInfo, parseEditInput } from "./changeCard";

describe("parseEditInput", () => {
  it("字段齐全返回对象", () => {
    expect(parseEditInput({ file_path: "a.ts", old_string: "x", new_string: "y" })).toEqual({
      file_path: "a.ts",
      old_string: "x",
      new_string: "y",
    });
  });
  it("缺字段或非法输入返回 null", () => {
    expect(parseEditInput({ file_path: "a.ts" })).toBeNull();
    expect(parseEditInput(null)).toBeNull();
    expect(parseEditInput("x")).toBeNull();
  });
});

describe("buildChangeInfo", () => {
  it("Edit → modified 片段对 + 按行统计", () => {
    const info = buildChangeInfo("Edit", {
      file_path: "/a/b.rs",
      old_string: "x = 1\ny = 2",
      new_string: "x = 3",
    });
    expect(info).toMatchObject({
      filePath: "/a/b.rs",
      addCount: 1,
      delCount: 2,
      anchor: "x = 3",
    });
    expect(info?.pair).toMatchObject({ oldText: "x = 1\ny = 2", newText: "x = 3", status: "modified" });
  });

  it("Write → added，oldText 为空、delCount 为 0", () => {
    const info = buildChangeInfo("Write", { file_path: "/n.py", content: "a\nb\nc" });
    expect(info).toMatchObject({ filePath: "/n.py", addCount: 3, delCount: 0 });
    expect(info?.pair).toMatchObject({ oldText: "", newText: "a\nb\nc", status: "added" });
  });

  it("NotebookEdit：old_source 缺省按纯新增处理", () => {
    const info = buildChangeInfo("NotebookEdit", {
      notebook_path: "/nb.ipynb",
      new_source: "print(1)",
    });
    expect(info).toMatchObject({ filePath: "/nb.ipynb", addCount: 1, delCount: 0 });
    expect(info?.pair.status).toBe("modified");
  });

  it("字段缺失 / 非变更工具 → null（回退普通结果展示）", () => {
    expect(buildChangeInfo("Edit", { file_path: "/a" })).toBeNull();
    expect(buildChangeInfo("Write", { file_path: "/a" })).toBeNull();
    expect(buildChangeInfo("NotebookEdit", { notebook_path: "/a" })).toBeNull();
    expect(buildChangeInfo("Read", { file_path: "/a" })).toBeNull();
    expect(buildChangeInfo("Edit", null)).toBeNull();
  });
});
