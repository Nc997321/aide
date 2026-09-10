// 路径解析 bun 兼容测试（bun 1.3.14 实测差异：isAbsolute 不认反斜杠盘符路径、dirname 返回 "C:"、
// recursive mkdir 对已存在目录抛 EEXIST——Node 下验证逻辑正确性，bun 侧行为在部署时手动实测）。
// 注意 vitest 跑在 Node 下，这里断言的是一致语义：Windows 绝对路径无论斜杠方向都不被 join 进 cwd，
// 且输出统一正斜杠（bun 对正斜杠路径行为与 Node 一致）。

import { describe, it, expect } from "vitest";
import { resolveDocxPath, safeDirname } from "./path.js";

describe("resolveDocxPath（bun 兼容）", () => {
  it("Windows 反斜杠绝对路径 → 原样（bun isAbsolute 误判兜底），输出 normalize 正斜杠", () => {
    const r = resolveDocxPath("C:/work", "C:\\Users\\yangx\\Desktop\\a.docx");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe("C:/Users/yangx/Desktop/a.docx");
  });

  it("正斜杠绝对路径 → 原样", () => {
    const r = resolveDocxPath("C:/work", "C:/Users/yangx/Desktop/a.docx");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe("C:/Users/yangx/Desktop/a.docx");
  });

  it("相对路径 → join cwd（结果 normalize 正斜杠）", () => {
    const r = resolveDocxPath("C:\\work\\repo", "a.docx");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe("C:/work/repo/a.docx");
  });

  it("verbatim \\\\?\\ 路径 → 原样透传（不 normalize 不 join）", () => {
    const r = resolveDocxPath("C:/work", "\\\\?\\C:\\Users\\yangx\\Desktop\\a.docx");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe("\\\\?\\C:\\Users\\yangx\\Desktop\\a.docx");
  });

  it("空/非字符串 → invalid_arg", () => {
    expect(resolveDocxPath("C:/work", "").ok).toBe(false);
    expect(resolveDocxPath("C:/work", "   ").ok).toBe(false);
    expect(resolveDocxPath("C:/work", 42).ok).toBe(false);
  });
});

describe("safeDirname（bun dirname 反斜杠 bug 兜底）", () => {
  it("反斜杠路径取父目录", () => {
    expect(safeDirname("C:\\Users\\yangx\\Desktop\\a.docx")).toBe("C:\\Users\\yangx\\Desktop");
  });

  it("正斜杠路径取父目录", () => {
    expect(safeDirname("C:/Users/yangx/Desktop/a.docx")).toBe("C:/Users/yangx/Desktop");
  });

  it("verbatim 路径取父目录（前缀保留）", () => {
    expect(safeDirname("\\\\?\\C:\\Users\\yangx\\Desktop\\a.docx")).toBe("\\\\?\\C:\\Users\\yangx\\Desktop");
  });

  it("无分隔符 → .", () => {
    expect(safeDirname("a.docx")).toBe(".");
  });
});
