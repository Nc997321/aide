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
 */
export const CODEGRAPH_INSTRUCTIONS = `This environment has a PRE-BUILT code index for the current workspace, exposed as the aide-codegraph MCP tools (find_symbol / semantic_search / call_graph). Rules:
1. When you need to find where a symbol is defined, you MUST call mcp__aide-codegraph__find_symbol FIRST — do NOT use Grep for definition lookup.
2. When you need callers or callees of a function, you MUST call mcp__aide-codegraph__call_graph FIRST.
3. When you know what the code does but not its name, use mcp__aide-codegraph__semantic_search.
Grep is for text/pattern search, NOT for locating symbols. These tools are exact, instant, and far cheaper than a grep-then-read fan-out.`;

const SNIPPET_HARD_CAP = 300;

// ---------------------------------------------------------------------------
// Grep 纠偏 hook（PreToolUse）
// ---------------------------------------------------------------------------

/**
 * 为什么需要这个 hook（2026-07-26 三轮 headless A/B 实锤）：MCP instructions
 * 把工具采纳率从 0 拉到 ~10%，codegraph-explore skill 进入列表也没被主动
 * 调用——第三方模型（Kimi K2.6）对「自愿遵守」类引导（instructions/skill
 * 列表/用户 prompt 点名）都不稳定。hook 是 harness 级强制通道：每次 Grep
 * 命中符号状 pattern 就注入纠偏提示，模型无法「忽略」它，同一轮内即可纠偏。
 *
 * 只做 additionalContext 软纠偏，不 deny——日志串/错误消息等文本搜索是
 * Grep 的合法用途，误伤代价大于收益。
 */
const SYMBOLISH_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** 判断 Grep pattern 是否像"在找一个符号"（裸标识符，可带 \b 词界）。 */
export function looksLikeSymbolLookup(pattern: string): boolean {
  const p = pattern.trim().replace(/\\b/g, "");
  return SYMBOLISH_RE.test(p) && p.length >= 3;
}

/** PreToolUse hook（matcher ^Grep$）：符号状 pattern → 注入 codegraph 纠偏提示。 */
export function makeCodegraphGrepNudgeHook() {
  return async (input: { hook_event_name?: string; tool_name?: string; tool_input?: unknown }) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    if (input.tool_name !== "Grep") return {};
    const ti = input.tool_input;
    if (!ti || typeof ti !== "object" || Array.isArray(ti)) return {};
    const pattern = (ti as Record<string, unknown>).pattern;
    if (typeof pattern !== "string" || !looksLikeSymbolLookup(pattern)) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        additionalContext:
          // 2026-08-03 文案迭代：preference→替代，逃生口收窄为"无法命中"（0 结果/索引没建）。
          // "钉住"语义：有结果（哪怕差）不退 Grep，逼模型啃 find_symbol 而不是逃回 grep 老路。
          // 大白话描述用途（避免 symbol/调用链 jargon，第三方模型更买账）；工具全名保留供调用。
          `Note: "${pattern.trim().replace(/\\b/g, "")}" looks like a function/class/variable name you're looking for. ` +
          `Use mcp__aide-codegraph__find_symbol (to find where it's defined) or mcp__aide-codegraph__call_graph (to find who calls it / what it calls) ` +
          `INSTEAD OF Grep — do not Grep for this name. ` +
          `Only fall back to Grep if they return no match or say the index is not built.`,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// 格式化（纯函数，测试直接覆盖）
// ---------------------------------------------------------------------------

function fallbackText(reason: string): string {
  return (
    `Code index unavailable (${reason}). Fall back to Grep/Glob for this query. ` +
    `The user can build the index in Settings → 代码索引.`
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
 * `trusted=false`（受限模式）时也返回 null：不信任工作区不建索引，注册了 codegraph
 * MCP 只会诱导模型对必然返回 no_index 的工具空调用。server 实例 per-worker 构造：
 * handler 闭包持有该会话的 emit 与 cwd。省略 trusted = 信任（向后兼容）。
 */
export function codegraphMcpRegistration(
  cwd: string,
  emit: (e: ChatEvent) => void,
  env: NodeJS.ProcessEnv = process.env,
  trusted = true,
): Record<string, unknown> | null {
  if (!trusted) return null;
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
