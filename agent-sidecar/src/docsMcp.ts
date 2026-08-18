// aide-docs MCP server 统一注册：docx（read_docx / write_docx）+ pdf（read_pdf）工具合并。
// 组织文件在上层，子实现各自独立（docxTools.ts / pdfTools.ts + docx/ / pdf/ 子目录）。
//
// 注册条件与 codegraphMcpRegistration 完全相同——docs 跟 codegraph 同步即可：
// `trusted=false`（受限模式）时返回 null：不信任工作区不暴露文档读取工具。
// AIDE_DOCX_TOOLS=off 时返回 null（A/B 实测与调试用，不进设置面板）。
//
// server 实例 per-worker 构造：handler 闭包持有该会话的 cwd。**无 emit 参数**——docx/pdf
// 一次性同步解析，不像 codegraph 要 IPC 客户端（codegraphClient.ts 的 emit+request_id+
// 超时那套不适用）。

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { buildDocxTools, DOCX_ALLOW_RULE } from "./docxTools.js";
import { buildPdfTools, PDF_ALLOW_RULE } from "./pdfTools.js";

/** allowedTools 前缀规则：匹配 aide-docs server 全部工具，canUseTool 直接跳过（只读工具不弹窗）。 */
export const DOCS_ALLOW_RULE = "mcp__aide-docs";

/**
 * MCP instructions 块（initialize 时呈现给模型）。codegraph 冒烟实锤过 instructions 是
 * 必需品——第三方模型对没有 instructions 块的 MCP 工具视而不见，连 prompt 点名都无视。
 * 删除或弱化前必须先跑 smoke-mcp.ts 验证模型仍采纳 read_docx / read_pdf / write_docx。
 */
export const DOCS_INSTRUCTIONS = `This environment has built-in document tools exposed as the aide-docs MCP server (read_docx / write_docx / read_pdf). Rules:
1. When the user asks you to read a .docx file, you MUST call mcp__aide-docs__read_docx — do NOT use Read (returns binary garbage) and do NOT use Bash+pandoc (pandoc is often not installed).
2. read_docx returns the document content as markdown (headings, lists, tables, link text preserved; images are replaced with alt text/path — no image bytes) plus a one-line summary (paragraphs/images/tables/sections counts).
3. For long documents, call read_docx with mode: "structure" first to get a compact JSON overview (headings, tables, images, fields, sections) and decide which part to read in full.
4. When the user asks you to read a .pdf file, you MUST call mcp__aide-docs__read_pdf — do NOT use Read (binary garbage) and do NOT use Bash+pdftotext (often not installed, and loses Chinese on PDFs whose fonts lack ToUnicode maps).
5. read_pdf returns the content as per-page markdown (## Page N), layout reconstructed from coordinates (paragraphs/table rows preserved). Images are counted but not extracted. Scanned PDFs (no text layer) are reported per page — those need OCR. For long documents, call with mode: "structure" first to get a per-page overview (chars/images/preview), then read specific pages with pages ("1-5", "3", "1,3,5-7"). Without pages, documents up to 20 pages are read fully; larger ones read the first 5 pages only.
6. When the user asks you to create or write a .docx file, you MUST call mcp__aide-docs__write_docx with the markdown content and the output file_path — do NOT use Bash with python-docx/pandoc (often not installed) and do NOT try to write binary files yourself.
7. write_docx converts markdown to .docx (headings, lists, tables, code blocks, blockquotes, and local images supported; unreadable images degrade to a placeholder). It refuses to overwrite an existing file unless you pass overwrite: true.
8. write_docx extension syntax: [TOC] inserts a table of contents (Word fills page numbers on open); [TOC:figures] / [TOC:tables] insert figure/table indexes that collect paragraphs styled with ::: caption / ::: tablecaption (mark figure captions and table captions with those directives). \newpage inserts a page break; ::: center/right/justify aligns the following paragraph; {width=N} after an image sets its width in px.`;

/**
 * 默认注册；AIDE_DOCX_TOOLS=off 时返回 null（A/B 实测与调试用，不进设置面板）。
 * `trusted=false`（受限模式）时也返回 null：不信任工作区不暴露文档读取工具。
 * 省略 trusted = 信任（向后兼容）。
 */
export function docsMcpRegistration(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  trusted = true,
): Record<string, unknown> | null {
  if (!trusted) return null;
  if (env.AIDE_DOCX_TOOLS === "off") return null;

  const server = createSdkMcpServer({
    name: "aide-docs",
    version: "1.0.0",
    instructions: DOCS_INSTRUCTIONS,
    tools: [...buildDocxTools(cwd), ...buildPdfTools(cwd)],
  });

  return { "aide-docs": server };
}

// 兼容导出：docxTools/pdfTools 的 allow rule 与 docsMcp 同值，统一从 docsMcp 取。
export { DOCX_ALLOW_RULE, PDF_ALLOW_RULE };
