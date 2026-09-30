import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent } from "../engine/types.js";
import { queryLsp } from "./lspClient.js";
import { LspNav, type NavArgs } from "./lspNav.js";
import { lspToolsMounted, type LspGate } from "./lspGate.js";

/**
 * allowedTools 前缀规则：匹配该 server 全部工具，canUseTool 直接跳过（只读工具不弹窗）。
 * 与 CODEGRAPH_ALLOW_RULE / DOCS_ALLOW_RULE 同款形状。
 */
export const LSP_ALLOW_RULE = "mcp__aide-lsp";

/** 暴露给模型的工具名。与 Rust 侧 `tool` 字段的映射是 `lsp_X` → `X`
 *  （见 `lsp/agent_query.rs` 的分派）。测试钉住。 */
export const LSP_TOOL_NAMES = [
  "lsp_symbols",
  "lsp_references",
  "lsp_definition",
  "lsp_implementations",
  "lsp_outline",
] as const;

/**
 * server 级说明。codegraph 的实证：光注册工具模型会无视，**instructions 才翻转行为**。
 *
 * 2026-09-29 重写。旧版讲了一堆「状态怎么读、什么时候别信」——那是在教模型提防这组工具，
 * 实际效果是它不用。现在每发都自带代码与文本兜底（见 lspNav.ts），说明书只需讲清
 * **哪种 grep 该换成哪个调用**：模型的真实搜索形状（转录统计）就是下面那几条 grep。
 */
export const LSP_INSTRUCTIONS = `aide-lsp is a language server for this workspace: compiler-accurate code navigation that answers in ONE call what usually takes several grep + Read rounds. Reach for it whenever you are looking for code by a symbol name:
- instead of \`grep -n "fn foo" -A 30\` or reading a whole file to find foo → lsp_definition {name:"foo"}: location AND the full source body.
- instead of grepping for a name to see who calls/uses it → lsp_references {name:"foo"}: every real use, each with its line and the function it sits in — no hits from comments, strings or unrelated same-named symbols.
- instead of \`grep -n "a\\|b\\|c"\` to locate several symbols → lsp_symbols {names:["a","b","c"]}: kind, location and declaration line of each.
- instead of skimming a long file → lsp_outline {file}: its declarations with line ranges, so you Read only the part you need.
- lsp_implementations: what implements an interface/trait (grep cannot see these).
Names may be bare (\`get\`) or qualified (\`LspManager::get\`); pass \`file\` too (relative is fine) to pick the one declared in that file. Calls never hang: if the server has not finished indexing you get plain-text matches, clearly marked unverified. Only a result that says "confirmed negative" proves absence.
Grep stays right for non-code text: string literals, log messages, config keys, comments, file names. Your Grep/grep searches for code identifiers may come back annotated by aide-lsp with the semantic answer — trust that over the raw text hits.
Blind spot: files excluded from the language project (commonly *.test.ts via tsconfig) are not indexed — use Grep for those.`;

export interface LspToolsDeps extends LspGate {
  cwd: string;
  emit: (e: ChatEvent) => void;
}

/** 入参 shape。**每次调用返回新对象**：多个工具复用同一个 zod 原始 shape 会让 SDK 挂上的
 *  `root` 反向引用串成环（`JSON.stringify(spec)` 抛 circular structure）。 */
const target = () => ({
  name: z
    .string()
    .optional()
    .describe("Symbol name, bare or qualified: 'get', 'LspManager::get', 'api.sendMessage'."),
  file: z
    .string()
    .optional()
    .describe("File path (relative to the workspace is fine). With `name`: the file that declares it (disambiguates). With `line`: anchors a position."),
  line: z.number().int().optional().describe("1-based line in `file`. Use instead of `name` when you have a position."),
  character: z.number().int().optional().describe("1-based column; optional — defaults to the symbol on that line."),
});

/**
 * 挂载闸门三条见 `lspGate.ts`（**别在这里重写**——退役内置 LSP 通道的判据是同一份，
 * 分叉会造出「两个都没有」或「两个都在」）。返回 null = server 不挂载 = 工具对模型不存在。
 *
 */
export function lspMcpRegistration(deps: LspToolsDeps): Record<string, unknown> | null {
  if (!lspToolsMounted(deps)) return null;

  const nav = new LspNav({
    cwd: deps.cwd,
    query: (t, args, timeoutMs) => queryLsp(t, args, deps.cwd, deps.emit, { timeoutMs }),
  });

  const server = createSdkMcpServer({
    name: "aide-lsp",
    version: "2.0.0",
    instructions: LSP_INSTRUCTIONS,
    tools: [
      tool(
        "lsp_symbols",
        "Locate symbols by name — several at once. For each name: its kind (function/class/method…), the type it belongs to, file:line:column, line range, and the declaration line itself. Replaces grepping for `fn X|class X|X =` patterns. Names match exactly; if several symbols share a name they are all listed.",
        {
          names: z.array(z.string()).optional().describe("Symbol names to locate (up to 8), bare or qualified."),
          name: z.string().optional().describe("A single symbol name (same as names:[name])."),
        },
        async (args) => textResult(await nav.symbols(args as NavArgs)),
      ),
      tool(
        "lsp_definition",
        "Go to a symbol's definition and get its FULL SOURCE — the whole function/class/type body with line numbers (up to 80 lines, then a Read offset to continue). Give a name, or a position {file, line} of a use site. One call replaces `grep -n \"fn X\" -A 30` + Read.",
        target(),
        async (args) => textResult(await nav.definition(args as NavArgs)),
      ),
      tool(
        "lsp_references",
        "Every real use of a symbol across the workspace, grouped by file; each hit shows line:column, the function/method it is inside, and the line of code. Compiler-precise: excludes comments, strings and same-named members of other types. Give a name (plus `file` to pick one of several same-named symbols) or a position.",
        target(),
        async (args) => textResult(await nav.references("references", args as NavArgs)),
      ),
      tool(
        "lsp_implementations",
        "What implements an interface/trait/abstract method (or what a type implements) — grouped by file with the enclosing type and code line. Grep cannot find these: implementors need not mention the interface name.",
        target(),
        async (args) => textResult(await nav.references("implementations", args as NavArgs)),
      ),
      tool(
        "lsp_outline",
        "The structure of one source file: its classes, functions, methods, types and constants as a tree, each with its line range. Use it before reading a long file, then Read only the range you need.",
        {
          file: z.string().describe("File path (relative to the workspace is fine)."),
        },
        async (args) => textResult(await nav.outline(args as NavArgs)),
      ),
    ],
  });

  return { "aide-lsp": server };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
