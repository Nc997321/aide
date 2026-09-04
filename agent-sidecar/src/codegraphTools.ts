import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent } from "./types.js";
import {
  queryCodegraph,
  type CodegraphQueryResponse,
  type CodegraphTool,
} from "./codegraphClient.js";

/** allowedTools 前缀规则：匹配该 server 全部工具，canUseTool 直接跳过（只读工具不弹窗）。 */
export const CODEGRAPH_ALLOW_RULE = "mcp__aide-codegraph";

/**
 * MCP instructions 块（initialize 时呈现给模型）。2026-07-26 headless 冒烟实锤：
 * 没有它时模型对工具视而不见——Claude Code 系统提示对内置 Grep 的偏好极强，
 * 连 prompt 里直接点名 "Use the find_symbol tool" 都会被无视、照样 Grep；
 * 加上这段 instructions 后同一 prompt 立刻改用我们的工具。这不是优化是必需品，
 * 删除或弱化前必须先跑 agent-sidecar/smoke-mcp.ts 验证行为不退化。
 *
 * 2026-09-04 扩写：加入「追符号不追字符串」纪律与已知盲区清单（本项目实测边界），
 * 让模型命中盲区时直接退 Grep 而不是对索引空调用。任务级输出契约（链路图/
 * 工具占比报告/防作弊）不进这里——那是 codegraph-explore skill 的职责。
 */
export const CODEGRAPH_INSTRUCTIONS = `This environment has a PRE-BUILT code index for the current workspace, exposed as the aide-codegraph MCP tools. Rules:
1. Need a definition (function/class/method/interface/enum) → mcp__aide-codegraph__find_symbol FIRST; it returns the full source body with file:line, so prefer it over reading whole files. NEVER use Grep to locate a definition.
2. Need callers/callees → mcp__aide-codegraph__call_graph FIRST. It is a verifier, not a discovery tool: when candidates > 1 (name-level join), Read the listed locations to disambiguate — do not guess.
3. Know what the code does but not its name → mcp__aide-codegraph__semantic_search (short natural-language description; retry from different angles on a miss). Results are similarity candidates — verify at the returned file:line before relying on them.
4. Trace symbols, not strings: event/command names are string literals the graph cannot see — find the named symbol behind them first, then chain via find_symbol/call_graph. (A Tauri invoke name usually equals its Rust fn name → find_symbol CAN catch it.)
5. Known blind spots — when the query target is one of these, go straight to Grep: Vue template component refs <X/> and custom events emit/@xxx; Tauri event/command string literals like app.emit("xxx"); cross-language IPC boundaries (Rust↔sidecar stdio, sidecar→frontend, invoke→Rust); anonymous switch cases and structural tags like </script>.
6. Fall back to Grep only after the index fails or misses, and state the reason in a few words (e.g. "blind spot: Vue template ref"). Grep is for text/pattern search, NOT for locating symbols. These tools are exact, instant, and far cheaper than a grep-then-read fan-out.`;

const SNIPPET_HARD_CAP = 300;

// ---------------------------------------------------------------------------
// 格式化（纯函数，测试直接覆盖）
// ---------------------------------------------------------------------------

function fallbackText(reason: string): string {
  return (
    `Code index unavailable (${reason}). Fall back to Grep/Glob for this query. ` +
    `The user can enable the index for this workspace in the 右侧栏 代码索引 panel.`
  );
}

export function formatToolResponse(
  toolName: CodegraphTool,
  resp: CodegraphQueryResponse,
  args: Record<string, unknown>,
): string {
  // 失败路径全部返回文本——工具报错会让 agent 纠结，文本提示让它自然换路。
  if (resp.timedOut) return fallbackText("query timed out");
  if (resp.cancelled) return fallbackText(resp.error ?? "cancelled");
  if (!resp.ok) return fallbackText(resp.error ?? "unknown error");
  if (resp.status === "no_index" || resp.status === "wrong_project") {
    return fallbackText("index not built for this project");
  }
  if (resp.status === "structure_only") {
    return (
      `The code index's semantic layer is still building (or unavailable), so this ` +
      `semantic query can't run yet. Structure queries (find_symbol, call_graph) work. ` +
      `Fall back to Grep for now.`
    );
  }
  if (resp.status === "degraded") {
    return (
      `The code index's semantic layer is degraded — the shard has far fewer vectors ` +
      `than symbols (${resp.health ?? "vector shortfall"}), so semantic search would ` +
      `return wrong/empty results. Rebuild it via the 右侧栏 代码索引 panel (全量重建). ` +
      `Fall back to Grep for this query.`
    );
  }

  const results = resp.results ?? [];
  if (results.length === 0) {
    const what = (args.name as string) ?? (args.query as string) ?? "";
    return (
      `No match for "${what}" in the code index (the index is healthy — the symbol ` +
      `may not exist, or the project's languages are not covered by the indexer). Try Grep.`
    );
  }

  if (toolName === "find_symbol") {
    const lines = results.map((r: any) => {
      const parent = r.parent ? ` (${r.parent})` : "";
      const end = r.end_line && r.end_line > r.line ? `-${r.end_line}` : "";
      const head = `${r.kind} ${r.name} — ${r.file}:${r.line}${end}${parent}`;
      // r.source is the symbol's full source sliced by the backend (capped);
      // absent when the span is missing (old index) or exceeds the cap — then
      // the agent uses `end` to Read precisely instead.
      const src = r.source ? `\n${r.source}` : "";
      return `${head}${src}`;
    });
    return `Definitions (exact, from code index):\n${lines.join("\n")}`;
  }

  if (toolName === "call_graph") {
    const lines = results.map((r: any) => {
      const defs = r.peer_defs?.length ? ` (defined at ${r.peer_defs.join(", ")})` : "";
      return `${r.peer}${defs} — called at ${r.call_file}:${r.call_line}`;
    });
    const notes: string[] = [];
    if ((resp.candidates ?? 0) > 1) {
      notes.push(
        `⚠ ${resp.candidates} candidate definitions share this name (name-level join) — Read the listed locations to disambiguate.`,
      );
    }
    if (resp.truncated) notes.push(`⚠ Results truncated at ${results.length} rows.`);
    const head = notes.length ? `${notes.join("\n")}\n` : "";
    return `${head}Call graph:\n${lines.join("\n")}`;
  }

  // semantic_search
  const lines = results.map((r: any) => {
    const snippet = String(r.snippet ?? "").slice(0, SNIPPET_HARD_CAP);
    return `${r.kind} ${r.name} — ${r.file}:${r.line} (score ${Number(r.score).toFixed(2)})\n  ${snippet}`;
  });
  return (
    `Semantic matches (vector-similarity CANDIDATES — Read the file to verify before relying on them):\n` +
    lines.join("\n")
  );
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * 默认注册；AIDE_CODEGRAPH_TOOLS=off 时返回 null（A/B 实测与调试用，不进设置面板）。
 * 挂载条件（并列，任一不满足即 null）：
 * - `trusted=false`（受限模式）：不信任工作区不建索引，注册了 codegraph
 *   MCP 只会诱导模型对必然返回 no_index 的工具空调用。
 * - `codegraphEnabled=false`：该工作区索引开关未开（每工作区默认关，右侧栏
 *   「代码索引」面板控制——主进程在 cmd JSON 下发 codegraph_enabled）。
 * server 实例 per-worker 构造：handler 闭包持有该会话的 emit 与 cwd。
 * 省略 trusted / enabled = 信任且开启（向后兼容，测试/手工调用用）。
 */
export function codegraphMcpRegistration(
  cwd: string,
  emit: (e: ChatEvent) => void,
  env: NodeJS.ProcessEnv = process.env,
  trusted = true,
  enabled = true,
): Record<string, unknown> | null {
  if (!trusted) return null;
  if (!enabled) return null;
  if (env.AIDE_CODEGRAPH_TOOLS === "off") return null;

  const run = async (
    toolName: CodegraphTool,
    args: Record<string, unknown>,
  ) => {
    const resp = await queryCodegraph(toolName, args, cwd, emit);
    return textResult(formatToolResponse(toolName, resp, args));
  };

  const server = createSdkMcpServer({
    name: "aide-codegraph",
    version: "1.0.0",
    instructions: CODEGRAPH_INSTRUCTIONS,
    tools: [
      tool(
        "find_symbol",
        "Locate the exact definition of a symbol (function/class/method/interface/enum) by name across the indexed project. Returns file:line for each definition. STRONGLY PREFER this over Grep when you need to find where something is defined — one call replaces a grep-then-read fan-out.",
        { name: z.string().describe("Symbol name, e.g. 'makeSkillGuardHook'") },
        async (args) => run("find_symbol", args as Record<string, unknown>),
      ),
      tool(
        "semantic_search",
        "Find code by MEANING when you don't know the identifier: describe what the code does in natural language (e.g. 'permission dialog flow', 'image input handling'). Returns candidate symbols with file:line and a short snippet, replacing iterative keyword grepping. Results are vector-similarity candidates — Read the file to verify before relying on them.",
        {
          query: z.string().describe("Natural-language description of the code you're looking for"),
          limit: z.number().int().min(1).max(10).optional().describe("Max results (default 5)"),
        },
        async (args) => run("semantic_search", args as Record<string, unknown>),
      ),
      tool(
        "call_graph",
        "List callers of / callees of a function or method by name, from the project's pre-built call graph. direction='callers': who calls this symbol; 'callees': what this symbol calls. Much cheaper than grepping every usage site. Name-level join: when candidates>1, multiple definitions share the name — Read the listed locations to disambiguate.",
        {
          name: z.string().describe("Function/method name"),
          direction: z.enum(["callers", "callees"]).describe("'callers' = who calls it; 'callees' = what it calls"),
        },
        async (args) => run("call_graph", args as Record<string, unknown>),
      ),
    ],
  });

  return { "aide-codegraph": server };
}
