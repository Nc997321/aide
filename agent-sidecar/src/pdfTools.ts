import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { statSync, readFileSync } from "node:fs";
import { parsePdf, PDF_MAX_CHARS, PDF_MAX_BYTES, type PdfParseResult } from "./pdf/parse.js";
import { resolvePdfPath } from "./pdf/path.js";

/** allowedTools 前缀规则：与 docx 共用 aide-docs server，同一前缀。 */
export const PDF_ALLOW_RULE = "mcp__aide-docs";

// ---------------------------------------------------------------------------
// 格式化（纯函数，测试直接覆盖）
// ---------------------------------------------------------------------------

export function formatPdfResult(res: PdfParseResult, path: string): string {
  if (!res.ok) {
    switch (res.reason) {
      case "not_found":
        return `File not found: ${path}. Check the path (typos, relative vs absolute, working directory).`;
      case "not_pdf":
        return `Could not parse as PDF: ${res.detail}. This may be a corrupt file or not a PDF.`;
      case "encrypted":
        return `PDF is password-protected: ${res.detail}. Remove the password and retry.`;
      case "too_large":
        return `File too large to read via read_pdf: ${res.detail}. Ask the user to extract the specific pages, or split the file.`;
      case "invalid_arg":
        return `Invalid arguments: ${res.detail}`;
      case "unknown":
        return `Could not parse PDF: ${res.detail}. Fallback: try Bash with pdftotext (if installed) or pymupdf.`;
    }
  }
  const head = `# ${path}\n\n`;
  if (res.mode === "structure") {
    return `${head}${JSON.stringify(res.structure, null, 2)}`;
  }
  const previewNote =
    res.meta.readPages < res.meta.pages
      ? ` (document has ${res.meta.pages} pages — use pages to read more)`
      : "";
  const meta = `Pages: ${res.meta.readPages}/${res.meta.pages} read${previewNote}, Images: ${res.meta.images}, Scanned (no text): ${res.meta.scannedPages}\n\n`;
  const tail = res.truncated
    ? `\n[Truncated at ${PDF_MAX_CHARS} characters — use pages to read specific pages.]`
    : "";
  return `${head}${meta}${res.markdown}${tail}`;
}

// ---------------------------------------------------------------------------
// read_pdf 工具定义（注册在 aide-docs server，见 docsMcp.ts）
// 工厂函数：handler 闭包持有该会话的 cwd（与 docx 同模式，per-worker 构造）。
// ---------------------------------------------------------------------------

export function buildPdfTools(cwd: string) {
  return [
    tool(
      "read_pdf",
      "Read a .pdf file and return its content as markdown — text extracted per page (## Page N), layout reconstructed from coordinates (paragraphs/table rows preserved, wide column gaps become spaces). Images are counted but not extracted (no bytes). Use this INSTEAD OF Read (binary garbage) or Bash+pdftotext (often not installed, and loses Chinese on PDFs whose fonts lack ToUnicode maps). Does NOT handle scanned PDFs (no text layer) — those need OCR. For long documents, call with mode: \"structure\" first to get a per-page overview, then read specific pages with pages.",
      {
        file_path: z.string().describe("Absolute or workspace-relative path to the .pdf file"),
        pages: z
          .string()
          .optional()
          .describe(
            'Page range to read: "3", "1-5", or "1,3,5-7". Omit to read all pages (up to 20; larger documents read the first 5 pages only)',
          ),
        mode: z
          .enum(["markdown", "structure"])
          .optional()
          .describe(
            "Output mode: markdown (default, per-page text) or structure (compact JSON overview: page count, per-page chars/images/preview — use for long documents to decide which pages to read)",
          ),
      },
      async (args) => {
        const a = args as Record<string, unknown>;
        const resolved = resolvePdfPath(cwd, a.file_path);
        if (!resolved.ok) return textResult(`Invalid file_path: ${resolved.detail}`);

        const path = resolved.path;
        let stat: { size: number };
        try {
          stat = statSync(path);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            return textResult(formatPdfResult({ ok: false, reason: "not_found", detail: "" }, path));
          }
          const msg = err instanceof Error ? err.message : String(err);
          return textResult(formatPdfResult({ ok: false, reason: "unknown", detail: `stat failed: ${msg}` }, path));
        }

        if (stat.size > PDF_MAX_BYTES) {
          const mb = (stat.size / (1024 * 1024)).toFixed(1);
          const limit = (PDF_MAX_BYTES / (1024 * 1024)).toFixed(0);
          return textResult(
            formatPdfResult({ ok: false, reason: "too_large", detail: `${mb} MB exceeds the ${limit} MB limit` }, path),
          );
        }

        let buffer: Buffer;
        try {
          buffer = readFileSync(path);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return textResult(formatPdfResult({ ok: false, reason: "unknown", detail: `read failed: ${msg}` }, path));
        }

        const res = await parsePdf(buffer, {
          mode: a.mode === "structure" ? "structure" : "markdown",
          pages: typeof a.pages === "string" ? a.pages : undefined,
        });
        return textResult(formatPdfResult(res, path));
      },
    ),
  ];
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
