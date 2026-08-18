import { describe, it, expect } from "vitest";
import { formatPdfResult, PDF_ALLOW_RULE } from "./pdfTools.js";
import { docsMcpRegistration } from "./docsMcp.js";

const META = { pages: 63, readPages: 5, images: 2, scannedPages: 1 };

describe("formatPdfResult", () => {
  it("ok: head + meta + markdown", () => {
    const t = formatPdfResult(
      { ok: true, mode: "markdown", markdown: "## Page 1\n正文", truncated: false, meta: META },
      "/p/a.pdf",
    );
    expect(t).toContain("# /p/a.pdf");
    expect(t).toContain("Pages: 5/63 read");
    expect(t).toContain("Images: 2");
    expect(t).toContain("Scanned (no text): 1");
    expect(t).toContain("## Page 1");
    expect(t).not.toContain("Truncated");
  });

  it("ok partial read: hints pages param", () => {
    const t = formatPdfResult(
      { ok: true, mode: "markdown", markdown: "x", truncated: false, meta: META },
      "/p/a.pdf",
    );
    expect(t).toContain("use pages to read more");
  });

  it("ok truncated: tail note", () => {
    const t = formatPdfResult(
      { ok: true, mode: "markdown", markdown: "x".repeat(100), truncated: true, meta: META },
      "/p/a.pdf",
    );
    expect(t).toContain("Truncated");
  });

  it("structure mode: JSON overview", () => {
    const t = formatPdfResult(
      {
        ok: true,
        mode: "structure",
        truncated: false,
        structure: {
          pageCount: 63,
          pages: [{ page: 1, chars: 288, images: 2, preview: "1. 账号注册", scanned: false }],
        },
      },
      "/p/a.pdf",
    );
    expect(t).toContain("# /p/a.pdf");
    expect(t).toContain('"pageCount": 63');
    expect(t).toContain('"preview"');
  });

  it("not_found", () => {
    expect(formatPdfResult({ ok: false, reason: "not_found", detail: "" }, "/p/a.pdf")).toContain("File not found");
  });

  it("not_pdf", () => {
    expect(formatPdfResult({ ok: false, reason: "not_pdf", detail: "bad header" }, "/p/a.pdf")).toContain(
      "Could not parse as PDF",
    );
  });

  it("encrypted", () => {
    expect(formatPdfResult({ ok: false, reason: "encrypted", detail: "pwd" }, "/p/a.pdf")).toContain(
      "password-protected",
    );
  });

  it("too_large", () => {
    const t = formatPdfResult({ ok: false, reason: "too_large", detail: "200 MB" }, "/p/a.pdf");
    expect(t).toContain("too large");
    expect(t).toContain("200 MB");
  });

  it("invalid_arg", () => {
    expect(formatPdfResult({ ok: false, reason: "invalid_arg", detail: "pages 99 out of range" }, "/p/a.pdf")).toContain(
      "Invalid arguments",
    );
  });

  it("unknown fallback hints pdftotext/pymupdf", () => {
    const t = formatPdfResult({ ok: false, reason: "unknown", detail: "boom" }, "/p/a.pdf");
    expect(t).toContain("boom");
    expect(t).toContain("pdftotext");
  });
});

describe("docsMcpRegistration (pdf)", () => {
  it("allow rule matches the MCP server name prefix", () => {
    expect(PDF_ALLOW_RULE).toBe("mcp__aide-docs");
  });

  it("server exposes read_pdf alongside read_docx/write_docx", () => {
    const spec = docsMcpRegistration("/proj");
    const seen = new WeakSet();
    const json = JSON.stringify(spec, (_key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
    expect(json).toContain('"read_pdf"');
    expect(json).toContain('"read_docx"');
    expect(json).toContain('"write_docx"');
  });
});
