import { describe, it, expect } from "vitest";
import { parseEditInput, buildEditDiffLines } from "./editDiff";

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

describe("buildEditDiffLines", () => {
  it("old 行标 del、new 行标 add，文本不含 +/− 前缀（无 sign 字段）", () => {
    const r = buildEditDiffLines({ file_path: "a.ts", old_string: "foo\nbar", new_string: "baz" });
    expect(r.lines).toEqual([
      { text: "foo", cls: "aide-diff-del" },
      { text: "bar", cls: "aide-diff-del" },
      { text: "baz", cls: "aide-diff-add" },
    ]);
    expect(r.delCount).toBe(2);
    expect(r.addCount).toBe(1);
  });
});
