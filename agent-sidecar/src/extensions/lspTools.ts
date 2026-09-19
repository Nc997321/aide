import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent } from "../engine/types.js";
import { queryLsp, type LspTool } from "./lspClient.js";
import { formatLspResponse } from "./lspStatusText.js";
import { lspToolsMounted, type LspGate } from "./lspGate.js";

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
1. Semantic questions — "where is X defined", "who references X", "what implements X" — start here, not with Grep. The answer is compiler-precise: a match is a real reference, not a mention in a comment or a string, and a common name (\`get\`, \`run\`) returns its true call sites instead of every textual hit. One call replaces a grep-then-read fan-out.
2. Grep keeps its own job: text, strings, config, logs, comments, file names — anything you would search by characters rather than by symbol.
3. The language server starts lazily and may still be indexing (rust-analyzer takes 40-70s on a large project). Every result carries a status: only status "ready" with zero results is a CONFIRMED negative. Any other status means the question was not answered — retry, or fall back to Grep and say the result is unverified. Never report "no references" from a non-ready status. An "indexing" status that names specific languages means exactly that: those languages were not searched at all.
4. Two known blind spots: (a) \`.vue\` usages ARE included in reference results from \`.ts\`/\`.js\` files (the TS server loads the Vue plugin) — only anchoring a query ON a \`.vue\` file is unsupported, so anchor on the \`.ts\` side; (b) files excluded from the TS project (tsconfig \`exclude\`, commonly \`*.test.ts\`) are not searched at all — cover test files with Grep.`;

export interface LspToolsDeps extends LspGate {
  cwd: string;
  emit: (e: ChatEvent) => void;
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
 * 挂载闸门三条见 `lspGate.ts`（**别在这里重写**——退役内置 LSP 通道的判据是同一份，
 * 分叉会造出「两个都没有」或「两个都在」）。返回 null = server 不挂载 = 工具对模型不存在。
 *
 * headless 不在闸门里单独列一条：`lspLanguages` 由主进程下发，headless 不发 ⇒ 空 ⇒ 关。
 */
export function lspMcpRegistration(
  deps: LspToolsDeps,
): Record<string, unknown> | null {
  if (!lspToolsMounted(deps)) return null;

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
        "Find where a symbol is defined, by NAME, across the whole workspace. This is the tool for \"where is X\" when you know the name — it resolves the owner of the name, so you don't grep and read a dozen files to find out which of them defines it. Names match exactly (fuzzy near-misses are filtered out), so a miss really means the name is absent. Returns file:line candidates; if several symbols share the name it lists them and you must pick one with lsp_references/lsp_definition at that position. Grep is for text, not for names.",
        nameOrPosition(),
        async (args) => run("symbols", args as Record<string, unknown>),
      ),
      tool(
        "lsp_references",
        "Find every real call site of a symbol via the language server — compiler-precise, so it excludes mentions in comments, strings and same-named members of other types. Use it for any \"who calls / who uses X\" question once you know where X is (or pass a position directly); plain-text lookups stay Grep's job.",
        nameOrPosition(),
        async (args) => run("references", args as Record<string, unknown>),
      ),
      tool(
        "lsp_definition",
        "Jump from a use site to where the symbol is defined, via the language server. Pass {file, line, character} when you have a position, or a `name` to resolve it first. Not for text search — that stays Grep's job.",
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
