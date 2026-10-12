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

  it("提问取问题文本、计划取首行标题，不露 JSON", () => {
    const q = (question: string) => ({ question, header: "h", options: [] });
    expect(summarizeToolInput("AskUserQuestion", { questions: [q("用哪个库？")] })).toBe("用哪个库？");
    expect(summarizeToolInput("AskUserQuestion", { questions: [q("用哪个库？"), q("要测试吗？")] }))
      .toBe("用哪个库？ 等 2 个问题");
    expect(summarizeToolInput("AskUserQuestion", {})).toBe("");
    expect(summarizeToolInput("ExitPlanMode", { plan: "\n# 重构摘要行\n\n1. 第一步" })).toBe("重构摘要行");
    expect(summarizeToolInput("ExitPlanMode", {})).toBe("");
    expect(summarizeToolInput("EnterPlanMode", {})).toBe("");
  });

  it("常用工具各取一个人读的字段：网址 / 搜索词 / 任务描述 / 技能名 / 待办", () => {
    expect(summarizeToolInput("WebFetch", { url: "https://x", prompt: "p" })).toBe("https://x");
    expect(summarizeToolInput("WebSearch", { query: "tauri v2" })).toBe("tauri v2");
    expect(summarizeToolInput("Agent", { description: "查引用", prompt: "…" })).toBe("查引用");
    expect(summarizeToolInput("Skill", { skill: "aide-design" })).toBe("aide-design");
    expect(summarizeToolInput("NotebookEdit", { notebook_path: "/a/n.ipynb" })).toBe("/a/n.ipynb");
    const todo = (content: string, status: string) => ({ content, status, activeForm: content });
    expect(summarizeToolInput("TodoWrite", { todos: [todo("写测试", "completed"), todo("改实现", "in_progress")] }))
      .toBe("改实现");
    expect(summarizeToolInput("TodoWrite", { todos: [todo("写测试", "completed"), todo("改实现", "pending")] }))
      .toBe("1/2 项已完成");
    expect(summarizeToolInput("TodoWrite", {})).toBe("");
  });

  it("其它工具与缺字段时留空（不露原始 JSON），input 为空不抛", () => {
    expect(summarizeToolInput("mcp__x__do", { a: 1 })).toBe("");
    expect(summarizeToolInput("WebFetch", {})).toBe("");
    expect(summarizeToolInput("Grep", {})).toBe("");
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
