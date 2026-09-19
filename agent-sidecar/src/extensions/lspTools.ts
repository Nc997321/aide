import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent } from "../engine/types.js";
import { queryLsp, type LspTool } from "./lspClient.js";
import { formatLspResponse } from "./lspStatusText.js";

/**
 * allowedTools 前缀规则：匹配该 server 全部工具，canUseTool 直接跳过（只读工具不弹窗）。
 * 与 CODEGRAPH_ALLOW_RULE / DOCS_ALLOW_RULE 同款形状。
 */
export const LSP_ALLOW_RULE = "mcp__aide-lsp";

/** 暴露给模型的工具名。与 Rust 侧 `tool` 字段的映射是 `lsp_X` → `X`
 *  （见 `lsp/agent_query.rs` 的 run_jump 分派）。测试钉住。 */
export const LSP_TOOL_NAMES = [
  "lsp_symbols",
  "lsp_references",
  "lsp_definition",
  "lsp_implementations",
] as const;

/**
 * server 级说明。codegraph 的实证：光注册工具模型会无视，**instructions 才翻转行为**。
 *
 * 这里只说三件事，且每件都指向「别把 LSP 当万能」——纯文本查找仍归 Grep，
 * 本 server 的价值在符号名有歧义时（编译器级精确，不含注释/字符串里的同名文本）。
 */
export const LSP_INSTRUCTIONS = `This environment has a LANGUAGE SERVER for the current workspace, exposed as the aide-lsp MCP tools. Read the returned status before trusting a result:
1. Semantic questions — "who defines X", "who references X", "what implements X" — use these tools. They are compiler-precise: a match is a real reference, not a mention in a comment or a string. When a symbol name is common (get, run, handle) or several types define it, one call replaces a grep-then-read fan-out.
2. Plain-text / config / log / string-literal lookups are still Grep's job. Do not use these tools to find text.
3. The language server starts lazily and may still be indexing (rust-analyzer takes 40-70s on a large project). Every result carries a status: only status "ready" with zero results is a CONFIRMED negative. Any other status means the question was not answered — retry, or fall back to Grep and say the result is unverified. Never report "no references" from a non-ready status.`;

export interface LspToolsDeps {
  cwd: string;
  emit: (e: ChatEvent) => void;
  env: NodeJS.ProcessEnv;
  trusted: boolean;
  /** 该工作区配得上 LSP 的语言（主进程 `lsp_languages_for_path` 算好下发）。空 = 不挂载。 */
  lspLanguages: string[];
}

/** 工具入参：给名字（服务层自己解析坐标），或直接给坐标。两者二选一。
 *
 *  **每次调用返回新对象**：四个工具复用同一个 zod 原始 shape 会让 SDK 挂上的
 *  `root` 反向引用串成环（表现是 `JSON.stringify(spec)` 抛 circular structure，
 *  也意味着服务端注册可能拿到互相纠缠的 schema）。 */
const nameOrPosition = () => ({
  name: z
    .string()
    .optional()
    .describe("Symbol name, e.g. 'LspManager::get' or just 'get'. Preferred form."),
  file: z.string().optional().describe("Absolute path — narrows the search or anchors the position."),
  line: z.number().int().optional().describe("1-based line, only with `file` (skips name lookup)."),
  character: z.number().int().optional().describe("1-based column, only with `file` and `line`."),
});

/**
 * 挂载条件（并列，任一不满足即返回 null → server 不挂载 → 工具对模型不存在）：
 * - `trusted=false`：不信任的工作区不跑语言服务器（主进程侧同一道门）。
 * - `lspLanguages` 为空：该工作区没有配得上 LSP 的语言。挂载只会白付每轮重发的
 *   工具 schema，并诱导模型去调注定返回 no_server 的工具。
 * - `AIDE_LSP_TOOLS=off`：逃生舱（与 AIDE_CODEGRAPH_TOOLS / AIDE_DOCX_TOOLS 同款）。
 * - `emit` 缺失：headless 没有 Rust 宿主，事件发出去也没人回（调用方传 undefined 时拦截）。
 */
export function lspMcpRegistration(
  deps: LspToolsDeps,
): Record<string, unknown> | null {
  if (!deps.trusted) return null;
  if (deps.lspLanguages.length === 0) return null;
  if (deps.env.AIDE_LSP_TOOLS === "off") return null;

  const run = async (
    toolName: LspTool,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
    const resp = await queryLsp(toolName, args, deps.cwd, deps.emit);
    return textResult(formatLspResponse(toolName, resp, args));
  };

  const server = createSdkMcpServer({
    name: "aide-lsp",
    version: "1.0.0",
    instructions: LSP_INSTRUCTIONS,
    tools: [
      tool(
        "lsp_symbols",
        "Find a symbol's definition by NAME across the workspace via the language server. Prefer this over Grep when the name is common or several types define it — the language server resolves owners and overloads, Grep cannot. Returns file:line candidates; when more than one matches, Read them to disambiguate.",
        nameOrPosition(),
        async (args) => run("symbols", args as Record<string, unknown>),
      ),
      tool(
        "lsp_references",
        "Find every call site of a symbol via the language server — compiler-precise, so it excludes mentions in comments, strings and same-named members of other types. Use it when you need the real callers of an ambiguous name (e.g. `get`). Plain-text lookups stay Grep's job.",
        nameOrPosition(),
        async (args) => run("references", args as Record<string, unknown>),
      ),
      tool(
        "lsp_definition",
        "Jump to where a symbol is defined, via the language server. Same trade-off as lsp_symbols: use it for ambiguous names, not for text search.",
        nameOrPosition(),
        async (args) => run("definition", args as Record<string, unknown>),
      ),
      tool(
        "lsp_implementations",
        "Find what implements an interface/trait (or what a symbol implements). This is hard for Grep — the implementing types need not mention the interface name. Use it when tracing polymorphic call sites.",
        nameOrPosition(),
        async (args) => run("implementations", args as Record<string, unknown>),
      ),
    ],
  });

  return { "aide-lsp": server };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
