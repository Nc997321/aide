// aide-docs MCP server 统一注册：docx（read_docx / write_docx）+ pdf（read_pdf）工具合并。
// 组织文件在上层，子实现各自独立（docxTools.ts / pdfTools.ts + docx/ / pdf/ 子目录）。
//
// 注册条件：仅 `trusted=false`（受限模式）时返回 null——不信任工作区不暴露文档
// 读取工具。**刻意不跟随代码索引的工作区开关**（codegraphMcpRegistration 自
// 那以后多一道条件）：docx/pdf 工具不扫盘不建索引，工作区关索引不应牵连文档工具。
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
1. To read a .docx, you MUST call mcp__aide-docs__read_docx — never Read (binary garbage) or Bash+pandoc (not installed). Legacy .doc / .xlsx are not supported: ask the user to convert to .docx first.
2. To read a .pdf, you MUST call mcp__aide-docs__read_pdf — never Read or Bash+pdftotext (not installed, and loses Chinese on PDFs without ToUnicode maps). Scanned PDFs (no text layer) need OCR — say so instead of calling the tool. For long documents, call mode: "structure" first, then read specific pages via pages (at most 20 pages per request).
3. To create or write a .docx, you MUST call mcp__aide-docs__write_docx with markdown content and a file_path — never Bash+python-docx/pandoc or writing binary yourself. It refuses to overwrite an existing file unless you pass overwrite: true. Supported extension syntax: [TOC] / [TOC:figures] / [TOC:tables] indexes, \\newpage page breaks, ::: center/right/justify paragraph alignment, {width=N} image widths.`;

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
