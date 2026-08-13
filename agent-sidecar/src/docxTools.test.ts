import { describe, it, expect } from "vitest";
import {
  docxMcpRegistration,
  formatDocxResult,
  formatDocxGenResult,
  DOCX_ALLOW_RULE,
} from "./docxTools.js";


describe("formatDocxResult", () => {
  it("ok: head + markdown", () => {
    const t = formatDocxResult({ ok: true, markdown: "Hello", truncated: false, messages: [] }, "/p/a.docx");
    expect(t).toContain("# /p/a.docx");
    expect(t).toContain("Hello");
    expect(t).not.toContain("Truncated");
  });

  it("ok truncated: tail note", () => {
    const t = formatDocxResult({ ok: true, markdown: "x".repeat(100), truncated: true, messages: [] }, "/p/a.docx");
    expect(t).toContain("Truncated");
  });

  it("not_found", () => {
    expect(formatDocxResult({ ok: false, reason: "not_found", detail: "" }, "/p/a.docx")).toContain("File not found");
  });

  it("not_docx hints convert to .docx", () => {
    const t = formatDocxResult({ ok: false, reason: "not_docx", detail: "bad zip" }, "/p/a.docx");
    expect(t).toContain("legacy .doc");
    expect(t).toContain("Convert to .docx");
  });

  it("encrypted", () => {
    expect(formatDocxResult({ ok: false, reason: "encrypted", detail: "pwd" }, "/p/a.docx")).toContain("password-protected");
  });

  it("too_large", () => {
    const t = formatDocxResult({ ok: false, reason: "too_large", detail: "120 MB" }, "/p/a.docx");
    expect(t).toContain("too large");
    expect(t).toContain("120 MB");
  });

  it("unknown fallback hints pandoc/python-docx", () => {
    const t = formatDocxResult({ ok: false, reason: "unknown", detail: "boom" }, "/p/a.docx");
    expect(t).toContain("boom");
    expect(t).toContain("pandoc");
  });
});

describe("formatDocxGenResult", () => {
  it("ok: path + counts", () => {
    const t = formatDocxGenResult(
      { ok: true, buffer: Buffer.from("x"), paragraphs: 3, images: 1, skippedImages: 0 },
      "/p/a.docx",
    );
    expect(t).toContain("# /p/a.docx");
    expect(t).toContain("Wrote 3 paragraphs");
    expect(t).toContain("1 images");
    expect(t).toContain("Bytes: 1");
  });

  it("ok: skipped images noted", () => {
    const t = formatDocxGenResult(
      { ok: true, buffer: Buffer.from("x"), paragraphs: 1, images: 0, skippedImages: 2 },
      "/p/a.docx",
    );
    expect(t).toContain("2 skipped");
  });

  it("ok: verbatim prefix stripped for display", () => {
    const t = formatDocxGenResult(
      { ok: true, buffer: Buffer.from("x"), paragraphs: 1, images: 0, skippedImages: 0 },
      "\\\\?\\C:\\proj\\a.docx",
    );
    expect(t).toContain("# C:\\proj\\a.docx");
    expect(t).not.toContain("\\\\?\\");
  });

  it("invalid_arg", () => {
    expect(formatDocxGenResult({ ok: false, reason: "invalid_arg", detail: "bad" }, "/p/a.docx")).toContain(
      "Invalid arguments: bad",
    );
  });

  it("exists hints overwrite", () => {
    const t = formatDocxGenResult({ ok: false, reason: "exists", detail: "" }, "/p/a.docx");
    expect(t).toContain("already exists");
    expect(t).toContain("overwrite: true");
  });

  it("unknown", () => {
    expect(formatDocxGenResult({ ok: false, reason: "unknown", detail: "boom" }, "/p/a.docx")).toContain("boom");
  });
});

describe("docxMcpRegistration", () => {
  it("returns server spec by default, null when AIDE_DOCX_TOOLS=off or untrusted", () => {
    expect(docxMcpRegistration("/proj")).not.toBeNull();
    expect(docxMcpRegistration("/proj", { AIDE_DOCX_TOOLS: "off" } as NodeJS.ProcessEnv)).toBeNull();
    expect(docxMcpRegistration("/proj", process.env, false)).toBeNull();
  });

  it("allow rule matches the MCP server name prefix", () => {
    expect(DOCX_ALLOW_RULE).toBe("mcp__aide-docs");
  });

  it("spec contains the aide-docs server", () => {
    const spec = docxMcpRegistration("/proj");
    expect(spec!["aide-docs"]).toBeDefined();
  });

  it("tool descriptions steer the agent to read_docx (snapshot)", () => {
    const spec = docxMcpRegistration("/proj");
    // SDK server 实例内含 zod v4 schema（内部 root 自引用），直接 JSON.stringify 会抛
    // circular structure —— 用 WeakSet replacer 去环，工具描述仍在序列化结果里。
    const seen = new WeakSet();
    const json = JSON.stringify(spec, (_key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
    expect(json).toMatchSnapshot();
  });

  it("server carries MCP instructions steering the model to read_docx (必需品)", () => {
    const spec = docxMcpRegistration("/proj");
    const seen = new WeakSet();
    const json = JSON.stringify(spec, (_key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
    // instructions 缺失时模型会无视工具（codegraph 2026-07-26 冒烟实锤），此处防回归。
    expect(json).toContain("MUST call mcp__aide-docs__read_docx");
    expect(json).toContain("MUST call mcp__aide-docs__write_docx");
    expect(json).toContain("does NOT handle legacy .doc");
  });
});