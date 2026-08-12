import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { statSync, readFileSync } from "node:fs";
import {
  parseDocx,
  resolveDocxPath,
  DOCX_MAX_BYTES,
  DOCX_MAX_CHARS,
  type DocxParseResult,
} from "./docx/parse.js";

/** allowedTools 前缀规则：匹配该 server 全部工具，canUseTool 直接跳过（只读工具不弹窗）。 */
export const DOCX_ALLOW_RULE = "mcp__aide-docs";

/**
 * MCP instructions 块（initialize 时呈现给模型）。codegraph 冒烟实锤过 instructions 是
 * 必需品——第三方模型对没有 instructions 块的 MCP 工具视而不见，连 prompt 点名都无视。
 * 删除或弱化前必须先跑 smoke-mcp.ts 验证模型仍采纳 read_docx。
 */
export const DOCX_INSTRUCTIONS = `This environment has a built-in .docx (Word 2007+) reader exposed as the aide-docs MCP tool (read_docx). Rules:
1. When the user asks you to read a .docx file, you MUST call mcp__aide-docs__read_docx — do NOT use Read (returns binary garbage) and do NOT use Bash+pandoc (pandoc is often not installed).
2. read_docx returns the document content as markdown (headings, lists, tables, link text preserved; images are replaced with alt text/path — no image bytes).
3. read_docx only handles .docx. It does NOT handle legacy .doc (Word 97-2003), .pdf, or .xlsx — for those, ask the user to convert to .docx or use another approach.`;

const DOCX_EXTENSIONS = new Set(["docx"]);

/** 判断路径是否指向 .docx（照 imageInputCapability.ts 的 isImagePath 范式）。 */
export function isDocxPath(path: unknown): boolean {
  if (typeof path !== "string") return false;
  const ext = path.trim().split(/[\\/]/).at(-1)?.split(".").at(-1)?.toLowerCase();
  return !!ext && DOCX_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// Read 纠偏 hook（PreToolUse）
// ---------------------------------------------------------------------------

/**
 * 为什么需要硬 deny（不是软提示）：.docx 是 zip 二进制，Read 出来全是乱码，100% 错误用途，
 * 硬 deny 安全。与 imageGuard 同 matcher (^Read$) 但条件互斥——imageGuard 看图片扩展名，
 * 本 hook 看 .docx 扩展名。不拦 Bash（pandoc 能工作，误伤代价大，同 codegraphGrep 取舍）。
 *
 * 必须 alwaysMounted:false + build 检查 docxMounted——否则 trusted=false / 环境变量 off /
 * 任务支线下模型被 deny 却无 read_docx 替代工具，死路。详见 builtinHooks/index.ts。
 */
export function makeDocxReadNudgeHook() {
  return async (input: { hook_event_name?: string; tool_name?: string; tool_input?: unknown }) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    if (input.tool_name !== "Read") return {};
    const ti = input.tool_input;
    if (!ti || typeof ti !== "object" || Array.isArray(ti)) return {};
    const fp = (ti as Record<string, unknown>).file_path;
    if (!isDocxPath(fp)) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: `"${String(fp)}" is a .docx file. Read returns binary garbage. Use mcp__aide-docs__read_docx to read .docx as markdown.`,
      },
    };
  };
}

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
    ],
  });

  return { "aide-docs": server };
}