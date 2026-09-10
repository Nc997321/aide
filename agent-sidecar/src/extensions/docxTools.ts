import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  parseDocx,
  resolveDocxPath,
  DOCX_MAX_BYTES,
  DOCX_MAX_CHARS,
  type DocxParseResult,
} from "./docx/parse.js";
import { resolveDocxOutPath, safeDirname } from "./docx/path.js";
import { DOCX_MAX_INPUT_CHARS } from "./docx/constants.js";
import { markdownToModel } from "./docx/md/toModel.js";
import { modelToDocxBuffer } from "./docx/gen/index.js";
import type { DocxDocument } from "./docx/model.js";

/** write 结果（工具层组合 markdownToModel 计数 + modelToDocxBuffer buffer 而成） */
export type DocxGenResult =
  | { ok: true; buffer: Buffer; paragraphs: number; images: number; skippedImages: number }
  | { ok: false; reason: "invalid_arg" | "unknown"; detail: string };

/** allowedTools 前缀规则：匹配 aide-docs server 全部工具（docx + pdf），canUseTool 直接跳过。 */
export const DOCX_ALLOW_RULE = "mcp__aide-docs";

// ---------------------------------------------------------------------------
// 格式化（纯函数，测试直接覆盖）
// ---------------------------------------------------------------------------

export function formatDocxResult(res: DocxParseResult, path: string): string {
  if (!res.ok) {
    switch (res.reason) {
      case "not_found":
        return `File not found: ${path}. Check the path (typos, relative vs absolute, working directory).`;
      case "not_docx":
        return (
          `Could not parse as .docx: ${res.detail}. This may be a legacy .doc (Word 97-2003, ` +
          `not .docx), a corrupt file, or not a Word document. Convert to .docx (Word → Save ` +
          `As .docx, or libreoffice --headless --convert-to docx) and retry.`
        );
      case "encrypted":
        return `Document is password-protected: ${res.detail}. Remove the password in Word and retry.`;
      case "too_large":
        return (
          `File too large to read via read_docx: ${res.detail}. Ask the user to extract the ` +
          `specific section, or split the file.`
        );
      case "unknown":
        return (
          `Could not parse .docx: ${res.detail}. Fallback: try Bash with pandoc (if installed) ` +
          `or python-docx.`
        );
    }
  }
  const head = `# ${path}\n\n`;
  if (res.mode === "structure") {
    return `${head}${JSON.stringify(res.structure, null, 2)}`;
  }
  const meta = `Paragraphs: ${res.meta.paragraphs}, Images: ${res.meta.images}, Tables: ${res.meta.tables}, Sections: ${res.meta.sections}\n\n`;
  const tail = res.truncated
    ? `\n\n[Truncated at ${DOCX_MAX_CHARS} characters — ask the user for the specific section or heading if you need more.]`
    : "";
  return `${head}${meta}${res.markdown}${tail}`;
}

/** handler 层错误（exists 由 write_docx 的 statSync 检查产生，不在 gen.ts 的 reason 里）。 */
export type DocxGenOutcome = DocxGenResult | { ok: false; reason: "exists"; detail: string };

/** 剥 verbatim `\\?\` 前缀（含 `\\?\UNC\` 情形），展示给模型的路径要可被 read_docx 直接复用。 */
function stripVerbatimPrefix(p: string): string {
  if (p.startsWith("\\\\?\\UNC\\")) return `\\\\${p.slice(8)}`;
  if (p.startsWith("\\\\?\\")) return p.slice(4);
  return p;
}

export function formatDocxGenResult(res: DocxGenOutcome, path: string, hasToc = false): string {
  if (!res.ok) {
    switch (res.reason) {
      case "invalid_arg":
        return `Invalid arguments: ${res.detail}`;
      case "exists":
        return `File already exists: ${path}. Pass overwrite: true to replace it, or choose a different file_path.`;
      case "unknown":
        return `Could not generate .docx: ${res.detail}`;
    }
  }
  const display = stripVerbatimPrefix(path);
  const images = res.images > 0 ? `, ${res.images} images` : "";
  const skipped = res.skippedImages > 0 ? ` (${res.skippedImages} skipped)` : "";
  const tocNote = hasToc
    ? `\n\nNote: the document contains a TOC field marked for auto-update — when the user opens it in Word, accept the "update fields" prompt (or press Ctrl+A then F9) to fill in page numbers.`
    : "";
  return `# ${display}\n\nWrote ${res.paragraphs} paragraphs${images}${skipped}. Bytes: ${res.buffer.length}${tocNote}`;
}

/** 文档是否含 TOC 域（[TOC] / [TOC:...] 变体）——write 成功提示用 */
export function hasTocField(doc: DocxDocument): boolean {
  return doc.sections.some((s) =>
    s.blocks.some((b) => b.kind === "field" && b.type === "toc"),
  );
}

// ---------------------------------------------------------------------------
// docx 工具定义（注册在 aide-docs server，见 docsMcp.ts）
// 工厂函数：handler 闭包持有该会话的 cwd（per-worker 构造）。
// ---------------------------------------------------------------------------

export function buildDocxTools(cwd: string) {
  return [
    tool(
      "read_docx",
      "Read a .docx (Word 2007+) file and return its content as markdown — headings/lists/tables/link text preserved; images replaced with alt text/path (no image bytes). Use this INSTEAD OF Read (binary garbage) or Bash+pandoc (often not installed). Does NOT handle legacy .doc, .pdf, or .xlsx — ask the user to convert to .docx.",
      {
        file_path: z.string().describe("Absolute or workspace-relative path to the .docx file"),
        mode: z
          .enum(["markdown", "structure"])
          .optional()
          .describe(
            "Output mode: markdown (default, full content) or structure (compact JSON overview: headings/tables/images/fields/sections — use for long documents to decide what to read)",
          ),
        images: z
          .enum(["placeholder", "skip", "base64"])
          .optional()
          .describe(
            "Image strategy: placeholder (default, alt text + path, no bytes), skip (omit images), or base64 (embed image bytes as data URIs — large output, use only when the image content matters)",
          ),
      },
      async (args) => {
        const a = args as Record<string, unknown>;
        const fp = a.file_path;
        const resolved = resolveDocxPath(cwd, fp);
        if (!resolved.ok) return textResult(`Invalid file_path: ${resolved.detail}`);

        const path = resolved.path;
        let stat: { size: number };
        try {
          stat = statSync(path);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            return textResult(formatDocxResult({ ok: false, reason: "not_found", detail: "" }, path));
          }
          const msg = err instanceof Error ? err.message : String(err);
          return textResult(formatDocxResult({ ok: false, reason: "unknown", detail: `stat failed: ${msg}` }, path));
        }

        if (stat.size > DOCX_MAX_BYTES) {
          const mb = (stat.size / (1024 * 1024)).toFixed(1);
          const limit = (DOCX_MAX_BYTES / (1024 * 1024)).toFixed(0);
          return textResult(
            formatDocxResult({ ok: false, reason: "too_large", detail: `${mb} MB exceeds the ${limit} MB limit` }, path),
          );
        }

        let buffer: Buffer;
        try {
          buffer = readFileSync(path);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return textResult(formatDocxResult({ ok: false, reason: "unknown", detail: `read failed: ${msg}` }, path));
        }

        const res = await parseDocx(buffer, {
          mode: a.mode === "structure" ? "structure" : "markdown",
          images: a.images === "skip" || a.images === "base64" ? a.images : "placeholder",
        });
        return textResult(formatDocxResult(res, path));
      },
    ),
    tool(
      "write_docx",
      "Write a markdown string to a .docx (Word 2007+) file. Converts markdown to a real .docx — headings, lists, tables, code blocks, blockquotes, and local images (relative to the working directory) are supported; unreadable images degrade to a placeholder. Use this INSTEAD OF Bash+python-docx/pandoc (often not installed). Refuses to overwrite an existing file unless overwrite: true is passed.",
      {
        file_path: z.string().describe("Absolute or workspace-relative path where the .docx file will be written"),
        markdown: z.string().describe("Markdown content to convert to .docx"),
        overwrite: z
          .boolean()
          .optional()
          .describe("Set to true to overwrite an existing file (default false — refuses to overwrite)"),
      },
      async (args) => {
        const a = args as Record<string, unknown>;
        const resolved = resolveDocxOutPath(cwd, a.file_path);
        if (!resolved.ok) {
          return textResult(formatDocxGenResult({ ok: false, reason: "invalid_arg", detail: resolved.detail }, ""));
        }
        const path = resolved.path;

        const md = a.markdown;
        if (typeof md !== "string" || md.trim() === "") {
          return textResult(
            formatDocxGenResult({ ok: false, reason: "invalid_arg", detail: "markdown must be a non-empty string" }, path),
          );
        }
        if (md.length > DOCX_MAX_INPUT_CHARS) {
          return textResult(
            formatDocxGenResult(
              { ok: false, reason: "invalid_arg", detail: `markdown exceeds the ${DOCX_MAX_INPUT_CHARS} character limit` },
              path,
            ),
          );
        }

        // 覆盖保护：目标已存在且未显式 overwrite → 拒绝，引导模型换路径或加 overwrite
        if (a.overwrite !== true) {
          try {
            statSync(path);
            return textResult(formatDocxGenResult({ ok: false, reason: "exists", detail: "" }, path));
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") {
              const msg = err instanceof Error ? err.message : String(err);
              return textResult(formatDocxGenResult({ ok: false, reason: "unknown", detail: `stat failed: ${msg}` }, path));
            }
          }
        }

        try {
          // safeDirname：bun 的 path.dirname 对 Windows 反斜杠路径返回 "C:"（实测 bun 1.3.14），
          // verbatim `\\?\` 路径不能 normalize，父目录用手动实现取。
          mkdirSync(safeDirname(path), { recursive: true });
        } catch (err) {
          // bun 的 recursive mkdir 对「已存在目录」抛 EEXIST（Node 是 no-op，实测 bun 1.3.14）——
          // 目录已存在即满足要求，吞掉；其余错误照报。
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "EEXIST") {
            const msg = err instanceof Error ? err.message : String(err);
            return textResult(formatDocxGenResult({ ok: false, reason: "unknown", detail: `mkdir failed: ${msg}` }, path));
          }
        }

        const parsed = markdownToModel(md, { cwd });
        if (!parsed.ok) return textResult(formatDocxGenResult(parsed, path));
        let buffer: Buffer;
        try {
          buffer = await modelToDocxBuffer(parsed.doc);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return textResult(formatDocxGenResult({ ok: false, reason: "unknown", detail: `docx generation failed: ${msg}` }, path));
        }
        const res: DocxGenResult = {
          ok: true,
          buffer,
          paragraphs: parsed.paragraphs,
          images: parsed.images,
          skippedImages: parsed.skippedImages,
        };

        try {
          writeFileSync(path, res.buffer);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return textResult(formatDocxGenResult({ ok: false, reason: "unknown", detail: `write failed: ${msg}` }, path));
        }
        return textResult(formatDocxGenResult(res, path, hasTocField(parsed.doc)));
      },
    ),
  ];
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
