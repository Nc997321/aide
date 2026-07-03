import { describe, it, expect } from "vitest";
import { parseEditInput, buildEditDiffLines } from "./editDiff";

describe("parseEditInput", () => {
  it("returns null for non-object input", () => {
    expect(parseEditInput(null)).toBeNull();
    expect(parseEditInput("Edit path")).toBeNull();
    expect(parseEditInput(undefined)).toBeNull();
  });

  it("returns null when a required field is missing", () => {
    expect(parseEditInput({ file_path: "a.ts", old_string: "x" })).toBeNull();
  });

  it("returns null when a field has the wrong type", () => {
    expect(parseEditInput({ file_path: "a.ts", old_string: 1, new_string: "y" })).toBeNull();
  });

  it("parses a valid Edit input, ignoring extra fields like replace_all", () => {
    expect(
      parseEditInput({ file_path: "a.ts", old_string: "foo", new_string: "bar", replace_all: true }),
    ).toEqual({ file_path: "a.ts", old_string: "foo", new_string: "bar" });
  });
});

describe("buildEditDiffLines", () => {
  it("builds del lines then add lines for single-line strings", () => {
    const result = buildEditDiffLines({ file_path: "a.ts", old_string: "foo", new_string: "bar" });
    expect(result.lines).toEqual([
      { text: "-foo", cls: "aide-diff-del" },
      { text: "+bar", cls: "aide-diff-add" },
    ]);
    expect(result.delCount).toBe(1);
    expect(result.addCount).toBe(1);
  });

  it("splits multi-line old_string/new_string into one entry per line", () => {
    const result = buildEditDiffLines({
      file_path: "a.ts",
      old_string: "line1\nline2",
      new_string: "line1\nline2\nline3",
    });
    expect(result.lines).toEqual([
      { text: "-line1", cls: "aide-diff-del" },
      { text: "-line2", cls: "aide-diff-del" },
      { text: "+line1", cls: "aide-diff-add" },
      { text: "+line2", cls: "aide-diff-add" },
      { text: "+line3", cls: "aide-diff-add" },
    ]);
    expect(result.delCount).toBe(2);
    expect(result.addCount).toBe(3);
  });

  it("treats an empty string as a single empty line", () => {
    const result = buildEditDiffLines({ file_path: "a.ts", old_string: "", new_string: "x" });
    expect(result.lines[0]).toEqual({ text: "-", cls: "aide-diff-del" });
    expect(result.delCount).toBe(1);
  });
});
