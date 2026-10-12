import { describe, expect, it } from "vitest";
import { previewToolResult, summarizeToolInput } from "./toolSummary";

describe("summarizeToolInput", () => {
  it("Bash 取命令、文件类取路径", () => {
    expect(summarizeToolInput("Bash", { command: "pnpm test" })).toBe("pnpm test");
    expect(summarizeToolInput("Read", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
  });

  it("Grep / Glob 写成人话而不是原始 JSON", () => {
    expect(summarizeToolInput("Grep", { pattern: "foo", path: "src/" })).toBe('"foo" in src/');
    expect(summarizeToolInput("Grep", { pattern: "foo", glob: "*.vue" })).toBe('"foo" in *.vue');
    expect(summarizeToolInput("Grep", { pattern: "foo", type: "rust" })).toBe('"foo" in *.rust');
    expect(summarizeToolInput("Grep", { pattern: "foo" })).toBe('"foo"');
    expect(summarizeToolInput("Glob", { pattern: "**/*.vue" })).toBe("**/*.vue");
    expect(summarizeToolInput("Glob", { pattern: "*.rs", path: "crates" })).toBe("*.rs in crates");
  });

  it("其它工具与缺字段时回退成截断的 JSON，input 为空不抛", () => {
    expect(summarizeToolInput("WebFetch", { url: "https://x" })).toBe('{"url":"https://x"}');
    expect(summarizeToolInput("Grep", {})).toBe("{}");
    expect(summarizeToolInput("Bash", undefined)).toBe("");
  });
});

describe("previewToolResult", () => {
  it("还没有结果 / 空结果 → null，不配占位文字", () => {
    expect(previewToolResult("Bash", undefined)).toBeNull();
    expect(previewToolResult("Bash", "\n")).toBeNull();
  });

  it("取开头三行，其余计数；结尾换行不算一行", () => {
    expect(previewToolResult("Bash", "a\nb\nc\nd\ne\n")).toEqual({
      lines: ["a", "b", "c"], rest: 2,
    });
    expect(previewToolResult("Bash", "only")).toEqual({ lines: ["only"], rest: 0 });
  });

  it("tail：还在跑的命令取末尾三行", () => {
    expect(previewToolResult("Bash", "a\nb\nc\nd\ne\n", { tail: true })).toEqual({
      lines: ["c", "d", "e"], rest: 2,
    });
    expect(previewToolResult("Bash", "a\nb", { tail: true })?.lines).toEqual(["a", "b"]);
  });

  it("剥掉 ANSI 颜色与回车", () => {
    expect(previewToolResult("Bash", "\u001b[32m✓\u001b[0m ok\r\n")?.lines).toEqual(["✓ ok"]);
  });

  it("Grep / Glob 原样预览工具输出；无匹配不出预览", () => {
    expect(previewToolResult("Grep", "Found 2 files\nsrc/a.ts\nsrc/b.ts")).toEqual({
      lines: ["Found 2 files", "src/a.ts", "src/b.ts"], rest: 0,
    });
    expect(previewToolResult("Glob", "a.vue\nb.vue\nc.vue\nd.vue")).toEqual({
      lines: ["a.vue", "b.vue", "c.vue"], rest: 1,
    });
    expect(previewToolResult("Grep", "No matches found")).toBeNull();
    expect(previewToolResult("Glob", "No files found")).toBeNull();
  });

  it("Read 不贴文件正文", () => {
    expect(previewToolResult("Read", "1\tx\n2\ty")).toBeNull();
  });

  it("超长单行截断，不把整行塞进 DOM", () => {
    const p = previewToolResult("Bash", "x".repeat(5000));
    expect(p?.lines[0]).toHaveLength(240);
  });
});
