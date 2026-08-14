// resolveDocxOutPath 测试（原 gen.test.ts 平移，函数随 gen.ts 退役迁到 path.ts）。

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { resolveDocxOutPath } from "./path.js";

describe("resolveDocxOutPath", () => {
  it("non-string / empty → invalid_arg", () => {
    expect(resolveDocxOutPath("/cwd", 123).ok).toBe(false);
    expect(resolveDocxOutPath("/cwd", null).ok).toBe(false);
    expect(resolveDocxOutPath("/cwd", "  ").ok).toBe(false);
  });
  it("verbatim \\\\?\\ prefix passthrough", () => {
    const r = resolveDocxOutPath("/cwd", "\\\\?\\C:\\proj\\a.docx");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe("\\\\?\\C:\\proj\\a.docx");
  });
  it("absolute direct / relative joined to cwd", () => {
    const abs = resolveDocxOutPath("/cwd", "/abs/a.docx");
    expect(abs.ok).toBe(true);
    if (abs.ok) expect(abs.path).toBe("/abs/a.docx");
    const rel = resolveDocxOutPath("/cwd", "a.docx");
    expect(rel.ok).toBe(true);
    if (rel.ok) expect(rel.path).toBe(join("/cwd", "a.docx"));
  });
});
