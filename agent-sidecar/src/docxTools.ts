import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  parseDocx,
  resolveDocxPath,
  DOCX_MAX_BYTES,
  DOCX_MAX_CHARS,
  type DocxParseResult,
} from "./docx/parse.js";
import {
  markdownToDocxBuffer,
  resolveDocxOutPath,
  DOCX_MAX_INPUT_CHARS,
  type DocxGenResult,
} from "./docx/gen.js";

/** allowedTools 前缀规则：匹配该 server 全部工具，canUseTool 直接跳过（只读工具不弹窗）。 */
export const DOCX_ALLOW_RULE = "mcp__aide-docs";

/**
 * MCP instructions 块（initialize 时呈现给模型）。codegraph 冒烟实锤过 instructions 是
 * 必需品——第三方模型对没有 instructions 块的 MCP 工具视而不见，连 prompt 点名都无视。
 * 删除或弱化前必须先跑 smoke-mcp.ts 验证模型仍采纳 read_docx / write_docx。
 */
export const DOCX_INSTRUCTIONS = `This environment has built-in .docx (Word 2007+) tools exposed as the aide-docs MCP server (read_docx / write_docx). Rules:
1. When the user asks you to read a .docx file, you MUST call mcp__aide-docs__read_docx — do NOT use Read (returns binary garbage) and do NOT use Bash+pandoc (pandoc is often not installed).
2. read_docx returns the document content as markdown (headings, lists, tables, link text preserved; images are replaced with alt text/path — no image bytes).
3. read_docx only handles .docx. It does NOT handle legacy .doc (Word 97-2003), .pdf, or .xlsx — for those, ask the user to convert to .docx or use another approach.
4. When the user asks you to create or write a .docx file, you MUST call mcp__aide-docs__write_docx with the markdown content and the output file_path — do NOT use Bash with python-docx/pandoc (often not installed) and do NOT try to write binary files yourself.
5. write_docx converts markdown to .docx (headings, lists, tables, code blocks, blockquotes, and local images supported; unreadable images degrade to a placeholder). It refuses to overwrite an existing file unless you pass overwrite: true.`;


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
  const tail = res.truncated
    ? `\n\n[Truncated at ${DOCX_MAX_CHARS} characters — ask the user for the specific section or heading if you need more.]`
    : "";
  return `${head}${res.markdown}${tail}`;
}

/** handler 层错误（exists 由 write_docx 的 statSync 检查产生，不在 gen.ts 的 reason 里）。 */
export type DocxGenOutcome = DocxGenResult | { ok: false; reason: "exists"; detail: string };

/** 剥 verbatim `\\?\` 前缀（含 `\\?\UNC\` 情形），展示给模型的路径要可被 read_docx 直接复用。 */
function stripVerbatimPrefix(p: string): string {
  if (p.startsWith("\\\\?\\UNC\\")) return `\\\\${p.slice(8)}`;
  if (p.startsWith("\\\\?\\")) return p.slice(4);
  return p;
}

export function formatDocxGenResult(res: DocxGenOutcome, path: string): string {
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
  return `# ${display}\n\nWrote ${res.paragraphs} paragraphs${images}${skipped}. Bytes: ${res.buffer.length}`;
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * 默认注册；AIDE_DOCX_TOOLS=off 时返回 null（A/B 实测与调试用，不进设置面板）。
 * `trusted=false`（受限模式）时也返回 null：不信任工作区不暴露 read_docx。
 * 与 codegraphMcpRegistration 注册条件完全相同——docx 跟 codegraph 同步即可。
 *
 * server 实例 per-worker 构造：handler 闭包持有该会话的 cwd。**无 emit 参数**——docx 一次性
 * 同步解析，不像 codegraph 要 IPC 客户端（codegraphClient.ts 的 emit+request_id+超时那套
 * 不适用）。省略 trusted = 信任（向后兼容）。
 */
export function docxMcpRegistration(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  trusted = true,
): Record<string, unknown> | null {
  if (!trusted) return null;
  if (env.AIDE_DOCX_TOOLS === "off") return null;

  const server = createSdkMcpServer({
    name: "aide-docs",
    version: "1.0.0",
    instructions: DOCX_INSTRUCTIONS,
    tools: [
      tool(
        "read_docx",
        "Read a .docx (Word 2007+) file and return its content as markdown — headings/lists/tables/link text preserved; images replaced with alt text/path (no image bytes). Use this INSTEAD OF Read (binary garbage) or Bash+pandoc (often not installed). Does NOT handle legacy .doc, .pdf, or .xlsx — ask the user to convert to .docx.",
        { file_path: z.string().describe("Absolute or workspace-relative path to the .docx file") },
        async (args) => {
          const fp = (args as Record<string, unknown>).file_path;
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

          const res = await parseDocx(buffer);
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
            mkdirSync(dirname(path), { recursive: true });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return textResult(formatDocxGenResult({ ok: false, reason: "unknown", detail: `mkdir failed: ${msg}` }, path));
          }

          const res = await markdownToDocxBuffer(md, { cwd });
          if (!res.ok) return textResult(formatDocxGenResult(res, path));

          try {
            writeFileSync(path, res.buffer);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return textResult(formatDocxGenResult({ ok: false, reason: "unknown", detail: `write failed: ${msg}` }, path));
          }
          return textResult(formatDocxGenResult(res, path));
        },
      ),
    ],
  });

  return { "aide-docs": server };
}